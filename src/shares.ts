import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Subprocess } from "bun";
import type { Hub } from "./hub.ts";
import { isActive } from "./memory.ts";
import { MODEL_RE } from "./brain.ts";
import { ALWAYS_HIDDEN, accessFor, cleanRules, findSecret, gitignorePatterns, matches, safePath, type PathRules } from "./public/rules.ts";
import { unifiedDiff } from "./public/diff.ts";
import { DEFAULT_LIMITS, type BoxLimits, type Manifest, type OutboxEvent, type Scope } from "./public/types.ts";
import type { Fact, Notebook, Share, ShareApply, ShareEvent, Teammate } from "./types.ts";

// Sharing a teammate: the hub's side. It copies what you chose into a bundle, starts a sealed box for the link,
// pulls the box's outbox, and applies changes to your folder only when you say so. The box never gets anything else,
// and nothing the box sends is trusted: every event is checked field by field, and every file change is checked
// against your rules again here, whatever the box claims.

const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const BOX_ENTRY = resolve(import.meta.dir, "public/box.ts");
const MAX_COPY_FILES = 5000;
const MAX_COPY_BYTES = 50_000_000;
const MAX_FILE_BYTES = 1_000_000;
const MAX_PULL_BYTES = 8_000_000;
const KEEP_VERSIONS = 10;

type R<T> = { value?: T; error?: string };

/** Starts and stops boxes. The hub never touches Docker itself: the sealed runner asks a root helper to. */
export interface BoxRunner {
  readonly kind: string;
  /** True when boxes run in their own container with no way back to the hub. */
  readonly sealed: boolean;
  start(s: Share, bundleDir: string): Promise<void>;
  stop(s: Share): Promise<void>;
  remove(s: Share): Promise<void>;
  socket(s: Share): string;
  outbox(s: Share): string;
  /** Whether the box looks up (it may still be starting). */
  alive(s: Share): boolean;
  /** The hub is shutting down. */
  shutdown?(): void;
}

/**
 * Sealed: one Docker container per link, started by `hearth-boxctl` (root, via a systemd path unit). The hub drops a
 * request file; the helper only knows "start/stop/remove <id>" and builds every path and flag itself.
 */
export class DockerRunner implements BoxRunner {
  readonly kind = "docker";
  readonly sealed = true;
  constructor(private ctlDir: string, private boxesRoot = "/var/lib/hearth-boxes") { mkdirSync(ctlDir, { recursive: true, mode: 0o700 }); }
  private request(action: "start" | "stop" | "remove", id: string) {
    const name = `${Date.now()}-${randomUUID()}.json`;
    writeFileSync(join(this.ctlDir, `.${name}`), JSON.stringify({ action, id }));
    renameSync(join(this.ctlDir, `.${name}`), join(this.ctlDir, name)); // the helper only sees complete files
  }
  async start(s: Share) {
    this.request("start", s.id);
    for (let i = 0; i < 120 && !existsSync(this.socket(s)); i++) await Bun.sleep(250);
    if (!existsSync(this.socket(s))) throw new Error("The box didn't start. Check `journalctl -u hearth-boxctl` on the server.");
  }
  async stop(s: Share) { this.request("stop", s.id); }
  async remove(s: Share) { this.request("remove", s.id); }
  socket(s: Share) { return join(this.boxesRoot, s.id, "run", "box.sock"); }
  outbox(s: Share) { return join(this.boxesRoot, s.id, "outbox.jsonl"); }
  alive(s: Share) { return existsSync(this.socket(s)); } // containers outlive the hub
}

/** For trying it out on a laptop: the box runs as a plain subprocess. Same code, but NOT sealed. */
export class LocalRunner implements BoxRunner {
  readonly kind = "local";
  readonly sealed = false;
  private procs = new Map<string, Subprocess>();
  constructor(private root: string, private apiKey: string | undefined) {}
  private dir(s: Share) { return join(this.root, s.id); }
  async start(s: Share, bundleDir: string) {
    if (this.procs.get(s.id)?.exitCode === null) return;
    if (!this.apiKey) throw new Error("Set HEARTH_BOX_API_KEY (a Claude API key just for shared links) in the hub's .env.");
    mkdirSync(join(this.dir(s), "run"), { recursive: true });
    rmSync(this.socket(s), { force: true });
    this.procs.set(s.id, Bun.spawn([process.execPath, BOX_ENTRY], {
      cwd: this.dir(s), stdout: "inherit", stderr: "inherit",
      env: { PATH: process.env.PATH || "", HOME: this.dir(s), BOX_BUNDLE: bundleDir, BOX_DATA: this.dir(s), ANTHROPIC_API_KEY: this.apiKey },
    }));
    for (let i = 0; i < 80 && !existsSync(this.socket(s)); i++) await Bun.sleep(100);
    if (!existsSync(this.socket(s))) throw new Error("The box didn't start.");
  }
  async stop(s: Share) { this.procs.get(s.id)?.kill(); this.procs.delete(s.id); }
  async remove(s: Share) { await this.stop(s); rmSync(this.dir(s), { recursive: true, force: true }); }
  socket(s: Share) { return join(this.dir(s), "run", "box.sock"); }
  outbox(s: Share) { return join(this.dir(s), "outbox.jsonl"); }
  alive(s: Share) { return this.procs.get(s.id)?.exitCode === null; }
  shutdown() { for (const p of this.procs.values()) p.kill(); this.procs.clear(); }
}

// ---------- checking what comes back ----------

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const content = (v: unknown) => (v === null ? null : typeof v === "string" && v.length <= MAX_FILE_BYTES ? v : undefined);

/** A box event, rebuilt field by field from untrusted JSON. Anything malformed is dropped. */
export function checkEvent(raw: any): OutboxEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const at = typeof raw.at === "string" && !Number.isNaN(Date.parse(raw.at)) ? new Date(raw.at).toISOString() : new Date().toISOString();
  const session = /^[A-Za-z0-9-]{1,64}$/.test(raw.session) ? raw.session : "";
  const visitor = str(raw.visitor, 40) || "Visitor";
  switch (raw.kind) {
    case "chat": return session && (raw.fit === "in" || raw.fit === "unsure") ? { kind: "chat", at, session, visitor, fit: raw.fit, costUsd: num(raw.costUsd, 0, 100, 0) } : null;
    case "refused": {
      const reason = ["out", "injection", "abuse", "limit", "check"].includes(raw.reason) ? raw.reason : null;
      return session && reason ? { kind: "refused", at, session, visitor, reason, text: str(raw.text, 300), note: str(raw.note, 200) } : null;
    }
    case "ask": return session && str(raw.question, 500) ? { kind: "ask", at, session, visitor, id: str(raw.id, 64) || randomUUID(), question: str(raw.question, 500), why: str(raw.why, 300) } : null;
    case "edit": {
      if (!session || !Array.isArray(raw.files) || !raw.files.length || raw.files.length > 200) return null;
      const files = [];
      for (const f of raw.files) {
        const path = safePath(f?.path);
        const before = content(f?.before), after = content(f?.after);
        if (!path || before === undefined || after === undefined) return null;
        files.push({ path, before, after, added: num(f.added, 0, 1e6, 0), removed: num(f.removed, 0, 1e6, 0) });
      }
      return { kind: "edit", at, session, visitor, id: str(raw.id, 64) || randomUUID(), bundleVersion: num(raw.bundleVersion, 0, 1e9, 0), asked: str(raw.asked, 500), note: str(raw.note, 500), files };
    }
    case "paused": return { kind: "paused", at, reason: str(raw.reason, 200) };
    default: return null;
  }
}

function cleanScope(raw: any, fallback: string): Scope {
  const list = (v: unknown, n: number, max: number) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).slice(0, n).map((x) => x.trim().slice(0, max)) : []);
  return {
    does: str(raw?.does, 400).trim() || fallback,
    examples: list(raw?.examples, 6, 120),
    not: list(raw?.not, 10, 120),
    allowCode: raw?.allowCode === true,
    allowLongForm: raw?.allowLongForm === true,
  };
}

function cleanLimits(raw: any, prev: BoxLimits = DEFAULT_LIMITS): BoxLimits {
  return {
    costCapDayUsd: num(raw?.costCapDayUsd, 0.1, 50, prev.costCapDayUsd),
    perVisitorPer10Min: Math.round(num(raw?.perVisitorPer10Min, 1, 60, prev.perVisitorPer10Min)),
    perVisitorPerDay: Math.round(num(raw?.perVisitorPerDay, 1, 500, prev.perVisitorPerDay)),
    perIpPer10Min: Math.round(num(raw?.perIpPer10Min, 1, 200, prev.perIpPer10Min)),
    perLinkPerHour: Math.round(num(raw?.perLinkPerHour, 1, 5000, prev.perLinkPerHour)),
    maxMessageChars: Math.round(num(raw?.maxMessageChars, 100, 8000, prev.maxMessageChars)),
  };
}

/** Three-way merge with git's merge-file (no repo needed). */
function merge3(ours: string, base: string, theirs: string) {
  const dir = mkdtempSync(join(tmpdir(), "hearth-merge-"));
  try {
    const [o, b, t] = ["ours", "base", "theirs"].map((n) => join(dir, n));
    writeFileSync(o, ours); writeFileSync(b, base); writeFileSync(t, theirs);
    const r = Bun.spawnSync(["git", "merge-file", "-p", "-L", "yours", "-L", "when shared", "-L", "visitor", o, b, t]);
    if (r.exitCode === null || r.exitCode < 0 || r.exitCode > 127) throw new Error("git merge-file failed");
    return { text: r.stdout.toString(), conflicts: r.exitCode };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const git = (cwd: string, args: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { env: { PATH: process.env.PATH || "", HOME: tmpdir(), GIT_TERMINAL_PROMPT: "0" } });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};

export class Shares {
  private timer: ReturnType<typeof setInterval> | null = null;
  private pulling = false;

  constructor(readonly hub: Hub, readonly runner: BoxRunner | null) {}

  get enabled() { return !!this.runner; }
  private get store() { return this.hub.store; }
  private root(s: Share) { return join(this.hub.config.dataDir, "shares", s.id); }
  bundleDir(s: Share) { return join(this.root(s), "bundle"); }

  start(intervalMs = 5000) {
    if (!this.runner) return;
    const tick = () => this.ensure().then(() => this.pull()).catch((e) => console.error("share pull failed", e));
    this.timer = setInterval(tick, intervalMs);
    tick();
  }

  private starting = new Set<string>();
  /** Every running link has a box: after a restart, or a link made from the command line. */
  async ensure() {
    if (!this.runner) return;
    for (const s of await this.list()) {
      if (s.status !== "running" || this.starting.has(s.id) || this.runner.alive(s)) continue;
      this.starting.add(s.id);
      this.runner.start(s, this.bundleDir(s)).catch((e) => console.error(`share ${s.id}: ${e.message}`)).finally(() => this.starting.delete(s.id));
    }
  }
  stop() { if (this.timer) clearInterval(this.timer); this.runner?.shutdown?.(); }

  async list() { return (await this.store.all<Share>("shares")).filter((s) => s.status !== "revoked"); }
  async get(id: string) { const s = await this.store.get<Share>("shares", id); return s && s.status !== "revoked" ? s : null; }

  /** The box behind a link, for the hub to forward visitor API calls to. */
  async socketFor(link: string) {
    if (!this.runner || !/^[A-Za-z0-9_-]{16,64}$/.test(link)) return null;
    const s = (await this.store.all<Share>("shares")).find((x) => x.status === "running" && x.link.length === link.length && sha256(x.link) === sha256(link));
    return s ? this.runner.socket(s) : null;
  }

  // ---------- create, change, publish, revoke ----------

  async create(input: any, opts: { start?: boolean } = {}): Promise<R<Share>> {
    if (!this.runner) return { error: "Sharing is off on this hub. Set HEARTH_BOX_RUNNER (see deploy/lightsail.md)." };
    const t = await this.store.get<Teammate>("teammates", str(input?.teammateId, 64));
    if (!t) return { error: "Pick one of your teammates to share." };
    const kind = input?.kind === "guest" ? "guest" : "public";
    const label = str(input?.label, 40).trim();
    if (kind === "guest" && !label) return { error: "Say who this guest link is for." };
    if (input?.autoApply === true && kind !== "guest") return { error: "Public links can't apply changes by themselves. Use a guest link for someone you trust." };
    const now = this.hub.clock().toISOString();
    const share: Share = {
      id: randomBytes(12).toString("hex"), createdAt: now, link: randomBytes(18).toString("base64url"),
      kind, ...(label ? { label } : {}), teammateId: t.id, role: str(input?.role, 400).trim() || t.description || t.name,
      ownerName: str(input?.ownerName, 40).trim() || "the owner", notebooks: [], notes: [],
      scope: cleanScope(input?.scope, t.description || `Help with ${t.name.toLowerCase()}.`), limits: cleanLimits(input?.limits),
      models: { teammate: "claude-opus-5-5", guard: "claude-haiku-5-5", effort: "medium" },
      autoApply: input?.autoApply === true, version: 0, status: "running", outboxOffset: 0,
      stats: { chats: 0, refused: 0, offTopic: 0, costUsd: 0 }, answers: { always: [], once: {} },
    };
    const r = await this.applyInput(share, input);
    if (r.error) return r;
    await this.publish(share);
    if (opts.start !== false) try { await this.runner.start(share, this.bundleDir(share)); }
    catch (e: any) { await this.store.put<Share>("shares", { ...share, status: "paused" }); return { error: e.message }; }
    await this.hub.log("share", `Shared ${t.name}${kind === "guest" ? ` with ${label}` : " by public link"}`);
    this.hub.emit("shares");
    return { value: (await this.get(share.id))! };
  }

  /** Notebooks, notes, models and folder: checked here, used by create and update. */
  private async applyInput(share: Share, input: any): Promise<R<Share>> {
    if (input?.notebooks !== undefined) {
      const known = new Set((await this.store.all<Notebook>("notebooks")).map((n) => n.name));
      const names = Array.isArray(input.notebooks) ? input.notebooks.filter((n: unknown) => typeof n === "string") : [];
      const unknown = names.filter((n: string) => !known.has(n));
      if (unknown.length) return { error: `No notebook called ${unknown[0]}.` };
      share.notebooks = [...new Set<string>(names)].slice(0, 20);
    }
    if (input?.notes !== undefined) share.notes = (Array.isArray(input.notes) ? input.notes : []).filter((n: unknown) => typeof n === "string" && n.trim()).slice(0, 20).map((n: string) => n.trim().slice(0, 300));
    if (input?.scope !== undefined) share.scope = cleanScope(input.scope, share.scope.does);
    if (input?.limits !== undefined) share.limits = cleanLimits(input.limits, share.limits);
    if (input?.role !== undefined) share.role = str(input.role, 400).trim() || share.role;
    if (input?.ownerName !== undefined) share.ownerName = str(input.ownerName, 40).trim() || share.ownerName;
    if (input?.models !== undefined) {
      const m = input.models;
      if (typeof m?.teammate === "string" && MODEL_RE.test(m.teammate) && m.teammate) share.models.teammate = m.teammate;
      if (typeof m?.guard === "string" && MODEL_RE.test(m.guard) && m.guard) share.models.guard = m.guard;
      if (["low", "medium", "high"].includes(m?.effort)) share.models.effort = m.effort;
    }
    if (input?.autoApply !== undefined) {
      if (input.autoApply === true && share.kind !== "guest") return { error: "Public links can't apply changes by themselves." };
      share.autoApply = input.autoApply === true;
    }
    if (input?.folder === null) delete share.folder;
    else if (input?.folder !== undefined) {
      const path = str(input.folder?.path, 1000);
      if (!path || !path.startsWith("/")) return { error: "Give the folder's full path." };
      let real: string;
      try { real = realpathSync(path); } catch { return { error: "That folder doesn't exist." }; }
      if (!statSync(real).isDirectory()) return { error: "That's a file, not a folder." };
      const data = realpathSync(this.hub.config.dataDir);
      if (real === "/" || real === realpathSync(process.env.HOME || "/") || data.startsWith(real + sep) || real === data || real.startsWith(data + sep)) {
        return { error: "Share a project folder, not your home folder, the whole disk or the hub's data." };
      }
      const rules = input.folder?.rules ? cleanRules(input.folder.rules) : (share.folder?.rules || { read: ["**"] });
      share.folder = { path: real, rules, published: share.folder?.path === real ? share.folder.published : {}, excluded: [] };
    }
    return { value: share };
  }

  async update(id: string, input: any): Promise<R<Share>> {
    const s = await this.get(id);
    if (!s) return { error: "No such link." };
    const r = await this.applyInput(s, input);
    if (r.error) return r;
    await this.publish(s);
    this.hub.emit("shares");
    return { value: (await this.get(id))! };
  }

  /** Facts from the notebooks you picked, and the notes you typed. That's all the box learns about you. */
  async knowledge(s: Share) {
    const now = this.hub.clock();
    const facts = (await this.store.all<Fact>("memory")).filter((f) => isActive(f, now) && s.notebooks.includes(f.notebook));
    return [...facts.map((f) => f.fact), ...s.notes].slice(0, 300);
  }

  /** Write a new version of the bundle and point the box at it. */
  async publish(s: Share) {
    const t = await this.store.get<Teammate>("teammates", s.teammateId);
    const version = s.version + 1;
    const root = this.bundleDir(s), vdir = join(root, `v${version}`);
    rmSync(vdir, { recursive: true, force: true });
    mkdirSync(join(vdir, "files"), { recursive: true });
    let folder: Manifest["folder"];
    if (s.folder) {
      const copied = this.copyFolder(s.folder.path, s.folder.rules, join(vdir, "files"));
      s.folder.published = Object.fromEntries(Object.entries(copied.files).map(([p, f]) => [p, { sha256: f.sha256, access: f.access }]));
      s.folder.excluded = copied.excluded;
      folder = { name: basename(s.folder.path), rules: s.folder.rules, files: copied.files };
    }
    const manifest: Manifest = {
      version, kind: s.kind, ...(s.label ? { label: s.label } : {}), ownerName: s.ownerName,
      teammate: { name: t?.name || "Teammate", role: s.role, ...(t?.emoji ? { emoji: t.emoji } : {}) },
      scope: s.scope, knowledge: await this.knowledge(s), limits: s.limits, models: s.models, ...(folder ? { folder } : {}),
    };
    writeFileSync(join(vdir, "manifest.json"), JSON.stringify(manifest, null, 1));
    this.writeAtomic(join(root, "answers.json"), JSON.stringify(s.answers));
    this.writeAtomic(join(root, "current.json"), JSON.stringify({ version }));
    for (const d of readdirSync(root)) {
      const n = Number(d.match(/^v(\d+)$/)?.[1]);
      if (n && n <= version - KEEP_VERSIONS) rmSync(join(root, d), { recursive: true, force: true });
    }
    s.version = version;
    await this.store.put<Share>("shares", { ...s, updatedAt: this.hub.clock().toISOString() });
    return manifest;
  }

  private writeAtomic(file: string, text: string) {
    writeFileSync(`${file}.tmp`, text, { mode: 0o644 });
    renameSync(`${file}.tmp`, file);
  }

  /**
   * Copy the files the rules allow into the bundle. Never: anything always-hidden (.env, keys, .git, node_modules),
   * anything in the root .gitignore, symlinks, binary files, or files that look like they hold a password or key.
   */
  copyFolder(src: string, rules: PathRules, dest: string) {
    const ignore = existsSync(join(src, ".gitignore")) ? gitignorePatterns(readFileSync(join(src, ".gitignore"), "utf8")) : [];
    const files: NonNullable<Manifest["folder"]>["files"] = {};
    const excluded: { path: string; why: string }[] = [];
    let total = 0, count = 0;
    const walk = (rel: string) => {
      for (const ent of readdirSync(join(src, rel), { withFileTypes: true })) {
        const p = rel ? `${rel}/${ent.name}` : ent.name;
        if (ALWAYS_HIDDEN.some((x) => matches(x, p)) || ignore.some((x) => matches(x, p))) continue;
        if (ent.isSymbolicLink()) { excluded.push({ path: p, why: "symlink" }); continue; }
        if (ent.isDirectory()) { walk(p); continue; }
        if (!ent.isFile()) continue;
        const access = accessFor(rules, p);
        if (access === "hidden") continue;
        const size = statSync(join(src, p)).size;
        if (size > MAX_FILE_BYTES) { excluded.push({ path: p, why: "over 1 MB" }); continue; }
        if (count >= MAX_COPY_FILES || total + size > MAX_COPY_BYTES) { excluded.push({ path: p, why: "folder too big" }); continue; }
        const bytes = readFileSync(join(src, p));
        let text: string;
        try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); if (text.includes("\0")) throw 0; }
        catch { excluded.push({ path: p, why: "not a text file" }); continue; }
        const secret = findSecret(text);
        if (secret) { excluded.push({ path: p, why: `looks like it has a ${secret}` }); continue; }
        mkdirSync(dirname(join(dest, p)), { recursive: true });
        writeFileSync(join(dest, p), bytes, { mode: 0o644 });
        files[p] = { sha256: sha256(bytes), size, access };
        total += size; count++;
      }
    };
    walk("");
    return { files, excluded };
  }

  async revoke(id: string) {
    const s = await this.store.get<Share>("shares", id);
    if (!s || s.status === "revoked") return false;
    await this.store.put<Share>("shares", { ...s, status: "revoked", updatedAt: this.hub.clock().toISOString() });
    await this.runner?.remove(s);
    rmSync(this.root(s), { recursive: true, force: true });
    await this.hub.log("share", "Turned off a shared link");
    this.hub.emit("shares");
    return true;
  }

  async pause(id: string, paused: boolean) {
    const s = await this.get(id);
    if (!s || !this.runner) return null;
    if (paused) await this.runner.stop(s); else await this.runner.start(s, this.bundleDir(s));
    const next = { ...s, status: paused ? "paused" as const : "running" as const };
    await this.store.put<Share>("shares", next);
    this.hub.emit("shares");
    return next;
  }

  // ---------- what comes back ----------

  /** Read new outbox lines from every box. The box only ever appends; the hub keeps its own place in the file. */
  async pull() {
    if (!this.runner || this.pulling) return;
    this.pulling = true;
    try {
      for (const s of await this.list()) {
        const file = this.runner.outbox(s);
        if (!existsSync(file)) continue;
        const size = statSync(file).size;
        const from = size < s.outboxOffset ? 0 : s.outboxOffset;
        if (size === from) continue;
        const buf = new Uint8Array(await Bun.file(file).slice(from, Math.min(size, from + MAX_PULL_BYTES)).arrayBuffer());
        let end = buf.lastIndexOf(10);
        if (end < 0) { if (buf.length >= MAX_PULL_BYTES) end = buf.length - 1; else continue; } // one huge line: skip it
        const lines = new TextDecoder().decode(buf.subarray(0, end + 1)).split("\n");
        const fresh: ShareEvent[] = [];
        for (const line of lines) {
          if (!line.trim() || line.length > 2 * MAX_FILE_BYTES * 200) continue;
          let raw: unknown;
          try { raw = JSON.parse(line); } catch { continue; }
          const event = checkEvent(raw);
          if (!event) continue;
          const status = event.kind === "edit" || event.kind === "ask" ? "pending" : "new";
          fresh.push(await this.store.put<ShareEvent>("shareEvents", { id: randomUUID(), createdAt: this.hub.clock().toISOString(), shareId: s.id, kind: event.kind, status, event }));
        }
        const cur = (await this.get(s.id)) || s;
        const stats = { ...cur.stats };
        for (const e of fresh) {
          const ev = e.event;
          if (ev.kind === "chat") { stats.chats++; stats.costUsd = +(stats.costUsd + ev.costUsd).toFixed(4); }
          if (ev.kind === "refused") { stats.refused++; if (ev.reason === "out") stats.offTopic++; }
          if ("at" in ev) stats.lastAt = ev.at;
        }
        await this.store.put<Share>("shares", { ...cur, outboxOffset: from + end + 1, stats });
        if (fresh.length) await this.notify(cur, fresh);
        if (cur.autoApply && cur.kind === "guest") {
          for (const e of fresh.filter((x) => x.kind === "edit")) await this.apply(cur.id, [e.id], "apply");
        }
      }
    } finally { this.pulling = false; }
  }

  private async notify(s: Share, fresh: ShareEvent[]) {
    const t = await this.store.get<Teammate>("teammates", s.teammateId);
    const name = t?.name || "Teammate";
    for (const e of fresh) {
      const ev = e.event;
      let text = "";
      if (ev.kind === "ask") text = `${ev.visitor} asked ${name}: "${ev.question}"`;
      else if (ev.kind === "edit") text = `${ev.visitor} changed ${ev.files.length} file${ev.files.length === 1 ? "" : "s"} in ${s.folder ? basename(s.folder.path) : "the shared folder"}`;
      else if (ev.kind === "refused" && (ev.reason === "injection" || ev.reason === "abuse")) text = `${name}'s link blocked a message from ${ev.visitor} (${ev.reason})`;
      else if (ev.kind === "paused") text = `${name}'s link paused: ${ev.reason}`;
      if (!text) continue;
      await this.hub.log("share", text);
      await this.hub.push?.send({ title: `${name} (shared)`, body: text.slice(0, 160), tag: `share-${s.id}` }).catch(() => {});
    }
    this.hub.emit("shares");
  }

  async events(shareId: string, limit = 200) {
    const all = (await this.store.all<ShareEvent>("shareEvents")).filter((e) => e.shareId === shareId);
    return all.slice(-limit).reverse().map((e) => this.summary(e));
  }

  private summary(e: ShareEvent) {
    const ev = e.event;
    if (ev.kind !== "edit") return { id: e.id, kind: e.kind, status: e.status, result: e.result, event: ev };
    return { id: e.id, kind: e.kind, status: e.status, result: e.result, event: { ...ev, files: ev.files.map((f) => ({ path: f.path, added: f.added, removed: f.removed, deleted: f.after == null })) } };
  }

  /** One event with a diff for each file, for the preview. */
  async event(shareId: string, id: string) {
    const e = await this.store.get<ShareEvent>("shareEvents", id);
    if (!e || e.shareId !== shareId) return null;
    if (e.event.kind !== "edit") return this.summary(e);
    return { ...this.summary(e), diffs: e.event.files.map((f) => ({ path: f.path, diff: unifiedDiff(f.path, f.before, f.after) })) };
  }

  async reject(shareId: string, ids: string[]) {
    let n = 0;
    for (const id of ids) {
      const e = await this.store.get<ShareEvent>("shareEvents", id);
      if (!e || e.shareId !== shareId || e.kind !== "edit" || !["pending", "conflict"].includes(e.status)) continue;
      await this.store.put<ShareEvent>("shareEvents", { ...e, status: "rejected" });
      n++;
    }
    this.hub.emit("shares");
    return n;
  }

  /** Answer an "ask me": once (that visitor only), always (every visitor), or no. Pushes only that answer into the box. */
  async answer(shareId: string, id: string, input: any): Promise<R<ShareEvent>> {
    const s = await this.get(shareId);
    const e = await this.store.get<ShareEvent>("shareEvents", id);
    if (!s || !e || e.shareId !== shareId || e.event.kind !== "ask") return { error: "No such request." };
    const mode = ["once", "always", "no"].includes(input?.mode) ? input.mode : null;
    const text = str(input?.answer, 1000).trim();
    if (!mode) return { error: "Answer once, always or no." };
    if (mode !== "no" && !text) return { error: "Type the answer to share." };
    const q = { question: e.event.question, answer: mode === "no" ? `${s.ownerName} would rather not share that.` : text };
    if (mode === "always") s.answers.always.push(q);
    else (s.answers.once[e.event.session] ||= []).push(q);
    this.writeAtomic(join(this.bundleDir(s), "answers.json"), JSON.stringify(s.answers));
    await this.store.put<Share>("shares", s);
    const done = await this.store.put<ShareEvent>("shareEvents", { ...e, status: "answered", result: mode });
    this.hub.emit("shares");
    return { value: done };
  }

  // ---------- applying changes to your folder ----------

  /** Where a path really lives in your folder, or null if it would leave the folder or pass through a symlink. */
  private realPath(root: string, p: string) {
    const full = join(root, p);
    if (!full.startsWith(root + sep)) return null;
    let cur = root;
    for (const part of p.split("/").slice(0, -1)) {
      cur = join(cur, part);
      if (existsSync(cur) && lstatSync(cur).isSymbolicLink()) return null;
    }
    if (existsSync(full) && lstatSync(full).isSymbolicLink()) return null;
    return full;
  }

  /** The hub's own check, whatever the box says: the rules say edit, and it isn't a file we deliberately left out. */
  writable(s: Share, p: string) {
    if (!s.folder) return false;
    if (accessFor(s.folder.rules, p) !== "edit") return false;
    if (s.folder.excluded.some((x) => x.path === p)) return false;
    const full = this.realPath(s.folder.path, p);
    if (!full) return false;
    const pub = s.folder.published[p];
    if (pub) return pub.access === "edit";
    return !existsSync(full); // a file that exists but wasn't copied in (gitignored, secret, too big) is never overwritten
  }

  private readReal(root: string, p: string) {
    const full = join(root, p);
    return existsSync(full) ? readFileSync(full, "utf8") : null;
  }

  /** Replay the chosen changes on top of what's there now, merging where you've changed the same file. */
  private plan(s: Share, root: string, events: ShareEvent[]) {
    const state = new Map<string, string | null>();
    const conflicts: { path: string; why: string; text?: string }[] = [];
    const dropped: string[] = [];
    const read = (p: string) => (state.has(p) ? state.get(p)! : this.readReal(root, p));
    for (const e of events) {
      if (e.event.kind !== "edit") continue;
      for (const f of e.event.files) {
        const p = safePath(f.path);
        if (!p || !this.writable(s, p)) { if (p && !dropped.includes(p)) dropped.push(p); continue; }
        const ours = read(p), base = f.before, theirs = f.after;
        if (ours === base) state.set(p, theirs);
        else if (ours === theirs) state.set(p, ours);
        else if (ours == null || base == null || theirs == null) { conflicts.push({ path: p, why: "added or deleted on both sides" }); state.set(p, ours); }
        else {
          const m = merge3(ours, base, theirs);
          if (m.conflicts) conflicts.push({ path: p, why: "you both changed the same lines", text: m.text });
          state.set(p, m.text);
        }
      }
    }
    return { state, conflicts, dropped };
  }

  private async editEvents(shareId: string, ids: string[], statuses: ShareEvent["status"][]) {
    const out: ShareEvent[] = [];
    for (const id of ids) {
      const e = await this.store.get<ShareEvent>("shareEvents", id);
      if (e && e.shareId === shareId && e.kind === "edit" && statuses.includes(e.status)) out.push(e);
    }
    return out.sort((a, b) => (a.event as any).at.localeCompare((b.event as any).at) || a.createdAt.localeCompare(b.createdAt));
  }

  private async mark(events: ShareEvent[], status: ShareEvent["status"], result?: string) {
    for (const e of events) await this.store.put<ShareEvent>("shareEvents", { ...e, status, ...(result ? { result } : {}) });
    this.hub.emit("shares");
  }

  /**
   * apply: write into your folder (all or nothing; stops on a conflict). Keeps what was there so Undo puts it back.
   * copy:  a new folder next to yours with the changes; yours is untouched (conflicts are left marked in the copy).
   * branch: git folders only; a new branch with one commit per change.
   */
  async apply(shareId: string, ids: string[], mode: "apply" | "copy" | "branch") {
    const s = await this.get(shareId);
    if (!s?.folder) return { error: "This link has no folder." };
    const events = await this.editEvents(shareId, ids, ["pending", "conflict"]);
    if (!events.length) return { error: "Nothing to apply." };
    const root = s.folder.path;
    if (mode === "branch") return this.branch(s, events);
    const { state, conflicts, dropped } = this.plan(s, root, events);
    if (mode === "copy") {
      const dest = this.uniqueSibling(root, `${basename(root)} (${events[0].event.kind === "edit" ? events[0].event.visitor : "visitor"}'s changes)`);
      cpSync(root, dest, { recursive: true, filter: (from) => !/(^|\/)(node_modules|\.git)(\/|$)/.test(relative(root, from)) });
      for (const [p, after] of state) {
        const full = join(dest, p);
        if (after == null) rmSync(full, { force: true });
        else { mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, after); }
      }
      await this.mark(events, "copied", dest);
      return { value: { copiedTo: dest, conflicts, dropped } };
    }
    if (conflicts.length) {
      await this.mark(events, "conflict", conflicts.map((c) => `${c.path}: ${c.why}`).join("; "));
      return { error: "Some changes clash with edits you've made since sharing. Nothing was written.", conflicts, dropped };
    }
    const files: ShareApply["files"] = [];
    for (const [p, after] of state) {
      const before = this.readReal(root, p);
      if (before === after) continue;
      files.push({ path: p, before, after });
    }
    const record = await this.store.put<ShareApply>("shareApplies", { id: randomUUID(), createdAt: this.hub.clock().toISOString(), shareId, eventIds: events.map((e) => e.id), files });
    for (const f of files) this.writeReal(root, f.path, f.after);
    await this.mark(events, "applied", record.id);
    await this.hub.log("share", `Applied ${files.length} file change${files.length === 1 ? "" : "s"} to ${basename(root)}`);
    return { value: { applyId: record.id, files: files.map((f) => f.path), dropped } };
  }

  private writeReal(root: string, p: string, content: string | null) {
    const full = this.realPath(root, p);
    if (!full) return;
    if (content == null) rmSync(full, { force: true });
    else { mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, content); }
  }

  /** Put every file an apply touched back exactly as it was. */
  async undo(shareId: string, applyId: string) {
    const s = await this.get(shareId);
    const a = await this.store.get<ShareApply>("shareApplies", applyId);
    if (!s?.folder || !a || a.shareId !== shareId) return { error: "Nothing to undo." };
    if (a.undoneAt) return { error: "Already undone." };
    for (const f of a.files) this.writeReal(s.folder.path, f.path, f.before);
    await this.store.put<ShareApply>("shareApplies", { ...a, undoneAt: this.hub.clock().toISOString() });
    const events = await this.editEvents(shareId, a.eventIds, ["applied"]);
    await this.mark(events, "pending");
    await this.hub.log("share", `Undid ${a.files.length} file change${a.files.length === 1 ? "" : "s"} in ${basename(s.folder.path)}`);
    return { value: { restored: a.files.map((f) => f.path) } };
  }

  private uniqueSibling(root: string, name: string) {
    const safe = name.replace(/[\/\\:\0]/g, "-").slice(0, 120);
    let dest = join(dirname(root), safe);
    for (let i = 2; existsSync(dest); i++) dest = join(dirname(root), `${safe} ${i}`);
    return dest;
  }

  private async branch(s: Share, events: ShareEvent[]) {
    const root = s.folder!.path;
    const top = git(root, ["rev-parse", "--show-toplevel"]);
    if (!top.ok) return { error: "This folder isn't a git repo. Use Apply or Save as a copy." };
    const prefix = relative(realpathSync(top.out), root);
    const visitor = events[0].event.kind === "edit" ? events[0].event.visitor : "visitor";
    const branch = `hearth/${visitor.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "visitor"}-${randomBytes(3).toString("hex")}`;
    const wt = mkdtempSync(join(tmpdir(), "hearth-branch-"));
    rmSync(wt, { recursive: true, force: true });
    const add = git(root, ["worktree", "add", "-q", "-b", branch, wt, "HEAD"]);
    if (!add.ok) return { error: `Couldn't make a branch: ${add.err.slice(0, 200)}` };
    const wtRoot = prefix ? join(wt, prefix) : wt;
    try {
      for (const e of events) {
        const { state, conflicts, dropped } = this.plan(s, wtRoot, [e]);
        if (conflicts.length) {
          git(root, ["worktree", "remove", "--force", wt]); git(root, ["branch", "-D", branch]);
          await this.mark(events, "conflict", conflicts.map((c) => `${c.path}: ${c.why}`).join("; "));
          return { error: "A change clashes with the branch. Nothing was committed.", conflicts, dropped };
        }
        for (const [p, after] of state) this.writeReal(wtRoot, p, after);
        const ev = e.event.kind === "edit" ? e.event : null;
        git(wt, ["add", "-A", "--", prefix || "."]);
        git(wt, ["-c", "user.name=Hearth", "-c", "user.email=hearth@localhost", "commit", "-q", "--no-verify", "-m", `${ev?.visitor}: ${ev?.asked.slice(0, 72)}\n\n${ev?.note || ""}`.trim()]);
      }
    } finally { git(root, ["worktree", "remove", "--force", wt]); }
    await this.mark(events, "branched", branch);
    return { value: { branch } };
  }
}
