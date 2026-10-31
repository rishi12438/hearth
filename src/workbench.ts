import { randomBytes, randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, writeFileSync, writeSync, readSync } from "node:fs";
import { join, posix } from "node:path";
import type { Store } from "./store/index.ts";
import type { Files } from "./files.ts";
import type { Vault } from "./vault.ts";
import type { StoredFile, WorkSession, WorkSettings } from "./types.ts";

// The workbench: the one place the team's code runs. Teammates think on this hub; when they need to run
// something they use a few tools (run, write_file, read_file, copy_in, copy_out) and the hub carries that out here.
// It's E2B if you connected it, else a locked-down Docker container on this hub (Settings → Your hub & devices).
//
// Folders: /work/<teammate> is each teammate's own and stays between jobs; /work/shared is for everyone. Nothing secret
// ever goes onto the workbench, and every job's time on it is written down (sessions), so anyone can see what happened
// and carry on.

export const DEFAULT_WORK: WorkSettings = { workbench: "auto" };

export type RunResult = { code: number; stdout: string; stderr: string };
/** One kind of workbench. Paths are absolute inside it. */
export interface Bench {
  readonly kind: "docker" | "e2b" | "plain";
  readonly root: string;
  label(): string;
  ensure(): Promise<void>;
  run(cmd: string, cwd: string, timeoutMs: number): Promise<RunResult>;
  write(path: string, data: Uint8Array): Promise<void>;
  /** null if there's no such file. */
  read(path: string, max: number): Promise<Uint8Array | null>;
  /** Called once a minute; pause or stop if it's been idle too long. */
  idle?(idleMs: number): Promise<void>;
}

const MAX_TOOL_OUT = 8_000;
const MAX_LOG_OUT = 800;
const MAX_WRITE = 2_000_000;
const MAX_FILE = 15 * 1024 * 1024;
const TOKEN_TTL_MS = 30 * 60_000;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "team";
const trim = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);

// ---------------------------------------------------------------- Docker on this hub

type Exec = (args: string[], opts?: { stdin?: Uint8Array; timeoutMs?: number }) => Promise<{ code: number; stdout: Uint8Array; stderr: string }>;
export const dockerExec: Exec = async (args, opts = {}) => {
  const p = Bun.spawn(["docker", ...args], { stdin: opts.stdin ?? "ignore", stdout: "pipe", stderr: "pipe" });
  const timer = opts.timeoutMs ? setTimeout(() => p.kill(), opts.timeoutMs) : null;
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited]);
  if (timer) clearTimeout(timer);
  return { code, stdout: new Uint8Array(stdout), stderr };
};
export function dockerAvailable() {
  if (!Bun.which("docker")) return false;
  return Bun.spawnSync(["docker", "info", "--format", "{{.ServerVersion}}"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

/**
 * A container that can only see its own volume (/work): not the hub's data, keys or files. No root, no extra
 * privileges, capped memory, CPU and processes. Internet works (for pip install); on a server, deploy/setup.sh also
 * blocks it from the hub's own ports and the cloud's metadata address.
 */
export class DockerBench implements Bench {
  readonly kind = "docker" as const;
  readonly root = "/work";
  constructor(private o: { name?: string; volume?: string; image?: string; memory?: string; cpus?: string; exec?: Exec } = {}) {}
  private get name() { return this.o.name || "hearth-workbench"; }
  private get exec() { return this.o.exec || dockerExec; }
  label() { return "Docker on this hub"; }

  async ensure() {
    const st = await this.exec(["inspect", "-f", "{{.State.Running}}", this.name]);
    if (st.code === 0 && new TextDecoder().decode(st.stdout).trim() === "true") return;
    if (st.code === 0) { await this.must(["start", this.name]); return; }
    const image = this.o.image || "python:3.12-slim", volume = this.o.volume || "hearth-work";
    // A fresh volume belongs to root; hand it to the unprivileged user the work runs as. It must not stay empty, or Docker
    // copies the image's own /work over it on first use and the folder goes back to root.
    await this.must(["run", "--rm", "-v", `${volume}:/work`, image, "sh", "-c", "mkdir -p /work/.home /work/shared && chown -R 1000:1000 /work"], 300_000);
    await this.must(["run", "-d", "--name", this.name, "--restart", "unless-stopped",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "512",
      "--memory", this.o.memory || "1g", "--cpus", this.o.cpus || "1", "--user", "1000:1000",
      "-e", "HOME=/work/.home", "-e", "PATH=/work/.home/.local/bin:/usr/local/bin:/usr/bin:/bin",
      "-v", `${volume}:/work`, "-w", "/work", image, "sleep", "infinity"], 300_000);
  }
  private async must(args: string[], timeoutMs = 60_000) {
    const r = await this.exec(args, { timeoutMs });
    if (r.code !== 0) throw new Error(`docker ${args[0]}: ${r.stderr.trim().split("\n").pop() || `exit ${r.code}`}`);
  }

  async run(cmd: string, cwd: string, timeoutMs: number): Promise<RunResult> {
    const secs = Math.max(1, Math.round(timeoutMs / 1000));
    const r = await this.exec(["exec", "-w", cwd, this.name, "timeout", "-k", "5", String(secs), "bash", "-lc", cmd], { timeoutMs: timeoutMs + 15_000 });
    return { code: r.code, stdout: new TextDecoder().decode(r.stdout), stderr: r.stderr };
  }
  async write(path: string, data: Uint8Array) {
    const r = await this.exec(["exec", "-i", this.name, "sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "sh", path], { stdin: data, timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || "Couldn't write the file.");
  }
  async read(path: string, max: number) {
    const r = await this.exec(["exec", this.name, "sh", "-c", 'test -f "$1" && head -c "$2" "$1"', "sh", path, String(max)], { timeoutMs: 60_000 });
    return r.code === 0 ? r.stdout : null;
  }
}

// ---------------------------------------------------------------- plain: straight on this machine (you chose it)

/**
 * No container: commands run as the hub's own user in <data>/workbench. Simple and fast, but the code can read anything
 * that user can, including the hub's data and keys. Only used when you pick it. The tools still keep to the folder, and
 * the command gets a bare environment with none of the hub's settings.
 */
export class PlainBench implements Bench {
  readonly kind = "plain" as const;
  readonly root: string;
  constructor(dataDir: string) {
    mkdirSync(join(dataDir, "workbench"), { recursive: true, mode: 0o700 });
    this.root = realpathSync(join(dataDir, "workbench"));
  }
  label() { return "Plain, on this hub (no container)"; }
  async ensure() { mkdirSync(join(this.root, "shared"), { recursive: true, mode: 0o700 }); }
  async run(cmd: string, cwd: string, timeoutMs: number): Promise<RunResult> {
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const env: Record<string, string> = { PATH: process.env.PATH || "/usr/bin:/bin", HOME: join(this.root, ".home"), LANG: "C.UTF-8" };
    const p = Bun.spawn(["bash", "-lc", cmd], { cwd: this.inside(cwd), env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(timer);
    return { code, stdout, stderr };
  }
  /** Resolves symlinks, so a link the code made can't point the tools outside the folder. */
  private inside(path: string) {
    let dir = path;
    while (!existsSync(dir)) dir = posix.dirname(dir);
    const real = posix.join(realpathSync(dir), posix.relative(dir, path));
    if (real !== this.root && !real.startsWith(this.root + "/")) throw new Error("That path leads outside the workbench.");
    return real;
  }
  async write(path: string, data: Uint8Array) {
    const p = this.inside(path);
    mkdirSync(posix.dirname(p), { recursive: true, mode: 0o700 });
    const fd = openSync(p, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, data); } finally { closeSync(fd); }
  }
  async read(path: string, max: number) {
    let p: string;
    try { p = this.inside(path); } catch { return null; }
    if (!existsSync(p) || !statSync(p).isFile()) return null;
    const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const buf = Buffer.alloc(Math.min(max, statSync(p).size)); const n = readSync(fd, buf, 0, buf.length, 0); return new Uint8Array(buf.subarray(0, n)); }
    finally { closeSync(fd); }
  }
}

// ---------------------------------------------------------------- one shared E2B sandbox

/** The bits of the e2b SDK this uses, so tests can stand in for it. */
export type E2bSdk = {
  create(apiKey: string, timeoutMs: number): Promise<E2bBox>;
  connect(apiKey: string, id: string, timeoutMs: number): Promise<E2bBox>;
  pause(apiKey: string, id: string): Promise<void>;
};
export type E2bBox = {
  sandboxId: string;
  run(cmd: string, cwd: string, timeoutMs: number): Promise<RunResult>;
  write(path: string, data: Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array | null>;
};

export const realE2bSdk: E2bSdk = {
  async create(apiKey, timeoutMs) {
    const { Sandbox } = await import("e2b");
    return box(await Sandbox.create("base", { apiKey, timeoutMs, lifecycle: { onTimeout: { action: "pause", mode: "filesystem" }, autoResume: false } }));
  },
  async connect(apiKey, id, timeoutMs) { const { Sandbox } = await import("e2b"); return box(await Sandbox.connect(id, { apiKey, timeoutMs })); },
  async pause(apiKey, id) { const { Sandbox } = await import("e2b"); await Sandbox.pause(id, { apiKey, mode: "filesystem" }); },
};
function box(sb: any): E2bBox {
  return {
    sandboxId: sb.sandboxId,
    async run(cmd, cwd, timeoutMs) {
      try { const r = await sb.commands.run(cmd, { cwd, timeoutMs, user: "user" }); return { code: r.exitCode, stdout: r.stdout || "", stderr: r.stderr || "" }; }
      catch (e: any) { if (typeof e?.exitCode === "number") return { code: e.exitCode, stdout: e.stdout || "", stderr: e.stderr || "" }; throw e; }
    },
    async write(path, data) { await sb.files.write(path, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), { user: "user" }); },
    async read(path) { try { return new Uint8Array(await sb.files.read(path, { format: "bytes", user: "user" })); } catch { return null; } },
  };
}

/** One sandbox the whole team shares. Paused (disk kept) when idle, woken when a job needs it. */
export class E2bBench implements Bench {
  readonly kind = "e2b" as const;
  readonly root = "/home/user/work";
  private live: E2bBox | null = null;
  constructor(private o: { dataDir: string; apiKey: () => string; sdk?: E2bSdk; idlePauseMin?: number }) {}
  private get sdk() { return this.o.sdk || realE2bSdk; }
  private file() { return join(this.o.dataDir, "workbench-e2b.json"); }
  private saved(): { sandboxId?: string } { try { return JSON.parse(readFileSync(this.file(), "utf8")); } catch { return {}; } }
  label() { const id = this.live?.sandboxId || this.saved().sandboxId; return id ? `E2B sandbox ${id.slice(0, 8)}` : "E2B sandbox"; }

  async ensure() {
    if (this.live) return;
    const key = this.o.apiKey();
    if (!key) throw new Error("E2B isn't connected.");
    const timeoutMs = ((this.o.idlePauseMin || 15) + 10) * 60_000;
    const id = this.saved().sandboxId;
    if (id) this.live = await this.sdk.connect(key, id, timeoutMs).catch(() => null);
    if (!this.live) {
      this.live = await this.sdk.create(key, timeoutMs);
      writeFileSync(this.file(), JSON.stringify({ sandboxId: this.live.sandboxId }), { mode: 0o600 });
    }
    await this.live.run(`mkdir -p ${this.root}/shared`, "/home/user", 30_000);
  }
  async run(cmd: string, cwd: string, timeoutMs: number) { await this.ensure(); return this.live!.run(cmd, cwd, timeoutMs); }
  async write(path: string, data: Uint8Array) { await this.ensure(); await this.live!.write(path, data); }
  async read(path: string, max: number) { await this.ensure(); const b = await this.live!.read(path); return b ? b.slice(0, max) : null; }
  async idle(idleMs: number) {
    if (!this.live || idleMs < (this.o.idlePauseMin || 15) * 60_000) return;
    const id = this.live.sandboxId;
    this.live = null;
    await this.sdk.pause(this.o.apiKey(), id).catch(() => {});
  }
}

// ---------------------------------------------------------------- the manager: which bench, tools, sessions

const E2B_API = "https://api.e2b.dev";

/** Is this E2B key real? null when it is, else a short reason (never the key). */
export async function checkE2bKey(key: string, api = E2B_API): Promise<string | null> {
  try {
    const r = await fetch(`${api}/sandboxes`, { headers: { "X-API-Key": key }, signal: AbortSignal.timeout(10_000) });
    if (r.status === 401 || r.status === 403) return "E2B didn't accept that key.";
    return r.ok ? null : `E2B answered ${r.status}.`;
  } catch { return "Couldn't reach E2B."; }
}

type Grant = { sessionId: string; folder: string; threadId?: string; jobId?: string; teammateId?: string; exp: number };
type Opts = {
  store: Store; files: Files; dataDir: string; vault: Vault;
  settings: () => Promise<WorkSettings>;
  docker?: () => boolean; dockerBench?: Bench; e2bSdk?: E2bSdk; now?: () => number;
  checkE2b?: (key: string) => Promise<string | null>;
};

export const TOOLS = [
  { name: "run", description: "Run a shell command on the workbench, in your folder. Use it for code, pip install, conversions. Returns the output.",
    inputSchema: { type: "object", properties: { command: { type: "string" }, timeout_seconds: { type: "number", description: "Default 120, max 1800" } }, required: ["command"] } },
  { name: "write_file", description: "Write a text file in your folder on the workbench (code, data, notes). Paths are relative to your folder; ../shared/ is shared with your team.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "read_file", description: "Read a text file from the workbench.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "copy_in", description: "Copy a file the user attached (or one made earlier in this chat) from the hub onto the workbench, into your folder.",
    inputSchema: { type: "object", properties: { file: { type: "string", description: "Its name or id" } }, required: ["file"] } },
  { name: "copy_out", description: "Bring a finished file from the workbench back to the hub. It shows up in the chat for the user.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, name: { type: "string", description: "Name to show (optional)" } }, required: ["path"] } },
] as const;

export class Workbench {
  private grants = new Map<string, Grant>();
  private docker: Bench | null = null;
  private plain: PlainBench | null = null;
  private e2b: E2bBench | null = null;
  private lastUse = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private o: Opts) {}
  private now() { return this.o.now ? this.o.now() : Date.now(); }

  /** The bench your setting picks right now, or null (off, or nothing available). */
  async pick(): Promise<Bench | null> {
    const s = await this.o.settings();
    const hasE2b = !!this.e2bKey();
    const hasDocker = this.o.dockerBench ? true : (this.o.docker ?? dockerAvailable)();
    // "auto" never falls back to plain: running code without a container is only ever your explicit choice.
    const want = s.workbench === "off" ? null : s.workbench === "plain" ? "plain" : s.workbench === "e2b" ? (hasE2b ? "e2b" : null)
      : s.workbench === "docker" ? (hasDocker ? "docker" : null) : hasE2b ? "e2b" : hasDocker ? "docker" : null;
    if (want === "plain") return (this.plain ??= new PlainBench(this.o.dataDir));
    if (want === "e2b") return (this.e2b ??= new E2bBench({ dataDir: this.o.dataDir, apiKey: () => this.e2bKey(), sdk: this.o.e2bSdk }));
    if (want === "docker") return (this.docker ??= this.o.dockerBench || new DockerBench());
    return null;
  }
  private e2bKey() { return process.env.HEARTH_E2B_API_KEY || this.o.vault.get("e2b") || ""; }
  /** Connect E2B: the key is checked with E2B, then kept in the vault. Returns a reason when it's no good. */
  async setE2bKey(key: string) {
    const k = key.trim();
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(k)) return "That doesn't look like an E2B API key.";
    const bad = await (this.o.checkE2b ?? checkE2bKey)(k);
    if (bad) return bad;
    this.o.vault.set("e2b", k);
    return null;
  }
  forgetE2bKey() { this.o.vault.delete("e2b"); this.e2b = null; }

  async status() {
    const s = await this.o.settings();
    const b = await this.pick();
    return { settings: s, workbench: b ? { kind: b.kind, label: b.label() } : null, e2b: !!this.e2bKey(), docker: this.o.dockerBench ? true : (this.o.docker ?? dockerAvailable)() };
  }

  /** A job starts: a short-lived key for its tools, scoped to that job and the teammate's folder. */
  async open(job: { jobId?: string; threadId?: string; teammateId?: string; teammateName?: string; task?: string }) {
    const bench = await this.pick();
    if (!bench) return null;
    const token = randomBytes(24).toString("base64url");
    const folder = posix.join(bench.root, slug(job.teammateName || job.teammateId || "team"));
    const s = await this.o.store.put<WorkSession>("sessions", {
      id: randomUUID(), createdAt: new Date(this.now()).toISOString(), jobId: job.jobId, threadId: job.threadId, teammateId: job.teammateId,
      task: job.task?.slice(0, 300), machine: bench.kind === "e2b" ? `e2b:${bench.label()}` : bench.kind, folder, status: "working", steps: [], installed: [], fileIds: [],
    });
    this.grants.set(token, { sessionId: s.id, folder, threadId: job.threadId, jobId: job.jobId, teammateId: job.teammateId, exp: this.now() + TOKEN_TTL_MS });
    return { token, sessionId: s.id };
  }

  /** The job ended: its key stops working, and the session is closed. Returns files it brought back. */
  async close(token: string, ok: boolean) {
    const g = this.grants.get(token);
    this.grants.delete(token);
    if (!g) return [];
    await this.logQueue.get(g.sessionId);
    this.logQueue.delete(g.sessionId);
    const s = await this.o.store.get<WorkSession>("sessions", g.sessionId);
    if (!s) return [];
    await this.o.store.put<WorkSession>("sessions", { ...s, status: s.steps.length && !ok ? "failed" : "done", endedAt: new Date(this.now()).toISOString() });
    return s.fileIds;
  }

  /** A tool call from a job's agent (via tools-mcp.ts). The key decides which job and folder; nothing else is reachable. */
  async tool(token: string, name: string, args: any): Promise<{ ok: boolean; text: string }> {
    const g = this.grants.get(token);
    if (!g || g.exp < this.now()) return { ok: false, text: "This job's workbench access has ended." };
    g.exp = this.now() + TOKEN_TTL_MS;
    const bench = await this.pick();
    if (!bench) return { ok: false, text: "No workbench right now (Settings → Your hub & devices)." };
    const started = this.now();
    this.lastUse = started;
    let r: { ok: boolean; text: string; what: string; fileId?: string };
    try {
      await bench.ensure();
      await bench.run(`mkdir -p ${JSON.stringify(g.folder)} ${JSON.stringify(posix.join(bench.root, "shared"))}`, bench.root, 30_000);
      r = await this.do(bench, g, name, args || {});
    } catch (e: any) { r = { ok: false, text: String(e?.message || e).slice(0, 500), what: name }; }
    await this.log(g, name, r, this.now() - started, name === "run" ? String(args?.command || "") : "");
    return { ok: r.ok, text: r.text };
  }

  private path(bench: Bench, g: Grant, raw: unknown) {
    const p = String(raw || "").trim();
    if (!p || p.includes("\0")) throw new Error("Give a file path.");
    const full = posix.normalize(posix.isAbsolute(p) ? p : posix.join(g.folder, p));
    if (full !== bench.root && !full.startsWith(bench.root + "/")) throw new Error(`Stay inside ${bench.root}.`);
    return full;
  }

  private async do(bench: Bench, g: Grant, name: string, a: any): Promise<{ ok: boolean; text: string; what: string; fileId?: string }> {
    switch (name) {
      case "run": {
        const cmd = String(a.command || "");
        if (!cmd.trim()) return { ok: false, text: "Give a command.", what: "run" };
        const t = Math.min(1800, Math.max(1, Number(a.timeout_seconds) || 120)) * 1000;
        const out = await bench.run(cmd, g.folder, t);
        const text = [out.stdout && `stdout:\n${out.stdout}`, out.stderr && `stderr:\n${out.stderr}`, `exit code ${out.code}`].filter(Boolean).join("\n");
        return { ok: out.code === 0, text: trim(text, MAX_TOOL_OUT), what: cmd.slice(0, 300) };
      }
      case "write_file": {
        const path = this.path(bench, g, a.path);
        const data = new TextEncoder().encode(String(a.content ?? ""));
        if (data.length > MAX_WRITE) return { ok: false, text: "That's over 2 MB; build it with code on the workbench instead.", what: path };
        await bench.write(path, data);
        return { ok: true, text: `Wrote ${path} (${data.length} bytes).`, what: path };
      }
      case "read_file": {
        const path = this.path(bench, g, a.path);
        const b = await bench.read(path, MAX_TOOL_OUT * 4);
        if (!b) return { ok: false, text: `No file at ${path}.`, what: path };
        if (b.includes(0)) return { ok: true, text: `${path} is a binary file. Use copy_out to give it to the user.`, what: path };
        return { ok: true, text: trim(new TextDecoder().decode(b), MAX_TOOL_OUT), what: path };
      }
      case "copy_in": {
        const f = await this.hubFile(g, String(a.file || ""));
        if (!f) return { ok: false, text: "No file with that name in this chat.", what: String(a.file) };
        const bytes = this.o.files.bytes(f.id);
        if (!bytes) return { ok: false, text: "That file is missing on the hub.", what: f.name };
        const dest = posix.join(g.folder, f.name);
        await bench.write(dest, new Uint8Array(bytes));
        return { ok: true, text: `Copied ${f.name} to ${dest}.`, what: f.name };
      }
      case "copy_out": {
        const path = this.path(bench, g, a.path);
        const b = await bench.read(path, MAX_FILE + 1);
        if (!b) return { ok: false, text: `No file at ${path}.`, what: path };
        if (b.length > MAX_FILE) return { ok: false, text: "That file is over 15 MB.", what: path };
        const r = await this.o.files.save(b, { name: String(a.name || posix.basename(path)), source: "teammate", threadId: g.threadId, jobId: g.jobId, teammateId: g.teammateId });
        if (!r.value) return { ok: false, text: r.error || "Couldn't save it.", what: path };
        return { ok: true, text: `Saved ${r.value.name} to the chat.`, what: path, fileId: r.value.id };
      }
    }
    return { ok: false, text: `No tool called ${name}.`, what: name };
  }

  /** Files from this chat (attached by the user, or made in it), by id or name. */
  private async hubFile(g: Grant, key: string) {
    const all = (await this.o.store.all<StoredFile>("files")).filter((f) => (g.threadId && f.threadId === g.threadId) || (g.jobId && f.jobId === g.jobId));
    return all.find((f) => f.id === key) || all.filter((f) => f.name === key).pop() || null;
  }

  /** Tool calls can run at the same time (the agent may call several at once); their log entries go in one at a time. */
  private logQueue = new Map<string, Promise<void>>();
  private log(g: Grant, tool: string, r: { ok: boolean; text: string; what: string; fileId?: string }, ms: number, cmd: string) {
    const next = (this.logQueue.get(g.sessionId) || Promise.resolve()).then(() => this.logNow(g, tool, r, ms, cmd)).catch(() => {});
    this.logQueue.set(g.sessionId, next);
    return next;
  }
  private async logNow(g: Grant, tool: string, r: { ok: boolean; text: string; what: string; fileId?: string }, ms: number, cmd: string) {
    const s = await this.o.store.get<WorkSession>("sessions", g.sessionId);
    if (!s) return;
    const installed = [...s.installed];
    if (r.ok && cmd) for (const pkg of installsIn(cmd)) if (!installed.includes(pkg)) installed.push(pkg);
    await this.o.store.put<WorkSession>("sessions", {
      ...s, installed, fileIds: r.fileId ? [...s.fileIds, r.fileId] : s.fileIds,
      steps: [...s.steps, { at: new Date(this.now()).toISOString(), tool, what: r.what, ok: r.ok, ms, out: r.text.slice(0, MAX_LOG_OUT) }].slice(-200),
    });
  }

  /** Recent sessions for a teammate or chat: what happened before, so the next job can continue. */
  async recent(filter: { teammateId?: string; threadId?: string }, n = 5) {
    return (await this.o.store.all<WorkSession>("sessions"))
      .filter((s) => (filter.teammateId && s.teammateId === filter.teammateId) || (filter.threadId && s.threadId === filter.threadId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, n);
  }

  startTimer() { this.timer ??= setInterval(() => this.e2b?.idle?.(this.now() - this.lastUse).catch(() => {}), 60_000); }
  stopTimer() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}

/** Packages a command installed: "pip install pandas matplotlib" → ["pip:pandas", "pip:matplotlib"]. */
export function installsIn(cmd: string) {
  const out: string[] = [];
  for (const part of cmd.split(/&&|;|\|\|/)) {
    const m = /\b(pip3?|uv pip|npm|apt-get|apt)\s+(?:install|i|add)\s+(.+)/.exec(part.trim());
    if (!m) continue;
    const kind = m[1].startsWith("apt") ? "apt" : m[1] === "npm" ? "npm" : "pip";
    for (const w of m[2].split(/\s+/)) if (w && !w.startsWith("-")) out.push(`${kind}:${w}`);
  }
  return out;
}
