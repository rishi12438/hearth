import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parse, test as testFormula, variablesOf, normalize, FormulaError, type Node } from "./formula.ts";
import { computeNextAt } from "../hooks.ts";
import { wallParts } from "../time.ts";
import type { Trigger as HookTrigger } from "../types.ts";
import { cleanJudge, checkValue, eventText, type Judge, type JudgeExample, type JudgeValue } from "./judge.ts";

// The event pipeline: anything pushes events into a source, every event is written down, and a consumer checks it
// against every trigger on that source. A trigger is a formula (plain code, see formula.ts) plus what to do.
//
//   anything ──push──► source ──► events (saved) ──► every trigger: formula ──true──► action (notify / think / workflow)
//
// - A source is a named inbox with its own variables. Push sources get a secret URL; anything can call it.
// - "time" is the built-in source: timers sit in a table with their next run, and the minter pushes one event
//   when each comes due (time_to_run, scheduled_for, late_by_min, hour, weekday…), so time rules are formulas too.
// - Everything lives in its own SQLite file (data/events.db) with real columns, so it's easy to inspect and delete.
// - Every create/update is checked for conflicts first (same name, same service twice, a rule that overlaps one
//   you have, a variable the source never sends). A conflict comes back with what clashed and what to do instead.

export type SourceVar = { name: string; description?: string };
export type SourceKind = "push" | "time";
export type EventSource = {
  id: string; name: string; kind: SourceKind; description: string;
  /** What it's about, for duplicate checks: the same service + scope can't be two sources. */
  service: string | null; scope: string | null;
  variables: SourceVar[];
  /** variable -> where to find it in what was pushed ("pull_request.title", "headers.x-github-event"). */
  mapping: Record<string, string> | null;
  status: "active" | "paused"; createdBy: string;
  createdAt: string; updatedAt: string; lastEventAt: string | null; eventCount: number;
};
export type TriggerAction =
  | { type: "notify"; text: string }
  | { type: "think"; prompt: string }
  | { type: "workflow"; name: string; inputs: Record<string, string> };
export type EventTrigger = {
  id: string; name: string; sourceId: string; sourceName: string;
  /** The rule, checked with plain code against each event's variables. With a judge, it says which events to ask about. */
  formula: string;
  /** Optional: one question for the quick model, answered with one value (judge), then compared by judge.pass. */
  judge: Judge | null;
  /** Corrections you gave this trigger's judge. */
  examples: number;
  action: TriggerAction; why: string;
  status: "active" | "paused"; cooldownMin: number;
  lastFiredAt: string | null; fireCount: number;
  createdBy: string; teammateId: string | null; threadId: string | null;
  createdAt: string; updatedAt: string;
};
export type TimerSchedule =
  | { at: string; repeat?: "none" | "daily" | "weekdays" | "weekly" | "monthly" }
  | { time: string; days: number[] }
  | { everyMin: number };
export type Timer = {
  id: string; name: string; schedule: TimerSchedule; data: Record<string, unknown>;
  nextAt: string | null; lastRunAt: string | null; runCount: number;
  status: "active" | "paused" | "done"; createdBy: string; createdAt: string; updatedAt: string;
};
export type EventStatus = "new" | "processing" | "matched" | "unmatched" | "failed";
export type LogLine = { at: string; triggerId: string | null; step: string; detail: string; value?: JudgeValue };
export type PipelineEvent = {
  id: string; sourceId: string; sourceName: string; status: EventStatus;
  variables: Record<string, unknown>; payload: unknown; depth: number; test: boolean;
  receivedAt: string; processedAt: string | null; error: string | null;
  log?: LogLine[];
};
export type Conflict = { kind: "name" | "duplicate" | "overlap" | "variables" | "protected" | "loop"; message: string; existing?: { id: string; name: string }; options: string[] };
export type Result<T> = { value: T; error?: undefined; conflict?: undefined } | { value?: undefined; error: string; conflict?: Conflict };

/** What the hub does when a trigger matches. `quiet` = it ran and chose not to speak. `judge` = the judge's value, if any. */
export type Runner = (trigger: EventTrigger, event: PipelineEvent, judge?: JudgeValue) => Promise<{ text?: string; quiet?: boolean }>;
/** Asks the quick model a trigger's judge question about an event; returns the one value (or throws). */
export type JudgeFn = (judge: Judge, event: PipelineEvent, examples: JudgeExample[]) => Promise<JudgeValue>;
/** At most this many judge calls per trigger per hour, so a busy source can't run up a bill. */
export const JUDGE_PER_HOUR = 60;

export const TIME_SOURCE = "time";
export const TIME_VARIABLES: SourceVar[] = [
  { name: "time_to_run", description: "the timer's name" },
  { name: "scheduled_for", description: "when it was due (ISO)" },
  { name: "current_time", description: "when it actually ran (ISO)" },
  { name: "late_by_min", description: "minutes late (the hub was off or busy)" },
  { name: "hour", description: "0-23, your time zone" },
  { name: "minute", description: "0-59" },
  { name: "weekday", description: "Sun, Mon, … Sat" },
  { name: "date", description: "YYYY-MM-DD" },
  { name: "data", description: "whatever the timer carries (data.who, data.url…)" },
];
/** Every event also has these, whatever the source. */
const ALWAYS = ["source", "payload"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const MAX_PAYLOAD = 64_000;
const MAX_DEPTH = 3;
const KEEP_DAYS = 30;
const KEEP_EVENTS = 5000;

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const j = (x: unknown) => JSON.stringify(x ?? null);
const str = (x: unknown, max: number) => (typeof x === "string" ? x.trim().slice(0, max) : "");
const slug = (x: unknown) => str(x, 48).toLowerCase().replace(/\s+/g, "-");

/** Fill {{var.path}} from an event's variables (missing ones become empty). */
export function fillTemplate(s: string, vars: Record<string, unknown>) {
  return s.replace(/\{\{\s*([\w$.-]+)\s*\}\}/g, (_, path: string) => {
    let cur: any = vars;
    for (const k of path.split(".")) cur = cur != null && typeof cur === "object" ? cur[k] : undefined;
    return cur == null ? "" : typeof cur === "object" ? JSON.stringify(cur) : String(cur);
  });
}

function pick(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const k of path.split(".")) {
    if (cur == null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, k)) return null;
    cur = cur[k];
  }
  return cur ?? null;
}

export class EventPipeline {
  readonly db: Database;
  private trees = new Map<string, Node>();
  private draining: Promise<void> | null = null;
  private again = false;
  private depth = new AsyncLocalStorage<number>();
  /** Set by the hub. */
  run: Runner = async () => ({ quiet: true });
  /** Set by the hub: the quick model answers judge questions. */
  judgeFn: JudgeFn = async () => { throw new Error("No model to judge with."); };
  /** Extra checks on an action (e.g. the workflow exists). Returns an error, or null. */
  checkAction: (a: TriggerAction) => Promise<string | null> = async () => null;
  /** Something changed: the hub tells open apps. */
  onChange: (what: "sources" | "triggers" | "timers" | "events", detail?: { created?: string; by?: string }) => void = () => {};

  constructor(file: string, readonly clock: () => Date = () => new Date(), readonly tz: () => Promise<string> = async () => "UTC") {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new Database(file, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        service TEXT, scope TEXT,
        variables TEXT NOT NULL CHECK (json_valid(variables)),
        mapping TEXT CHECK (mapping IS NULL OR json_valid(mapping)),
        secret TEXT, status TEXT NOT NULL DEFAULT 'active', created_by TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_event_at TEXT, event_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS triggers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        formula TEXT NOT NULL,
        judge TEXT CHECK (judge IS NULL OR json_valid(judge)),
        action TEXT NOT NULL CHECK (json_valid(action)),
        why TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', cooldown_min INTEGER NOT NULL DEFAULT 0,
        last_fired_at TEXT, fire_count INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL, teammate_id TEXT, thread_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS triggers_source ON triggers (source_id, status);
      CREATE TABLE IF NOT EXISTS timers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
        schedule TEXT NOT NULL CHECK (json_valid(schedule)),
        data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
        next_at TEXT, last_run_at TEXT, run_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active', created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS timers_due ON timers (status, next_at);
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL, source_name TEXT NOT NULL, status TEXT NOT NULL,
        variables TEXT NOT NULL CHECK (json_valid(variables)),
        payload TEXT CHECK (payload IS NULL OR json_valid(payload)),
        depth INTEGER NOT NULL DEFAULT 0, test INTEGER NOT NULL DEFAULT 0,
        received_at TEXT NOT NULL, processed_at TEXT, error TEXT
      );
      CREATE INDEX IF NOT EXISTS events_status ON events (status, received_at);
      CREATE INDEX IF NOT EXISTS events_source ON events (source_id, received_at);
      CREATE TABLE IF NOT EXISTS event_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        trigger_id TEXT, at TEXT NOT NULL, step TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
        value TEXT CHECK (value IS NULL OR json_valid(value))
      );
      CREATE INDEX IF NOT EXISTS event_log_event ON event_log (event_id, id);
      CREATE INDEX IF NOT EXISTS event_log_trigger ON event_log (trigger_id, step, at);
      CREATE TABLE IF NOT EXISTS judge_examples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
        event_id TEXT, input TEXT NOT NULL,
        value TEXT NOT NULL CHECK (json_valid(value)),
        judged TEXT CHECK (judged IS NULL OR json_valid(judged)),
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS judge_examples_trigger ON judge_examples (trigger_id, id);
    `);
    // Files made before judges existed get the new columns.
    for (const [table, col, def] of [["triggers", "judge", "TEXT"], ["event_log", "value", "TEXT"]]) {
      const cols = this.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    }
    // A run cut off by a restart isn't run again (it may have half-happened); it's marked so you can see it.
    this.db.query("UPDATE events SET status = 'failed', error = 'The hub stopped while this was running.' WHERE status = 'processing'").run();
    this.ensureTimeSource();
  }

  close() { this.db.close(); }

  private now() { return this.clock().toISOString(); }

  private ensureTimeSource() {
    const now = this.now();
    const row = this.db.query("SELECT id FROM sources WHERE name = ?").get(TIME_SOURCE) as any;
    if (row) { this.db.query("UPDATE sources SET variables = ? WHERE id = ?").run(j(TIME_VARIABLES), row.id); return; }
    this.db.query(`INSERT INTO sources (id, name, kind, description, service, scope, variables, mapping, secret, status, created_by, created_at, updated_at)
      VALUES (?, ?, 'time', ?, 'hearth', 'clock', ?, NULL, NULL, 'active', 'system', ?, ?)`)
      .run(randomUUID(), TIME_SOURCE, "Hearth's clock: one event each time a timer comes due.", j(TIME_VARIABLES), now, now);
  }

  // ---------- rows <-> objects ----------

  private source(r: any): EventSource {
    return { id: r.id, name: r.name, kind: r.kind, description: r.description, service: r.service, scope: r.scope,
      variables: JSON.parse(r.variables), mapping: r.mapping ? JSON.parse(r.mapping) : null, status: r.status, createdBy: r.created_by,
      createdAt: r.created_at, updatedAt: r.updated_at, lastEventAt: r.last_event_at, eventCount: r.event_count };
  }
  private trigger(r: any): EventTrigger {
    return { id: r.id, name: r.name, sourceId: r.source_id, sourceName: r.source_name, formula: r.formula, judge: r.judge ? JSON.parse(r.judge) : null,
      examples: r.examples ?? 0, action: JSON.parse(r.action),
      why: r.why, status: r.status, cooldownMin: r.cooldown_min, lastFiredAt: r.last_fired_at, fireCount: r.fire_count,
      createdBy: r.created_by, teammateId: r.teammate_id, threadId: r.thread_id, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  private timer(r: any): Timer {
    return { id: r.id, name: r.name, schedule: JSON.parse(r.schedule), data: JSON.parse(r.data), nextAt: r.next_at, lastRunAt: r.last_run_at,
      runCount: r.run_count, status: r.status, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  private event(r: any): PipelineEvent {
    return { id: r.id, sourceId: r.source_id, sourceName: r.source_name, status: r.status, variables: JSON.parse(r.variables),
      payload: r.payload == null ? null : JSON.parse(r.payload), depth: r.depth, test: !!r.test,
      receivedAt: r.received_at, processedAt: r.processed_at, error: r.error };
  }

  // ---------- reading ----------

  sources(): EventSource[] { return (this.db.query("SELECT * FROM sources ORDER BY created_at").all() as any[]).map((r) => this.source(r)); }
  findSource(idOrName: string): EventSource | null {
    const r = this.db.query("SELECT * FROM sources WHERE id = ? OR name = ?").get(idOrName, String(idOrName).toLowerCase());
    return r ? this.source(r) : null;
  }
  private TRIGGERS = "SELECT t.*, s.name AS source_name, (SELECT count(*) FROM judge_examples x WHERE x.trigger_id = t.id) AS examples FROM triggers t JOIN sources s ON s.id = t.source_id";
  triggers(source?: string): EventTrigger[] {
    const s = source ? this.findSource(source) : null;
    if (source && !s) return [];
    const rows = s ? this.db.query(`${this.TRIGGERS} WHERE t.source_id = ? ORDER BY t.created_at`).all(s.id) : this.db.query(`${this.TRIGGERS} ORDER BY t.created_at`).all();
    return (rows as any[]).map((r) => this.trigger(r));
  }
  findTrigger(idOrName: string): EventTrigger | null {
    const r = this.db.query(`${this.TRIGGERS} WHERE t.id = ? OR t.name = ?`).get(idOrName, String(idOrName).toLowerCase());
    return r ? this.trigger(r) : null;
  }
  timers(): Timer[] { return (this.db.query("SELECT * FROM timers ORDER BY CASE WHEN next_at IS NULL THEN 1 ELSE 0 END, next_at").all() as any[]).map((r) => this.timer(r)); }
  findTimer(idOrName: string): Timer | null {
    const r = this.db.query("SELECT * FROM timers WHERE id = ? OR name = ?").get(idOrName, String(idOrName).toLowerCase());
    return r ? this.timer(r) : null;
  }
  events(o: { source?: string; status?: string; limit?: number; before?: string; log?: boolean } = {}): PipelineEvent[] {
    const where: string[] = [], args: any[] = [];
    if (o.source) { const s = this.findSource(o.source); where.push("source_id = ?"); args.push(s?.id ?? "-"); }
    if (o.status) { where.push("status = ?"); args.push(o.status); }
    if (o.before) { where.push("received_at < ?"); args.push(o.before); }
    const limit = Math.max(1, Math.min(500, o.limit || 50));
    const rows = this.db.query(`SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY received_at DESC, rowid DESC LIMIT ${limit}`).all(...args) as any[];
    const evs = rows.map((r) => this.event(r));
    if (o.log !== false) for (const e of evs) e.log = this.logOf(e.id);
    return evs;
  }
  getEvent(id: string): PipelineEvent | null {
    const r = this.db.query("SELECT * FROM events WHERE id = ?").get(id);
    if (!r) return null;
    const e = this.event(r);
    e.log = this.logOf(id);
    return e;
  }
  private logOf(eventId: string): LogLine[] {
    return (this.db.query("SELECT at, trigger_id, step, detail, value FROM event_log WHERE event_id = ? ORDER BY id").all(eventId) as any[])
      .map((r) => ({ at: r.at, triggerId: r.trigger_id, step: r.step, detail: r.detail, ...(r.value != null ? { value: JSON.parse(r.value) } : {}) }));
  }
  private log(eventId: string, step: string, detail = "", triggerId: string | null = null, value?: JudgeValue) {
    this.db.query("INSERT INTO event_log (event_id, trigger_id, at, step, detail, value) VALUES (?, ?, ?, ?, ?, ?)").run(eventId, triggerId, this.now(), step, detail.slice(0, 2000), value === undefined ? null : j(value));
  }

  // ---------- sources ----------

  private cleanVars(x: unknown): SourceVar[] | string {
    if (!Array.isArray(x)) return "variables must be a list like [{\"name\":\"from\"}, {\"name\":\"text\"}].";
    const out: SourceVar[] = [];
    for (const v of x.slice(0, 40)) {
      const name = typeof v === "string" ? v.trim() : str(v?.name, 40);
      if (!/^[a-z_][a-z0-9_]{0,39}$/i.test(name)) return `"${name}" isn't a usable variable name (letters, numbers, _).`;
      if (ALWAYS.includes(name)) return `"${name}" is already on every event; pick another name.`;
      if (out.some((o) => o.name === name)) continue;
      out.push({ name, description: typeof v === "object" ? str(v?.description, 160) || undefined : undefined });
    }
    if (!out.length) return "A source needs at least one variable.";
    return out;
  }
  private cleanMapping(x: unknown, vars: SourceVar[]): Record<string, string> | null | string {
    if (x == null) return null;
    if (typeof x !== "object" || Array.isArray(x)) return "mapping must be an object: {\"variable\": \"path.in.what.was.sent\"}.";
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(x as Record<string, unknown>).slice(0, 40)) {
      if (!vars.some((sv) => sv.name === k)) return `mapping names "${k}", which isn't one of the source's variables (${vars.map((v) => v.name).join(", ")}).`;
      const path = str(v, 200);
      if (!/^[\w$-]+(\.[\w$-]+)*$/.test(path)) return `mapping for "${k}" must be a dotted path like "body.sender.login".`;
      out[k] = path;
    }
    return out;
  }

  /** Make a push source. Returns its secret once: the URL is /api/events/<name>/<secret>. */
  createSource(input: any, createdBy = "you"): Result<{ source: EventSource; secret: string }> {
    const name = slug(input?.name);
    if (!NAME.test(name)) return { error: "A source needs a short name: lowercase letters, numbers and dashes (e.g. github-prs)." };
    const vars = this.cleanVars(input?.variables);
    if (typeof vars === "string") return { error: vars };
    const mapping = this.cleanMapping(input?.mapping, vars);
    if (typeof mapping === "string") return { error: mapping };
    const service = str(input?.service, 60).toLowerCase() || null;
    const scope = str(input?.scope, 120).toLowerCase() || null;
    const clash = this.findSource(name);
    if (clash) return this.conflict({ kind: "name", message: `There's already a source called "${name}".`, existing: clash, options: [`use "${name}" as it is`, `source.update "${name}" to add what's missing`, "pick a different name"] });
    if (service) {
      const dup = this.sources().find((s) => s.service === service && (s.scope || "") === (scope || ""));
      if (dup) return this.conflict({ kind: "duplicate", message: `"${dup.name}" already receives ${service}${scope ? ` for ${scope}` : ""}. Two sources would get every event twice.`, existing: dup, options: [`use "${dup.name}"`, `source.update "${dup.name}" (add variables or a mapping)`, "give a different scope if it really is something else"] });
    }
    const now = this.now(), id = randomUUID(), secret = randomBytes(24).toString("base64url");
    this.db.query(`INSERT INTO sources (id, name, kind, description, service, scope, variables, mapping, secret, status, created_by, created_at, updated_at)
      VALUES (?, ?, 'push', ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`)
      .run(id, name, str(input?.description, 300), service, scope, j(vars), mapping ? j(mapping) : null, secret, str(createdBy, 40) || "you", now, now);
    this.onChange("sources", { created: id, by: str(createdBy, 40) || "you" });
    return { value: { source: this.findSource(id)!, secret } };
  }

  updateSource(idOrName: string, input: any): Result<EventSource> {
    const s = this.findSource(idOrName);
    if (!s) return { error: `No source called "${idOrName}".` };
    if (s.kind === "time" && (input?.variables || input?.mapping || input?.name)) return this.conflict({ kind: "protected", message: "The time source is built in; only its status can change.", existing: s, options: ["add a timer with time.schedule instead"] });
    const vars = input?.variables !== undefined ? this.cleanVars(input.variables) : s.variables;
    if (typeof vars === "string") return { error: vars };
    // Dropping a variable a trigger still reads would break that trigger silently.
    const dropped = s.variables.filter((v) => !vars.some((n) => n.name === v.name)).map((v) => v.name);
    for (const t of this.triggers(s.id)) {
      const reads = variablesOf(this.tree(t.formula)!).map((p) => p.split(".")[0]);
      const gone = reads.filter((r) => dropped.includes(r));
      if (gone.length) return this.conflict({ kind: "variables", message: `Trigger "${t.name}" still reads ${gone.join(", ")}.`, existing: t, options: [`trigger.update "${t.name}" first`, "keep those variables"] });
    }
    const mapping = input?.mapping !== undefined ? this.cleanMapping(input.mapping, vars) : s.mapping ? this.cleanMapping(s.mapping, vars) : null;
    if (typeof mapping === "string") return { error: mapping };
    const status = input?.status === "paused" || input?.status === "active" ? input.status : s.status;
    const description = input?.description !== undefined ? str(input.description, 300) : s.description;
    const service = input?.service !== undefined ? str(input.service, 60).toLowerCase() || null : s.service;
    const scope = input?.scope !== undefined ? str(input.scope, 120).toLowerCase() || null : s.scope;
    if (service && (service !== s.service || scope !== s.scope)) {
      const dup = this.sources().find((o) => o.id !== s.id && o.service === service && (o.scope || "") === (scope || ""));
      if (dup) return this.conflict({ kind: "duplicate", message: `"${dup.name}" already receives ${service}${scope ? ` for ${scope}` : ""}.`, existing: dup, options: [`use "${dup.name}"`] });
    }
    this.db.query("UPDATE sources SET variables = ?, mapping = ?, status = ?, description = ?, service = ?, scope = ?, updated_at = ? WHERE id = ?")
      .run(j(vars), mapping ? j(mapping) : null, status, description, service, scope, this.now(), s.id);
    this.onChange("sources");
    return { value: this.findSource(s.id)! };
  }

  /** A new secret: the old URL stops working at once. */
  rotateSecret(idOrName: string): Result<{ source: EventSource; secret: string }> {
    const s = this.findSource(idOrName);
    if (!s) return { error: `No source called "${idOrName}".` };
    if (s.kind !== "push") return { error: "Only push sources have a URL." };
    const secret = randomBytes(24).toString("base64url");
    this.db.query("UPDATE sources SET secret = ?, updated_at = ? WHERE id = ?").run(secret, this.now(), s.id);
    this.onChange("sources");
    return { value: { source: s, secret } };
  }

  /** Delete a source and its triggers. Its past events stay in the log unless purgeEvents. */
  removeSource(idOrName: string, purgeEvents = false): Result<{ triggers: number; events: number }> {
    const s = this.findSource(idOrName);
    if (!s) return { error: `No source called "${idOrName}".` };
    if (s.kind === "time") return this.conflict({ kind: "protected", message: "The time source is built in and can't be deleted.", existing: s, options: ["pause it", "delete its timers or triggers instead"] });
    const triggers = this.triggers(s.id).length;
    let events = 0;
    if (purgeEvents) events = this.clearEvents({ source: s.id });
    this.db.query("DELETE FROM sources WHERE id = ?").run(s.id); // triggers go with it (ON DELETE CASCADE)
    this.onChange("sources"); this.onChange("triggers");
    return { value: { triggers, events } };
  }

  // ---------- triggers ----------

  private tree(formula: string): Node | null {
    let t = this.trees.get(formula);
    if (!t) { try { t = parse(formula); } catch { return null; } this.trees.set(formula, t); if (this.trees.size > 2000) this.trees.clear(); }
    return t;
  }

  private cleanAction(a: any): TriggerAction | string {
    switch (a?.type) {
      case "notify": { const text = str(a.text, 1000); return text ? { type: "notify", text } : "A notify action needs text."; }
      case "think": { const prompt = str(a.prompt, 2000); return prompt ? { type: "think", prompt } : "A think action needs a prompt."; }
      case "workflow": {
        const name = str(a.name, 80);
        if (!name) return "A workflow action needs the workflow's name.";
        const inputs: Record<string, string> = {};
        if (a.inputs && typeof a.inputs === "object") for (const [k, v] of Object.entries(a.inputs).slice(0, 30)) inputs[k.slice(0, 40)] = String(v ?? "").slice(0, 2000);
        return { type: "workflow", name, inputs };
      }
    }
    return 'The action must be {"type":"notify","text"}, {"type":"think","prompt"} or {"type":"workflow","name","inputs"}.';
  }

  /** Variables a formula may read on this source; anything else is a typo. */
  private known(s: EventSource) { return new Set([...ALWAYS, ...s.variables.map((v) => v.name)]); }

  private checkFormula(formula: string, s: EventSource): string | null {
    let tree: Node;
    try { tree = parse(formula); } catch (e) { return e instanceof FormulaError ? `The formula doesn't read: ${e.message}` : "The formula doesn't read."; }
    const known = this.known(s);
    if (variablesOf(tree).some((p) => p.split(".")[0] === "judge")) return "The formula runs before the judge, so it can't read judge. Compare judge in judge.pass (e.g. \"judge >= 7\"); use the formula to pick which events to ask about (or \"true\").";
    const bad = variablesOf(tree).map((p) => p.split(".")[0]).filter((r) => !known.has(r));
    if (bad.length) return `"${s.name}" doesn't send ${[...new Set(bad)].join(", ")}. It sends: ${[...known].join(", ")}.`;
    return null;
  }

  private actionKey(a: TriggerAction, judge: Judge | null = null) {
    return (a.type === "workflow" ? `workflow:${a.name}` : a.type === "notify" ? `notify:${a.text}` : `think:${a.prompt}`) + (judge ? `|judge:${j(judge)}` : "");
  }
  private cleanJudgeFor(x: any, s: EventSource): Judge | null | string {
    if (x == null || x === false) return null;
    return cleanJudge(x, this.known(s));
  }

  async addTrigger(input: any, createdBy = "you"): Promise<Result<EventTrigger>> {
    const name = slug(input?.name);
    if (!NAME.test(name)) return { error: "A trigger needs a short name: lowercase letters, numbers and dashes." };
    const s = this.findSource(str(input?.source, 60));
    if (!s) return { error: `No source called "${str(input?.source, 60)}". Sources: ${this.sources().map((x) => x.name).join(", ")}.` };
    const formula = str(input?.formula ?? input?.when, 2000);
    const bad = this.checkFormula(formula, s);
    if (bad) return this.conflict({ kind: "variables", message: bad, options: ["fix the formula", `source.update "${s.name}" to add the variable`] });
    const action = this.cleanAction(input?.action);
    if (typeof action === "string") return { error: action };
    const judge = this.cleanJudgeFor(input?.judge, s);
    if (typeof judge === "string") return { error: judge };
    const extra = await this.checkAction(action);
    if (extra) return { error: extra };
    const clash = this.findTrigger(name);
    if (clash) return this.conflict({ kind: "name", message: `There's already a trigger called "${name}".`, existing: clash, options: [`trigger.update "${name}"`, "pick a different name"] });
    if (!input?.force) {
      const over = this.overlapping(s, formula, action, judge);
      if (over) return this.conflict(over);
    }
    const now = this.now(), id = randomUUID();
    const cooldown = Math.max(0, Math.min(10080, Math.round(Number(input?.cooldownMin) || 0)));
    this.db.query(`INSERT INTO triggers (id, name, source_id, formula, judge, action, why, status, cooldown_min, created_by, teammate_id, thread_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`)
      .run(id, name, s.id, formula, judge ? j(judge) : null, j(action), str(input?.why, 300), cooldown, str(createdBy, 40) || "you", str(input?.teammateId, 64) || null, str(input?.threadId, 64) || null, now, now);
    this.onChange("triggers", { created: id, by: str(createdBy, 40) || "you" });
    return { value: this.findTrigger(id)! };
  }

  async updateTrigger(idOrName: string, input: any): Promise<Result<EventTrigger>> {
    const t = this.findTrigger(idOrName);
    if (!t) return { error: `No trigger called "${idOrName}".` };
    const s = this.findSource(t.sourceId)!;
    const formula = input?.formula !== undefined || input?.when !== undefined ? str(input.formula ?? input.when, 2000) : t.formula;
    const bad = this.checkFormula(formula, s);
    if (bad) return this.conflict({ kind: "variables", message: bad, options: ["fix the formula"] });
    let action = t.action;
    if (input?.action !== undefined) {
      const a = this.cleanAction(input.action);
      if (typeof a === "string") return { error: a };
      const extra = await this.checkAction(a);
      if (extra) return { error: extra };
      action = a;
    }
    let judge = t.judge;
    if (input?.judge !== undefined) {
      const jd = this.cleanJudgeFor(input.judge, s);
      if (typeof jd === "string") return { error: jd };
      judge = jd;
    }
    if (!input?.force && (formula !== t.formula || input?.action !== undefined || input?.judge !== undefined)) {
      const over = this.overlapping(s, formula, action, judge, t.id);
      if (over) return this.conflict(over);
    }
    const status = input?.status === "paused" || input?.status === "active" ? input.status : t.status;
    const cooldown = input?.cooldownMin !== undefined ? Math.max(0, Math.min(10080, Math.round(Number(input.cooldownMin) || 0))) : t.cooldownMin;
    const why = input?.why !== undefined ? str(input.why, 300) : t.why;
    // A new question or answer kind makes old corrections meaningless.
    if (input?.judge !== undefined && j(judge?.prompt ?? null) + j(judge?.output ?? null) !== j(t.judge?.prompt ?? null) + j(t.judge?.output ?? null)) this.db.query("DELETE FROM judge_examples WHERE trigger_id = ?").run(t.id);
    this.db.query("UPDATE triggers SET formula = ?, judge = ?, action = ?, status = ?, cooldown_min = ?, why = ?, updated_at = ? WHERE id = ?")
      .run(formula, judge ? j(judge) : null, j(action), status, cooldown, why, this.now(), t.id);
    this.onChange("triggers");
    return { value: this.findTrigger(t.id)! };
  }

  removeTrigger(idOrName: string): boolean {
    const t = this.findTrigger(idOrName);
    if (!t) return false;
    this.db.query("DELETE FROM triggers WHERE id = ?").run(t.id);
    this.onChange("triggers");
    return true;
  }

  /**
   * Another trigger on the same source that does the same thing and would catch the same events: the same rule
   * written differently, or (from the recent events) everything this one catches is caught by it already.
   */
  private overlapping(s: EventSource, formula: string, action: TriggerAction, judge: Judge | null, except?: string): Conflict | null {
    const tree = this.tree(formula)!;
    const key = this.actionKey(action, judge);
    const same = this.triggers(s.id).filter((t) => t.id !== except && t.status === "active" && this.actionKey(t.action, t.judge) === key);
    if (!same.length) return null;
    const recent = this.events({ source: s.id, limit: 200, log: false }).filter((e) => !e.test);
    const mine = recent.filter((e) => testFormula(tree, this.varsOf(e)));
    for (const t of same) {
      const other = this.tree(t.formula);
      if (!other) continue;
      const sameRule = normalize(other) === normalize(tree);
      const covered = mine.length > 0 && mine.every((e) => testFormula(other, this.varsOf(e)));
      if (sameRule || covered) {
        return { kind: "overlap", message: sameRule ? `"${t.name}" already does this with the same rule.` : `"${t.name}" already does this and caught all ${mine.length} of the recent events this would.`,
          existing: t, options: [`keep "${t.name}"`, `trigger.update "${t.name}" to widen it`, "force: true to keep both anyway"] };
      }
    }
    return null;
  }

  private varsOf(e: PipelineEvent) { return { ...e.variables, source: e.sourceName, payload: e.payload }; }

  /** What a rule would have caught among recent events, and which existing triggers also catch those. */
  dryrun(sourceName: string, formula: string, limit = 200): Result<{ checked: number; matched: number; examples: PipelineEvent[]; alsoMatchedBy: { name: string; count: number }[]; note: string }> {
    const s = this.findSource(sourceName);
    if (!s) return { error: `No source called "${sourceName}".` };
    const bad = this.checkFormula(formula, s);
    if (bad) return { error: bad };
    const tree = this.tree(formula)!;
    const recent = this.events({ source: s.id, limit, log: false });
    const hits = recent.filter((e) => testFormula(tree, this.varsOf(e)));
    const also = this.triggers(s.id).map((t) => {
      const other = this.tree(t.formula);
      return { name: t.name, count: other ? hits.filter((e) => testFormula(other, this.varsOf(e))).length : 0 };
    }).filter((x) => x.count > 0);
    return { value: { checked: recent.length, matched: hits.length, examples: hits.slice(0, 5), alsoMatchedBy: also, note: "Judges aren't asked in a dry-run: matched = the events a judge would be asked about." } };
  }

  // ---------- timers (the time minter) ----------

  private cleanSchedule(x: any): TimerSchedule | string {
    if (x?.at) {
      const d = new Date(String(x.at));
      if (isNaN(d.getTime())) return "at must be a date and time (ISO 8601 with an offset).";
      const repeat = ["none", "daily", "weekdays", "weekly", "monthly"].includes(x.repeat) ? x.repeat : "none";
      return { at: d.toISOString(), repeat };
    }
    if (x?.time) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(x.time))) return 'time must be "HH:MM" (24-hour).';
      const days = Array.isArray(x.days) ? [...new Set(x.days.map(Number).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() as number[] : [];
      return { time: String(x.time), days };
    }
    if (x?.everyMin !== undefined) {
      const n = Math.round(Number(x.everyMin));
      if (!(n >= 5 && n <= 10080)) return "everyMin must be between 5 and 10080 (a week).";
      return { everyMin: n };
    }
    return 'A schedule is {"at":"<ISO>","repeat"?:"daily|weekdays|weekly|monthly"}, {"time":"HH:MM","days":[0-6]} or {"everyMin":n}.';
  }
  private asHook(s: TimerSchedule): HookTrigger {
    if ("at" in s) return { type: "at", at: s.at, repeat: s.repeat || "none" };
    if ("time" in s) return { type: "schedule", time: s.time, days: s.days.length ? s.days : [0, 1, 2, 3, 4, 5, 6] };
    return { type: "every", minutes: s.everyMin };
  }

  async addTimer(input: any, createdBy = "you"): Promise<Result<Timer>> {
    const name = slug(input?.name ?? input?.time_to_run);
    if (!NAME.test(name)) return { error: "A timer needs a short name (it becomes time_to_run): lowercase letters, numbers and dashes." };
    const schedule = this.cleanSchedule(input?.schedule ?? input);
    if (typeof schedule === "string") return { error: schedule };
    const data = input?.data && typeof input.data === "object" && !Array.isArray(input.data) ? input.data : {};
    if (j(data).length > 4000) return { error: "A timer's data is too big (4 KB at most)." };
    const clash = this.findTimer(name);
    if (clash) return this.conflict({ kind: "name", message: `There's already a timer called "${name}" (next ${clash.nextAt ?? "never"}).`, existing: clash, options: [`time.update "${name}" to move it`, "pick a different name"] });
    const now = this.clock();
    const first = "everyMin" in schedule ? new Date(now.getTime() + schedule.everyMin * 60000).toISOString() : computeNextAt(this.asHook(schedule), await this.tz(), now);
    if ("at" in schedule && (schedule.repeat || "none") === "none" && new Date(schedule.at) < new Date(now.getTime() - 60000)) return { error: "That time has already passed." };
    const id = randomUUID(), iso = now.toISOString();
    this.db.query("INSERT INTO timers (id, name, schedule, data, next_at, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)")
      .run(id, name, j(schedule), j(data), first, str(createdBy, 40) || "you", iso, iso);
    this.onChange("timers", { created: id, by: str(createdBy, 40) || "you" });
    return { value: this.findTimer(id)! };
  }

  async updateTimer(idOrName: string, input: any): Promise<Result<Timer>> {
    const t = this.findTimer(idOrName);
    if (!t) return { error: `No timer called "${idOrName}".` };
    let schedule = t.schedule, nextAt = t.nextAt;
    if (input?.schedule !== undefined) {
      const sc = this.cleanSchedule(input.schedule);
      if (typeof sc === "string") return { error: sc };
      schedule = sc;
      const now = this.clock();
      nextAt = "everyMin" in sc ? new Date(now.getTime() + sc.everyMin * 60000).toISOString() : computeNextAt(this.asHook(sc), await this.tz(), now);
    }
    const data = input?.data && typeof input.data === "object" && !Array.isArray(input.data) ? input.data : t.data;
    const status = ["active", "paused"].includes(input?.status) ? input.status : t.status === "done" && input?.schedule ? "active" : t.status;
    this.db.query("UPDATE timers SET schedule = ?, data = ?, next_at = ?, status = ?, updated_at = ? WHERE id = ?").run(j(schedule), j(data), nextAt, status, this.now(), t.id);
    this.onChange("timers");
    return { value: this.findTimer(t.id)! };
  }

  removeTimer(idOrName: string): boolean {
    const t = this.findTimer(idOrName);
    if (!t) return false;
    this.db.query("DELETE FROM timers WHERE id = ?").run(t.id);
    this.onChange("timers");
    return true;
  }

  /** Push one time event for every timer that's due. A timer missed while the hub was off runs once, late, and says so. */
  async mint(): Promise<number> {
    const now = this.clock(), iso = now.toISOString(), tz = await this.tz();
    const due = (this.db.query("SELECT * FROM timers WHERE status = 'active' AND next_at IS NOT NULL AND next_at <= ? ORDER BY next_at").all(iso) as any[]).map((r) => this.timer(r));
    const time = this.findSource(TIME_SOURCE)!;
    for (const t of due) {
      const sched = new Date(t.nextAt!);
      const w = wallParts(sched, tz);
      const next = "everyMin" in t.schedule
        ? new Date(Math.max(sched.getTime() + t.schedule.everyMin * 60000, now.getTime() + 1000)).toISOString()
        : computeNextAt(this.asHook(t.schedule), tz, now, true);
      // Moved on before the event goes out, so a slow consumer can't mint the same run twice.
      this.db.query("UPDATE timers SET next_at = ?, last_run_at = ?, run_count = run_count + 1, status = ?, updated_at = ? WHERE id = ?")
        .run(next, iso, next ? "active" : "done", iso, t.id);
      if (time.status !== "active") continue;
      this.insertEvent(time, {
        time_to_run: t.name, scheduled_for: t.nextAt, current_time: iso,
        late_by_min: Math.max(0, Math.floor((now.getTime() - sched.getTime()) / 60000)),
        hour: w.h, minute: w.mi, weekday: WEEKDAYS[w.wd], date: `${w.y}-${String(w.m).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`,
        data: t.data,
      }, { timer: t.name }, false);
    }
    if (due.length) { this.onChange("timers"); this.kick(); }
    return due.length;
  }

  // ---------- events in ----------

  /** A push source's secret, for its URL (/api/events/<name>/<secret>). Only the owner's API shows it. */
  secretOf(idOrName: string): string | null {
    const s = this.findSource(idOrName);
    return s ? ((this.db.query("SELECT secret FROM sources WHERE id = ?").get(s.id) as any)?.secret ?? null) : null;
  }

  /** Check a push URL's secret (constant time). */
  private secretOk(s: EventSource, secret: string) {
    const row = this.db.query("SELECT secret FROM sources WHERE id = ?").get(s.id) as any;
    if (!row?.secret || !secret) return false;
    const a = Buffer.from(hash(secret), "hex"), b = Buffer.from(hash(row.secret), "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Something pushed to /api/events/<source>/<secret>. Null when the source or secret is wrong. */
  push(sourceName: string, secret: string, body: string, headers: Record<string, string> = {}): Result<PipelineEvent> | null {
    const s = this.findSource(sourceName);
    if (!s || s.kind !== "push" || !this.secretOk(s, secret)) return null;
    if (s.status !== "active") return { error: "This source is paused." };
    if (body.length > MAX_PAYLOAD) return { error: "Too large." };
    let payload: unknown;
    try { payload = body.trim() ? JSON.parse(body) : {}; } catch { payload = { text: body }; }
    return this.publish(s, payload, headers);
  }

  /** Publish from inside the hub (a built-in watcher, a test, a workflow). */
  publish(source: EventSource | string, payload: unknown, headers: Record<string, string> = {}, test = false): Result<PipelineEvent> {
    const s = typeof source === "string" ? this.findSource(source) : source;
    if (!s) return { error: `No source called "${source}".` };
    if (s.kind === "time") return this.conflict({ kind: "protected", message: "Only timers push to the time source.", options: ["time.schedule a timer"] });
    const depth = (this.depth.getStore() ?? -1) + 1;
    if (depth > MAX_DEPTH) return this.conflict({ kind: "loop", message: `Events are triggering events ${depth} deep; stopped so it can't loop forever.`, options: ["check the triggers on this source"] });
    const vars: Record<string, unknown> = {};
    const low = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    for (const v of s.variables) {
      const path = s.mapping?.[v.name];
      vars[v.name] = path ? (path.startsWith("headers.") ? low[path.slice(8).toLowerCase()] ?? null : pick(payload, path)) : pick(payload, v.name);
    }
    return { value: this.insertEvent(s, vars, payload, test, depth) };
  }

  private insertEvent(s: EventSource, vars: Record<string, unknown>, payload: unknown, test: boolean, depth = 0): PipelineEvent {
    const id = randomUUID(), now = this.now();
    let p = j(payload);
    if (p.length > MAX_PAYLOAD) p = j({ truncated: true, text: p.slice(0, 8000) });
    this.db.query("INSERT INTO events (id, source_id, source_name, status, variables, payload, depth, test, received_at) VALUES (?, ?, ?, 'new', ?, ?, ?, ?, ?)")
      .run(id, s.id, s.name, j(vars), p, depth, test ? 1 : 0, now);
    this.db.query("UPDATE sources SET last_event_at = ?, event_count = event_count + 1 WHERE id = ?").run(now, s.id);
    this.log(id, "received", test ? "test event" : s.kind === "time" ? `timer ${vars.time_to_run}` : `from ${s.name}`);
    this.onChange("events");
    this.kick();
    return this.getEvent(id)!;
  }

  // ---------- the consumer ----------

  private kick() { queueMicrotask(() => { void this.drain(); }); }

  /** Work through every new event in order. Safe to call any time; only one pass runs at once. */
  drain(): Promise<void> {
    if (this.draining) { this.again = true; return this.draining; }
    this.draining = (async () => {
      await null; // so `this.draining` is set before the finally below can clear it
      try {
        do {
          this.again = false;
          for (;;) {
            const row = this.db.query("SELECT * FROM events WHERE status = 'new' ORDER BY received_at, rowid LIMIT 1").get();
            if (!row) break;
            await this.process(this.event(row));
          }
        } while (this.again);
      } finally { this.draining = null; }
    })();
    return this.draining;
  }

  private async process(e: PipelineEvent) {
    this.db.query("UPDATE events SET status = 'processing' WHERE id = ?").run(e.id);
    const vars = this.varsOf(e);
    let ran = 0, failed = 0;
    for (const t of this.triggers(e.sourceId).filter((x) => x.status === "active")) {
      const tree = this.tree(t.formula);
      if (!tree) { this.log(e.id, "failed", `formula doesn't read: ${t.formula}`, t.id); failed++; continue; }
      if (!testFormula(tree, vars)) continue;
      const now = this.clock();
      if (t.cooldownMin && t.lastFiredAt && now.getTime() - new Date(t.lastFiredAt).getTime() < t.cooldownMin * 60000) {
        this.log(e.id, "cooldown", `${t.name}: matched, but it ran less than ${t.cooldownMin} min ago`, t.id);
        continue;
      }
      let value: JudgeValue | undefined;
      if (t.judge) {
        const hourAgo = new Date(now.getTime() - 3_600_000).toISOString();
        const asked = (this.db.query("SELECT count(*) AS n FROM event_log WHERE trigger_id = ? AND step IN ('judged', 'judge-failed') AND at >= ?").get(t.id, hourAgo) as any).n;
        if (asked >= JUDGE_PER_HOUR) { this.log(e.id, "skipped", `${t.name}: its judge was asked ${JUDGE_PER_HOUR} times in the last hour; not asking again yet`, t.id); continue; }
        try {
          value = await this.judgeFn(t.judge, e, this.examplesOf(t.id));
        } catch (err: any) {
          this.log(e.id, "judge-failed", `${t.name}: ${String(err?.message || err).slice(0, 300)}`, t.id);
          failed++;
          continue;
        }
        const passTree = this.tree(t.judge.pass);
        const passes = !!passTree && testFormula(passTree, { ...vars, judge: value });
        this.log(e.id, "judged", `${t.name}: judge = ${value} → ${passes ? "acts" : "doesn't act"} (${t.judge.pass})`, t.id, value);
        if (!passes) continue;
      }
      this.log(e.id, "matched", `${t.name}: ${t.formula}${t.judge ? ` and ${t.judge.pass}` : ""}`, t.id);
      this.db.query("UPDATE triggers SET last_fired_at = ?, fire_count = fire_count + 1 WHERE id = ?").run(now.toISOString(), t.id);
      try {
        const r = await this.depth.run(e.depth, () => this.run(t, e, value));
        this.log(e.id, r.quiet ? "quiet" : "ran", r.quiet ? `${t.name}: nothing worth saying` : `${t.name}: ${(r.text || "done").slice(0, 500)}`, t.id);
        ran++;
      } catch (err: any) {
        this.log(e.id, "failed", `${t.name}: ${String(err?.message || err).slice(0, 500)}`, t.id);
        failed++;
      }
    }
    const status: EventStatus = ran ? "matched" : failed ? "failed" : "unmatched";
    if (!ran && !failed) this.log(e.id, "unmatched", "no trigger matched");
    this.db.query("UPDATE events SET status = ?, processed_at = ?, error = ? WHERE id = ?").run(status, this.now(), failed && !ran ? "a trigger failed" : null, e.id);
    this.onChange("events");
  }

  // ---------- teaching the judges ----------

  private examplesOf(triggerId: string): JudgeExample[] {
    return (this.db.query("SELECT input, value FROM judge_examples WHERE trigger_id = ? ORDER BY id DESC LIMIT 8").all(triggerId) as any[])
      .reverse().map((r) => ({ input: r.input, value: JSON.parse(r.value) }));
  }

  /** Every correction a trigger's judge has, newest first. */
  examples(trigger: string) {
    const t = this.findTrigger(trigger);
    if (!t) return [];
    return (this.db.query("SELECT id, event_id, input, value, judged, created_at FROM judge_examples WHERE trigger_id = ? ORDER BY id DESC").all(t.id) as any[])
      .map((r) => ({ id: r.id, eventId: r.event_id, input: r.input, value: JSON.parse(r.value), judged: r.judged == null ? null : JSON.parse(r.judged), createdAt: r.created_at }));
  }

  /**
   * "The judge got this one wrong: it should be <value>." Kept as an example the judge sees next time
   * (the last 8 per trigger; at most 50 kept). Re-correcting the same event replaces its example.
   */
  correct(eventId: string | null, trigger: string, value: unknown): Result<{ value: JudgeValue; examples: number }> {
    const t = this.findTrigger(trigger);
    if (!t) return { error: `No trigger called "${trigger}".` };
    if (!t.judge) return { error: `"${t.name}" has no judge to correct.` };
    // No event named: the last one this trigger's judge answered.
    const id = eventId || (this.db.query("SELECT event_id FROM event_log WHERE trigger_id = ? AND step = 'judged' ORDER BY id DESC LIMIT 1").get(t.id) as any)?.event_id;
    const e = id ? this.getEvent(id) : null;
    if (!e) return { error: "That event isn't in the log any more." };
    const v = checkValue(value, t.judge.output);
    if (v === null) return { error: `"${value}" isn't an answer this judge can give.` };
    const judged = e.log?.filter((l) => l.triggerId === t.id && l.step === "judged").at(-1)?.value;
    this.db.query("DELETE FROM judge_examples WHERE trigger_id = ? AND event_id = ?").run(t.id, e.id);
    this.db.query("INSERT INTO judge_examples (trigger_id, event_id, input, value, judged, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(t.id, e.id, eventText(e).slice(0, 1500), j(v), judged === undefined ? null : j(judged), this.now());
    this.db.query("DELETE FROM judge_examples WHERE trigger_id = ? AND id NOT IN (SELECT id FROM judge_examples WHERE trigger_id = ? ORDER BY id DESC LIMIT 50)").run(t.id, t.id);
    this.log(e.id, "corrected", `${t.name}: you said ${v}${judged !== undefined ? ` (the judge said ${judged})` : ""}`, t.id, v);
    this.onChange("triggers");
    return { value: { value: v, examples: this.examples(t.id).length } };
  }

  forgetExample(id: number) { const ok = !!this.db.query("SELECT 1 FROM judge_examples WHERE id = ?").get(id); this.db.query("DELETE FROM judge_examples WHERE id = ?").run(id); if (ok) this.onChange("triggers"); return ok; }

  // ---------- housekeeping ----------

  removeEvent(id: string) {
    if (!this.db.query("SELECT 1 FROM events WHERE id = ?").get(id)) return false;
    this.db.query("DELETE FROM events WHERE id = ?").run(id);
    this.onChange("events");
    return true;
  }

  clearEvents(o: { source?: string; status?: string } = {}) {
    const where: string[] = ["status != 'processing'"], args: any[] = [];
    if (o.source) { where.push("source_id = ?"); args.push(this.findSource(o.source)?.id ?? "-"); }
    if (o.status) { where.push("status = ?"); args.push(o.status); }
    // Counted first: SQLite's change count also includes the log lines that go with each event.
    const n = (this.db.query(`SELECT count(*) AS n FROM events WHERE ${where.join(" AND ")}`).get(...args) as any).n as number;
    this.db.query(`DELETE FROM events WHERE ${where.join(" AND ")}`).run(...args);
    this.onChange("events");
    return n;
  }

  /** Keep the last 30 days and at most 5000 events. */
  prune() {
    const cutoff = new Date(this.clock().getTime() - KEEP_DAYS * 86_400_000).toISOString();
    let n = this.db.query("DELETE FROM events WHERE received_at < ? AND status NOT IN ('new', 'processing')").run(cutoff).changes;
    n += this.db.query(`DELETE FROM events WHERE id IN (SELECT id FROM events WHERE status NOT IN ('new', 'processing') ORDER BY received_at DESC LIMIT -1 OFFSET ${KEEP_EVENTS})`).run().changes;
    return n;
  }

  /** One tick of the hub: mint due timers, work the queue, tidy up. */
  async tick() {
    await this.mint();
    await this.drain();
    this.prune();
  }

  private conflict(c: Conflict): { error: string; conflict: Conflict } {
    return { error: `${c.message} Options: ${c.options.join("; ")}.`, conflict: c };
  }
}
