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

type Cdp = (method: string, params?: object) => Promise<any>;

/** Starts a throwaway headless Chrome with your cookies, opens `url`, hands `fn` a DevTools line to it, then cleans up. */
async function withPage<T>(url: string, opts: { cookies?: Cookie[]; timeoutMs?: number; chrome?: string | null }, fn: (send: Cdp, deadline: number) => Promise<T>): Promise<T> {
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
    const send: Cdp = (method, params = {}) => new Promise<any>((ok, bad) => {
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
    return await fn(send, deadline);
  } finally {
    try { ws?.close(); } catch {}
    proc.kill();
    await proc.exited.catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }
}

const evalIn = async (send: Cdp, expression: string) => (await send("Runtime.evaluate", { expression, returnByValue: true }).catch(() => null))?.result?.value;

/** Opens a page in headless Chrome and returns its final URL, visible text, and what "extract" pulled out. */
export async function readPage(url: string, opts: ReadOpts = {}): Promise<{ url: string; text: string; data?: unknown }> {
  return withPage(url, opts, async (send, deadline) => {
    // Wait for the app to render (these sites build the page with JavaScript after it loads).
    const until = Math.min(Date.now() + (opts.waitMs ?? 6000), deadline - 2000);
    const ready = opts.waitFor ? `!!document.querySelector(${JSON.stringify(opts.waitFor)})` : "false";
    while (Date.now() < until) {
      await Bun.sleep(400);
      if ((await evalIn(send, ready)) === true) { await Bun.sleep(800); break; } // a moment more for the rest of the list
    }
    const expr = `JSON.stringify({ url: location.href, text: document.body ? document.body.innerText : '', data: ${opts.extract ? `(() => { try { return ${opts.extract}; } catch (e) { return null; } })()` : "undefined"} })`;
    return JSON.parse(await evalIn(send, expr));
  });
}

export type SendIn = {
  cookies: Cookie[];
  /** The message box, tried in order. */
  composer: string[];
  /** The Send button, tried in order; with none found, Enter sends. */
  sendButton?: string[];
  signedOut: RegExp;
  chrome?: string | null;
  timeoutMs?: number;
};

/**
 * Types `text` into a conversation you're logged into and sends it, like you would: open the chat, click the message
 * box, type, press Send. Then checks the words show up in the chat. Only called after you tapped Approve.
 */
export async function sendInPage(url: string, text: string, o: SendIn): Promise<void> {
  await withPage(url, { cookies: o.cookies, chrome: o.chrome, timeoutMs: o.timeoutMs ?? 60_000 }, async (send, deadline) => {
    const box = JSON.stringify(o.composer.join(", "));
    let found = false;
    while (!found && Date.now() < deadline - 8000) {
      await Bun.sleep(500);
      const href = String(await evalIn(send, "location.href"));
      if (o.signedOut.test(href)) throw new Error("The site signed Hearth out. Reconnect it in Connectors.");
      found = (await evalIn(send, `!!document.querySelector(${box})`)) === true;
    }
    if (!found) throw new Error("Couldn't find the message box on that page (the chat link may be wrong, or the site changed). Nothing was sent.");
    await evalIn(send, `(() => { const e = document.querySelector(${box}); e.scrollIntoView(); e.focus(); e.click && e.click(); return true; })()`);
    await Bun.sleep(300);
    // One line at a time, with Shift+Enter between lines, so a multi-line message doesn't send early.
    const lines = text.replace(/\r/g, "").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]) await send("Input.insertText", { text: lines[i] });
      if (i < lines.length - 1) {
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8 });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, modifiers: 8 });
      }
    }
    await Bun.sleep(400);
    const btn = JSON.stringify((o.sendButton || []).join(", "));
    const clicked = o.sendButton?.length ? (await evalIn(send, `(() => { const b = document.querySelector(${btn}); if (!b || b.disabled || b.getAttribute("aria-disabled") === "true") return false; b.click(); return true; })()`)) === true : false;
    if (!clicked) {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    }
    // Sent when the box empties out and the words appear in the chat.
    const probe = JSON.stringify(lines.find((l) => l.trim())!.trim().slice(0, 40));
    const until = Math.min(Date.now() + 10_000, deadline);
    while (Date.now() < until) {
      await Bun.sleep(600);
      const ok = await evalIn(send, `(() => { const e = document.querySelector(${box}); const left = e ? (e.innerText || e.value || "").trim() : ""; return !left && document.body.innerText.includes(${probe}); })()`);
      if (ok === true) return;
    }
    throw new Error("Typed the message but couldn't confirm it went out. Check the chat before trying again, so it isn't sent twice.");
  });
}
