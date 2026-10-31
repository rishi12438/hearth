import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Vault } from "./vault.ts";

// Cloud computers the hub sets up by itself: an E2B sandbox (paste an API key once, like the Deepgram key) or your own VM
// (its address and an SSH key). The hub mints the machine a computer key, runs a setup script on it that downloads Hearth
// from this hub, installs Bun and Claude Code, and starts the link. From then on it's an ordinary linked computer
// (computers.ts): online or not, picked for work, shown with its signal.

export type MachineKind = "e2b" | "ssh";
export type Machine = {
  id: string; kind: MachineKind; name: string; deviceId: string; createdAt: string;
  /** paused (e2b): its disk is kept, so Hearth, Claude Code and its login stay installed and it wakes in seconds. */
  state: "setting-up" | "running" | "paused" | "stopped" | "error"; step?: string; error?: string;
  /** e2b: the sandbox (live or paused); start on its own when a job needs a computer; pause after this many idle minutes. */
  sandboxId?: string; autoStart?: boolean; idleStopMin?: number; lastWorkAt?: number;
  /** ssh: where it is, and its host key as first seen (pinned: a different key later is refused). */
  host?: string; port?: number; user?: string; knownHosts?: string;
};

/** Runs one command on a machine. stdin carries secrets, so they never sit in argv or a log. */
export type Runner = { run(cmd: string, opts: { stdin?: string; timeoutMs: number; onLine?: (line: string) => void }): Promise<{ code: number; stderr: string }> };
export type E2bSandbox = { sandboxId: string; runner: Runner };
export type E2b = {
  create(apiKey: string, opts: { timeoutMs: number; metadata: Record<string, string> }): Promise<E2bSandbox>;
  /** Keep the disk, drop the memory: it costs next to nothing while paused. */
  pause(apiKey: string, sandboxId: string): Promise<void>;
  /** Wake a paused sandbox (it boots from its kept disk). Throws if E2B no longer has it. */
  resume(apiKey: string, sandboxId: string, timeoutMs: number): Promise<E2bSandbox>;
  kill(apiKey: string, sandboxId: string): Promise<void>;
  setTimeout(apiKey: string, sandboxId: string, timeoutMs: number): Promise<void>;
};
export type SshTarget = { host: string; port: number; user: string; privateKey: string; knownHosts?: string };
export type Ssh = { runner(t: SshTarget, pin: (knownHosts: string) => void): Runner };

const NAME_RE = /[^A-Za-z0-9 ._()-]/g;
const HOST_RE = /^[A-Za-z0-9.:-]{1,253}$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const SETUP_TIMEOUT_MS = 10 * 60_000;
export const E2B_API = "https://api.e2b.dev";

/** POSIX single-quoting for values put into a remote command. */
export const shq = (v: string) => `'${v.replaceAll("'", `'"'"'`)}'`;

/**
 * What runs on a new machine. The computer key arrives on stdin. Prints "@@step …" lines so the phone can show progress.
 * Safe to run again: it refreshes Hearth from the hub and restarts the link.
 */
export function setupScript(hub: string, deviceId: string, name: string) {
  return `set -eu
read -r TOKEN
HUB=${shq(hub)}; DEVICE=${shq(deviceId)}; NAME=${shq(name)}
H="$HOME/hearth"; mkdir -p "$H/data"; chmod 700 "$H/data"
step() { echo "@@step $*"; }
step "Downloading Hearth from your hub"
curl -fsS --max-time 120 -H "Authorization: Bearer $TOKEN" "$HUB/computer/bundle" | tar -xz -C "$H"
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
if ! command -v bun >/dev/null; then
  step "Installing Bun"
  command -v unzip >/dev/null || { sudo -n apt-get update -qq && sudo -n apt-get install -y -qq unzip; } >/dev/null 2>&1 || true
  curl -fsSL https://bun.sh/install | bash >/dev/null
fi
step "Installing Hearth's packages"
(cd "$H" && bun install --production >/dev/null)
if ! command -v claude >/dev/null; then step "Installing Claude Code"; curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1 || echo "Couldn't install Claude Code" >&2; fi
if ! command -v codex >/dev/null; then step "Installing Codex"; curl -fsSL https://chatgpt.com/codex/install.sh | sh >/dev/null 2>&1 || true; fi
umask 077
printf '{"hub":"%s","token":"%s","deviceId":"%s","name":"%s","cloud":true}\\n' "$HUB" "$TOKEN" "$DEVICE" "$NAME" > "$H/data/computer.json"
${START_LINK}
if [ -z "\${HEARTH_NO_CRON:-}" ]; then
  (crontab -l 2>/dev/null | grep -v hearth-computer; echo "@reboot cd $H && PATH=$PATH bun $H/src/cli.ts computer >> $H/computer.log 2>&1 # hearth-computer") | crontab - 2>/dev/null || true
fi
step "Linked"
`;
}

/** Start the link from what's already installed. Exits 3 if there's no install to start (then a full setup runs). */
const START_LINK = `H="$HOME/hearth"; export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
[ -f "$H/data/computer.json" ] && command -v bun >/dev/null || exit 3
echo "@@step Starting the link"
cd "$H"
# Only this install's link, found by its full path.
pkill -f "$H/src/cli.ts computer" 2>/dev/null || true
S=""; command -v setsid >/dev/null && S=setsid
nohup $S "$(command -v bun)" "$H/src/cli.ts" computer >> "$H/computer.log" 2>&1 < /dev/null &`;
const STOP_SCRIPT = `pkill -f "$HOME/hearth/src/cli.ts computer" 2>/dev/null || true; `
  + `if [ -z "\${HEARTH_NO_CRON:-}" ]; then (crontab -l 2>/dev/null | grep -v hearth-computer) | crontab - 2>/dev/null || true; fi`;

/** Is this E2B key real? null when it is, else a short reason (never the key). */
export async function checkE2bKey(key: string, api = E2B_API): Promise<string | null> {
  try {
    const r = await fetch(`${api}/sandboxes`, { headers: { "X-API-Key": key }, signal: AbortSignal.timeout(10_000) });
    if (r.status === 401 || r.status === 403) return "E2B didn't accept that key.";
    return r.ok ? null : `E2B answered ${r.status}.`;
  } catch { return "Couldn't reach E2B."; }
}

type Opts = {
  dataDir: string;
  /** This hub's public address, which the machine dials back to. */
  hubUrl: () => string | null;
  /** Mint a computer key for a new machine, and remove one. */
  addComputer: (name: string, machineId: string) => Promise<{ token: string; deviceId: string }>;
  removeComputer: (deviceId: string) => Promise<void>;
  /** Rotate a machine's key (each setup run gets a fresh one; the old stops working). */
  rekey: (deviceId: string) => Promise<string>;
  isOnline: (deviceId: string) => boolean;
  isBusy: (deviceId: string) => boolean;
  /** Where the E2B key and the VMs' SSH keys live, encrypted. */
  vault: Vault;
  e2b?: E2b; ssh?: Ssh; now?: () => number;
  /** Tests only: let a machine dial back to a hub on 127.0.0.1. */
  allowLocalHub?: boolean;
};

export class Machines {
  onChange: () => void = () => {};
  private busy = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private opts: Opts) { mkdirSync(join(opts.dataDir, "keys"), { recursive: true, mode: 0o700 }); }
  private now() { return this.opts.now ? this.opts.now() : Date.now(); }

  // ---- what's saved: the list (no secrets) in machines.json; the E2B key and each VM's SSH key in the encrypted vault ----

  private file() { return join(this.opts.dataDir, "machines.json"); }
  list(): Machine[] { try { return JSON.parse(readFileSync(this.file(), "utf8")); } catch { return []; } }
  get(id: string) { return this.list().find((m) => m.id === id) || null; }
  private save(list: Machine[]) { writeFileSync(this.file(), JSON.stringify(list, null, 2), { mode: 0o600 }); this.onChange(); }
  private patch(id: string, p: Partial<Machine>) {
    const list = this.list();
    const i = list.findIndex((m) => m.id === id);
    if (i < 0) return null;
    list[i] = { ...list[i], ...p };
    this.save(list);
    return list[i];
  }
  hasE2bKey() { return !!process.env.HEARTH_E2B_API_KEY || this.opts.vault.has("e2b"); }
  private e2bKey() { return process.env.HEARTH_E2B_API_KEY || this.opts.vault.get("e2b") || ""; }
  async setE2bKey(key: string, check = checkE2bKey) {
    const k = key.trim();
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(k)) return "That doesn't look like an E2B API key.";
    const bad = await check(k);
    if (bad) return bad;
    this.opts.vault.set("e2b", k);
    this.onChange();
    return null;
  }
  forgetE2bKey() {
    this.opts.vault.delete("e2b");
    this.onChange();
  }
  private sshKey(id: string) { return `ssh:${id}`; }

  // ---- adding ----

  async addE2b(input: { name?: unknown; autoStart?: unknown; idleStopMin?: unknown }) {
    if (!this.hasE2bKey()) return { error: "Add your E2B API key first." };
    const hubErr = this.hubCheck();
    if (hubErr) return { error: hubErr };
    const m = await this.create("e2b", input.name, "Cloud sandbox", {
      autoStart: input.autoStart !== false, idleStopMin: clamp(Number(input.idleStopMin) || 30, 5, 24 * 60),
    });
    void this.start(m.id);
    return { value: m };
  }

  async addSsh(input: { name?: unknown; host?: unknown; port?: unknown; user?: unknown; privateKey?: unknown }) {
    const host = String(input.host || "").trim(), user = String(input.user || "ubuntu").trim(), port = Number(input.port || 22);
    const privateKey = String(input.privateKey || "").trim();
    if (!HOST_RE.test(host)) return { error: "Enter the machine's IP address or host name." };
    if (!USER_RE.test(user)) return { error: "That user name doesn't look right." };
    if (!(port >= 1 && port <= 65535)) return { error: "The port should be a number like 22." };
    if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----$/.test(privateKey) || privateKey.length > 16_000) return { error: "Paste the whole private key, including the BEGIN and END lines." };
    const hubErr = this.hubCheck();
    if (hubErr) return { error: hubErr };
    if (!this.opts.ssh) return { error: "SSH isn't available on this hub." };
    // Reach it once before minting anything; this also pins its host key.
    let knownHosts = "";
    const probe = await this.opts.ssh.runner({ host, port, user, privateKey }, (k) => { knownHosts = k; }).run("true", { timeoutMs: 20_000 });
    if (probe.code !== 0) return { error: sshError(probe.stderr) };
    const m = await this.create("ssh", input.name, host, { host, port, user, knownHosts });
    this.opts.vault.set(this.sshKey(m.id), privateKey + "\n");
    void this.start(m.id);
    return { value: m };
  }

  private async create(kind: MachineKind, rawName: unknown, fallback: string, extra: Partial<Machine>) {
    const name = (String(rawName || "").replace(NAME_RE, "").trim() || fallback).slice(0, 40);
    const id = randomUUID();
    const { deviceId } = await this.opts.addComputer(name, id);
    const m: Machine = { id, kind, name, deviceId, createdAt: new Date(this.now()).toISOString(), state: "stopped", ...extra };
    this.save([...this.list(), m]);
    return m;
  }

  private hubCheck() {
    const u = this.opts.hubUrl();
    if (!u) return "Set HEARTH_PUBLIC_URL to this hub's https address, so the machine can reach it.";
    if (!this.opts.allowLocalHub && /\/\/(127\.|localhost|\[::1\])/.test(u)) return "This hub's address is only reachable on this machine; a cloud computer can't dial back to it.";
    return null;
  }

  // ---- running ----

  /** Set it up (again) and start the link. E2B: makes a fresh sandbox first. */
  async start(id: string) {
    const m = this.get(id);
    if (!m || this.busy.has(id)) return;
    this.busy.add(id);
    let sandboxId: string | undefined;
    try {
      this.patch(id, { state: "setting-up", step: "Starting", error: undefined });
      const hub = this.opts.hubUrl();
      if (!hub) throw new Error(this.hubCheck()!);
      let runner: Runner;
      if (m.kind === "e2b") {
        if (!this.opts.e2b) throw new Error("E2B isn't available on this hub.");
        const timeoutMs = ((m.idleStopMin || 30) + 10) * 60_000;
        // A paused sandbox still has everything installed: wake it and just start the link.
        if (m.state === "paused" && m.sandboxId) {
          this.patch(id, { step: "Waking the sandbox" });
          const woke = await this.opts.e2b.resume(this.e2bKey(), m.sandboxId, timeoutMs).catch(() => null);
          if (woke) {
            const quick = await woke.runner.run(`bash -c ${shq(START_LINK)}`, { timeoutMs: 60_000 });
            if (quick.code === 0) { this.patch(id, { state: "running", step: undefined, lastWorkAt: this.now() }); return; }
            sandboxId = woke.sandboxId; runner = woke.runner; // install missing: set it up in place
          }
        }
        if (!sandboxId!) {
          if (m.sandboxId) await this.opts.e2b.kill(this.e2bKey(), m.sandboxId).catch(() => {}); // gone or broken
          this.patch(id, { step: "Making a sandbox" });
          const box = await this.opts.e2b.create(this.e2bKey(), { timeoutMs, metadata: { hearth: id } });
          sandboxId = box.sandboxId; runner = box.runner;
        }
        this.patch(id, { sandboxId, lastWorkAt: this.now() });
      } else {
        runner = this.sshRunner(m);
      }
      const token = await this.opts.rekey(m.deviceId);
      const r = await runner!.run(`bash -c ${shq(setupScript(hub, m.deviceId, m.name))}`, {
        stdin: `${token}\n`, timeoutMs: SETUP_TIMEOUT_MS,
        onLine: (line) => { if (line.startsWith("@@step ")) this.patch(id, { step: line.slice(7).trim() }); },
      });
      if (r.code !== 0) throw new Error(lastLine(r.stderr) || `Setup stopped (exit ${r.code}).`);
      this.patch(id, { state: "running", step: undefined, lastWorkAt: this.now() });
    } catch (e: any) {
      if (sandboxId) await this.opts.e2b?.kill(this.e2bKey(), sandboxId).catch(() => {});
      this.patch(id, { state: "error", step: undefined, error: plainError(String(e?.message || e)), ...(sandboxId ? { sandboxId: undefined } : {}) });
    } finally { this.busy.delete(id); }
  }

  /** E2B: paused, so its disk (and everything installed) is kept but it stops costing compute. SSH: the link stops. */
  async stop(id: string) {
    const m = this.get(id);
    if (!m) return;
    if (m.kind === "e2b" && m.sandboxId) {
      const ok = await this.opts.e2b?.pause(this.e2bKey(), m.sandboxId).then(() => true).catch(() => false);
      if (ok) { this.patch(id, { state: "paused", step: undefined }); return; }
      await this.opts.e2b?.kill(this.e2bKey(), m.sandboxId).catch(() => {}); // couldn't pause: don't leave it running
    }
    if (m.kind === "ssh") await this.sshRunner(m).run(STOP_SCRIPT, { timeoutMs: 20_000 }).catch(() => {});
    this.patch(id, { state: "stopped", sandboxId: undefined, step: undefined });
  }

  /** Gone for good: E2B deletes the sandbox and its disk. */
  private async destroy(m: Machine) {
    if (m.kind === "e2b" && m.sandboxId) await this.opts.e2b?.kill(this.e2bKey(), m.sandboxId).catch(() => {});
    else await this.stop(m.id);
  }

  async remove(id: string) {
    const m = this.get(id);
    if (!m) return false;
    await this.destroy(m);
    this.opts.vault.delete(this.sshKey(id));
    this.save(this.list().filter((x) => x.id !== id));
    await this.opts.removeComputer(m.deviceId);
    return true;
  }

  /** The device behind a machine was unlinked some other way: forget the machine too. */
  async deviceRemoved(deviceId: string) {
    const m = this.list().find((x) => x.deviceId === deviceId);
    if (!m) return;
    await this.destroy(m);
    this.opts.vault.delete(this.sshKey(m.id));
    this.save(this.list().filter((x) => x.id !== m.id));
  }

  /** A job needs a computer and none is online: wake a sandbox that's allowed to start on its own. */
  async wake() {
    const m = this.list().find((x) => x.kind === "e2b" && x.autoStart && ["paused", "stopped", "error"].includes(x.state) && !this.busy.has(x.id));
    if (m && this.hasE2bKey()) await this.start(m.id);
    return !!m;
  }

  startTimer() { this.timer ??= setInterval(() => this.tick().catch(() => {}), 60_000); }
  stopTimer() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** Once a minute: sandboxes doing work stay up; idle ones past their limit are paused so they stop costing. */
  async tick() {
    for (const m of this.list()) {
      if (m.kind !== "e2b" || m.state !== "running" || !m.sandboxId) continue;
      if (this.opts.isBusy(m.deviceId)) { this.patch(m.id, { lastWorkAt: this.now() }); }
      const idleMs = this.now() - (this.get(m.id)?.lastWorkAt || 0);
      const limit = (m.idleStopMin || 30) * 60_000;
      if (idleMs > limit) { await this.stop(m.id); continue; }
      // Keep E2B's own clock ahead of ours, so the sandbox lives until we decide it's idle.
      await this.opts.e2b?.setTimeout(this.e2bKey(), m.sandboxId, limit - idleMs + 10 * 60_000).catch(() => {});
    }
  }

  /** For the app: no secrets, plus whether it's online right now. */
  view(m: Machine) {
    const { knownHosts, ...rest } = m;
    return { ...rest, online: this.opts.isOnline(m.deviceId) };
  }

  private sshRunner(m: Machine): Runner {
    if (!this.opts.ssh) throw new Error("SSH isn't available on this hub.");
    const privateKey = this.opts.vault.get(this.sshKey(m.id));
    if (!privateKey) throw new Error("This machine's SSH key is missing. Remove it and add it again.");
    return this.opts.ssh.runner(
      { host: m.host!, port: m.port || 22, user: m.user || "ubuntu", privateKey, knownHosts: m.knownHosts },
      () => {},
    );
  }
}

/** E2B and the network speak in long messages; say what to do instead. */
export function plainError(msg: string) {
  if (/unauthori[sz]ed|invalid api key|401/i.test(msg)) return "E2B didn't accept the API key. Disconnect E2B and connect it again with a fresh key.";
  if (/rate limit|429|concurrent|limit reached/i.test(msg)) return "Your E2B plan is at its limit of running sandboxes. Stop one, or try again in a bit.";
  if (/ENOTFOUND|ECONNREFUSED|fetch failed|network/i.test(msg)) return "Couldn't reach E2B from this hub. Check the hub's internet connection.";
  return msg.slice(0, 300);
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));
const lastLine = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean).pop()?.slice(0, 300) || "";

function sshError(stderr: string) {
  if (/Permission denied/i.test(stderr)) return "The machine refused that key. Check the user name, and that the key's public half is in ~/.ssh/authorized_keys.";
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) return "The machine's identity changed since it was first added. If you rebuilt it, remove and add it again.";
  if (/Could not resolve|Connection refused|timed out|No route to host|Network is unreachable/i.test(stderr)) return "Couldn't reach the machine over SSH. Check the address, and that port 22 is open to this hub.";
  return `SSH failed: ${lastLine(stderr) || "no answer"}`;
}

// ---- the real drivers ----

/** ssh with the key and known_hosts in a private temp folder that lives only for the call. Host key pinned after first use. */
export const realSsh: Ssh = {
  runner(t, pin) {
    return {
      async run(cmd, opts) {
        const dir = mkdtempSync(join(tmpdir(), "hearth-ssh-"));
        try {
          const key = join(dir, "key"), known = join(dir, "known_hosts");
          writeFileSync(key, t.privateKey.endsWith("\n") ? t.privateKey : `${t.privateKey}\n`, { mode: 0o600 });
          writeFileSync(known, t.knownHosts ? `${t.knownHosts}\n` : "", { mode: 0o600 });
          const proc = Bun.spawn(["ssh", "-i", key, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none",
            "-o", `UserKnownHostsFile=${known}`, "-o", "GlobalKnownHostsFile=/dev/null",
            "-o", `StrictHostKeyChecking=${t.knownHosts ? "yes" : "accept-new"}`, "-o", "ConnectTimeout=10",
            "-p", String(t.port), `${t.user}@${t.host}`, cmd],
            { stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore", stdout: "pipe", stderr: "pipe" });
          const timer = setTimeout(() => proc.kill(), opts.timeoutMs);
          const lines = readLines(proc.stdout, opts.onLine);
          const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text(), lines]);
          clearTimeout(timer);
          if (!t.knownHosts) { const k = readFileSync(known, "utf8").trim(); if (k) pin(k); }
          return { code, stderr };
        } finally { rmSync(dir, { recursive: true, force: true }); }
      },
    };
  },
};

/** The official e2b SDK, loaded on first use. Commands run as the sandbox's normal user. */
export const realE2b: E2b = {
  async create(apiKey, opts) {
    const { Sandbox } = await import("e2b");
    // If the hub ever misses its idle check, E2B pauses (keeping the disk) instead of deleting.
    const sb: any = await Sandbox.create("base", { apiKey, timeoutMs: opts.timeoutMs, metadata: opts.metadata,
      lifecycle: { onTimeout: { action: "pause", mode: "filesystem" }, autoResume: false } });
    return e2bHandle(sb);
  },
  async pause(apiKey, sandboxId) { const { Sandbox } = await import("e2b"); await Sandbox.pause(sandboxId, { apiKey, mode: "filesystem" }); },
  async resume(apiKey, sandboxId, timeoutMs) { const { Sandbox } = await import("e2b"); return e2bHandle(await Sandbox.connect(sandboxId, { apiKey, timeoutMs })); },
  async kill(apiKey, sandboxId) { const { Sandbox } = await import("e2b"); await Sandbox.kill(sandboxId, { apiKey }); },
  async setTimeout(apiKey, sandboxId, ms) { const { Sandbox } = await import("e2b"); await Sandbox.setTimeout(sandboxId, ms, { apiKey }); },
};

/** Commands run as the sandbox's normal user; "@@step" lines come back as they're printed. */
function e2bHandle(sb: any): E2bSandbox {
    return {
      sandboxId: sb.sandboxId,
      runner: {
        async run(cmd, o) {
          let buf = "";
          const h = await sb.commands.run(cmd, {
            background: true, stdin: o.stdin !== undefined, user: "user", timeoutMs: o.timeoutMs,
            onStdout: (d: string) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { o.onLine?.(buf.slice(0, i)); buf = buf.slice(i + 1); } },
          });
          if (o.stdin !== undefined) { await h.sendStdin(o.stdin); try { await h.closeStdin(); } catch {} }
          try { const r = await h.wait(); return { code: r.exitCode, stderr: r.stderr || "" }; }
          catch (e: any) { if (typeof e?.exitCode === "number") return { code: e.exitCode, stderr: String(e.stderr || "") }; throw e; }
        },
      },
    };
}

async function readLines(stream: ReadableStream<Uint8Array>, onLine?: (l: string) => void) {
  const dec = new TextDecoder();
  let buf = "";
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { onLine?.(buf.slice(0, i)); buf = buf.slice(i + 1); }
  }
}
