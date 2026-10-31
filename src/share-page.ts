import { createHash } from "node:crypto";

// The page a visitor opens at /t/<link>/. The hub serves it (the box can only answer JSON), with a sandbox CSP so it
// runs in an opaque origin: even on your hub's domain it can't read your app's storage or device token.
// Everything from the box is shown with textContent, never as HTML.

const SCRIPT = `
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const base = location.pathname.replace(/\\/?$/, "/");
let token = new URLSearchParams(location.hash.slice(1)).get("s") || "";
async function call(path, opts = {}) {
  const res = await fetch(base + "api/" + path, { ...opts, headers: { "Content-Type": "application/json", ...(token ? { "X-Visitor": token } : {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || "Something went wrong."), { status: res.status });
  return data;
}
function bubble(role, text, extra) {
  const b = el("div", "msg " + role, text);
  if (extra) b.append(extra);
  $("#log").append(b);
  b.scrollIntoView({ block: "end" });
  return b;
}
function editNote(edit) {
  const d = el("div", "edit");
  d.append(el("div", "edit-title", "Changes saved for review"));
  for (const f of edit.files) d.append(el("div", "edit-file", f.path + "  +" + f.added + " -" + f.removed));
  return d;
}
async function start() {
  const info = await call("info");
  document.title = info.name;
  $("#emoji").textContent = info.emoji || "";
  $("#name").textContent = info.name;
  $("#does").textContent = info.does;
  for (const ex of info.examples || []) {
    const c = el("button", "chip", ex);
    c.type = "button";
    c.onclick = () => { $("#text").value = ex; $("#text").focus(); };
    $("#chips").append(c);
  }
  if (token) {
    try {
      const r = await call("messages");
      for (const m of r.messages) bubble(m.role === "visitor" ? "me" : "them", m.text);
    } catch { token = ""; }
  }
}
async function send(e) {
  e.preventDefault();
  const text = $("#text").value.trim();
  if (!text) return;
  $("#text").value = "";
  $("#send").disabled = true;
  bubble("me", text);
  const wait = bubble("them wait", "…");
  try {
    if (!token) { token = (await call("session", { method: "POST", body: "{}" })).token; location.hash = "s=" + token; }
    const r = await call("chat", { method: "POST", body: JSON.stringify({ text }) });
    wait.remove();
    bubble("them" + (r.refused ? " refused" : ""), r.reply, r.edit ? editNote(r.edit) : null);
  } catch (err) {
    wait.remove();
    bubble("note", err.message);
  } finally { $("#send").disabled = false; $("#text").focus(); }
}
$("#form").addEventListener("submit", send);
$("#text").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#form").requestSubmit(); } });
start().catch((err) => { $("#does").textContent = err.status === 404 ? "This link is turned off." : err.message; $("#form").hidden = true; });
`;

const STYLE = `
*{box-sizing:border-box}body{margin:0;font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f4ef;color:#1d1b16}
main{max-width:640px;margin:0 auto;min-height:100vh;display:flex;flex-direction:column;padding:16px}
header{display:flex;gap:12px;align-items:center;padding:8px 0 12px}#emoji{font-size:34px}#name{font-weight:650;font-size:20px}
#does{color:#6b665c;font-size:14px}#chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.chip{border:1px solid #ddd6c8;background:#fff;border-radius:16px;padding:5px 11px;font:inherit;font-size:13px;cursor:pointer}
#log{flex:1;display:flex;flex-direction:column;gap:8px;padding:8px 0}
.msg{max-width:85%;padding:9px 13px;border-radius:16px;white-space:pre-wrap;word-wrap:break-word}
.me{align-self:flex-end;background:#2d5a46;color:#fff}.them{align-self:flex-start;background:#fff;border:1px solid #e7e1d4}
.refused{color:#6b665c}.wait{color:#9a9488}.note{align-self:center;color:#8a4b2a;font-size:14px}
.edit{margin-top:8px;padding-top:8px;border-top:1px dashed #ddd6c8;font-size:13px;color:#4a463e}.edit-title{font-weight:600}
.edit-file{font-family:ui-monospace,Menlo,monospace}
form{display:flex;gap:8px;position:sticky;bottom:0;background:#f6f4ef;padding:10px 0}
textarea{flex:1;resize:none;height:46px;border:1px solid #ddd6c8;border-radius:12px;padding:11px;font:inherit}
button#send{border:0;border-radius:12px;background:#2d5a46;color:#fff;padding:0 18px;font:inherit;font-weight:600}
footer{color:#9a9488;font-size:12px;text-align:center;padding:4px 0 8px}
`;

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>Chat</title><style>${STYLE}</style></head><body><main>
<header><div id="emoji"></div><div><div id="name"></div><div id="does"></div></div></header>
<div id="chips"></div><div id="log"></div>
<form id="form"><textarea id="text" maxlength="2000" placeholder="Message" aria-label="Message"></textarea><button id="send">Send</button></form>
<footer>An assistant someone shared with you. It only knows what they chose to share. They see counts, blocked messages and anything it asks them for you, not your whole chat.</footer>
</main><script>${SCRIPT}</script></body></html>`;

const scriptHash = createHash("sha256").update(SCRIPT).digest("base64");

export function sharePage(hubOrigin: string) {
  return new Response(HTML, {
    headers: {
      "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      "Content-Security-Policy": [
        "sandbox allow-scripts allow-forms", "default-src 'none'", `script-src 'sha256-${scriptHash}'`, "style-src 'unsafe-inline'",
        `connect-src ${hubOrigin}`, "img-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
      ].join("; "),
    },
  });
}
