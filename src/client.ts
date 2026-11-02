#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadConfig } from "./config.ts";
import { availableHarnesses } from "./brain.ts";
import { computerName, connect, joinHub, readLink, type Link } from "./computer.ts";
import { TokenMint } from "./tokenmint.ts";

// Hearth Client: the app you install on a Mac, Windows PC or Ubuntu desktop. It links that computer to your Hearth Hub
// (your phone approves it), runs work there with the computer's own Claude/Codex login, and can set up the Claude token
// your shared links use. Your phone is a window onto the hub; a client is a computer that works for it.
// Opening the app shows its page in your browser; after setup it starts at login and keeps the link up.

const OS = platform();
export const clientDir = () => process.env.HEARTH_CLIENT_DATA || (OS === "darwin" ? join(homedir(), "Library/Application Support/Hearth Client")
  : OS === "win32" ? join(process.env.APPDATA || join(homedir(), "AppData/Roaming"), "Hearth Client") : join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "hearth-client"));
const PORT = Number(process.env.HEARTH_CLIENT_PORT || 47823);

type Stage = "setup" | "waiting" | "linked";
type State = { stage: Stage; hub?: string; name: string; code?: string; error?: string; connected: boolean; brains: string[];
  token: "none" | "asking" | "done" | "error"; tokenUrl?: string; tokenError?: string; atLogin: boolean };

const open = (url: string) => { try { Bun.spawn(OS === "darwin" ? ["open", url] : OS === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url], { stdout: "ignore", stderr: "ignore" }); } catch {} };

// ---------- start at login, per OS ----------

const LABEL = "com.hearth.client";
const loginPaths = () => ({
  darwin: join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`),
  linux: join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "autostart", "hearth-client.desktop"),
  win32: join(process.env.APPDATA || "", "Microsoft/Windows/Start Menu/Programs/Startup", "Hearth Client.cmd"),
}[OS as "darwin" | "linux" | "win32"]);

export function atLogin() { const p = loginPaths(); return !!p && existsSync(p); }

export function setAtLogin(on: boolean, exe = process.execPath) {
  const p = loginPaths();
  if (!p) return;
  if (!on) {
    if (OS === "darwin") Bun.spawnSync(["launchctl", "bootout", `gui/${process.getuid?.()}/${LABEL}`]);
    rmSync(p, { force: true });
    return;
  }
  mkdirSync(join(p, ".."), { recursive: true });
  if (OS === "darwin") {
    // caffeinate -s: keep the Mac awake while it's plugged in, so work can reach it.
    const path = ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local/bin"), join(homedir(), ".bun/bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":");
    writeFileSync(p, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>/usr/bin/caffeinate</string><string>-s</string><string>${exe}</string><string>--background</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${path}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${join(homedir(), "Library/Logs/hearth-client.log")}</string>
  <key>StandardErrorPath</key><string>${join(homedir(), "Library/Logs/hearth-client.log")}</string>
</dict></plist>
`);
  } else if (OS === "linux") {
    writeFileSync(p, `[Desktop Entry]\nType=Application\nName=Hearth Client\nExec="${exe}" --background\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n`);
  } else {
    writeFileSync(p, `@echo off\r\nstart "" /min "${exe}" --background\r\n`);
  }
}

// ---------- the app ----------

export class Client {
  state: State;
  private stopLink: (() => void) | null = null;
  private mint: TokenMint | null = null;

  constructor(readonly dataDir = clientDir()) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const link = readLink(dataDir);
    this.state = { stage: link ? "linked" : "setup", hub: link?.hub, name: link?.name || computerName(), connected: false,
      brains: availableHarnesses(this.config()).filter((h) => h === "claude" || h === "codex"), token: existsSync(join(dataDir, "token-sent")) ? "done" : "none", atLogin: atLogin() };
  }

  private config() { return { ...loadConfig({ ...process.env, HEARTH_TARGET: "mac", HEARTH_DATA: this.dataDir }), dataDir: this.dataDir }; }

  /** Keep the link to the hub up (work comes down it). */
  startLink(link = readLink(this.dataDir)) {
    if (!link || this.stopLink) return;
    this.stopLink = connect({ config: this.config(), link, log: (s) => { console.log(s); if (/connected to/i.test(s)) this.state.connected = true; if (/lost|closed|retry/i.test(s)) this.state.connected = false; },
      onSignedOut: () => { this.stopLink?.(); this.stopLink = null; rmSync(join(this.dataDir, "computer.json"), { force: true }); this.state = { ...this.state, stage: "setup", connected: false, hub: undefined }; } });
  }

  /** Step 1-2: ask the hub, show the code, wait for your phone. */
  async join(hub: string, name: string) {
    let url: URL;
    try { url = new URL(/^https?:\/\//.test(hub) ? hub : `https://${hub}`); } catch { this.state.error = "That isn't a web address."; return; }
    Object.assign(this.state, { stage: "waiting", error: undefined, code: undefined, hub: url.origin, name: name.trim().slice(0, 60) || computerName() });
    try {
      const link = await joinHub(url.origin, this.dataDir, this.state.name, () => {}, { onCode: (code) => { this.state.code = code; } });
      Object.assign(this.state, { stage: "linked", code: undefined });
      if (!atLogin()) { try { setAtLogin(true); this.state.atLogin = true; } catch {} }
      this.startLink(link);
    } catch (e: any) { Object.assign(this.state, { stage: "setup", error: e.message, code: undefined }); }
  }

  /** Step 3: a Claude token for shared links, made with this computer's subscription. claude opens the browser; you approve. */
  async shareToken() {
    const link = readLink(this.dataDir);
    if (!link || this.state.token === "asking") return;
    this.mint?.cancel();
    this.mint = new TokenMint(undefined, { browser: true });
    Object.assign(this.state, { token: "asking", tokenError: undefined, tokenUrl: undefined });
    try {
      const { url } = await this.mint.start();
      this.state.tokenUrl = url;
      const token = await this.mint.waitForToken();
      if (!token) throw new Error("Didn't get a token. Try again.");
      await this.sendToken(link, token);
    } catch (e: any) { Object.assign(this.state, { token: "error", tokenError: e.message }); }
  }

  /** If the browser shows a code instead of finishing (some setups), paste it. */
  async shareTokenCode(code: string) {
    const link = readLink(this.dataDir);
    if (!link || !this.mint) return;
    try { await this.sendToken(link, await this.mint.finish(code)); }
    catch (e: any) { Object.assign(this.state, { token: "error", tokenError: e.message }); }
  }

  private async sendToken(link: Link, token: string) {
    const res = await fetch(`${link.hub}/computer/share-key`, { method: "POST", headers: { Authorization: `Bearer ${link.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    if (!res.ok) throw new Error(`Your hub didn't take it: ${(await res.text()).slice(0, 120)}`);
    writeFileSync(join(this.dataDir, "token-sent"), new Date().toISOString());
    Object.assign(this.state, { token: "done", tokenUrl: undefined });
  }

  unlink() {
    this.stopLink?.(); this.stopLink = null;
    rmSync(join(this.dataDir, "computer.json"), { force: true });
    rmSync(join(this.dataDir, "token-sent"), { force: true });
    this.state = { ...this.state, stage: "setup", hub: undefined, connected: false, token: "none" };
  }

  /** The local page. Only this computer can reach it, only with this run's key (other websites can't drive it). */
  serve(port = PORT) {
    const key = randomBytes(18).toString("base64url");
    const server = Bun.serve({
      port, hostname: "127.0.0.1",
      fetch: async (req) => {
        const url = new URL(req.url);
        if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.get("host") || "")) return new Response("No", { status: 403 }); // DNS rebinding
        if (url.pathname === "/") return new Response(PAGE.replace("{{KEY}}", key), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": CSP, "X-Frame-Options": "DENY" } });
        if (req.headers.get("x-client-key") !== key) return new Response("No", { status: 403 });
        const json = (d: unknown) => Response.json(d, { headers: { "Cache-Control": "no-store" } });
        const body = req.method === "POST" ? await req.json().catch(() => ({})) as any : {};
        switch (`${req.method} ${url.pathname}`) {
          case "GET /api/state": return json(this.state);
          case "POST /api/join": this.join(String(body.hub || ""), String(body.name || "")); return json({ ok: true });
          case "POST /api/token": this.shareToken(); return json({ ok: true });
          case "POST /api/token-code": await this.shareTokenCode(String(body.code || "")); return json(this.state);
          case "POST /api/login": setAtLogin(!!body.on); this.state.atLogin = atLogin(); return json(this.state);
          case "POST /api/unlink": this.unlink(); return json(this.state);
          case "POST /api/open-hub": if (this.state.hub) open(this.state.hub); return json({ ok: true });
          default: return new Response("Not found", { status: 404 });
        }
      },
    });
    writeFileSync(join(this.dataDir, "port"), String(server.port));
    return server;
  }
}

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hearth Client</title>
<style>
*{box-sizing:border-box}body{margin:0;font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Ubuntu,sans-serif;background:#f6f4ef;color:#1d1b16;display:grid;place-items:start center;min-height:100vh}
main{width:min(460px,100%);padding:40px 22px}h1{font-size:26px;margin:0 0 4px}p{margin:6px 0}.muted{color:#6b665c}.small{font-size:14px}
.card{background:#fff;border:1px solid #e7e1d4;border-radius:18px;padding:18px;margin:16px 0}
.step{display:flex;gap:12px;align-items:flex-start}.n{width:28px;height:28px;border-radius:50%;background:#1d1b16;color:#fff;display:grid;place-items:center;font-size:14px;flex:none}
.n.done{background:#2f9e6b}input{width:100%;padding:12px 13px;border:1px solid #ddd6c8;border-radius:11px;font:inherit;margin:6px 0}
button{border:0;border-radius:13px;background:#1d1b16;color:#fff;padding:12px 16px;font:inherit;font-weight:600;cursor:pointer;width:100%;margin-top:8px}
button.ghost{background:#efebe3;color:#1d1b16}button:disabled{opacity:.5}.code{font:700 34px ui-monospace,Menlo,monospace;letter-spacing:.18em;text-align:center;margin:10px 0}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#bbb;margin-right:6px}.dot.on{background:#2f9e6b}.err{color:#a3442a;font-size:14px}
.row{display:flex;justify-content:space-between;align-items:center;gap:10px}.mark{font-size:40px}
</style></head><body><main>
<div class="mark">🔥</div><h1>Hearth Client</h1><p class="muted">This computer works for your Hearth Hub: jobs run here with its own Claude login.</p>
<div id="app"></div>
</main><script>
const KEY = "{{KEY}}";
const $ = (s) => document.querySelector(s);
const call = (p, b) => fetch(p, { method: b ? "POST" : "GET", headers: { "X-Client-Key": KEY, "Content-Type": "application/json" }, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
const el = (t, a = {}, ...kids) => { const e = document.createElement(t); for (const [k, v] of Object.entries(a)) { if (k === "on") for (const [ev, f] of Object.entries(v)) e.addEventListener(ev, f); else if (k === "class") e.className = v; else e[k] = v; } for (const k of kids.flat(Infinity)) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k))); return e; };
let typing = false;
function draw(s) {
  if (typing) return;
  const app = $("#app"); app.replaceChildren();
  const step = (n, done, title, ...body) => el("div", { class: "card" }, el("div", { class: "step" }, el("div", { class: "n" + (done ? " done" : "") }, done ? "✓" : n), el("div", { style: "flex:1" }, el("b", {}, title), ...body)));
  if (s.stage === "setup") {
    const hub = el("input", { placeholder: "yournameassistant.com", value: s.hub || "", autocapitalize: "off", spellcheck: false, on: { focus: () => typing = true, blur: () => typing = false } });
    const name = el("input", { value: s.name, on: { focus: () => typing = true, blur: () => typing = false } });
    app.append(step(1, false, "Link this computer to your hub", el("p", { class: "muted small" }, "Your hub's address, and what to call this computer."), hub, name,
      s.error ? el("p", { class: "err" }, s.error) : null,
      el("button", { on: { click: () => { typing = false; call("/api/join", { hub: hub.value, name: name.value }).then(tick); } } }, "Link")),
      step(2, false, "Approve it on your phone", el("p", { class: "muted small" }, "Your phone shows a 4-letter code to approve.")),
      step(3, false, "Shared links", el("p", { class: "muted small" }, "Optional: let links you share use this computer's Claude subscription.")));
    return;
  }
  if (s.stage === "waiting") {
    app.append(step(1, true, "Asked " + s.hub),
      step(2, false, "Approve it on your phone", el("p", { class: "muted small" }, "Your primary phone got a request for \\"" + s.name + "\\". Approve it only if it shows this code:"), el("div", { class: "code" }, s.code || "…")));
    return;
  }
  const brains = s.brains.length ? s.brains.map((b) => b === "claude" ? "Claude Code" : "Codex").join(" and ") : "none yet: install Claude Code and log in";
  app.append(el("div", { class: "card" },
    el("div", { class: "row" }, el("b", {}, el("span", { class: "dot" + (s.connected ? " on" : "") }), s.connected ? "Linked and online" : "Linked, connecting…"), el("span", { class: "muted small" }, s.name)),
    el("p", { class: "muted small" }, s.hub), el("p", { class: "small" }, "Runs here: " + brains),
    el("button", { class: "ghost", on: { click: () => call("/api/open-hub", {}) } }, "Open your hub")));
  const t = s.token;
  app.append(el("div", { class: "card" },
    el("b", {}, "Shared links"),
    t === "done" ? el("p", { class: "small" }, "✓ Your shared links use this computer's Claude subscription.")
    : t === "asking" ? [el("p", { class: "small" }, "A Claude tab opened in your browser. Approve it there; this finishes by itself."),
        s.tokenUrl ? el("p", { class: "small" }, el("a", { href: s.tokenUrl, target: "_blank" }, "No tab? Open it here.")) : null,
        el("p", { class: "muted small" }, "If Claude shows you a code instead, paste it:"),
        (() => { const c = el("input", { placeholder: "Code from Claude", on: { focus: () => typing = true, blur: () => typing = false } }); return [c, el("button", { class: "ghost", on: { click: () => { typing = false; call("/api/token-code", { code: c.value }).then(tick); } } }, "Send code")]; })()]
    : [el("p", { class: "muted small" }, "When you share a teammate, its sandbox needs a Claude token. Make one with this computer's subscription: it can only talk to Claude, nothing else on your account."),
        s.tokenError ? el("p", { class: "err" }, s.tokenError) : null,
        el("button", { on: { click: () => call("/api/token", {}).then(tick) } }, "Use my Claude subscription")]));
  app.append(el("div", { class: "card" },
    el("div", { class: "row" }, el("span", {}, "Start when I log in"), el("input", { type: "checkbox", checked: s.atLogin, style: "width:auto", on: { change: (e) => call("/api/login", { on: e.target.checked }).then(tick) } }))),
    el("button", { class: "ghost", on: { click: () => { if (confirm("Unlink this computer from your hub?")) call("/api/unlink", {}).then(tick); } } }, "Unlink"));
}
let last = "";
const tick = () => call("/api/state").then((s) => { const j = JSON.stringify(s); if (j !== last) { last = j; draw(s); } }).catch(() => {});
tick(); setInterval(tick, 1500);
</script></body></html>`;

if (import.meta.main) {
  const background = process.argv.includes("--background");
  const dir = clientDir();
  // Already running (opened again from the Dock or Start menu): just show its page.
  const portFile = join(dir, "port");
  if (existsSync(portFile)) {
    const p = Number(readFileSync(portFile, "utf8"));
    const up = await fetch(`http://127.0.0.1:${p}/`, { signal: AbortSignal.timeout(800) }).then((r) => r.ok, () => false);
    if (up) { if (!background) open(`http://127.0.0.1:${p}/`); process.exit(0); }
  }
  const client = new Client(dir);
  let server;
  try { server = client.serve(); } catch { server = client.serve(0); }
  try { chmodSync(dir, 0o700); } catch {}
  client.startLink();
  console.log(`Hearth Client on http://127.0.0.1:${server.port}/`);
  if (!background) open(`http://127.0.0.1:${server.port}/`);
  const quit = () => { rmSync(portFile, { force: true }); process.exit(0); };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}
