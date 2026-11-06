import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A headless Chrome for sites you're logged into (LinkedIn, X…). No Playwright: Chrome's own DevTools protocol over a
// WebSocket. Each read starts a throwaway profile, loads your cookies, opens one page, takes its text and quits, so
// nothing lingers and one site's cookies never meet another's.

export type Cookie = { name: string; value: string; domain: string; path?: string; secure?: boolean; httpOnly?: boolean; expires?: number };

/**
 * The browser a login was made in (your Mac's Chrome), so headless Chrome presents as that same browser. LinkedIn ends a
 * session the moment it turns up from a different browser (a "Linux" Chrome on your Mac's login), signing you out
 * everywhere; with the same browser it doesn't. Cookies from Chrome on your Mac bring one along; pasted ones don't.
 */
export type Fingerprint = {
  userAgent: string; acceptLanguage: string; platform: string; timezone?: string;
  /** User-Agent Client Hints (Sec-CH-UA-*), so the headers tell the same story as the user agent. */
  metadata?: { brands: { brand: string; version: string }[]; fullVersionList?: { brand: string; version: string }[]; fullVersion?: string;
    platform: string; platformVersion: string; architecture: string; model: string; mobile: boolean; bitness?: string; wow64?: boolean };
};

const str = (v: unknown, max = 300) => (typeof v === "string" && v.length <= max ? v : null);
/** A fingerprint from outside (the Mac app, the vault), checked field by field; anything off and it's dropped. */
export function cleanFingerprint(f: any): Fingerprint | null {
  if (!f || typeof f !== "object") return null;
  const userAgent = str(f.userAgent), acceptLanguage = str(f.acceptLanguage, 100), platform = str(f.platform, 40);
  if (!userAgent || !/^Mozilla\/5\.0 /.test(userAgent) || !acceptLanguage || !platform) return null;
  const out: Fingerprint = { userAgent, acceptLanguage, platform };
  if (str(f.timezone, 60) && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(f.timezone)) out.timezone = f.timezone;
  const m = f.metadata;
  const brands = (x: any) => (Array.isArray(x) ? x.slice(0, 6).filter((b) => str(b?.brand, 60) && str(b?.version, 40)).map((b) => ({ brand: b.brand, version: b.version })) : undefined);
  if (m && typeof m === "object" && brands(m.brands)?.length && str(m.platform, 40) && str(m.platformVersion, 40) && str(m.architecture, 20)) {
    out.metadata = { brands: brands(m.brands)!, fullVersionList: brands(m.fullVersionList), fullVersion: str(m.fullVersion, 40) || undefined,
      platform: m.platform, platformVersion: m.platformVersion, architecture: m.architecture, model: str(m.model, 60) ?? "", mobile: !!m.mobile,
      bitness: str(m.bitness, 4) || undefined, wow64: !!m.wow64 };
  }
  return out;
}

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
  cookies?: Cookie[]; waitMs?: number; timeoutMs?: number; chrome?: string | null; fingerprint?: Fingerprint | null;
  /** CSS selector to wait for (the app has rendered); reading starts as soon as it shows up, or after waitMs. */
  waitFor?: string;
  /** A JavaScript expression run in the page; its JSON-able result comes back as "data". */
  extract?: string;
  /** Before reading, type `text` into the first of these boxes and press Enter (a site's own search, e.g. LinkedIn's
   *  "Search messages"), then wait for the results. */
  search?: { box: string[]; text: string };
  /** Before reading, scroll a lazily-loaded list until it shows `until` rows (the first of `items` that matches
   *  anything), or it stops growing. */
  more?: { items: string[]; until: number };
};

type Cdp = (method: string, params?: object) => Promise<any>;

/** Starts a throwaway headless Chrome with your cookies, opens `url`, hands `fn` a DevTools line to it, then cleans up. */
async function withPage<T>(url: string, opts: { cookies?: Cookie[]; timeoutMs?: number; chrome?: string | null; fingerprint?: Fingerprint | null }, fn: (send: Cdp, deadline: number) => Promise<T>): Promise<T> {
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
    const fp = opts.fingerprint;
    if (fp) {
      // Present as the browser the login came from (see Fingerprint): same user agent, client hints, language, time zone.
      await send("Network.setUserAgentOverride", { userAgent: fp.userAgent, acceptLanguage: fp.acceptLanguage, platform: fp.platform, ...(fp.metadata ? { userAgentMetadata: fp.metadata } : {}) });
      if (fp.timezone) await send("Emulation.setTimezoneOverride", { timezoneId: fp.timezone }).catch(() => {});
    } else {
      // Sites turn away "HeadlessChrome"; present the same browser without the word.
      const v = await send("Browser.getVersion");
      await send("Network.setUserAgentOverride", { userAgent: String(v.userAgent).replace("HeadlessChrome", "Chrome"), acceptLanguage: "en-US,en" });
    }
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

/** In the page: how many rows the first of these selectors that matches anything finds. */
const countRows = (items: string[]) => `(() => { for (const s of ${JSON.stringify(items)}) { const n = document.querySelectorAll(s).length; if (n) return n; } return 0; })()`;

/** Wait until the list's row count holds still for a moment (a search or a scroll has finished loading). */
async function settle(send: Cdp, items: string[], deadline: number, first = 0) {
  let last = first, still = 0;
  while (still < 2 && Date.now() < deadline - 3000) {
    await Bun.sleep(700);
    const n = Number(await evalIn(send, countRows(items))) || 0;
    still = n === last ? still + 1 : 0;
    last = n;
  }
  return last;
}

/** Type into the site's own search box and press Enter, like you would. */
async function searchIn(send: Cdp, s: { box: string[]; text: string }, items: string[], deadline: number) {
  const box = JSON.stringify(s.box);
  const find = `(() => { for (const q of ${box}) { const e = document.querySelector(q); if (e) { e.scrollIntoView(); e.focus(); e.click && e.click(); if ("value" in e) e.value = ""; return true; } } return false; })()`;
  let found = false;
  for (let i = 0; i < 10 && !found && Date.now() < deadline - 8000; i++) {
    found = (await evalIn(send, find)) === true;
    if (!found) await Bun.sleep(500);
  }
  if (!found) throw new Error("Couldn't find the site's search box (the page may have changed). Nothing was searched.");
  await Bun.sleep(300);
  await send("Input.insertText", { text: s.text.slice(0, 100) });
  await Bun.sleep(400);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await Bun.sleep(1500);
  if (items.length) await settle(send, items, deadline, -1);
}

/** Scroll the list's last row into view (and every scrollable box around it to its end) until enough rows show. */
async function scrollForMore(send: Cdp, m: { items: string[]; until: number }, deadline: number) {
  const scroll = `(() => { for (const s of ${JSON.stringify(m.items)}) { const els = document.querySelectorAll(s); if (!els.length) continue;
    const last = els[els.length - 1]; last.scrollIntoView({ block: "end" });
    for (let p = last.parentElement; p; p = p.parentElement) if (p.scrollHeight > p.clientHeight + 10) p.scrollTop = p.scrollHeight;
    return els.length; } return 0; })()`;
  let have = Number(await evalIn(send, countRows(m.items))) || 0, stuck = 0;
  while (have < m.until && stuck < 2 && Date.now() < deadline - 5000) {
    await evalIn(send, scroll);
    const now = await settle(send, m.items, deadline, have);
    stuck = now > have ? 0 : stuck + 1;
    have = now;
  }
}

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
    if (opts.search?.text) await searchIn(send, opts.search, opts.more?.items || (opts.waitFor ? [opts.waitFor] : []), deadline);
    if (opts.more && opts.more.until > 0) await scrollForMore(send, opts.more, deadline);
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
  fingerprint?: Fingerprint | null;
  timeoutMs?: number;
  /** The page is the inbox, not the chat: search for the conversation named `name`, open it, and check it's the one
   *  that opened (its header shows that name) before typing. For sites whose list has no link per conversation. */
  open?: OpenByName;
};

export type OpenByName = {
  name: string;
  /** The site's search box. */
  search: string[];
  /** Conversation rows, tried in order. */
  rows: string[];
  /** In a row: its participants' names. */
  rowName: string[];
  /** In a row: what to click to open it. */
  rowClick: string[];
  /** The open conversation's name, at the top of the chat. */
  header: string[];
};

const normName = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Search the inbox for a conversation by its name, open the newest whose name matches exactly, and check it opened. */
async function openByName(send: Cdp, o: OpenByName, signedOut: RegExp, deadline: number) {
  let n = 0;
  while (!n && Date.now() < deadline - 15_000) {
    await Bun.sleep(500);
    if (signedOut.test(String(await evalIn(send, "location.href")))) throw new Error("The site signed Hearth out. Reconnect it in Connectors.");
    n = Number(await evalIn(send, countRows(o.rows))) || 0;
  }
  if (!n) throw new Error("Couldn't find the conversation list (the site may have changed). Nothing was sent.");
  await searchIn(send, { box: o.search, text: o.name.replace(/\s+/g, " ").trim() }, o.rows, deadline);
  const pick = `(() => {
    const want = ${JSON.stringify(normName(o.name))};
    const norm = (s) => String(s || "").replace(/\\s+/g, " ").trim().toLowerCase();
    for (const s of ${JSON.stringify(o.rows)}) {
      const rows = [...document.querySelectorAll(s)];
      if (!rows.length) continue;
      const names = rows.map((r) => { const e = r.querySelector(${JSON.stringify(o.rowName.join(", "))}); return String(e ? e.innerText : (r.innerText || "").split("\\n")[0]).replace(/\\s+/g, " ").trim(); });
      const i = names.map(norm).indexOf(want);
      if (i < 0) return { names: [...new Set(names)].slice(0, 8) };
      const row = rows[i];
      const c = row.querySelector(${JSON.stringify(o.rowClick.join(", "))}) || row;
      c.scrollIntoView(); c.click();
      return { clicked: true };
    }
    return { names: [] };
  })()`;
  const r = await evalIn(send, pick);
  if (!r?.clicked) throw new Error(`No conversation named "${o.name}"${r?.names?.length ? ` (the search found: ${r.names.join(", ")})` : ""}. Use the name exactly as the inbox read shows it. Nothing was sent.`);
  const header = `(() => { const e = document.querySelector(${JSON.stringify(o.header.join(", "))}); return e ? e.innerText : ""; })()`;
  const until = Math.min(Date.now() + 10_000, deadline - 8000);
  let shown = "";
  while (Date.now() < until) {
    await Bun.sleep(500);
    shown = normName(String(await evalIn(send, header) || ""));
    if (shown === normName(o.name)) return;
  }
  throw new Error(`Opened a conversation but it shows "${shown || "no name"}", not "${o.name}". Nothing was sent.`);
}

/**
 * Types `text` into a conversation you're logged into and sends it, like you would: open the chat, click the message
 * box, type, press Send. Then checks the words show up in the chat. Only called after you tapped Approve.
 */
export async function sendInPage(url: string, text: string, o: SendIn): Promise<void> {
  await withPage(url, { cookies: o.cookies, chrome: o.chrome, fingerprint: o.fingerprint, timeoutMs: o.timeoutMs ?? 60_000 }, async (send, deadline) => {
    if (o.open) await openByName(send, o.open, o.signedOut, deadline);
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
