import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname, platform } from "node:os";
import { dirname, join } from "node:path";
import { sha256 } from "./auth.ts";
import { Brain, availableHarnesses, type BrainProfile } from "./brain.ts";
import { ALIVE_EVERY_MS, COPY_ITEMS, isCopyItem, type CopyItem } from "./computers.ts";
import type { Config } from "./config.ts";

// The computer side of a link (run on your Mac): join a hub once, then keep a line open to it and run the work it sends,
// with this computer's own Claude/Codex login. The hub never gets a shell here: it can only ask for a brain call, which
// runs with the same slim, web-only tool set as on the hub, and for the login files you chose to copy.

/** cloud: the hub set this machine up (a sandbox or your VM) and may hand it logins. Your Mac's link never has it. */
export type Link = { hub: string; token: string; deviceId: string; name: string; cloud?: boolean };
const linkFile = (dataDir: string) => join(dataDir, "computer.json");

export function readLink(dataDir: string): Link | null {
  try { return JSON.parse(readFileSync(linkFile(dataDir), "utf8")); } catch { return null; }
}

/** Ask the hub to let this computer in. Your primary phone approves it, like any new device. */
export async function joinHub(hubUrl: string, dataDir: string, name = computerName(), log = console.log) {
  const hub = new URL(hubUrl).origin;
  const res = await fetch(`${hub}/api/access/request`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceName: name, kind: "computer" }) });
  const r: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(r.error || `The hub answered ${res.status}`);
  log(`\n  On your primary phone, approve "${name}". It shows the code  ${r.code}  — only approve if it matches.\n  Waiting…`);
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
      log(`  Linked to ${hub}. Start it with:  bun run computer\n`);
      return link;
    }
  }
  throw new Error("Nobody approved it in 10 minutes. Run join again.");
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

type Opts = { config: Config; link: Link; brain?: Brain; readCopy?: (item: CopyItem) => string | null; log?: (s: string) => void; copyEveryMs?: number; home?: string;
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
  let stopped = false, backoff = 1000, alive: ReturnType<typeof setInterval> | null = null, copyTimer: ReturnType<typeof setInterval> | null = null;
  let want: { items: CopyItem[]; have: Record<string, string> } = { items: [], have: {} };
  const send = (m: unknown) => { try { ws?.send(JSON.stringify(m)); } catch {} };
  const url = link.hub.replace(/^http/, "ws") + "/computer";

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

  const run = async (m: any) => {
    const ctl = new AbortController();
    runs.set(m.id, ctl);
    try {
      const profile: BrainProfile = { harness: String(m.profile?.harness || ""), model: String(m.profile?.model || "") };
      if (!availableHarnesses(config).includes(profile.harness)) throw new Error(`${profile.harness} isn't installed on ${link.name}.`);
      const meter = { costUsd: 0, unknown: false, signal: ctl.signal, onProgress: (text: string) => send({ t: "step", id: m.id, text }) };
      const reply = await brain.think(m.input, profile, meter);
      send({ t: "done", id: m.id, reply, costUsd: meter.unknown ? undefined : meter.costUsd });
    } catch (e: any) {
      send({ t: "error", id: m.id, message: e?.message || String(e) });
    } finally { runs.delete(m.id); }
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
      send({ t: "hello", harnesses: availableHarnesses(config), platform: platform() });
      alive = setInterval(() => send({ t: "alive" }), ALIVE_EVERY_MS);
      copyTimer = setInterval(copyUp, opts.copyEveryMs ?? 5 * 60_000);
    };
    ws.onmessage = (ev) => {
      let m: any;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.t === "ping") send({ t: "pong", ts: m.ts });
      else if (m.t === "run" && typeof m.id === "string") run(m);
      else if (m.t === "stop") runs.get(m.id)?.abort();
      else if (m.t === "want") { want = { items: (m.items || []).filter(isCopyItem), have: m.have || {} }; copyUp(); }
      else if (m.t === "logins" && link.cloud && m.items && typeof m.items === "object") {
        const wrote = writeLogins(opts.home || homedir(), m.items);
        if (wrote.length) log(`  got ${wrote.map((i) => COPY_ITEMS[i as CopyItem].label).join(" and ")} from the hub`);
      }
    };
    ws.onclose = (ev) => {
      if (alive) clearInterval(alive);
      if (copyTimer) clearInterval(copyTimer);
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
