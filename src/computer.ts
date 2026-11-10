import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sha256 } from "./auth.ts";
import { Brain, availableHarnesses, type BrainProfile } from "./brain.ts";
import { ALIVE_EVERY_MS, COPY_ITEMS, MAX_SHOT, isCopyItem, type CopyItem } from "./computers.ts";
import { readSiteCookiesAnywhere, canReadBrowser, chromeFingerprint } from "./chrome.ts";
import { requiredFor, labelFor, isValidDomain } from "./cookie-sites.ts";
import type { Config } from "./config.ts";
import { TOKEN_RE } from "./tokenmint.ts";
import { checkTools, type ToolStatus } from "./brains/tools.ts";
import { registerSkills } from "./brains/skills.ts";
import { linkedinSkill } from "./connectors/linkedin-api.ts";
import { chromeHere } from "./mac-chrome.ts";
import { googleSkills } from "./connectors/google-agent.ts";
import { execHere, KEY_RE, type ExecReq } from "./run-elsewhere.ts";

// The computer side of a link (run on your Mac): join a hub once, then keep a line open to it and run the work it sends,
// with this computer's own Claude/Codex login. The hub never gets a shell here: it can only ask for a brain call, which
// runs with the same slim, web-only tool set as on the hub, and for the login files and browser cookies you chose to
// copy. Cookies are read from your browser here (read-only) and sent up, and it re-copies when the hub asks (a session
// expired). The one exception is hearth-run (run-elsewhere.ts): a job's command, run in its own folder under
// ~/Hearth/runs, and only after you said yes to it on a card in that conversation. HEARTH_NO_RUN=1 turns it off here.

/** cloud: the hub set this machine up (a sandbox or your VM) and may hand it logins. Your Mac's link never has it. */
export type Link = { hub: string; token: string; deviceId: string; name: string; cloud?: boolean };
const linkFile = (dataDir: string) => join(dataDir, "computer.json");

export function readLink(dataDir: string): Link | null {
  try { return JSON.parse(readFileSync(linkFile(dataDir), "utf8")); } catch { return null; }
}

/** Ask the hub to let this computer in. Any of your signed-in devices approves it, like any new device. */
export async function joinHub(hubUrl: string, dataDir: string, name = computerName(), log = console.log, opts: { offerShareKey?: boolean; onCode?: (code: string) => void } = {}) {
  const hub = new URL(hubUrl).origin;
  const res = await fetch(`${hub}/api/access/request`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceName: name, kind: "computer" }) });
  const r: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(r.error || `The hub answered ${res.status}`);
  opts.onCode?.(r.code);
  log(`\n  On any device signed in to Hearth (Settings → Devices), approve "${name}". It shows the code  ${r.code}  — only approve if it matches.\n  Waiting…`);
  const until = Date.now() + 10 * 60_000;
  while (Date.now() < until) {
    await Bun.sleep(2000);
    const p = await fetch(`${hub}/api/access/poll`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ poll: r.poll }) });
    const j: any = await p.json().catch(() => ({}));
    if (!p.ok) throw new Error(j.error || "The request expired. Run join again.");
    if (j.status === "denied") throw new Error("Your phone said no.");
    if (j.status === "approved" && j.token) {
      const link: Link = { hub, token: j.token, deviceId: j.deviceId, name };
      writeFileSync(linkFile(dataDir), JSON.stringify(link, null, 2), { mode: 0o600 });
      log(`  Linked to ${hub}.`);
      if (process.stdin.isTTY && opts.offerShareKey !== false && !opts.onCode) await offerShareKey(link, log);
      log(`  Start it with:  bun run computer\n`);
      return link;
    }
  }
  throw new Error("Nobody approved it in 10 minutes. Run join again.");
}

/**
 * Shared links (someone chatting with one of your teammates) need a Claude key in their sandbox. Joining is the easy
 * moment to make one: this Mac has your browser and your Claude login, so `claude setup-token` is just "approve in the
 * browser". The token can only talk to Claude (scope user:inference); it goes to your hub over this computer's own key.
 */
export async function offerShareKey(link: Link, log = console.log, ask = askYesNo) {
  if (Bun.spawnSync(["claude", "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode !== 0) return false;
  const yes = await ask("  Use this Mac's Claude subscription for shared links (when you share a teammate)? [Y/n] ");
  if (!yes) { log("  Skipped. You can do it later with:  bun run share-key"); return false; }
  return sendShareKey(link, log);
}

export async function sendShareKey(link: Link, log = console.log, mint = mintToken) {
  log("  Opening your browser to approve a token for shared links…");
  const token = await mint();
  if (!token) { log("  Didn't get a token. Try again with:  bun run share-key"); return false; }
  const res = await fetch(`${link.hub}/computer/share-key`, { method: "POST", headers: { Authorization: `Bearer ${link.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  if (!res.ok) { log(`  The hub didn't take it: ${(await res.text()).slice(0, 160)}`); return false; }
  log("  Done: shared links will use your Claude subscription.");
  return true;
}

/** Run `claude setup-token` in this terminal (so you see it and the browser opens), and pick the token out of its output. */
export async function mintToken(): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), "hearth-token-"));
  chmodSync(dir, 0o700);
  const typescript = join(dir, "out");
  try {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "CLAUDECODE") env[k] = v;
    // `script` gives setup-token a real terminal and keeps a copy of what it printed.
    const cmd = platform() === "darwin" ? ["script", "-q", typescript, "claude", "setup-token"] : ["script", "-q", "-c", "claude setup-token", typescript];
    const p = Bun.spawn(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env });
    await p.exited;
    const out = existsSync(typescript) ? readFileSync(typescript, "utf8").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "") : "";
    return out.match(TOKEN_RE)?.[0] ?? null;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function askYesNo(q: string) {
  process.stdout.write(q);
  for await (const line of console) return !/^n/i.test(line.trim());
  return false;
}

/** What the phone calls this computer: the Mac's own name ("Rishi's MacBook Pro"), else the host name. */
export function computerName() {
  if (platform() === "darwin") {
    const r = Bun.spawnSync(["scutil", "--get", "ComputerName"]);
    const n = r.stdout.toString().trim();
    if (r.exitCode === 0 && n) return n.slice(0, 60);
  }
  return hostname().replace(/\.(local|lan|home)$/, "").slice(0, 60);
}

/** This computer's copy of a login, as the hub's Linux harness expects to find it. On a Mac, Claude keeps it in the Keychain. */
export function readLogin(item: CopyItem): string | null {
  if (item === "claude" && platform() === "darwin") {
    const r = Bun.spawnSync(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"]);
    const out = r.stdout.toString().trim();
    if (r.exitCode === 0 && out) return out;
  }
  const path = join(homedir(), COPY_ITEMS[item].path);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** Whether this machine has a login, without reading the secret (so no Keychain prompt just to check). */
export function hasLogin(item: CopyItem): boolean {
  if (item === "claude" && platform() === "darwin" && Bun.spawnSync(["security", "find-generic-password", "-s", "Claude Code-credentials"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0) return true;
  return existsSync(join(homedir(), COPY_ITEMS[item].path));
}

/**
 * One hearth-browser command from the hub (a job there got blocked, and you approved using this Mac's browser; see
 * other-browser.ts), run with this Mac's own enkidu-browser in a session the hub names. The page opens in a real,
 * visible Chrome here: your home connection, your logins. Screenshots go back as an image small enough for the line.
 */
export async function browseHere(sid: string, action: string, params: Record<string, unknown>, opts: { bin?: string | null; run?: (argv: string[]) => Promise<{ code: number; out: string }>; frames?: boolean } = {}): Promise<{ ok: boolean; out?: string; png?: string; mime?: string; frame?: string }> {
  if (!/^hearth-other-[a-f0-9]{6,20}$/.test(sid)) return { ok: false, out: "Not a session the hub can use." };
  if (!["open", "navigate", "observe", "click", "type", "press", "scroll", "evaluate", "screenshot", "back", "close"].includes(action)) return { ok: false, out: `Unknown command ${action}.` };
  const bin = opts.bin !== undefined ? opts.bin : (existsSync(join(homedir(), ".enkidu", "bin", "enkidu-browser")) ? join(homedir(), ".enkidu", "bin", "enkidu-browser") : Bun.which("enkidu-browser"));
  if (!bin) return { ok: false, out: "This Mac has no enkidu-browser, so it can't open pages for the hub." };
  const run = opts.run ?? (async (argv: string[]) => {
    // The hub's sessions have their own owner here, so they never mix with yours.
    const p = Bun.spawn([bin, ...argv], { env: { ...process.env, ENKIDU_OWNER: "hearth-hub" }, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill(), 120_000);
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    clearTimeout(timer);
    return { code: await p.exited, out: (out.trim() || err.trim()).slice(0, 60_000) };
  });
  const msg = (out: string) => { try { return String(JSON.parse(out).message || out); } catch { return out; } };
  // enkidu-browser never reuses a closed session's name, so each conversation's session gets a fresh one when it starts
  // over: <sid>-1, <sid>-2…
  const live = () => `${sid}-${generation.get(sid) ?? 0}`;
  if (action === "close") { await run(["session", "close", live()]); generation.set(sid, (generation.get(sid) ?? 0) + 1); return { ok: true, out: "Closed." }; }
  const use = (a: string, p: Record<string, unknown>) => run(["session", "use", live(), a, JSON.stringify(p)]);
  let r: { code: number; out: string };
  if (action === "open") {
    // In the background: its own headless Chrome (your logins copied in), so nothing pops up on your screen.
    const fresh = async () => { await run(["session", "close", live()]); generation.set(sid, (generation.get(sid) ?? 0) + 1); await run(["session", "new", live(), JSON.stringify({ recordName: "Hearth: a job from the hub" })]); return use("open", { ...params, headless: true }); };
    r = (await run(["session", "get", live()])).code === 0 ? await use("open", { ...params, headless: true }) : await fresh();
    if (r.code !== 0 && /lost|expired|canceled|cancelled|not found|no session/i.test(msg(r.out))) r = await fresh();
  } else if (action === "back") r = await use("evaluate", { expression: "history.back()" });
  else r = await use(action, params);
  if (r.code !== 0) return { ok: false, out: msg(r.out) };
  if (action !== "screenshot") {
    // A small picture of the page after each step, for the job's live view in the thread (it's headless: nothing to watch here).
    const frame = opts.frames !== false ? await smallShot(run, live()) : undefined;
    return { ok: true, out: r.out, ...(frame ? { frame } : {}) };
  }
  const file = shotFile(r.out);
  if (!file || !existsSync(file)) return { ok: false, out: "The screenshot didn't come out." };
  let bytes = readFileSync(file), mime = "image/png";
  if (bytes.length > MAX_SHOT && platform() === "darwin") {
    // Too big for the line: a smaller JPEG of it.
    const dir = mkdtempSync(join(tmpdir(), "hearth-shot-"));
    try {
      for (const [w, q] of [[1280, 70], [1000, 55], [800, 45]] as const) {
        const jpg = join(dir, `s-${w}.jpg`);
        Bun.spawnSync(["sips", "-s", "format", "jpeg", "-s", "formatOptions", String(q), "--resampleWidth", String(w), file, "--out", jpg], { stdout: "ignore", stderr: "ignore" });
        if (existsSync(jpg) && readFileSync(jpg).length <= MAX_SHOT) { bytes = readFileSync(jpg); mime = "image/jpeg"; break; }
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  if (bytes.length > MAX_SHOT) return { ok: false, out: "That screenshot is too big to send. Take a normal one (not full), or use observe." };
  return { ok: true, png: bytes.toString("base64"), mime };
}

/** Which session each conversation's is on now (see browseHere). */
const generation = new Map<string, number>();
/** Where enkidu-browser saved a screenshot: {"result": {"file": …}} (older ones put file at the top). */
const shotFile = (out: string) => { try { const j = JSON.parse(out); return String(j?.result?.file || j?.file || ""); } catch { return ""; } };

/** The page as a small JPEG (base64), for live view; nothing if it can't. */
async function smallShot(run: (argv: string[]) => Promise<{ code: number; out: string }>, sid: string): Promise<string | undefined> {
  const r = await run(["session", "use", sid, "screenshot", "{}"]);
  const file = shotFile(r.out);
  if (r.code !== 0 || !file || !existsSync(file)) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "hearth-frame-"));
  try {
    const jpg = join(dir, "f.jpg");
    Bun.spawnSync(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "50", "--resampleWidth", "900", file, "--out", jpg], { stdout: "ignore", stderr: "ignore" });
    const b = existsSync(jpg) ? readFileSync(jpg) : null;
    return b && b.length <= 400_000 ? b.toString("base64") : undefined;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** One hearth-browser command, the way you chose on its Approve card: your own Chrome, or a headless one in the background. */
export function browseOnMac(sid: string, action: string, params: Record<string, unknown>, mode: unknown) {
  return mode === "mine" ? chromeHere(sid, action, params) : browseHere(sid, action, params);
}

type Opts = { config: Config; link: Link; brain?: Brain; readCopy?: (item: CopyItem) => string | null; log?: (s: string) => void; copyEveryMs?: number; home?: string;
  /** How this computer's tools are (enkidu-browser, enkidu-cua), told to the hub for Settings. Swapped in tests. */
  tools?: () => Promise<ToolStatus[]>;
  /** hearth-browser commands from the hub (browseOnMac); swapped in tests. */
  browse?: typeof browseOnMac;
  /** hearth-run commands from the hub (execHere); swapped in tests. */
  exec?: typeof execHere;
  /** The hub signed this computer out for good. */
  onSignedOut?: () => void };

/** A cloud computer got logins from its hub: put them where Claude Code and Codex look, and skip Claude's first-run questions. */
export function writeLogins(home: string, items: Record<string, unknown>) {
  const wrote: string[] = [];
  for (const [item, data] of Object.entries(items)) {
    if (!isCopyItem(item) || typeof data !== "string" || data.length > 64 * 1024) continue;
    try { JSON.parse(data); } catch { continue; }
    const path = join(home, COPY_ITEMS[item].path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, data, { mode: 0o600 });
    chmodSync(path, 0o600);
    wrote.push(item);
  }
  if (wrote.includes("claude")) {
    const state = join(home, ".claude.json");
    let cur: any = {};
    try { cur = JSON.parse(readFileSync(state, "utf8")); } catch {}
    writeFileSync(state, JSON.stringify({ hasCompletedOnboarding: true, theme: "dark", ...cur }), { mode: 0o600 });
  }
  return wrote;
}

/** Keep a line open to the hub for as long as this runs, reconnecting with backoff. Returns a stop function. */
export function connect(opts: Opts) {
  const { config, link } = opts;
  const log = opts.log || ((s: string) => console.log(s));
  const brain = opts.brain || new Brain(config);
  const readCopy = opts.readCopy || readLogin;
  const runs = new Map<string, AbortController>();
  let ws: WebSocket | null = null;
  let stopped = false, backoff = 1000, alive: ReturnType<typeof setInterval> | null = null, copyTimer: ReturnType<typeof setInterval> | null = null, toolsTimer: ReturnType<typeof setInterval> | null = null;
  let want: { items: CopyItem[]; have: Record<string, string> } = { items: [], have: {} };
  let cookieWant: { sites: string[]; have: Record<string, string>; fresh?: string } = { sites: [], have: {} };
  const send = (m: unknown) => { try { ws?.send(JSON.stringify(m)); } catch {} };
  const url = link.hub.replace(/^http/, "ws") + "/computer";
  // The hub's agent skills for jobs run here (Gmail, Drive, Calendar), pointed back at the hub with this connection's key.
  let agentSkills: { key: string; google: boolean; linkedin: boolean } | null = null;
  registerSkills(() => (agentSkills?.google ? googleSkills(link.hub, agentSkills.key) : []));
  registerSkills(() => (agentSkills?.linkedin ? [linkedinSkill(link.hub, agentSkills.key)] : []));

  // Copy up only what changed since the hub last got it.
  const copyUp = () => {
    for (const item of want.items) {
      const data = readCopy(item);
      if (!data) continue;
      const hash = sha256(data);
      if (want.have[item] === hash) continue;
      send({ t: "copy", item, data, hash });
      want.have[item] = hash;
      log(`  copied your ${COPY_ITEMS[item].label} to the hub`);
    }
  };

  // Browser cookies the hub asked for (on connect, on sign-out, or when a teammate asks): read them here, send once.
  // The one it asked for fresh (a job hit a sign-out) always gets an answer: the login, or why there isn't one, so the
  // hub can tell the user "sign in on your Mac" instead of waiting.
  const copyCookiesUp = () => {
    if (!cookieWant.sites.length) return;
    const fresh = cookieWant.fresh;
    if (!canReadBrowser()) {
      log("  the hub asked for a browser login, but this computer can't read the browser here");
      if (fresh) send({ t: "noCookies", site: fresh, why: "unreadable" });
      return;
    }
    for (const domain of cookieWant.sites) {
      const found = readSiteCookiesAnywhere(domain, requiredFor(domain));
      if (!found) { if (domain === fresh) { send({ t: "noCookies", site: domain, why: "signed-out" }); log(`  the hub asked for your ${labelFor(domain)} login, but Chrome here isn't signed in to it`); } continue; }
      const data = JSON.stringify({ cookies: found.cookies, fingerprint: chromeFingerprint() });
      const hash = sha256(data);
      if (cookieWant.have[domain] === hash) continue;
      send({ t: "cookies", site: domain, data, hash });
      cookieWant.have[domain] = hash;
      log(`  copied your ${labelFor(domain)} login from ${found.profile} to the hub`);
    }
  };

  const run = async (m: any) => {
    const ctl = new AbortController();
    runs.set(m.id, ctl);
    try {
      const profile: BrainProfile = { harness: String(m.profile?.harness || ""), model: String(m.profile?.model || "") };
      if (!availableHarnesses(config).includes(profile.harness)) throw new Error(`${profile.harness} isn't installed on ${link.name}.`);
      const meter = { costUsd: 0, unknown: false, signal: ctl.signal, onProgress: (text: string) => send({ t: "step", id: m.id, text }),
        onAction: (text: string) => send({ t: "act", id: m.id, text }),
        onFrame: (f: { data: Uint8Array; mime: string }) => send({ t: "frame", id: m.id, mime: f.mime, data: Buffer.from(f.data).toString("base64") }) };
      const reply = await brain.think(m.input, profile, meter);
      send({ t: "done", id: m.id, reply, costUsd: meter.unknown ? undefined : meter.costUsd });
    } catch (e: any) {
      send({ t: "error", id: m.id, message: e?.message || String(e) });
    } finally { runs.delete(m.id); }
  };

  // A job's hearth-run, after you said yes on its card (run-elsewhere.ts). Its files come and go over HTTP.
  const runHere = (m: any) => {
    const id = m.id as string;
    if (process.env.HEARTH_NO_RUN === "1") { send({ t: "execd", id, error: `${link.name} doesn't take commands from the hub (HEARTH_NO_RUN is set there).` }); return; }
    const strs = (x: unknown) => (Array.isArray(x) ? x.filter((s) => typeof s === "string").slice(0, 20_000) : []);
    const tid = typeof m.tid === "string" && /^[0-9a-f-]{36}$/.test(m.tid) ? m.tid : null;
    if (!KEY_RE.test(String(m.key)) || typeof m.cmd !== "string" || m.cmd.length > 20_000) { send({ t: "execd", id, error: "That run didn't make sense." }); return; }
    const req: ExecReq = { key: m.key, tid, deleted: strs(m.deleted), full: m.full === true, cmd: m.cmd, bg: m.bg === true,
      timeoutSec: Math.min(Math.max(Number(m.timeoutSec) || 1800, 10), 24 * 3600), get: strs(m.get).slice(0, 50) };
    log(`  the hub is running a command here: ${req.cmd.slice(0, 160)}`);
    const ctl = new AbortController();
    runs.set(id, ctl);
    const auth = { Authorization: `Bearer ${link.token}` };
    (opts.exec ?? execHere)(req, {
      home: opts.home || homedir(), side: link.name, signal: ctl.signal,
      onLine: (text) => send({ t: "execLine", id, text }),
      fetchIn: async (t, to) => {
        const r = await fetch(`${link.hub}/computer/x/${t}`, { headers: auth });
        if (!r.ok) throw new Error(`couldn't get the files from the hub (${r.status})`);
        await Bun.write(to, r);
      },
      sendUp: async (file) => {
        const r = await fetch(`${link.hub}/computer/x/up/${id}`, { method: "POST", headers: { ...auth, "Content-Type": "application/gzip" }, body: Bun.file(file) });
        if (!r.ok) throw new Error(`couldn't send the files back to the hub (${r.status})`);
      },
    }).then((r) => send({ t: "execd", id, ...r }), (e) => send({ t: "execd", id, error: String(e?.message || e).slice(0, 500) }))
      .finally(() => runs.delete(id));
  };

  let opened = false;
  const signedOut = () => { log(`  ${link.name} was signed out of the hub. Run join again to link it.`); stopped = true; opts.onSignedOut?.(); };
  const retry = (why: string) => {
    log(`  lost the hub (${why}); trying again in ${Math.round(backoff / 1000)}s`);
    setTimeout(open, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  };
  const open = () => {
    if (stopped) return;
    opened = false;
    // Bun's WebSocket takes headers, so the key never sits in a URL or a log.
    ws = new WebSocket(url, { headers: { Authorization: `Bearer ${link.token}` } } as any);
    ws.onopen = () => {
      opened = true;
      backoff = 1000;
      log(`  connected to ${link.hub}`);
      // can: what this app knows how to do beyond brain runs, so the hub doesn't wait on an older app for nothing.
      send({ t: "hello", harnesses: availableHarnesses(config), platform: platform(), can: process.env.HEARTH_NO_RUN === "1" ? [] : ["exec"] });
      alive = setInterval(() => send({ t: "alive" }), ALIVE_EVERY_MS);
      copyTimer = setInterval(copyUp, opts.copyEveryMs ?? 5 * 60_000);
      // Its tools' health for Settings, now and every few minutes (a daemon can stop or come back).
      const tellTools = () => { (opts.tools ?? (() => checkTools()))().then((tools) => send({ t: "tools", tools })).catch(() => {}); };
      tellTools();
      toolsTimer = setInterval(tellTools, 5 * 60_000);
    };
    ws.onmessage = (ev) => {
      let m: any;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.t === "ping") send({ t: "pong", ts: m.ts });
      else if (m.t === "run" && typeof m.id === "string") run(m);
      else if (m.t === "stop") runs.get(m.id)?.abort();
      else if (m.t === "browse" && typeof m.id === "string" && !link.cloud) {
        const params = m.params && typeof m.params === "object" ? m.params : {};
        log(`  the hub is using this Mac's browser: ${String(m.action)}${typeof params.url === "string" ? ` ${params.url}` : ""}`);
        (opts.browse ?? browseOnMac)(String(m.sid), String(m.action), params, m.mode)
          .then((r) => send({ t: "browsed", id: m.id, ...r }), (e) => send({ t: "browsed", id: m.id, ok: false, out: String(e?.message || e) }));
      }
      else if (m.t === "exec" && typeof m.id === "string") runHere(m);
      else if (m.t === "want") { want = { items: (m.items || []).filter(isCopyItem), have: m.have || {} }; copyUp(); }
      else if (m.t === "skills" && typeof m.key === "string") { agentSkills = { key: m.key, google: m.google === true, linkedin: m.linkedin === true }; brain.refreshSkills?.(); }
      else if (m.t === "wantCookies") { cookieWant = { sites: (m.sites || []).filter(isValidDomain), have: m.have || {}, fresh: isValidDomain(m.fresh) ? m.fresh : undefined }; copyCookiesUp(); }
      else if (m.t === "logins" && link.cloud && m.items && typeof m.items === "object") {
        const wrote = writeLogins(opts.home || homedir(), m.items);
        if (wrote.length) log(`  got ${wrote.map((i) => COPY_ITEMS[i as CopyItem].label).join(" and ")} from the hub`);
      }
    };
    ws.onclose = (ev) => {
      if (agentSkills) { agentSkills = null; brain.refreshSkills?.(); } // that connection's key is dead now
      if (alive) clearInterval(alive);
      if (copyTimer) clearInterval(copyTimer);
      if (toolsTimer) clearInterval(toolsTimer);
      for (const c of runs.values()) c.abort();
      if (stopped) return;
      if (ev.code === 4001) return signedOut();
      if (opened) return retry(String(ev.code));
      // Refused before it opened: a revoked key, or the hub is just unreachable. Ask over plain HTTP to tell which.
      fetch(link.hub + "/computer", { headers: { Authorization: `Bearer ${link.token}` } })
        .then((r) => (r.status === 401 ? signedOut() : retry(`answered ${r.status}`)))
        .catch(() => retry("no answer"));
    };
    ws.onerror = () => {};
  };
  open();
  return () => { stopped = true; try { ws?.close(); } catch {} };
}
