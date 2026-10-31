import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A headless Chrome for sites you're logged into (LinkedIn, X…). No Playwright: Chrome's own DevTools protocol over a
// WebSocket. Each read starts a throwaway profile, loads your cookies, opens one page, takes its text and quits, so
// nothing lingers and one site's cookies never meet another's.

export type Cookie = { name: string; value: string; domain: string; path?: string; secure?: boolean; httpOnly?: boolean; expires?: number };

const CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium",
];

export function chromePath(env: Record<string, string | undefined> = process.env) {
  if (env.HEARTH_CHROME) return existsSync(env.HEARTH_CHROME) ? env.HEARTH_CHROME : null;
  return CANDIDATES.find((p) => existsSync(p)) || null;
}

/** "a=1; b=2" (a Cookie header) or a JSON export from a cookie extension -> cookies for this domain. */
export function parseCookies(raw: string, domain: string): Cookie[] {
  const text = String(raw || "").trim();
  if (!text) return [];
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const j = JSON.parse(text);
      const list: any[] = Array.isArray(j) ? j : Array.isArray(j.cookies) ? j.cookies : [];
      return list.filter((c) => c && typeof c.name === "string" && typeof c.value === "string")
        .map((c) => ({ name: c.name, value: c.value, domain: typeof c.domain === "string" && c.domain ? c.domain : domain, path: c.path || "/", secure: true, httpOnly: !!c.httpOnly,
          expires: typeof c.expirationDate === "number" ? Math.round(c.expirationDate) : typeof c.expires === "number" ? c.expires : undefined }));
    } catch { return []; }
  }
  return text.replace(/^cookie:\s*/i, "").split(";").map((p) => p.trim()).filter((p) => p.includes("=")).map((p) => {
    const i = p.indexOf("=");
    return { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim().replace(/^"|"$/g, ""), domain, path: "/", secure: true };
  });
}

type ReadOpts = {
  cookies?: Cookie[]; waitMs?: number; timeoutMs?: number; chrome?: string | null;
  /** CSS selector to wait for (the app has rendered); reading starts as soon as it shows up, or after waitMs. */
  waitFor?: string;
  /** A JavaScript expression run in the page; its JSON-able result comes back as "data". */
  extract?: string;
};

/** Opens a page in headless Chrome and returns its final URL, visible text, and what "extract" pulled out. */
export async function readPage(url: string, opts: ReadOpts = {}): Promise<{ url: string; text: string; data?: unknown }> {
  const exe = opts.chrome ?? chromePath();
  if (!exe) throw new Error("No Chrome on this machine. Install Google Chrome or Chromium, or set HEARTH_CHROME.");
  const profile = mkdtempSync(join(tmpdir(), "hearth-chrome-"));
  const proc = Bun.spawn([exe, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run",
    "--no-default-browser-check", "--disable-extensions", "--disable-gpu", "--mute-audio", "--window-size=1280,2000", "about:blank"],
  { stdout: "ignore", stderr: "ignore" });
  const deadline = Date.now() + (opts.timeoutMs ?? 45_000);
  let ws: WebSocket | null = null;
  try {
    // Chrome writes the port it picked into the profile once it's listening.
    const portFile = join(profile, "DevToolsActivePort");
    while (!existsSync(portFile) || !readFileSync(portFile, "utf8").includes("\n")) {
      if (Date.now() > deadline) throw new Error("Chrome didn't start.");
      await Bun.sleep(50);
    }
    const port = readFileSync(portFile, "utf8").split("\n")[0].trim();
    const targets: any[] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("Chrome has no page.");
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((ok, bad) => { ws!.onopen = ok; ws!.onerror = () => bad(new Error("Couldn't talk to Chrome.")); });
    let next = 1;
    const waiting = new Map<number, { ok: (v: any) => void; bad: (e: Error) => void }>();
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      const w = m.id && waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      m.error ? w.bad(new Error(m.error.message)) : w.ok(m.result);
    };
    const send = (method: string, params: object = {}) => new Promise<any>((ok, bad) => {
      const id = next++;
      waiting.set(id, { ok, bad });
      ws!.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (waiting.delete(id)) bad(new Error(`Chrome timed out on ${method}.`)); }, Math.max(1000, deadline - Date.now()));
    });
    await send("Network.enable");
    // Sites turn away "HeadlessChrome"; present the same browser without the word.
    const v = await send("Browser.getVersion");
    await send("Network.setUserAgentOverride", { userAgent: String(v.userAgent).replace("HeadlessChrome", "Chrome"), acceptLanguage: "en-US,en" });
    if (opts.cookies?.length) await send("Network.setCookies", { cookies: opts.cookies.map((c) => ({ ...c, url: undefined, path: c.path || "/" })) });
    await send("Page.navigate", { url });
    // Wait for the app to render (these sites build the page with JavaScript after it loads).
    const until = Math.min(Date.now() + (opts.waitMs ?? 6000), deadline - 2000);
    const ready = opts.waitFor ? `!!document.querySelector(${JSON.stringify(opts.waitFor)})` : "false";
    while (Date.now() < until) {
      await Bun.sleep(400);
      const r = await send("Runtime.evaluate", { expression: ready, returnByValue: true }).catch(() => null);
      if (r?.result?.value === true) { await Bun.sleep(800); break; } // a moment more for the rest of the list
    }
    const expr = `JSON.stringify({ url: location.href, text: document.body ? document.body.innerText : '', data: ${opts.extract ? `(() => { try { return ${opts.extract}; } catch (e) { return null; } })()` : "undefined"} })`;
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true });
    return JSON.parse(r.result.value);
  } finally {
    try { ws?.close(); } catch {}
    proc.kill();
    await proc.exited.catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }
}
