import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// "Use my Chrome" (on your Mac): a hub job drives a tab in the Chrome you're using, through AppleScript, so it has your
// real logins and you watch it happen. One tab per conversation (the hub's session id), opened in your front window.
// Pages are read and clicked with JavaScript in that tab, which needs Chrome's View → Developer → Allow JavaScript from
// Apple Events once; macOS also asks once whether Hearth may control Chrome.
// The other way, "Run in the background", is enkidu-browser's own headless Chrome (computer.ts browseHere).

export type Osa = (script: string, args: string[]) => Promise<{ code: number; out: string; err: string }>;
export type Shot = (bounds: [number, number, number, number], file: string) => Promise<boolean>;

const realOsa: Osa = async (script, args) => {
  const p = Bun.spawn(["osascript", "-e", script, ...args], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), 60_000);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  clearTimeout(timer);
  return { code: await p.exited, out: out.trim(), err: err.trim() };
};
const realShot: Shot = async ([x1, y1, x2, y2], file) => {
  const r = Bun.spawnSync(["screencapture", "-x", "-R", `${x1},${y1},${x2 - x1},${y2 - y1}`, file]);
  return r.exitCode === 0 && existsSync(file);
};

/** A new tab in the front window (a window first, if Chrome has none); prints its id. */
const NEW_TAB = `on run argv
  tell application "Google Chrome"
    activate
    if (count of windows) = 0 then make new window
    tell front window
      set t to make new tab with properties {URL:(item 1 of argv)}
      return (id of t) as string
    end tell
  end tell
end run`;

/** One thing to a tab, found by its id in any window: js <code> | go <url> | loading | close | show (front, and its window's bounds).
 *  Chrome answers a tab's id as text (and ids pass AppleScript's integer range), so ids are compared as text. */
export const ON_TAB = `on run argv
  set tid to (item 1 of argv) as string
  set what to item 2 of argv
  set arg to item 3 of argv
  tell application "Google Chrome"
    repeat with w in windows
      set i to 0
      repeat with t in tabs of w
        set i to i + 1
        if ((id of t) as string) is tid then
          if what is "js" then return (execute t javascript arg) as string
          if what is "go" then
            set URL of t to arg
            return "ok"
          end if
          if what is "loading" then return (loading of t) as string
          if what is "close" then
            close t
            return "ok"
          end if
          if what is "show" then
            set active tab index of w to i
            set index of w to 1
            set b to bounds of w
            return ((item 1 of b) as string) & "," & ((item 2 of b) as string) & "," & ((item 3 of b) as string) & "," & ((item 4 of b) as string)
          end if
        end if
      end repeat
    end repeat
  end tell
  return "NO_TAB"
end run`;

/** The page's text and what you can click, each tagged data-hearth-ref="eN" so click/type can find it. */
const OBSERVE = `(() => {
  const seen = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  document.querySelectorAll("[data-hearth-ref]").forEach((e) => e.removeAttribute("data-hearth-ref"));
  const sel = "a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=option],[role=menuitem],[role=combobox],[role=textbox],[contenteditable=true],[onclick]";
  const parts = []; let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (n >= 250) break;
    if (!seen(el)) continue;
    const ref = "e" + (++n); el.setAttribute("data-hearth-ref", ref);
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "input" ? "input:" + (el.type || "text") : tag);
    const name = (el.getAttribute("aria-label") || el.innerText || el.value || el.placeholder || el.title || el.name || "").replace(/\\s+/g, " ").trim().slice(0, 80);
    parts.push(ref + " " + role + (name ? ' "' + name + '"' : "") + (tag === "a" && el.href ? " -> " + String(el.href).slice(0, 120) : ""));
  }
  return JSON.stringify({ url: location.href, title: document.title, text: (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n").slice(0, 8000), elements: parts });
})()`;

const KEYS: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, PageDown: 34, PageUp: 33, Home: 36, End: 35, Space: 32 };

/** The JavaScript for one action, always answering a JSON string. */
export function actionJs(action: string, p: Record<string, unknown>): string | null {
  const el = (ref: unknown) => `document.querySelector('[data-hearth-ref="' + ${JSON.stringify(String(ref ?? ""))} + '"]')`;
  const missing = (ref: unknown) => `JSON.stringify({ error: "No ${String(ref).replace(/[^\w]/g, "")} on the page now: run observe again for fresh refs." })`;
  const here = `JSON.stringify({ ok: true, url: location.href, title: document.title })`;
  switch (action) {
    case "observe": return OBSERVE;
    case "click":
      if (typeof p.x === "number" && typeof p.y === "number") return `(() => { const e = document.elementFromPoint(${p.x}, ${p.y}); if (!e) return JSON.stringify({ error: "Nothing there." }); e.click(); return ${here}; })()`;
      return `(() => { const e = ${el(p.ref)}; if (!e) return ${missing(p.ref)}; e.scrollIntoView({ block: "center" }); if (e.focus) e.focus(); e.click(); return ${here}; })()`;
    case "type":
      return `(() => { const e = ${p.ref ? el(p.ref) : "document.activeElement"}; if (!e) return ${missing(p.ref)}; const text = ${JSON.stringify(String(p.text ?? ""))};
        e.scrollIntoView({ block: "center" }); if (e.focus) e.focus();
        if (e.isContentEditable) document.execCommand("insertText", false, text);
        else { const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const d = Object.getOwnPropertyDescriptor(proto, "value");
          if (d && d.set) d.set.call(e, (e.value || "") + text); else e.value = (e.value || "") + text;
          e.dispatchEvent(new Event("input", { bubbles: true })); e.dispatchEvent(new Event("change", { bubbles: true })); }
        return JSON.stringify({ ok: true }); })()`;
    case "press": {
      const key = String(p.key ?? ""), code = KEYS[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
      if (!code) return null;
      return `(() => { const e = document.activeElement || document.body; const o = { key: ${JSON.stringify(key === "Space" ? " " : key)}, code: ${JSON.stringify(key)}, keyCode: ${code}, which: ${code}, bubbles: true, cancelable: true };
        for (const t of ["keydown", "keypress", "keyup"]) e.dispatchEvent(new KeyboardEvent(t, o));
        if (o.key === "Enter" && e.form && e.form.requestSubmit) e.form.requestSubmit();
        return ${here}; })()`;
    }
    case "scroll": return `(() => { window.scrollBy(0, ${Number(p.dy) || 600}); return JSON.stringify({ ok: true }); })()`;
    case "evaluate": return `(() => { try { const v = (0, eval)(${JSON.stringify(String(p.expression ?? ""))}); return JSON.stringify({ value: v === undefined ? null : v }); } catch (e) { return JSON.stringify({ error: String(e) }); } })()`;
    case "back": return `(() => { history.back(); return JSON.stringify({ ok: true }); })()`;
    case "here": return here;
    default: return null;
  }
}

/** Chrome's own words for its off switches, in plain words for the agent to pass on. */
function plain(err: string) {
  if (/JavaScript through AppleScript is turned off|Allow JavaScript from Apple Events/i.test(err))
    return "Chrome on the Mac doesn't let Hearth read pages yet. Ask the user to turn on, once, in Chrome's menu bar: View → Developer → Allow JavaScript from Apple Events. Then try again.";
  if (/-1743|Not authorized to send Apple events|not allowed to send/i.test(err))
    return "The Mac didn't let Hearth control Chrome. Ask the user to allow it in System Settings → Privacy & Security → Automation (Hearth → Google Chrome), then try again.";
  if (/-600|isn't running|Can't get application/i.test(err)) return "Chrome isn't installed or didn't start on the Mac.";
  return err.slice(0, 300) || "Chrome on the Mac didn't answer.";
}

/** Which tab is each conversation's (by the hub's session id). Kept while the Mac app runs. */
const tabs = new Map<string, string>();

/** One hearth-browser command in your own Chrome. Same answers as browseHere: {ok, out} or {ok, png}. */
export async function chromeHere(sid: string, action: string, params: Record<string, unknown>, opts: { osa?: Osa; shot?: Shot; sleep?: (ms: number) => Promise<void> } = {}): Promise<{ ok: boolean; out?: string; png?: string; mime?: string }> {
  const osa = opts.osa ?? realOsa, shot = opts.shot ?? realShot, sleep = opts.sleep ?? Bun.sleep;
  const tab = (what: string, arg = "") => osa(ON_TAB, [tabs.get(sid) || "0", what, arg]);
  const fail = (r: { out: string; err: string }) => ({ ok: false, out: plain(r.err || r.out) });
  const settle = async () => { for (let i = 0; i < 60; i++) { await sleep(500); const r = await tab("loading"); if (r.code !== 0 || r.out !== "true") break; } await sleep(400); };
  const js = async (code: string) => {
    const r = await tab("js", code);
    if (r.code !== 0) return fail(r);
    if (r.out === "NO_TAB") return { ok: false, out: "That tab was closed. Run hearth-browser open <url> again." };
    try { const j = JSON.parse(r.out); if (j && typeof j === "object" && "error" in j) return { ok: false, out: String(j.error) }; } catch {}
    return { ok: true, out: r.out };
  };
  if (action === "close") { if (tabs.has(sid)) await tab("close"); tabs.delete(sid); return { ok: true, out: "Closed." }; }
  if (action === "open" || action === "navigate") {
    const url = String(params.url || "");
    if (!/^https?:\/\//.test(url)) return { ok: false, out: "Only http(s) pages." };
    const known = tabs.has(sid) ? await tab("go", url) : null;
    if (!known || known.out === "NO_TAB") {
      const r = await osa(NEW_TAB, [url]);
      if (r.code !== 0 || !/^\d+$/.test(r.out)) return fail(r);
      tabs.set(sid, r.out);
    } else if (known.code !== 0) return fail(known);
    await settle();
    return js(actionJs("here", {})!);
  }
  if (!tabs.has(sid)) return { ok: false, out: "No tab open for this yet. Run hearth-browser open <url> first." };
  if (action === "screenshot") {
    const r = await tab("show");
    const b = r.out.split(",").map(Number);
    if (r.code !== 0 || b.length !== 4 || b.some((n) => !Number.isFinite(n))) return r.out === "NO_TAB" ? { ok: false, out: "That tab was closed. Run hearth-browser open <url> again." } : fail(r);
    const dir = mkdtempSync(join(tmpdir(), "hearth-tab-"));
    try {
      const file = join(dir, "tab.jpg"), small = join(dir, "small.jpg");
      if (!(await shot(b as [number, number, number, number], file))) return { ok: false, out: "The Mac couldn't take a picture of Chrome (Hearth may need Screen Recording in System Settings → Privacy & Security). Use observe to read the page." };
      Bun.spawnSync(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "60", "--resampleWidth", "1280", file, "--out", small], { stdout: "ignore", stderr: "ignore" });
      const bytes = readFileSync(existsSync(small) ? small : file);
      return { ok: true, png: bytes.toString("base64"), mime: "image/jpeg" };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const code = actionJs(action, params);
  if (!code) return { ok: false, out: action === "press" ? `Unknown key ${params.key}. Try Enter, Tab, Escape, Backspace, ArrowDown, ArrowUp, PageDown.` : `Unknown command ${action}.` };
  const r = await js(code);
  if (r.ok && (action === "click" || action === "back" || (action === "press" && params.key === "Enter"))) { await settle(); return js(actionJs("here", {})!); }
  return r;
}
