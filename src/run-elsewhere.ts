import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

// Run something somewhere else. A job works on the hub, in its workspace folder; when a step needs another machine
// (the user's Mac for Xcode, a macOS app or their files; a cloud computer from Settings for heavy work), the agent runs
// `hearth-run <machine> -- <command>`. Hearth copies the folder there (only what changed since last time), runs the
// command in that copy, and copies what changed back. The agent never deals with git, scp or paths on the other side.
//
// It always asks first: the first run on a machine in a conversation waits for the user's Yes on a card, and the agent
// asks them plainly in its reply ("Can I run the build on your Mac? It needs Xcode."). Yes covers that machine in that
// conversation for 12 hours; there's no "always".
//
// How the copying works: each side keeps a list of the files it knows the other side has (size, time, sha256). A run
// sends what changed on the hub since then (a tar.gz the machine fetches over HTTP, so it isn't bound by the line's
// 1 MB messages) and the paths deleted; the machine sends back what the command changed. A file changed on both sides
// keeps both: the incoming one takes the name, the local one is kept as name.on-<side>.ext and comes along next time.
// Big files (over 25 MB) don't move unless asked for (--with, --get). Folders like node_modules never move: each side
// builds its own.

export type Entry = { size: number; mtime: number; sha: string };
export type Manifest = Record<string, Entry>;

export const MAX_FILE = 25 * 1024 * 1024;
/** One transfer, either way. Bun takes request bodies up to 128 MB. */
export const MAX_TRANSFER = 100 * 1024 * 1024;
/** Never copied: each side builds its own, or it's junk. */
export const SKIP_DIRS = new Set(["node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".next", ".turbo", ".gradle", "DerivedData", ".build", "Pods", ".hearth-sync"]);
const SKIP_FILES = new Set([".DS_Store"]);
const MAX_FILES = 20_000;

const sha256File = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

/**
 * What's in a folder now: regular files only (symlinks are never followed or copied), skipping SKIP_DIRS. prev saves
 * re-hashing a file whose size and time are the same. Big files are listed without a hash.
 */
export function scan(root: string, prev: Manifest = {}, maxFile = MAX_FILE): Manifest {
  const out: Manifest = {};
  let n = 0;
  const walk = (dir: string, rel: string) => {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names.sort()) {
      if (n >= MAX_FILES || /[\n\r\\]/.test(name)) continue;
      const p = join(dir, name), r = rel ? `${rel}/${name}` : name;
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) walk(p, r); continue; }
      if (!st.isFile() || SKIP_FILES.has(name)) continue;
      n++;
      const was = prev[r], mtime = Math.floor(st.mtimeMs);
      if (was && was.size === st.size && was.mtime === mtime) { out[r] = was; continue; }
      let sha = "";
      if (st.size <= maxFile) { try { sha = sha256File(p); } catch { continue; } }
      out[r] = { size: st.size, mtime, sha };
    }
  };
  walk(root, "");
  return out;
}

/** What changed from before to now: new or different files, and ones that are gone. */
export function diff(before: Manifest, now: Manifest) {
  const changed: string[] = [], deleted: string[] = [];
  for (const [p, e] of Object.entries(now)) {
    const b = before[p];
    if (!b || b.size !== e.size || (e.sha ? b.sha !== e.sha : b.mtime !== e.mtime)) changed.push(p);
  }
  for (const p of Object.keys(before)) if (!now[p]) deleted.push(p);
  return { changed, deleted };
}

/** A path from the other side: relative, inside, nothing odd. */
export function safeRel(p: unknown): string | null {
  if (typeof p !== "string" || !p || p.length > 1000 || p.startsWith("/") || /[\0\n\r\\]/.test(p)) return null;
  const parts = p.split("/");
  if (parts.some((x) => !x || x === "." || x === "..")) return null;
  return p;
}

/** Is every folder on the way to rel inside root a real folder (not a symlink out)? Makes the missing ones. */
function safeParent(root: string, rel: string): boolean {
  let cur = root;
  for (const part of rel.split("/").slice(0, -1)) {
    cur = join(cur, part);
    try {
      const st = lstatSync(cur);
      if (!st.isDirectory()) return false;
    } catch { mkdirSync(cur, { mode: 0o755 }); }
  }
  return true;
}

/** name.ext -> name.on-<side>.ext (and name.on-<side>-2.ext if that's taken). */
export function keepName(root: string, rel: string, side: string) {
  const ext = extname(rel), stem = ext ? rel.slice(0, -ext.length) : rel, tag = side.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "other";
  for (let i = 1; ; i++) {
    const r = `${stem}.on-${tag}${i > 1 ? `-${i}` : ""}${ext}`;
    if (!existsSync(join(root, r))) return r;
  }
}

/** Pack these files from root into a tar.gz. Returns its path and size, or an error. */
export async function pack(root: string, files: string[], into: string): Promise<{ file: string; size: number } | { error: string }> {
  const list = join(into, `list-${randomUUID()}`), file = join(into, `out-${randomUUID()}.tgz`);
  writeFileSync(list, files.join("\n") + "\n");
  try {
    const p = Bun.spawn(["tar", "-czf", file, "-C", root, "-T", list], { stdout: "ignore", stderr: "pipe", env: { ...process.env, COPYFILE_DISABLE: "1" } });
    const err = await new Response(p.stderr).text();
    if ((await p.exited) !== 0) return { error: `couldn't pack the files: ${err.trim().slice(0, 200)}` };
    const size = statSync(file).size;
    if (size > MAX_TRANSFER) { rmSync(file, { force: true }); return { error: `that's ${mb(size)} to copy, over the ${mb(MAX_TRANSFER)} limit. Move big files out of the folder, or copy fewer.` }; }
    return { file, size };
  } finally { rmSync(list, { force: true }); }
}

/**
 * Put what came from the other side into root: the files in the tar.gz (regular files only, every path checked) and the
 * deletions. localChanged: what changed here since the last copy; a file changed both here and there keeps both.
 */
export async function unpack(root: string, tgz: string | null, deleted: string[], o: { localChanged: Set<string>; side: string; scratch: string }) {
  const got: string[] = [], kept: { path: string; as: string }[] = [], removed: string[] = [];
  if (tgz) {
    const tmp = mkdtempSync(join(o.scratch, "in-"));
    try {
      const p = Bun.spawn(["tar", "-xzf", tgz, "-C", tmp], { stdout: "ignore", stderr: "pipe" });
      const err = await new Response(p.stderr).text();
      if ((await p.exited) !== 0) throw new Error(`couldn't unpack what came back: ${err.trim().slice(0, 200)}`);
      for (const rel of Object.keys(scan(tmp, {}, Infinity))) {
        if (!safeRel(rel) || !safeParent(root, rel)) continue;
        const dest = join(root, rel);
        let st;
        try { st = lstatSync(dest); } catch {}
        if (st && !st.isFile()) continue;
        if (st && o.localChanged.has(rel) && sha256File(dest) !== sha256File(join(tmp, rel))) {
          const as = keepName(root, rel, o.side);
          renameSync(dest, join(root, as));
          kept.push({ path: rel, as });
        }
        renameSync(join(tmp, rel), dest);
        got.push(rel);
      }
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  for (const d of deleted) {
    const rel = safeRel(d);
    if (!rel || o.localChanged.has(rel)) continue;
    const p = join(root, rel);
    try { if (lstatSync(p).isFile() && safeParentNoMake(root, rel)) { rmSync(p); removed.push(rel); } } catch {}
  }
  return { got, kept, removed };
}
function safeParentNoMake(root: string, rel: string) {
  let cur = root;
  for (const part of rel.split("/").slice(0, -1)) {
    cur = join(cur, part);
    try { if (!lstatSync(cur).isDirectory()) return false; } catch { return false; }
  }
  return true;
}

/** The list each side keeps after a copy: what it had, plus what came in, minus what was deleted. */
export function after(had: Manifest, nowHere: Manifest, got: string[], removed: string[]): Manifest {
  const out: Manifest = { ...had };
  for (const p of got) if (nowHere[p]) out[p] = nowHere[p];
  for (const p of removed) delete out[p];
  return out;
}

export const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;

export function readManifest(file: string): Manifest | null {
  try { const j = JSON.parse(readFileSync(file, "utf8")); return j && typeof j === "object" ? j : null; } catch { return null; }
}
export function writeManifest(file: string, m: Manifest) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 });
  renameSync(tmp, file);
}

// ---------------------------------------------------------------- the machine's side

/** What the hub asks a machine to run (computers.ts sends it as {t:"exec", id, ...ExecReq}). */
export type ExecReq = {
  /** The folder's name on the machine (stable per hub folder). */
  key: string;
  /** Hub's changes to fetch (GET /computer/x/<tid>), or none. */
  tid: string | null;
  deleted: string[];
  /** The hub has no list for this machine: start from nothing. */
  full: boolean;
  cmd: string; bg: boolean; timeoutSec: number;
  /** Big files to bring back anyway. */
  get: string[];
};
/** What the machine says back. need: it lost its copy, so the hub resends everything. up: it uploaded its changes. */
export type ExecRes = {
  need?: "full"; error?: string; code?: number; out?: string; up?: boolean; deleted?: string[];
  big?: { path: string; size: number }[]; kept?: { path: string; as: string }[]; folder?: string; secs?: number; pid?: number;
};

export const KEY_RE = /^[A-Za-z0-9._-]{1,80}$/;
const OUT_MAX = 60_000;

/** The output's last OUT_MAX characters, so a chatty build still shows how it ended. */
const tail = (s: string) => (s.length > OUT_MAX ? `…(${s.length - OUT_MAX} earlier characters cut)\n${s.slice(-OUT_MAX)}` : s);

/**
 * Run one exec on this machine (computer.ts): bring the folder up to date from the hub, run the command in it, and send
 * back what changed. fetchIn/sendUp talk to the hub over HTTP; swapped in tests.
 */
export async function execHere(req: ExecReq, o: {
  home: string; side: string; fetchIn: (tid: string, to: string) => Promise<void>; sendUp: (file: string) => Promise<void>;
  onLine?: (s: string) => void; signal?: AbortSignal; shell?: string[];
}): Promise<ExecRes> {
  if (!KEY_RE.test(req.key)) return { error: "Not a folder the hub can use." };
  const base = join(o.home, "Hearth", "runs"), dir = join(base, req.key), mfile = join(base, `.${req.key}.json`);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const known = readManifest(mfile);
  if (!known && !req.full) return { need: "full" };
  const had = req.full ? {} : known!;
  const scratch = mkdtempSync(join(tmpdir(), "hearth-run-"));
  const t0 = Date.now();
  try {
    // 1. What came from the hub. Something that changed here too (a background job's output, say) keeps both.
    const localChanged = new Set(diff(had, scan(dir, had)).changed);
    let tgz: string | null = null;
    if (req.tid) { tgz = join(scratch, "in.tgz"); await o.fetchIn(req.tid, tgz); }
    const inn = await unpack(dir, tgz, req.deleted, { localChanged, side: o.side, scratch });
    const base0 = after(had, scan(dir, had), inn.got, inn.removed);
    // 2. Run it.
    let code = 0, out = "", pid: number | undefined;
    const sh = o.shell ?? ["bash", "-lc"];
    if (req.bg) {
      mkdirSync(join(dir, ".hearth-bg"), { recursive: true });
      const log = `.hearth-bg/${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
      const p = Bun.spawn([...sh, `nohup bash -lc ${shq(req.cmd)} > ${shq(log)} 2>&1 < /dev/null & echo $!`], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, HEARTH_RUN: "1" } });
      const [so, se] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      code = await p.exited;
      pid = Number(so.trim()) || undefined;
      out = code === 0 ? `Started in the background (pid ${pid ?? "?"}). Its output goes to ${log} in this folder; it comes back with the next run.` : se.trim();
    } else {
      const p = Bun.spawn([...sh, req.cmd], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, HEARTH_RUN: "1" } });
      const timer = setTimeout(() => { out += `\n(stopped: it ran longer than ${Math.round(req.timeoutSec / 60)} min)`; p.kill(); }, req.timeoutSec * 1000);
      const stop = () => { out += "\n(stopped)"; p.kill(); };
      o.signal?.addEventListener("abort", stop, { once: true });
      let last = 0;
      const read = async (s: ReadableStream<Uint8Array>) => {
        const dec = new TextDecoder();
        for await (const chunk of s as any) {
          out += dec.decode(chunk, { stream: true });
          if (out.length > OUT_MAX * 4) out = out.slice(-OUT_MAX * 2);
          if (o.onLine && Date.now() - last > 1500) { last = Date.now(); const l = out.trimEnd().split("\n").pop(); if (l) o.onLine(l.slice(0, 200)); }
        }
      };
      await Promise.all([read(p.stdout), read(p.stderr)]);
      code = await p.exited;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", stop);
    }
    // 3. What it changed goes back (big files only when asked for).
    const now = scan(dir, base0);
    const d = diff(base0, now);
    const want = new Set(req.get.map(safeRel).filter(Boolean) as string[]);
    const send = d.changed.filter((p) => now[p].size <= MAX_FILE || want.has(p));
    for (const p of want) if (now[p] && !send.includes(p)) send.push(p);
    const big = d.changed.filter((p) => !send.includes(p)).map((p) => ({ path: p, size: now[p].size }));
    let up = false;
    if (send.length) {
      const pk = await pack(dir, send, scratch);
      if ("error" in pk) return { error: `Ran it, but ${pk.error}`, code, out: tail(out) };
      await o.sendUp(pk.file);
      up = true;
    }
    writeManifest(mfile, now);
    return { code, out: tail(out), up, deleted: d.deleted, big, kept: inn.kept, folder: dir, secs: Math.round((Date.now() - t0) / 1000), ...(pid ? { pid } : {}) };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// ---------------------------------------------------------------- the hub's side

/** A machine a job can run on. */
export type RunPlace = { deviceId: string; name: string; mac: boolean; online: boolean; platform: string;
  /** Its app takes hearth-run (an older one, or one with HEARTH_NO_RUN, doesn't). */
  canRun?: boolean };
export type RunGate = "ok" | "ask" | "pending" | "no";

export type RunElsewhereOpts = {
  /** The brain's folder: only folders inside it can be copied (a job's workspace). */
  root: string;
  /** Where the hub keeps its lists and staged files (outside the brain's folder). */
  stateDir: string;
  places: () => RunPlace[];
  /** Hand a machine a staged file and a run; resolves with its answer and the file it uploaded, if any. */
  exec: (deviceId: string, req: ExecReq, staged: string | null, onLine?: (s: string) => void) => Promise<ExecRes & { upFile?: string }>;
  gate: (threadId: string, deviceId: string) => Promise<RunGate>;
  ask: (c: { threadId: string; jobId?: string; place: RunPlace; cmd: string; why?: string }) => Promise<void>;
  /** A paused cloud computer could be woken for this. */
  wake?: () => void;
  onLine?: (jobId: string, s: string) => void;
  /** A --bg run there ended: give its conversation a turn with this text (the hub's backgroundEnded path). */
  onBgEnd?: (w: BgWatch, text: string) => Promise<void>;
  /** A turn is working in this conversation now: checking (which copies files back) waits so it doesn't race it. */
  busy?: (threadId: string) => boolean;
  /** How often --bg runs are checked on (default 3 min); now(): for tests. */
  checkEveryMs?: number;
  now?: () => number;
};

/** A --bg run on another machine the hub keeps an eye on, so the agent never has to: it gets a turn when the run ends. */
export type BgWatch = { id: string; threadId: string; jobId?: string; deviceId: string; place: string; mac: boolean; dir: string; pid: number; log?: string; cmd: string; startedAt: number };

export type RunArgs = { place: string; cmd: string; why?: string; bg: boolean; with: string[]; get: string[]; timeoutMin: number };

export const RUN_USAGE = `usage: hearth-run list
       hearth-run <machine> [--why "<reason>"] [--bg] [--with <big file>] [--get <big file>] [--timeout <min>] -- <command>
  Runs <command> on another machine, in a copy of your current folder; what it changes comes back here.
  <machine>: mac (the user's Mac) or a name from hearth-run list. The first run on a machine in a conversation asks
  the user first.`;

/** The words of `hearth-run …`. A string is the usage error to print. */
export function parseRunArgv(argv: string[]): RunArgs | "list" | string {
  if (!argv.length || argv[0] === "help" || argv[0] === "--help") return RUN_USAGE;
  if (argv[0] === "list" || argv[0] === "machines") return "list";
  const [place, ...rest] = argv;
  const a: RunArgs = { place, cmd: "", bg: false, with: [], get: [], timeoutMin: 30 };
  let i = 0;
  for (; i < rest.length; i++) {
    const w = rest[i];
    if (w === "--") { i++; break; }
    if (w === "--bg") a.bg = true;
    else if (w === "--why" && rest[i + 1] !== undefined) a.why = rest[++i].slice(0, 300);
    else if ((w === "--with" || w === "--get") && rest[i + 1] !== undefined) {
      const p = safeRel(rest[++i].replace(/^\.\//, ""));
      if (!p) return `${w} takes a path inside your folder, like data/video.mp4`;
      (w === "--with" ? a.with : a.get).push(p);
    } else if (w === "--timeout" && rest[i + 1] !== undefined) {
      const n = Number(rest[++i]);
      if (!Number.isFinite(n) || n <= 0) return "--timeout takes minutes, like --timeout 60";
      a.timeoutMin = Math.min(n, 24 * 60);
    } else break; // the command starts here (no --)
  }
  a.cmd = rest.slice(i).join(" ").trim();
  if (!a.cmd && !a.get.length) return RUN_USAGE;
  if (!a.cmd) a.cmd = "true";
  return a;
}

/** The hub folder's name on a machine: readable, stable, and nothing about the hub's paths in it. */
export const folderKey = (realDir: string) => `${basename(realDir).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || "work"}-${createHash("sha256").update(realDir).digest("hex").slice(0, 12)}`;

export class RunElsewhere {
  private watches: BgWatch[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  constructor(private o: RunElsewhereOpts) {
    try { this.watches = JSON.parse(readFileSync(this.watchFile(), "utf8")); } catch { this.watches = []; }
    if (this.watches.length) this.startWatching();
  }

  private now() { return this.o.now?.() ?? Date.now(); }
  private watchFile() { return join(this.o.stateDir, "bg-watches.json"); }
  private saveWatches() {
    mkdirSync(this.o.stateDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.watchFile(), JSON.stringify(this.watches));
    if (!this.watches.length && this.timer) { clearInterval(this.timer); this.timer = null; }
  }
  private startWatching() {
    if (this.timer || !this.o.onBgEnd) return;
    this.timer = setInterval(() => { void this.checkBg(); }, this.o.checkEveryMs ?? 3 * 60_000);
    (this.timer as any).unref?.();
  }
  /** The --bg runs being watched for a conversation (all of them without one). */
  bgRuns(threadId?: string) { return this.watches.filter((w) => !threadId || w.threadId === threadId); }

  /**
   * Look in on each --bg run whose machine is online and whose conversation isn't mid-turn. Still going: nothing to say
   * (its files come back as a side effect). Ended: its files come back and its conversation gets a turn to report.
   */
  async checkBg() {
    if (this.checking || !this.o.onBgEnd) return;
    this.checking = true;
    try {
      for (const w of [...this.watches]) {
        // A run nobody's heard from in 3 days (the machine never came back): stop watching it.
        if (this.now() - w.startedAt > 3 * 86_400_000) { this.dropWatch(w.id); continue; }
        const place = this.o.places().find((p) => p.deviceId === w.deviceId);
        if (!place?.online || this.o.busy?.(w.threadId)) continue;
        if (!existsSync(w.dir)) { this.dropWatch(w.id); continue; }
        const look = `if kill -0 ${w.pid} 2>/dev/null; then echo HEARTH-BG-RUNNING; else echo HEARTH-BG-ENDED; echo "HEARTH-BG-CODE $(cat .hearth-bg/${w.id}.exit 2>/dev/null)"; ${w.log ? `tail -n 30 ${shq(w.log)}` : "true"}; fi`;
        let r: { code: number; text: string };
        try { r = await this.sync(place, { place: w.place, cmd: look, bg: false, with: [], get: [], timeoutMin: 2 }, w.dir); } catch { continue; }
        if (!r.text.includes("HEARTH-BG-ENDED")) continue;
        this.dropWatch(w.id);
        try { await this.o.onBgEnd(w, bgEndedText(w, r.text, this.now())); } catch { /* the hub logs its own failures */ }
      }
    } finally { this.checking = false; }
  }
  private dropWatch(id: string) { this.watches = this.watches.filter((x) => x.id !== id); this.saveWatches(); }

  /** Which machine "mac" or a name means. */
  find(name: string): RunPlace | null {
    const all = this.o.places(), n = name.trim().toLowerCase();
    if (!n) return null;
    if (n === "mac" || n === "my-mac" || n === "mymac") return all.find((p) => p.mac && p.online) ?? all.find((p) => p.mac) ?? null;
    return all.find((p) => p.name.toLowerCase() === n) ?? all.find((p) => p.name.toLowerCase().startsWith(n)) ?? null;
  }

  async list(threadId: string) {
    const all = this.o.places();
    if (!all.length) return "No other machines are linked to this hub. Everything runs here. (The user links their Mac with the Hearth app, or adds a cloud computer in Settings → Devices.)";
    const rows = await Promise.all(all.map(async (p) => {
      const g = p.online ? await this.o.gate(threadId, p.deviceId) : null;
      const what = p.mac ? "the user's own Mac: macOS, Xcode, their apps and files" : `a cloud computer${p.platform ? ` (${p.platform})` : ""}: for heavy or long work`;
      const state = !p.online ? "offline" : p.canRun === false ? "online, but its Hearth app can't take hearth-run (needs an update)" : g === "ok" ? "online, the user said yes in this conversation" : g === "no" ? "online, but the user said no in this conversation" : g === "pending" ? "online, waiting for the user's answer" : "online, asks the user first";
      return `- ${p.mac ? "mac" : p.name}${p.mac ? ` (${p.name})` : ""}: ${what}. ${state}.`;
    }));
    return `Machines you can run on (hearth-run <machine> -- <command>):\n${rows.join("\n")}`;
  }

  /** What `hearth-run <argv>` does for a job in this thread, working in cwd. First line is "HEARTH-EXIT <n>". */
  async run(argv: string[], ctx: { threadId: string; jobId?: string; cwd: string }): Promise<{ code: number; text: string }> {
    const a = parseRunArgv(argv);
    if (a === "list") return { code: 0, text: await this.list(ctx.threadId) };
    if (typeof a === "string") return { code: 2, text: a };
    const place = this.find(a.place);
    if (!place) {
      const names = this.o.places().map((p) => (p.mac ? "mac" : p.name));
      return { code: 2, text: `There's no machine called "${a.place}". ${names.length ? `There's: ${names.join(", ")}.` : "No other machines are linked, so run it here."}` };
    }
    if (!place.online) {
      if (!place.mac) this.o.wake?.();
      return { code: 3, text: place.mac ? `${place.name} (the user's Mac) is offline, so nothing can run there now. Do what you can here, and tell the user it needs their Mac to be on.` : `${place.name} is asleep. It's being woken now: try again in a minute or two.` };
    }
    if (place.canRun === false) return { code: 3, text: `${place.name} can't take commands from the hub: its Hearth app is too old for hearth-run, or turned it off. Do it here, and tell the user that updating the Hearth app on ${place.mac ? "their Mac" : place.name} would let you run it there.` };
    let dir: string;
    try { dir = realpathSync(resolve(ctx.cwd)); } catch { return { code: 2, text: "Your current folder doesn't exist." }; }
    const root = realpathSync(this.o.root);
    if (!dir.startsWith(root + sep)) return { code: 2, text: "hearth-run copies your current folder, and that has to be your workspace (or a folder in it). cd back there and run it again." };
    const g = await this.o.gate(ctx.threadId, place.deviceId);
    const who = place.mac ? `the user's Mac (${place.name})` : place.name;
    if (g === "no") return { code: 3, text: `The user said no to running things on ${who} in this conversation. Do it here, or tell them what you'd need it for.` };
    if (g !== "ok") {
      if (g === "ask") await this.o.ask({ threadId: ctx.threadId, jobId: ctx.jobId, place, cmd: a.cmd, why: a.why });
      return { code: 3, text: `Not run yet: running on ${who} waits for the user's Yes on the card under your reply. ${a.why ? "" : "(Next time, add --why \"<reason>\" so the card says why.) "}In your reply, ask them plainly, for example "Can I run this on ${place.mac ? "your Mac" : place.name}? ${a.why || "<why it needs that machine>"}", and say what it would do there. Finish what you can here meanwhile. When they answer you get a turn; then run the same hearth-run again.` };
    }
    if (!a.bg || !this.o.onBgEnd) return this.sync(place, a, dir, ctx.jobId);
    // --bg: the command writes its exit code when it's done, so the hub can say how it ended.
    const id = randomUUID().slice(0, 8);
    const res = await this.sync(place, { ...a, cmd: `__hd="$PWD"; (\n${a.cmd}\n); __hc=$?; printf '%s\\n' "$__hc" > "$__hd/.hearth-bg/${id}.exit"` }, dir, ctx.jobId);
    const pid = Number(res.text.match(/\(pid (\d+)\)/)?.[1]);
    if (res.code !== 0 || !pid) return res;
    const log = res.text.match(/output goes to (\.hearth-bg\/\S+\.log)/)?.[1];
    this.watches.push({ id, threadId: ctx.threadId, jobId: ctx.jobId, deviceId: place.deviceId, place: a.place, mac: place.mac, dir, pid, log, cmd: a.cmd, startedAt: this.now() });
    this.saveWatches();
    this.startWatching();
    return { ...res, text: `${res.text}\nThe hub watches it: when it ends, you get a turn here with how it went, and its files come back. So don't wait or check on it now: reply to the user.` };
  }

  private async sync(place: RunPlace, a: RunArgs, dir: string, jobId?: string): Promise<{ code: number; text: string }> {
    const key = folderKey(dir), mfile = join(this.o.stateDir, `${createHash("sha256").update(`${dir}|${place.deviceId}`).digest("hex").slice(0, 32)}.json`);
    const scratch = join(this.o.stateDir, "tmp");
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const known = readManifest(mfile);
    const onLine = jobId && this.o.onLine ? (s: string) => this.o.onLine!(jobId, s) : undefined;
    const attempt = async (had: Manifest, full: boolean) => {
      const now = scan(dir, had);
      const d = diff(had, now);
      const send = d.changed.filter((p) => now[p].size <= MAX_FILE || a.with.includes(p));
      for (const p of a.with) if (now[p] && !send.includes(p)) send.push(p);
      const left = d.changed.filter((p) => !send.includes(p));
      let staged: string | null = null;
      if (send.length) {
        const pk = await pack(dir, send, scratch);
        if ("error" in pk) return { error: pk.error } as const;
        staged = pk.file;
      }
      try {
        const res = await this.o.exec(place.deviceId, { key, tid: null, deleted: d.deleted, full, cmd: a.cmd, bg: a.bg, timeoutSec: Math.round(a.timeoutMin * 60), get: a.get }, staged, onLine);
        // A big file that stayed here isn't on the machine: leave it out of the list, so --with can send it later.
        const sent: Manifest = { ...now };
        for (const p of left) { if (had[p]) sent[p] = had[p]; else delete sent[p]; }
        return { res, now, sent, sentCount: send.length, left: left.map((p) => ({ path: p, size: now[p].size })) } as const;
      } finally { if (staged) rmSync(staged, { force: true }); }
    };
    let r = await attempt(known ?? {}, !known);
    if (!("error" in r) && r.res?.need === "full") r = await attempt({}, true);
    if ("error" in r) return { code: 1, text: `Didn't run: ${r.error}` };
    const { res } = r;
    if (res.need) return { code: 1, text: `${place.name} couldn't set up its copy of your folder. Try again.` };
    if (res.error && res.code === undefined) { if (res.upFile) rmSync(res.upFile, { force: true }); return { code: 1, text: `Didn't run on ${place.name}: ${res.error}` }; }
    // What came back goes in here. Something changed here meanwhile too keeps both (name.on-hub.ext).
    let back = { got: [] as string[], kept: [] as { path: string; as: string }[], removed: [] as string[] };
    try {
      const localChanged = new Set(diff(r.sent, scan(dir, r.sent)).changed);
      back = await unpack(dir, res.upFile ?? null, res.deleted || [], { localChanged, side: "hub", scratch });
    } finally { if (res.upFile) rmSync(res.upFile, { force: true }); }
    writeManifest(mfile, after(r.sent, scan(dir, r.sent), back.got, back.removed));
    return { code: res.code ?? 1, text: report(place, a, r.sentCount, r.left, res, back) };
  }
}

/** The turn a conversation gets when its --bg run on another machine ended. */
export function bgEndedText(w: BgWatch, checked: string, now = Date.now()): string {
  const code = checked.match(/HEARTH-BG-CODE (\d+)/)?.[1];
  const mins = Math.max(1, Math.round((now - w.startedAt) / 60_000));
  const took = mins < 90 ? `${mins} min` : `${(mins / 60).toFixed(1)} h`;
  const where = w.mac ? "the user's Mac" : w.place;
  const head = code === undefined
    ? `[Background run on ${where} stopped after about ${took}, without finishing normally (no exit code: it was killed, or the machine restarted).]`
    : `[Background run on ${where} ${code === "0" ? "finished" : "failed"}: exit ${code} after about ${took}.]`;
  const [files, out = ""] = checked.split("--- output ---");
  const last = out.replace(/HEARTH-BG-ENDED\n?|HEARTH-BG-CODE \d*\n?/g, "").trim();
  const back = files.split("\n").filter((l) => /^(Back here|Left on|.* changed on both sides)/.test(l)).join("\n");
  return `${head}
Command: ${w.cmd}
${back ? `${back}\n` : "No files changed since the last look.\n"}${last ? `Last lines of its output:\n<untrusted>\n${last.slice(-3000)}\n</untrusted>\n` : ""}
Tell the user how it went: the results or what broke, and where to look. Read the output and the files it wrote first.`;
}

function report(place: RunPlace, a: RunArgs, sent: number, left: { path: string; size: number }[], res: ExecRes, back: { got: string[]; kept: { path: string; as: string }[]; removed: string[] }) {
  const list = (xs: string[]) => (xs.length > 12 ? `${xs.slice(0, 12).join(", ")} and ${xs.length - 12} more` : xs.join(", "));
  const lines = [a.bg ? `Started on ${place.name}.` : `Ran on ${place.name}: exit ${res.code}${res.secs !== undefined ? `, ${res.secs}s` : ""}.`];
  lines.push(sent ? `Copied ${sent} changed file${sent === 1 ? "" : "s"} there first.` : "Nothing new to copy there first.");
  if (back.got.length) lines.push(`Back here, changed: ${list(back.got)}.`);
  if (back.removed.length) lines.push(`Back here, deleted: ${list(back.removed)}.`);
  if (!back.got.length && !back.removed.length && !a.bg) lines.push("It changed no files.");
  for (const k of [...(res.kept || []), ...back.kept]) lines.push(`${k.path} changed on both sides: both are kept (the other one is ${k.as}). Look at both and keep one.`);
  if (left.length) lines.push(`Not copied there (big): ${list(left.map((x) => `${x.path} (${mb(x.size)})`))}. Add --with <path> if the command needs one.`);
  if (res.big?.length) lines.push(`Left on ${place.name} (big): ${list(res.big.map((x) => `${x.path} (${mb(x.size)})`))}. Bring one here with: hearth-run ${place.mac ? "mac" : place.name} --get <path>`);
  if (res.error) lines.push(`Problem: ${res.error}`);
  if (res.out?.trim()) lines.push("--- output ---", res.out.trimEnd());
  return lines.join("\n");
}

// ---------------------------------------------------------------- the agent's command and skill

/** hearth-run: curl to the hub with the agent key, sending the folder it's in. Exits with the remote command's code. */
export function runElsewhereSkill(hubUrl: string, key: string) {
  const script = `#!/usr/bin/env bash
# hearth-run: run a command on another machine (the user's Mac, a cloud computer) in a copy of this folder. hearth-run help
set -uo pipefail
if [ $# -eq 0 ]; then set -- help; fi
args=(--data-urlencode "cwd=$PWD")
for a in "$@"; do args+=(--data-urlencode "a=$a"); done
run=()
if [ -n "\${HEARTH_JOB:-}" ]; then run=(-H "X-Hearth-Job: \${HEARTH_JOB}"); fi
out="$(mktemp)"
curl -sS -m 90000 -o "$out" -H "X-Hearth-Agent: ${key}" \${run[@]+"\${run[@]}"} "\${args[@]}" "${hubUrl}/api/agent/run" || { cat "$out" 2>/dev/null; rm -f "$out"; exit 1; }
code="$(head -1 "$out" | sed -n 's/^HEARTH-EXIT \\([0-9]*\\)$/\\1/p')"
if [ -n "$code" ]; then tail -n +2 "$out"; else cat "$out"; code=1; fi
rm -f "$out"
exit "$code"
`;
  return {
    name: "run-elsewhere", common: true, commands: ["hearth-run"], reads: [] as string[], scripts: { "hearth-run": script },
    description: "A step needs another machine: macOS or Xcode (build or run an iOS/Mac app), an app or file only on the user's Mac, or more power or time than this box has (a cloud computer). Run a command there with hearth-run, in a copy of your folder; changes come back.",
    body: `# Running something on another machine

You work on the hub, in your folder. Some steps need somewhere else:
- **the user's Mac** (\`mac\`): macOS only things (Xcode, xcodebuild, swift, simulators, \`open\`, osascript), apps they
  have there, files on their Mac (copy one into the folder: \`hearth-run mac -- cp ~/Downloads/report.pdf .\`).
- **a cloud computer** (by name): long or heavy work, or something you don't want on the hub.
Everything else: just run it here. Don't move work for no reason.

\`hearth-run list\` shows the machines, whether they're online, and whether the user said yes in this conversation.

## Running
\`hearth-run mac --why "it needs Xcode" -- xcodebuild -scheme App build\`
- Your current folder is copied there first (only what changed since last time), the command runs in that copy, and
  the files it changed come back into your folder. Output and the exit code come back too. You never handle git, scp
  or paths over there: the copy is "the same folder", just on that machine.
- **It asks the user first.** The first run on a machine in a conversation doesn't run: it puts a card under your
  reply and tells you so. In your reply, ask them plainly and say why ("Can I run the build on your Mac? It needs
  Xcode."). Always pass \`--why\` so the card says it. When they say yes you get a turn: run the same command again.
  If they say no, don't ask again in this conversation; do what you can here.
- Anything that takes more than a minute or two there (a batch of runs, a long build or test, a dev server): use
  \`--bg\`. It returns right away with its pid; its output goes to .hearth-bg/<time>.log. Then reply to the user. Don't
  wait, sleep or check on it in a loop: the hub checks on it, and when it ends you get a turn with its exit code and
  last output, and its files are back in your folder. The user asks how it's going: one quick
  \`hearth-run mac -- tail -5 .hearth-bg/*.log\`. Stop it with \`hearth-run mac -- kill <pid>\`.
- \`--timeout <min>\` (default 30) only for something short you need the answer to before you can reply.

## Files
- Folders like node_modules, .venv, DerivedData, Pods never move: each machine builds its own (run the install there).
- Big files (over 25 MB) stay where they were made. hearth-run says which; add \`--with <path>\` to send one there,
  or \`hearth-run mac --get <path>\` to bring one back.
- A file changed on both sides is kept twice: the incoming one takes the name, the other is \`name.on-<machine>.ext\`.
  Look at both and keep the right one.
- Symlinks aren't copied.

It runs on the user's real machine with their account: building, testing and reading are fine once they said yes.
Anything that sends, buys, deletes their own files or changes their settings still goes through Hearth's approval, so
say what you'd do and put it in your \`\`\`hearth block.`,
  };
}
