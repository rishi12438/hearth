import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import type { Store, Collection } from "./store/index.ts";
import type { Brain, BrainInput, BrainProfile, Brains, Meter } from "./brain.ts";
import { QUIET, ESCALATE, HARNESSES, MODEL_RE, availableHarnesses } from "./brain.ts";
import type { Scripts } from "./scripts.ts";
import type { Push } from "./push.ts";
import { parseReply } from "./reply.ts";
import { validateHook, computeNextAt, describeTrigger, isUserReminder } from "./hooks.ts";
import { recall, isActive, validateFact } from "./memory.ts";
import { describeLocal, inQuietHours, quietEndsAt, localDate, distanceMeters } from "./time.ts";
import type { Activity, Approval, Done, Fact, Hook, Job, LocationFix, Message, Notebook, Place, Prefs, Script, Skill, Teammate, Thread, Workflow } from "./types.ts";
import { Library, validateSkill, validateWorkflow, fill } from "./library.ts";
import { cleanTile, cleanOptions, extractTiles, type Tile } from "./tiles.ts";

const DEFAULT_PREFS: Prefs = {
  userName: "", tz: "UTC", quietStart: "23:00", quietEnd: "07:30",
  maxProactivePerDay: 6, proactiveToday: { date: "", n: 0 }, placeState: {},
};
export const DEFAULT_TEAMMATES: Pick<Teammate, "id" | "name" | "color" | "description" | "prompt">[] = [
  { id: "hearth", name: "Hearth", color: "#F5A524", description: "Your front desk. Handles anything and remembers everything.",
    prompt: "You are Hearth, the user's main assistant. Handle anything; be brief and warm." },
  { id: "planner", name: "Planner", color: "#5B8CFF", description: "Reminders, routines, your day and week.",
    prompt: "You are Planner. You own the user's time: reminders, routines, follow-ups, planning the day and week. Prefer creating hooks." },
  { id: "scout", name: "Scout", color: "#2FBF71", description: "Finds things: places, products, answers from the web.",
    prompt: "You are Scout. You find things: places to eat, products, facts, prices. Search the web, give 3 good options with one line each." },
  { id: "money", name: "Money", color: "#E36BD6", description: "Bills, subscriptions, spending, saving.",
    prompt: "You are Money. You track bills, subscriptions and spending and nudge the user before due dates. Never move money; offer reminders and drafts." },
];

const REVIEW_MARKER = "[[memory-review]]";
const PURGE_MARKER = "[[library-purge]]";
const LOCATION_KEEP_DAYS = 7;

type TurnOpts = { teammate?: Teammate | null; threadId?: string; jobId?: string; extra?: string; profile?: BrainProfile; meter?: Meter; allowedScripts?: string[] };
const label = (p: BrainProfile) => `${p.harness}${p.model ? `/${p.model}` : ""}`;

/** The orchestrator answers with JSON; tolerate a code fence or prose around it. */
export function parsePlan(raw: string): any | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { const p = JSON.parse(m[0]); return p && typeof p === "object" && Array.isArray(p.jobs ?? []) ? p : null; } catch { return null; }
}

/** Runs async critical sections one at a time (read-modify-write on shared docs). */
class Lock {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});
    return next;
  }
}

export type HubEvent = { type: string; data?: unknown };

export class Hub {
  clock = () => new Date();
  private listeners = new Set<(e: HubEvent) => void>();
  private firing = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  thinking = false;
  private prefsLock = new Lock();
  private memoryLock = new Lock();
  private started = new Set<string>();   // job ids already handed to runJob
  private inflight = 0;                   // orchestrations, splits and retries still running
  private rambleSpend = new Map<string, number>(); // message id -> USD

  constructor(
    readonly config: Config, readonly store: Store, readonly brain: Brain,
    readonly scripts: Scripts, readonly push: Push | null,
    readonly library: Library = new Library(null),
  ) {}

  // ---------- plumbing ----------

  on(fn: (e: HubEvent) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type: string, data?: unknown) { for (const fn of this.listeners) { try { fn({ type, data }); } catch {} } }

  private doc<T>(fields: T) {
    const now = this.clock().toISOString();
    return { id: randomUUID(), createdAt: now, ...fields };
  }

  async prefs(): Promise<Prefs> {
    const p = await this.store.get<Prefs & { id: string; createdAt: string }>("settings", "prefs");
    return { ...DEFAULT_PREFS, ...(p || {}) };
  }

  setPrefs(patch: Partial<Prefs>) {
    return this.prefsLock.run(() => this.setPrefsNow(patch));
  }

  private async setPrefsNow(patch: Partial<Prefs>) {
    const cur = await this.prefs();
    const next = { ...cur, ...patch, id: "prefs", createdAt: "1970-01-01T00:00:00.000Z" };
    await this.store.put("settings", next);
    if (patch.tz && patch.tz !== cur.tz) await this.retime(patch.tz);
    this.emit("prefs");
    return next as Prefs;
  }

  /** Wall-clock schedules follow you to a new time zone. */
  private async retime(tz: string) {
    for (const h of await this.store.all<Hook>("hooks")) {
      if (h.status !== "active" || h.trigger.type !== "schedule") continue;
      await this.store.put<Hook>("hooks", { ...h, nextAt: computeNextAt(h.trigger, tz, this.clock()) });
    }
  }

  async log(kind: string, text: string) {
    const a = await this.store.put<Activity>("activity", this.doc({ kind, text: text.slice(0, 400) }));
    await this.trim("activity", 1000);
    this.emit("activity", a);
  }

  private async trim(col: Collection, keep: number) {
    const rows = await this.store.all(col);
    for (const r of rows.slice(0, Math.max(0, rows.length - keep))) await this.store.remove(col, r.id);
  }

  // ---------- context for the brain ----------

  async context(query: string, mode: BrainInput["mode"], teammate?: Teammate | null) {
    const now = this.clock();
    const prefs = await this.prefs();
    const facts = await this.store.all<Fact>("memory");
    const memory = mode === "review" ? facts.filter((f) => isActive(f, now)) : recall(facts, query, 40, now);
    const hooks = (await this.store.all<Hook>("hooks")).filter((h) => h.status !== "done" && h.source !== "system");
    const places = await this.store.all<Place>("places");
    const fix = (await this.store.recent<LocationFix>("locations", 1))[0];
    const history = await this.store.recent<Message>("messages", 14);
    const today = localDate(now, prefs.tz);
    const used = prefs.proactiveToday.date === today ? prefs.proactiveToday.n : 0;
    let location: Record<string, unknown> | null = null;
    if (fix) {
      const near = places.find((p) => distanceMeters(fix, p) <= p.radiusM);
      location = { lat: +fix.lat.toFixed(4), lon: +fix.lon.toFixed(4), minutesAgo: Math.round((now.getTime() - new Date(fix.createdAt).getTime()) / 60000), atPlace: near?.name ?? null };
    }
    const team = await this.store.all<Teammate>("teammates");
    return {
      you: teammate ? { name: teammate.name, role: teammate.prompt } : { name: "Hearth", role: "The user's main assistant." },
      teammates: team.map((t) => ({ name: t.name, does: t.description })),
      hub: this.config.name,
      nowIso: now.toISOString(),
      now: describeLocal(now, prefs.tz),
      tz: prefs.tz,
      userName: prefs.userName || undefined,
      quietHours: `${prefs.quietStart}-${prefs.quietEnd}`,
      proactiveMessagesLeftToday: Math.max(0, prefs.maxProactivePerDay - used),
      location,
      places: places.map((p) => ({ name: p.name, radiusM: p.radiusM })),
      memory: memory.map((f) => ({ id: f.id, fact: f.fact, notebook: f.notebook, importance: f.importance, ...(f.expiresAt ? { expiresAt: f.expiresAt } : {}) })),
      notebooks: (await this.store.all<Notebook>("notebooks")).map((n) => ({ name: n.name, summary: n.summary })),
      hooks: hooks.map((h) => ({ id: h.id, title: h.title, when: describeTrigger(h.trigger, prefs.tz), does: h.action.type, why: h.why, status: h.status })),
      scripts: (await this.scripts.list()).filter((s) => s.status !== "rejected").map((s) => ({ name: s.name, description: s.description, status: s.status })),
      recentMessages: history.map((m) => ({ role: m.role, at: m.createdAt, text: m.text.slice(0, 600) })),
      library: mode === "review" ? undefined : await this.searchLibrary(query),
    };
  }

  // ---------- one brain turn, with an optional script round-trip ----------

  async turn(mode: BrainInput["mode"], input: string, evidence: string, opts: TurnOpts = {}) {
    const { teammate, extra } = opts;
    const profile = opts.profile || (await this.brains()).workhorse;
    const where = { teammateId: teammate?.id, threadId: opts.threadId, jobId: opts.jobId, recipe: opts.allowedScripts };
    const ctx = await this.context(input, mode, teammate);
    const first = parseReply(await this.brain.think({ mode, context: ctx, input, toolResults: extra }, profile, opts.meter));
    if (first.text.includes(ESCALATE)) return { text: ESCALATE, did: [] as Done[], used: [] as string[] };
    const applied = await this.applyActions(first.actions, evidence, where);
    if (!applied.runs.length) return { text: first.text, did: applied.done, used: applied.used, split: applied.split, tiles: applied.tiles };
    const scriptTiles: Tile[] = [];

    const results: string[] = [];
    for (const r of applied.runs.slice(0, 3)) {
      if (opts.allowedScripts && !opts.allowedScripts.includes(r.name)) {
        results.push(`## ${r.name}\nNot allowed: this recipe may only use ${opts.allowedScripts.join(", ") || "no scripts"}.`);
        continue;
      }
      const out = await this.scripts.run(r.name, r.args);
      if (out.needsApproval) {
        const ap = await this.requestApproval({ summary: `Run ${r.name} ${r.args.join(" ")}`.trim(), script: r.name, args: r.args }, where);
        applied.done.push({ kind: "approval", label: `Waiting for your Approve: ${r.name}`, id: ap.value?.id });
        results.push(`## ${r.name}\nThis changes something outside the hub, so it is waiting for the user's Approve. Tell them.`);
        continue;
      }
      applied.done.push({ kind: "script", label: `Ran ${r.name}${out.ok ? "" : " (failed)"}` });
      const ex = extractTiles(out.output);
      scriptTiles.push(...ex.tiles);
      results.push(`## ${r.name}\n${ex.text}${ex.tiles.length ? `\n(${ex.tiles.length} tile(s) already shown to the user)` : ""}`);
    }
    const ctx2 = await this.context(input, mode, teammate);
    const second = parseReply(await this.brain.think({ mode, context: ctx2, input, toolResults: [extra, ...results].filter(Boolean).join("\n\n") }, profile, opts.meter));
    const applied2 = await this.applyActions(second.actions.filter((a: any) => a?.type !== "script.run"), evidence, where);
    const tiles = [...applied.tiles, ...applied2.tiles, ...scriptTiles].slice(0, 4);
    return { text: second.text || first.text, did: [...applied.done, ...applied2.done], used: [...applied.used, ...applied2.used], split: applied.split ?? applied2.split, tiles };
  }

  // ---------- brains: who plans, who works ----------

  async brains(): Promise<Brains> {
    const saved = (await this.prefs()).brains;
    return { ...this.brain.defaults(), ...(saved || {}) };
  }

  async setBrains(patch: any) {
    const allowed = availableHarnesses(this.config);
    const cur = await this.brains();
    const next: Brains = { ...cur };
    for (const role of ["orchestrator", "workhorse", "heavy"] as const) {
      const p = patch?.[role];
      if (!p) continue;
      const harness = String(p.harness || "");
      const model = String(p.model ?? "");
      if (!(HARNESSES as readonly string[]).includes(harness) || !allowed.includes(harness)) return { error: `${harness} isn't available on this hub.` };
      if (!MODEL_RE.test(model)) return { error: "Model names are letters, digits, dots, dashes and slashes." };
      next[role] = { harness, model };
    }
    await this.setPrefs({ brains: next });
    await this.log("brains", `Orchestrator ${label(next.orchestrator)}, workhorse ${label(next.workhorse)}, heavy ${label(next.heavy)}`);
    return { value: next };
  }

  // ---------- rambles: you talk, the orchestrator hands out jobs ----------

  /** Group chats (one per ramble), newest first, with who's in them and whether anything is running or needs you. */
  async listThreads() {
    const jobs = (await this.store.all<Job>("jobs")).filter((j) => !j.parentId);
    return (await this.store.all<Thread>("threads"))
      .filter((t) => !t.id.startsWith("tm-") && t.id !== "main")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((t) => {
        const mine = jobs.filter((j) => j.threadId === t.id);
        return { ...t, members: [...new Set(mine.map((j) => j.teammateId))],
          working: mine.filter((j) => j.status === "working" || j.status === "queued").length,
          needsYou: mine.filter((j) => j.status === "waiting" || j.status === "blocked").length };
      });
  }

  async threadDetail(id: string) {
    const thread = await this.store.get<Thread>("threads", id);
    if (!thread) return null;
    const messages = (await this.store.all<Message>("messages")).filter((m) => m.threadId === id);
    const jobs = (await this.store.all<Job>("jobs")).filter((j) => j.threadId === id);
    return { thread, messages, jobs };
  }

  async removeThread(id: string) {
    for (const m of (await this.store.all<Message>("messages")).filter((m) => m.threadId === id)) await this.store.remove("messages", m.id);
    for (const j of (await this.store.all<Job>("jobs")).filter((j) => j.threadId === id)) await this.store.remove("jobs", j.id);
    const ok = await this.store.remove("threads", id);
    this.emit("threads");
    return ok;
  }

  private async touchThread(id: string, patch: Partial<Thread>) {
    const t = await this.store.get<Thread>("threads", id);
    if (!t) return;
    await this.store.put<Thread>("threads", { ...t, ...patch, updatedAt: this.clock().toISOString() });
    this.emit("threads");
  }

  /** Your direct messages with a teammate (Slack DM). Proactive messages from hooks born outside a chat land in Hearth's. */
  async dmThread(teammateId: string) {
    const id = `tm-${teammateId}`;
    const t = await this.store.get<Thread>("threads", id);
    if (t) return t;
    const now = this.clock().toISOString();
    return this.store.put<Thread>("threads", { id, createdAt: now, updatedAt: now, title: (await this.teammate(teammateId))?.name || "Hearth" });
  }

  private async updatesThread() { return (await this.dmThread("hearth")).id; }

  /** Stores what you said right away; the orchestrator and teammates work in the background. */
  async ramble(text: string, threadId?: string) {
    const clean = text.trim().slice(0, 8000);
    if (!clean) return { error: "Say something first." };
    // Every new ramble starts its own group chat (Slack-style); a ramble inside a chat continues it.
    let thread = threadId ? await this.store.get<Thread>("threads", threadId) : null;
    if (threadId && !thread) return { error: "No such chat." };
    if (!thread) {
      const now = this.clock().toISOString();
      thread = await this.store.put<Thread>("threads", { id: randomUUID(), createdAt: now, updatedAt: now, title: clean.split(/\s+/).slice(0, 6).join(" ") });
    }
    const m = await this.addMessage({ role: "user", text: clean, threadId: thread.id });
    await this.setPrefs({ lastUserAt: m.createdAt });
    await this.touchThread(thread.id, { preview: clean.slice(0, 120) });
    this.inflight++;
    this.orchestrate(thread, m).finally(() => this.inflight--);
    return { value: { thread, message: m } };
  }

  private async orchestrate(thread: Thread, m: Message) {
    this.thinking = true;
    this.emit("thinking", { threadId: thread.id });
    let plan: any = null;
    try {
      const brains = await this.brains();
      const ctx = await this.context(m.text, "orchestrate", null);
      const history = (await this.store.all<Message>("messages")).filter((x) => x.threadId === thread.id && x.id !== m.id).slice(-10)
        .map((x) => ({ role: x.role, text: x.text.slice(0, 500) }));
      const raw = await this.brain.think({ mode: "orchestrate", context: { ...ctx, thisChat: history }, input: m.text }, brains.orchestrator);
      plan = parsePlan(raw);
    } catch (err: any) {
      await this.log("orchestrator.failed", err.message);
    }
    this.thinking = false;
    this.emit("thinking", null);
    if (!plan) plan = { reply: "On it.", facts: [], jobs: [{ task: m.text, teammate: "Hearth", effort: "light" }] };

    for (const f of (plan.facts || []).slice(0, 10)) await this.addFact({ ...f, evidence: m.text.slice(0, 300) }, "assistant");
    const team = await this.store.all<Teammate>("teammates");
    const jobs: Job[] = [];
    const keyToId = new Map<string, string>();
    const wants = new Map<string, string[]>();
    for (const j of (plan.jobs || []).slice(0, 8)) {
      if (typeof j?.task !== "string" || !j.task.trim()) continue;
      const wanted = String(j.teammate || "Hearth").toLowerCase();
      let mate = team.find((t) => t.name.toLowerCase() === wanted);
      if (!mate && j.newTeammate) {
        const r = await this.addTeammate(j.newTeammate);
        if (r.value) { mate = r.value; team.push(mate); await this.log("teammate.created", `${mate.name} joined: ${mate.description}`); }
      }
      mate = mate || team.find((t) => t.id === "hearth")!;
      const use = j.use && typeof j.use === "object" ? j.use : null;
      const skill = use?.skill ? await this.skillByName(String(use.skill)) : null;
      const workflow = use?.workflow ? (await this.store.all<Workflow>("workflows")).find((w) => w.name === String(use.workflow) && w.status === "active") : null;
      const inputs = use?.inputs && typeof use.inputs === "object" ? Object.fromEntries(Object.entries(use.inputs).slice(0, 8).map(([k, v]) => [k, String(v).slice(0, 400)])) : undefined;
      jobs.push(await this.store.put<Job>("jobs", {
        ...this.doc({}), threadId: thread.id, messageId: m.id, task: j.task.trim().slice(0, 1000), teammateId: mate.id,
        status: "queued", effort: j.effort === "heavy" ? "heavy" : "light",
        skillId: skill?.status === "active" ? skill.id : undefined, workflowId: workflow?.id, inputs,
      } as Job));
      const made = jobs[jobs.length - 1];
      if (typeof j.id === "string") keyToId.set(j.id, made.id);
      if (Array.isArray(j.dependsOn)) wants.set(made.id, j.dependsOn.map(String));
    }
    // Resolve dependsOn keys to job ids; drop anything unknown or pointing forward (keeps it a DAG).
    for (const [i, job] of jobs.entries()) {
      const deps = (wants.get(job.id) || []).map((k) => keyToId.get(k)).filter((id): id is string => !!id && jobs.findIndex((x) => x.id === id) < i);
      if (deps.length) jobs[i] = await this.store.put<Job>("jobs", { ...job, dependsOn: deps });
    }
    for (const w of (Array.isArray(plan.newWorkflows) ? plan.newWorkflows : []).slice(0, 2)) await this.proposeWorkflow(w);

    if (plan.title && !thread.id.startsWith("tm-") && thread.title === m.text.split(/\s+/).slice(0, 6).join(" ")) await this.touchThread(thread.id, { title: String(plan.title).slice(0, 60) });
    // Hearth's short reply, then one message per task; each task's thread (the teammate working, replies) hangs under it.
    await this.addMessage({ role: "assistant", teammateId: "hearth", threadId: thread.id, text: String(plan.reply || "On it.").slice(0, 1000), jobIds: jobs.map((j) => j.id) });
    for (const j of jobs) await this.addMessage({ role: "assistant", teammateId: "hearth", threadId: thread.id, text: j.task, taskJobId: j.id });
    for (const j of jobs) this.emit("job", j);
    this.pump(m.id); // runs in the background; a new ramble is handled right away
  }

  /**
   * The scheduler: starts every queued job whose dependencies are done. Called whenever a job changes, so
   * approvals, unblocks and retries resume their dependents. A failed dependency skips its dependents only.
   */
  async pump(messageId: string) {
    const jobs = (await this.store.all<Job>("jobs")).filter((j) => j.messageId === messageId && !j.parentId);
    const byId = new Map(jobs.map((j) => [j.id, j]));
    const msg = await this.store.get<Message>("messages", messageId);
    for (const j of jobs) {
      if (j.status !== "queued" || this.started.has(j.id)) continue;
      const deps = (j.dependsOn || []).map((id) => byId.get(id)).filter(Boolean) as Job[];
      const bad = deps.find((d) => d.status === "failed");
      if (bad) {
        this.started.add(j.id);
        try { await this.saveJob({ ...j, status: "failed", result: `Skipped: it needed "${bad.task.slice(0, 80)}", which failed.`, finishedAt: this.clock().toISOString() }); }
        finally { this.started.delete(j.id); }
        continue;
      }
      if (deps.every((d) => d.status === "done")) {
        this.started.add(j.id);
        let earlier = deps.map((d) => `## ${d.task}\n${d.result || ""}`).join("\n\n");
        if (j.followsUp) earlier = await this.threadContext(j.followsUp, j.id);
        this.runJob(j, msg?.text || j.task, earlier).finally(() => this.started.delete(j.id));
      }
    }
  }

  /**
   * Reuse first: a job matched to a skill or workflow runs that directly (scripts need no model at all).
   * Otherwise it's worked out fresh: light jobs on the workhorse, heavy ones (and escalations) on heavy.
   * If a skill fails, the job is solved fresh and the teammate is asked to save a fixed version.
   */
  private async runJob(job: Job, ramble: string, earlier = "") {
    const started = Date.now();
    const meter: Meter = { costUsd: 0, unknown: false };
    const mate = await this.teammate(job.teammateId);
    let cur: Job = await this.saveJob({ ...job, status: "working", startedAt: this.clock().toISOString() });
    const finish = async (patch: Partial<Job>) => {
      const pending = (await this.store.all<Approval>("approvals")).some((a) => a.jobId === job.id && a.status === "pending");
      const blocked = (await this.store.get<Job>("jobs", job.id))?.blocked;
      const status = patch.status === "failed" ? "failed" : blocked ? "blocked" : pending ? "waiting" : "done";
      await this.addSpend(job.messageId, meter.costUsd);
      cur = await this.saveJob({
        ...cur, ...patch, blocked, status,
        durationMs: Date.now() - started, costUsd: meter.unknown ? null : +meter.costUsd.toFixed(4),
        finishedAt: status === "done" || status === "failed" ? this.clock().toISOString() : undefined,
      });
    };
    const overCap = async () => {
      const r = await this.spendCheck(job.messageId);
      if (!r) return false;
      cur = await this.saveJob({ ...cur, blocked: { need: r, why: "Spending caps keep a ramble from running up a bill.", unblock: "Raise the cap in Brains, or tap Try again later" } });
      return true;
    };

    let failedSkill: { name: string; error: string } | null = null;
    if (job.skillId || job.workflowId) {
      try {
        const r = job.workflowId
          ? await this.runWorkflow(job.workflowId, job.inputs || {}, { job, mate, meter })
          : await this.runSkill(job.skillId!, job.inputs || {}, { job, mate, meter });
        return await finish({ how: job.workflowId ? "workflow" : "skill", tier: r.usedModel ? "workhorse" : undefined, result: r.output.slice(0, 4000), did: r.did, tiles: r.tiles });
      } catch (err: any) {
        const sk = job.skillId ? await this.store.get<Skill>("skills", job.skillId) : null;
        failedSkill = { name: sk?.name || "workflow", error: err.message };
        await this.log("skill.failed", `${failedSkill.name}: ${err.message}`);
      }
    }

    const brains = await this.brains();
    const repairNote = failedSkill
      ? `\n\nThe saved skill "${failedSkill.name}" failed with: ${failedSkill.error}\nSolve the job fresh. Then, if you can, save a fixed version with skill.save using the same name. A recipe fix may only use scripts the old one used.`
      : "\n\nIf this job is likely to come back and you had to work it out, save it with skill.save.";
    const depNote = earlier ? `\n\nResults from earlier jobs you depend on:\n<untrusted>\n${earlier.slice(0, 6000)}\n</untrusted>` : "";
    const splitNote = job.effort === "heavy" && !job.depth ? "\n\nThis is a heavy job: if it has 2-4 parts that can be done independently, you may use jobs.split." : "";
    const input = `${job.task}${depNote}${repairNote}${splitNote}\n\n(From the user's ramble: "${ramble.slice(0, 600)}")`;
    const attempt = async (tier: "workhorse" | "heavy") => {
      cur = await this.saveJob({ ...cur, status: "working", tier });
      return this.turn("job", input, job.task, { teammate: mate, threadId: job.threadId, jobId: job.id, profile: brains[tier], meter });
    };
    let tier: "workhorse" | "heavy" = job.effort === "heavy" ? "heavy" : "workhorse";
    let escalated = false;
    if (await overCap()) return finish({ how: "fresh" });
    try {
      let r = await attempt(tier).catch((err) => (tier === "workhorse" ? null : Promise.reject(err)));
      if (tier === "workhorse" && (!r || r.text.includes(ESCALATE) || !r.text.trim())) {
        escalated = true; tier = "heavy";
        await this.log("job.escalated", `${job.task.slice(0, 80)} → ${label(brains.heavy)}`);
        r = await attempt("heavy");
      }
      if (!r || r.text.includes(ESCALATE)) throw new Error("Nobody could do this one.");
      if (r.split && job.effort === "heavy" && !job.depth) {
        const merged = await this.runSplit(cur, r.split, ramble, meter);
        return await finish({ how: "fresh", tier, escalated, result: merged.text.slice(0, 4000), did: [...r.did, ...merged.did], tiles: merged.tiles });
      }
      await finish({ how: failedSkill ? "repaired" : "fresh", tier, escalated, result: r.text.slice(0, 4000), did: r.did, tiles: r.tiles });
    } catch (err: any) {
      await finish({ status: "failed", how: "fresh", tier, escalated, result: err.message });
    }
  }

  /** Reply inside a job's thread: the same teammate picks it up, with the thread so far as context. */
  async replyToJob(rootId: string, text: string) {
    const root = await this.store.get<Job>("jobs", rootId);
    const clean = text.trim().slice(0, 4000);
    if (!root || root.followsUp || root.parentId) return { error: "No such thread." };
    if (!clean) return { error: "Say something first." };
    const m = await this.addMessage({ role: "user", text: clean, threadId: root.threadId, replyTo: root.id, teammateId: root.teammateId });
    await this.setPrefs({ lastUserAt: m.createdAt });
    const job = await this.store.put<Job>("jobs", { ...this.doc({}), threadId: root.threadId, messageId: m.id, task: clean, teammateId: root.teammateId, status: "queued", effort: root.effort, followsUp: root.id } as Job);
    await this.store.put<Message>("messages", { ...m, jobIds: [job.id] });
    this.emit("job", job);
    this.pump(m.id);
    return { value: { message: m, job } };
  }

  /** The thread so far (root job, earlier replies and answers), for a follow-up. */
  private async threadContext(rootId: string, beforeJobId: string) {
    const jobs = (await this.store.all<Job>("jobs")).filter((j) => (j.id === rootId || j.followsUp === rootId) && j.id !== beforeJobId);
    return jobs.map((j) => `## ${j.followsUp ? "User followed up" : "Original job"}: ${j.task}\n${j.result || "(no answer yet)"}`).join("\n\n");
  }

  /** A heavy job's sub-agents: run in parallel (under the same caps), then the heavy model merges their results. */
  private async runSplit(parent: Job, split: { subtasks: { task: string; teammate?: string }[]; merge: string }, ramble: string, meter: Meter) {
    const team = await this.store.all<Teammate>("teammates");
    const subs: Job[] = [];
    for (const st of split.subtasks) {
      const mate = team.find((t) => t.name.toLowerCase() === (st.teammate || "").toLowerCase()) || team.find((t) => t.id === parent.teammateId);
      subs.push(await this.saveJob({ ...this.doc({}), threadId: parent.threadId, messageId: parent.messageId, task: st.task, teammateId: mate?.id || parent.teammateId, status: "queued", effort: "light", parentId: parent.id, depth: 1 } as Job));
    }
    await this.log("job.split", `${parent.task.slice(0, 60)} → ${subs.length} sub-agents`);
    await Promise.all(subs.map((sj) => this.runJob(sj, ramble)));
    const results = (await Promise.all(subs.map((sj) => this.store.get<Job>("jobs", sj.id)))).filter(Boolean) as Job[];
    const brains = await this.brains();
    const mate = await this.teammate(parent.teammateId);
    const text = results.map((x) => `## ${x.task} (${x.status})\n${x.result || ""}`).join("\n\n");
    const merged = await this.turn("job", `${parent.task}\n\nYour sub-agents finished. ${split.merge}\nWrite the final answer for the user. Don't split again.`, parent.task,
      { teammate: mate, threadId: parent.threadId, jobId: parent.id, profile: brains.heavy, meter, extra: text });
    return merged;
  }

  /** Records model spend for the day and the ramble. */
  private async addSpend(messageId: string, usd: number) {
    if (!usd) return;
    this.rambleSpend.set(messageId, (this.rambleSpend.get(messageId) || 0) + usd);
    await this.prefsLock.run(async () => {
      const p = await this.prefs();
      const today = localDate(this.clock(), p.tz);
      const cur = p.spend?.date === today ? p.spend.usd : 0;
      await this.setPrefsNow({ spend: { date: today, usd: +(cur + usd).toFixed(4) } });
    });
  }

  /** Null when there's budget left; otherwise what's over. */
  async spendCheck(messageId: string) {
    const p = await this.prefs();
    const caps = { ramble: p.costCaps?.rambleUsd ?? this.config.costCapRambleUsd, day: p.costCaps?.dayUsd ?? this.config.costCapDayUsd };
    const today = p.spend?.date === localDate(this.clock(), p.tz) ? p.spend.usd : 0;
    if (today >= caps.day) return `Today's spending cap ($${caps.day}) is reached`;
    if ((this.rambleSpend.get(messageId) || 0) >= caps.ramble) return `This ramble's spending cap ($${caps.ramble}) is reached`;
    return null;
  }

  /** You unblocked it (opened the laptop, logged in, tapped Allow): run the job again from the top. */
  async retryJob(id: string) {
    const job = await this.store.get<Job>("jobs", id);
    if (!job || !["blocked", "failed"].includes(job.status)) return { error: "Only blocked or failed jobs can be retried." };
    const msg = await this.store.get<Message>("messages", job.messageId);
    const fresh = await this.saveJob({ ...job, blocked: undefined, status: "queued", result: undefined, did: undefined });
    await this.log("job.retry", job.task.slice(0, 80));
    if (fresh.parentId) { this.inflight++; this.runJob(fresh, msg?.text || job.task).finally(() => this.inflight--); }
    else await this.pump(fresh.messageId);
    return { value: fresh };
  }

  // ---------- skills & workflows ----------

  async searchLibrary(query: string) {
    if (!query.trim()) return [];
    const [skills, workflows, scripts] = await Promise.all([this.store.all<Skill>("skills"), this.store.all<Workflow>("workflows"), this.scripts.list()]);
    return this.library.search(query, skills, workflows, scripts);
  }

  async skillByName(name: string) {
    return (await this.store.all<Skill>("skills")).find((s) => s.name === name.toLowerCase()) || null;
  }

  /** Runs a saved skill. Script skills need no model; recipes are followed by the workhorse, limited to their scripts. */
  async runSkill(skillId: string, inputs: Record<string, string>, ctx: { job?: Job; mate?: Teammate | null; meter?: Meter }) {
    const sk = await this.store.get<Skill>("skills", skillId);
    if (!sk || sk.status !== "active") throw new Error("That skill isn't active.");
    const started = Date.now();
    try {
      let output = "", did: Done[] = [], usedModel = false, tiles: Tile[] = [];
      if (sk.kind === "script") {
        const args = sk.inputs.map((i) => inputs[i.name] ?? "");
        const out = await this.scripts.run(sk.script!, args);
        if (out.needsApproval) {
          const ap = await this.requestApproval({ summary: `${sk.description} (${args.filter(Boolean).join(", ")})`, script: sk.script!, args }, { threadId: ctx.job?.threadId, jobId: ctx.job?.id });
          if (ap.error) throw new Error(ap.error);
          output = "Waiting for your Approve.";
          did = [{ kind: "approval", label: `Waiting for your Approve: ${sk.name}`, id: ap.value!.id }];
        } else if (!out.ok) throw new Error(out.output.slice(0, 300));
        else { const ex = extractTiles(out.output); output = ex.text; tiles = ex.tiles; }
      } else {
        usedModel = true;
        const recipe = [`Follow this saved recipe exactly ("${sk.name}": ${sk.description}).`,
          ...sk.steps!.map((x, i) => `${i + 1}. ${x}`),
          `Inputs: ${JSON.stringify(inputs)}`, `You may only run these scripts: ${(sk.uses || []).join(", ") || "none"}. Don't write new code.`].join("\n");
        const r = await this.turn("job", recipe, ctx.job?.task || sk.name, { teammate: ctx.mate, threadId: ctx.job?.threadId, jobId: ctx.job?.id, meter: ctx.meter, allowedScripts: sk.uses || [] });
        if (!r.text.trim() || r.text.includes(ESCALATE)) throw new Error("The recipe didn't work this time.");
        output = r.text; did = r.did; tiles = r.tiles || [];
      }
      if (sk.view) tiles = tiles.map((t) => ({ ...t, options: { ...(sk.view || {}), ...(t.options || {}) } }));
      const ms = Date.now() - started;
      await this.store.put<Skill>("skills", { ...sk, runs: sk.runs + 1, lastUsedAt: this.clock().toISOString(), avgMs: Math.round(((sk.avgMs || ms) * sk.runs + ms) / (sk.runs + 1)) });
      this.emit("skills");
      return { output, did, usedModel, tiles };
    } catch (err) {
      await this.store.put<Skill>("skills", { ...sk, failures: sk.failures + 1, lastUsedAt: this.clock().toISOString() });
      this.emit("skills");
      throw err;
    }
  }

  async runWorkflow(workflowId: string, inputs: Record<string, string>, ctx: { job?: Job; mate?: Teammate | null; meter?: Meter }) {
    const wf = await this.store.get<Workflow>("workflows", workflowId);
    if (!wf || wf.status !== "active") throw new Error("That workflow isn't switched on.");
    let prev = "", did: Done[] = [], usedModel = false;
    const outputs: string[] = [];
    const tiles: Tile[] = [];
    for (const step of wf.steps) {
      const stepInputs = Object.fromEntries(Object.entries(step.inputs).map(([k, v]) => [k, fill(v, inputs, prev)]));
      let r: { output: string; did: Done[]; usedModel: boolean; tiles: Tile[] };
      let label = step.skill || "step";
      if (step.skill) {
        const sk = await this.skillByName(step.skill);
        if (!sk) throw new Error(`Workflow step "${step.skill}" doesn't exist any more.`);
        r = await this.runSkill(sk.id, stepInputs, ctx);
      } else {
        // A plain task: the named teammate works it out on the workhorse, with the previous output as context.
        const team = await this.store.all<Teammate>("teammates");
        const mate = team.find((t) => t.name.toLowerCase() === (step.teammate || "").toLowerCase()) || ctx.mate || null;
        const task = fill(step.task!, inputs, prev);
        const t = await this.turn("job", `${task}${prev ? `\n\nPrevious step's result:\n<untrusted>\n${prev.slice(0, 3000)}\n</untrusted>` : ""}`, task,
          { teammate: mate, threadId: ctx.job?.threadId, jobId: ctx.job?.id, meter: ctx.meter });
        if (!t.text.trim() || t.text.includes(ESCALATE)) throw new Error(`Step "${task.slice(0, 60)}" didn't work.`);
        r = { output: t.text, did: t.did, usedModel: true, tiles: t.tiles || [] };
        label = mate?.name || "step";
      }
      prev = r.output; did = [...did, ...r.did]; usedModel ||= r.usedModel; tiles.push(...r.tiles);
      outputs.push(`**${label}**: ${r.output}`);
      if (r.did.some((d) => d.kind === "approval")) break; // stop the chain until you approve
    }
    await this.store.put<Workflow>("workflows", { ...wf, runs: wf.runs + 1, lastUsedAt: this.clock().toISOString() });
    return { output: outputs.join("\n\n"), did, usedModel, tiles: tiles.slice(0, 4) };
  }

  /** Saves or fixes a skill. Code goes through script approval; recipes may only use approved scripts. */
  async saveSkill(a: any, teammateId?: string) {
    const v = validateSkill(a);
    if (!v.value) return { error: v.error! };
    const scripts = await this.scripts.list();
    const approved = new Set(scripts.filter((s) => s.status === "approved").map((s) => s.name));
    const prev = await this.skillByName(v.value.name);
    let status: Skill["status"] = "active";
    if (v.value.kind === "script") {
      if (typeof a.code === "string" && a.code.trim()) {
        const r = await this.scripts.propose({ name: v.value.script, description: v.value.description, code: a.code });
        if (r.error) return { error: r.error };
        this.emit("scripts");
      }
      const sc = (await this.scripts.list()).find((s) => s.name === v.value!.script);
      if (!sc) return { error: `No script called ${v.value.script}.` };
      status = sc.status === "approved" ? "active" : "proposed";
    } else {
      const uses: string[] = v.value.uses;
      const missing = uses.filter((u) => !approved.has(u));
      if (missing.length) return { error: `A recipe can only use approved scripts (not ${missing.join(", ")}).` };
      if (prev?.kind === "recipe" && uses.some((u) => !(prev.uses || []).includes(u))) return { error: "A fixed recipe can't use scripts the old one didn't." };
    }
    const now = this.clock().toISOString();
    const sk = await this.store.put<Skill>("skills", {
      ...(prev || { ...this.doc({}), runs: 0, failures: 0, version: 0 }),
      ...v.value, status, teammateId: prev?.teammateId || teammateId,
      version: (prev?.version || 0) + 1, lastFixedAt: prev ? now : undefined, updatedAt: now,
    } as Skill);
    if (!prev) await this.addFact({ fact: `For "${sk.description}", the team uses the skill ${sk.name}.`, notebook: "skills", importance: 1 }, "assistant");
    await this.log(prev ? "skill.fixed" : "skill.saved", `${sk.name}${status === "proposed" ? " (waiting for script approval)" : ""}`);
    this.emit("skills");
    return { value: sk };
  }

  /** Proposals wait for you to switch them on; ones you asked for ("save this as…") are on straight away. */
  async proposeWorkflow(a: any, status: Workflow["status"] = "proposed") {
    const v = validateWorkflow(a);
    if (!v.value) return { error: v.error! };
    for (const st of v.value.steps) if (st.skill && !(await this.skillByName(st.skill))) return { error: `No skill called ${st.skill}.` };
    const prev = (await this.store.all<Workflow>("workflows")).find((w) => w.name === v.value!.name);
    const wf = await this.store.put<Workflow>("workflows", { ...(prev || { ...this.doc({}), runs: 0 }), ...v.value, status, updatedAt: this.clock().toISOString() } as Workflow);
    await this.log(status === "active" ? "workflow.saved" : "workflow.proposed", wf.name);
    this.emit("skills");
    return { value: wf };
  }

  /** One tap: a finished ramble's jobs become a workflow, in order, reusing skills where they were used. No model. */
  async saveRambleAsWorkflow(messageId: string, name?: string) {
    const jobs = (await this.store.all<Job>("jobs")).filter((j) => j.messageId === messageId && !j.parentId);
    if (jobs.length < 1) return { error: "Nothing to save yet." };
    const msg = await this.store.get<Message>("messages", messageId);
    const thread = msg?.threadId ? await this.store.get<Thread>("threads", msg.threadId) : null;
    const team = await this.store.all<Teammate>("teammates");
    const skills = await this.store.all<Skill>("skills");
    // Order: dependencies first, otherwise as planned.
    const ordered: Job[] = [];
    const pending = [...jobs];
    while (pending.length) {
      const i = pending.findIndex((j) => (j.dependsOn || []).every((d) => ordered.some((o) => o.id === d)));
      ordered.push(...pending.splice(i < 0 ? 0 : i, 1));
    }
    const steps = ordered.map((j) => {
      const sk = j.skillId ? skills.find((x) => x.id === j.skillId) : null;
      return sk ? { skill: sk.name, inputs: j.inputs || {} } : { task: j.task, teammate: team.find((t) => t.id === j.teammateId)?.name, inputs: {} };
    });
    const base = (name || thread?.title || "my workflow").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36) || "workflow";
    if (steps.length === 1) steps.push({ task: "Summarise the result in one line for me.", teammate: "Hearth", inputs: {} });
    return this.proposeWorkflow({ name: base, description: thread?.title || msg?.text.slice(0, 120) || base, inputs: [], steps }, "active");
  }

  /**
   * The purger: keeps the library lean. Removes skills/workflows unused for a long time or that keep failing,
   * proposals never switched on, and assistant-written scripts nothing uses. Pinned items stay. No model involved.
   */
  async purgeLibrary(opts: { unusedDays?: number; proposalDays?: number } = {}) {
    const now = this.clock().getTime();
    const unused = (opts.unusedDays ?? Number(process.env.HEARTH_PURGE_UNUSED_DAYS || 45)) * 864e5;
    const proposalAge = (opts.proposalDays ?? 14) * 864e5;
    const age = (iso?: string) => now - new Date(iso || 0).getTime();
    const removed: string[] = [];
    const skills = await this.store.all<Skill>("skills");
    const workflows = await this.store.all<Workflow>("workflows");
    for (const sk of skills) {
      if (sk.pinned) continue;
      const stale = age(sk.lastUsedAt || sk.updatedAt || sk.createdAt) > unused;
      const broken = sk.failures >= 3 && sk.failures > sk.runs;
      const neverApproved = sk.status === "proposed" && age(sk.createdAt) > proposalAge;
      if (stale || broken || neverApproved) {
        await this.store.remove("skills", sk.id);
        removed.push(`skill ${sk.name} (${broken ? "kept failing" : neverApproved ? "never approved" : "unused"})`);
      }
    }
    const liveSkills = new Set((await this.store.all<Skill>("skills")).map((s) => s.name));
    for (const wf of workflows) {
      if (wf.pinned) continue;
      const stale = age(wf.lastUsedAt || wf.updatedAt || wf.createdAt) > unused;
      const neverOn = wf.status === "proposed" && age(wf.createdAt) > proposalAge;
      const orphan = wf.steps.some((s) => s.skill && !liveSkills.has(s.skill));
      if (stale || neverOn || orphan) {
        await this.store.remove("workflows", wf.id);
        removed.push(`workflow ${wf.name} (${orphan ? "a skill it needs is gone" : neverOn ? "never switched on" : "unused"})`);
      }
    }
    const usedScripts = new Set((await this.store.all<Skill>("skills")).flatMap((s) => [s.script, ...(s.uses || [])]).filter(Boolean) as string[]);
    for (const sc of await this.scripts.list()) {
      if (sc.origin !== "assistant" || usedScripts.has(sc.name)) continue;
      if (age(sc.lastRunAt || sc.updatedAt || sc.createdAt) > (sc.status === "approved" ? unused : proposalAge)) {
        await this.scripts.remove(sc.id);
        removed.push(`script ${sc.name} (nothing uses it)`);
      }
    }
    for (const m of (await this.store.all<Fact>("memory")).filter((f) => f.notebook === "skills")) {
      const name = m.fact.match(/skill ([a-z0-9-]+)\.$/)?.[1];
      if (name && !liveSkills.has(name)) await this.store.remove("memory", m.id);
    }
    if (removed.length) { await this.log("library.purged", removed.join("; ")); this.emit("skills"); this.emit("scripts"); }
    return removed;
  }

  /** When you approve a script, skills built on it switch on. */
  async scriptApproved(name: string) {
    for (const sk of await this.store.all<Skill>("skills")) {
      if (sk.kind === "script" && sk.script === name && sk.status === "proposed") await this.store.put<Skill>("skills", { ...sk, status: "active" });
    }
    this.emit("skills");
  }

  /** "Save as skill?" on a job that was worked out fresh. */
  async saveJobAsSkill(jobId: string) {
    const job = await this.store.get<Job>("jobs", jobId);
    if (!job || job.status !== "done") return { error: "Only finished jobs can become skills." };
    const mate = await this.teammate(job.teammateId);
    const before = new Set((await this.store.all<Skill>("skills")).map((s) => s.id));
    await this.turn("job", `Turn this finished job into a reusable skill. Reply with one short line and a single skill.save action.\nJOB: ${job.task}\nWHAT YOU DID: ${job.result || ""}\nACTIONS: ${JSON.stringify(job.did || [])}`,
      job.task, { teammate: mate, threadId: job.threadId });
    const created = (await this.store.all<Skill>("skills")).find((s) => !before.has(s.id) || s.updatedAt && s.updatedAt > job.createdAt);
    return created ? { value: created } : { error: "Your teammate didn't think this one is reusable." };
  }

  // ---------- approvals: the hub, not the model, decides what can touch the outside world ----------

  async requestApproval(a: any, where: { threadId?: string; jobId?: string }) {
    const script = String(a?.script || "");
    const sc = (await this.scripts.list()).find((s) => s.name === script);
    if (!sc) return { error: `No script called ${script}.` };
    const ap = await this.store.put<Approval>("approvals", {
      ...this.doc({}), threadId: where.threadId, jobId: where.jobId,
      summary: String(a.summary || `Run ${script}`).slice(0, 200), details: a.details ? String(a.details).slice(0, 1000) : undefined,
      action: { type: "script", script, args: (Array.isArray(a.args) ? a.args : []).slice(0, 8).map(String) },
      status: "pending",
    } as Approval);
    if (where.jobId) {
      const job = await this.store.get<Job>("jobs", where.jobId);
      if (job) await this.saveJob({ ...job, approvalIds: [...(job.approvalIds || []), ap.id] });
    }
    await this.log("approval.requested", ap.summary);
    this.emit("approval", ap);
    await this.push?.send({ title: "Needs your OK", body: ap.summary, tag: ap.id, url: ap.threadId ? `/#chat/${ap.threadId}` : "/" });
    return { value: ap };
  }

  async decideApproval(id: string, yes: boolean) {
    const ap = await this.store.get<Approval>("approvals", id);
    if (!ap || ap.status !== "pending") return { error: "Already decided." };
    let next: Approval = { ...ap, status: yes ? "approved" : "rejected", decidedAt: this.clock().toISOString() };
    await this.store.put("approvals", next);
    if (yes) {
      const out = await this.scripts.run(ap.action.script, ap.action.args, { approvedRun: true });
      next = { ...next, status: out.ok ? "done" : "failed", result: out.output.slice(0, 2000) };
      await this.store.put("approvals", next);
    }
    await this.log(yes ? "approval.approved" : "approval.rejected", ap.summary);
    this.emit("approval", next);
    if (ap.jobId) {
      const job = await this.store.get<Job>("jobs", ap.jobId);
      if (job) {
        const still = (await this.store.all<Approval>("approvals")).some((a) => a.jobId === job.id && a.status === "pending");
        const note = yes ? `\n\n${next.status === "done" ? "Done" : "Failed"}: ${ap.summary}${next.result ? `\n${next.result.slice(0, 600)}` : ""}` : `\n\nYou said no: ${ap.summary}`;
        await this.saveJob({ ...job, status: still ? "waiting" : "done", result: `${job.result || ""}${note}`.trim(), finishedAt: still ? undefined : this.clock().toISOString() });
      }
    }
    return { value: next };
  }

  private async saveJob(j: Job) {
    const saved = await this.store.put<Job>("jobs", { ...j, updatedAt: this.clock().toISOString() });
    this.emit("job", saved);
    if (!saved.parentId && (saved.status === "done" || saved.status === "failed")) {
      this.pump(saved.messageId).catch((e) => console.error("pump failed", e));
      this.touchThread(saved.threadId, {}).catch(() => {});
    }
    return saved;
  }

  // ---------- chat ----------

  async listMessages(limit = 50, before?: string) {
    return this.store.recent<Message>("messages", Math.min(limit, 200), before);
  }

  async addMessage(fields: Omit<Message, "id" | "createdAt">) {
    const m = await this.store.put<Message>("messages", this.doc(fields));
    this.emit("message", m);
    return m;
  }

  // ---------- actions proposed by the brain ----------

  async applyActions(actions: any[], evidence: string, where: { teammateId?: string; threadId?: string; jobId?: string; recipe?: string[] } = {}) {
    const done: Done[] = [];
    const used: string[] = [];
    const runs: { name: string; args: string[] }[] = [];
    let split: { subtasks: { task: string; teammate?: string }[]; merge: string } | null = null;
    const tiles: Tile[] = [];
    for (const a of actions.slice(0, 12)) {
      if (!a || typeof a !== "object") continue;
      try {
        switch (a.type) {
          case "hook.add": {
            const r = await this.addHook(a, a.requestedByUser === true ? "you" : "assistant", where);
            if (r.value) done.push({ kind: "hook", label: `${r.value.trigger.type === "at" ? "Reminder" : "Hook"}: ${r.value.title}`, id: r.value.id });
            else await this.log("action.rejected", `hook.add: ${r.error}`);
            break;
          }
          case "hook.remove": {
            const h = await this.store.get<Hook>("hooks", String(a.id));
            if (h && h.source !== "system" && (await this.removeHook(h.id))) done.push({ kind: "hook", label: `Removed: ${h.title}` });
            break;
          }
          case "hook.pause": {
            const h = await this.updateHook(String(a.id), { status: "paused" });
            if (h) done.push({ kind: "hook", label: `Paused: ${h.title}` });
            break;
          }
          case "memory.add": {
            const r = await this.addFact({ ...a, evidence: a.evidence || evidence.slice(0, 300) }, "assistant");
            if (r.value) done.push({ kind: "memory", label: `Remembered: ${r.value.fact}`, id: r.value.id });
            break;
          }
          case "memory.update": {
            const r = await this.updateFact(String(a.id), a);
            if (r) done.push({ kind: "memory", label: `Updated: ${r.fact}`, id: r.id });
            break;
          }
          case "memory.merge": {
            const r = await this.mergeFacts(Array.isArray(a.ids) ? a.ids.map(String) : [], a);
            if (r) done.push({ kind: "memory", label: `Merged into: ${r.fact}`, id: r.id });
            break;
          }
          case "memory.forget": {
            const f = await this.store.get<Fact>("memory", String(a.id));
            if (f && (await this.forgetFact(f.id))) done.push({ kind: "memory", label: `Forgot: ${f.fact}` });
            break;
          }
          case "memory.used":
            if (Array.isArray(a.ids)) { const ids = a.ids.map(String).slice(0, 20); used.push(...ids); await this.markUsed(ids); }
            break;
          case "notebook.summary":
            if (typeof a.name === "string" && typeof a.summary === "string") await this.setNotebook(a.name, a.summary);
            break;
          case "place.add": {
            const r = await this.addPlace(a);
            done.push({ kind: "place", label: r.value ? `Saved place: ${r.value.name}` : `Couldn't save place: ${r.error}` });
            break;
          }
          case "tile": {
            const t = cleanTile({ ...a, type: a.tile });
            if (t && tiles.length < 4) tiles.push(t);
            break;
          }
          case "skill.view": {
            if (where.recipe) break;
            const sk = await this.skillByName(String(a.skill || ""));
            const options = cleanOptions(a.options);
            if (sk && options) {
              await this.store.put<Skill>("skills", { ...sk, view: { ...(sk.view || {}), ...options } });
              this.emit("skills");
              done.push({ kind: "skill", label: `Updated how ${sk.name} looks` });
            }
            break;
          }
          case "jobs.split": {
            const subtasks = (Array.isArray(a.subtasks) ? a.subtasks : []).slice(0, 4)
              .filter((x: any) => typeof x?.task === "string" && x.task.trim())
              .map((x: any) => ({ task: String(x.task).slice(0, 600), teammate: typeof x.teammate === "string" ? x.teammate : undefined }));
            if (subtasks.length >= 2) split = { subtasks, merge: String(a.merge || "Combine the results into one answer.").slice(0, 400) };
            break;
          }
          case "script.run":
            if (typeof a.name === "string") runs.push({ name: a.name, args: Array.isArray(a.args) ? a.args.slice(0, 8).map(String) : [] });
            break;
          case "blocked": {
            const b = { need: String(a.need || "Something from you").slice(0, 200), why: String(a.why || "").slice(0, 300), unblock: String(a.unblock || "Tap Try again when it's sorted").slice(0, 200) };
            if (where.jobId) {
              const job = await this.store.get<Job>("jobs", where.jobId);
              if (job) await this.saveJob({ ...job, blocked: b });
            }
            done.push({ kind: "blocked", label: `Blocked: ${b.need}` });
            await this.log("job.blocked", `${b.need} (${b.unblock})`);
            await this.push?.send({ title: "I'm stuck", body: `${b.need}. ${b.unblock}`, tag: where.jobId, url: where.threadId ? `/#chat/${where.threadId}` : "/" });
            break;
          }
          case "approval.request": {
            if (where.recipe && !where.recipe.includes(String(a.script))) break; // recipes can't reach new scripts
            const r = await this.requestApproval(a, where);
            done.push({ kind: "approval", label: r.value ? `Waiting for your Approve: ${r.value.summary}` : `Couldn't ask: ${r.error}`, id: r.value?.id });
            break;
          }
          case "skill.save": {
            if (where.recipe) break;
            const r = await this.saveSkill(a, where.teammateId);
            done.push({ kind: "skill", label: r.value ? `${r.value.version > 1 ? "Fixed" : "Saved"} skill: ${r.value.name}${r.value.status === "proposed" ? " (approve its script to use it)" : ""}` : `Couldn't save skill: ${r.error}`, id: r.value?.id });
            break;
          }
          case "workflow.propose":
          case "workflow.save": {
            if (where.recipe) break;
            const r = await this.proposeWorkflow(a, a.type === "workflow.save" ? "active" : "proposed");
            if (r.value) done.push({ kind: "skill", label: `${a.type === "workflow.save" ? "Saved" : "Proposed"} workflow: ${r.value.name}`, id: r.value.id });
            break;
          }
          case "script.propose": {
            if (where.recipe) break;
            const r = await this.scripts.propose(a);
            if (r.value) { done.push({ kind: "script", label: `Wrote script ${r.value.name}: waiting for your approval`, id: r.value.id }); this.emit("scripts"); }
            else await this.log("action.rejected", `script.propose: ${r.error}`);
            break;
          }
        }
      } catch (err: any) {
        await this.log("action.failed", `${a.type}: ${err.message}`);
      }
    }
    return { done, used, runs, split, tiles };
  }

  // ---------- hooks ----------

  async listHooks() {
    const prefs = await this.prefs();
    return (await this.store.all<Hook>("hooks")).map((h) => ({ ...h, when: describeTrigger(h.trigger, prefs.tz) }));
  }

  async addHook(input: any, source: Hook["source"], where: { teammateId?: string; threadId?: string } = {}) {
    const v = validateHook(input);
    if (!v.value) return { error: v.error! };
    const prefs = await this.prefs();
    const nextAt = computeNextAt(v.value.trigger, prefs.tz, this.clock());
    const h = await this.store.put<Hook>("hooks", this.doc({ ...v.value, status: "active" as const, nextAt, fireCount: 0, source, teammateId: where.teammateId, threadId: where.threadId }));
    await this.log("hook.added", `${h.title} (${describeTrigger(h.trigger, prefs.tz)})`);
    this.emit("hooks");
    return { value: h };
  }

  async updateHook(id: string, patch: any) {
    const h = await this.store.get<Hook>("hooks", id);
    if (!h) return null;
    const next: Hook = { ...h, updatedAt: this.clock().toISOString() };
    const prefs = await this.prefs();
    if (patch.status === "active" || patch.status === "paused") next.status = patch.status;
    if (typeof patch.title === "string" && patch.title.trim()) next.title = patch.title.trim().slice(0, 80);
    if (patch.trigger || patch.action) {
      const v = validateHook({ ...h, ...patch });
      if (!v.value) return null;
      Object.assign(next, v.value);
      next.nextAt = computeNextAt(next.trigger, prefs.tz, this.clock());
    }
    if (patch.snoozeMin) {
      next.nextAt = new Date(this.clock().getTime() + Math.min(10080, Math.max(1, Number(patch.snoozeMin))) * 60000).toISOString();
      next.status = "active";
    }
    if (next.status === "active" && h.status === "paused" && !patch.snoozeMin && ["schedule", "every"].includes(next.trigger.type)) {
      next.nextAt = computeNextAt(next.trigger, prefs.tz, this.clock());
    }
    await this.store.put("hooks", next);
    this.emit("hooks");
    return next;
  }

  async removeHook(id: string) {
    const ok = await this.store.remove("hooks", id);
    if (ok) this.emit("hooks");
    return ok;
  }

  // ---------- memory ----------

  addFact(input: any, source: Fact["source"]) {
    return this.memoryLock.run(() => this.addFactNow(input, source));
  }

  private async addFactNow(input: any, source: Fact["source"]) {
    const v = validateFact(input);
    if (!v.value) return { error: v.error! };
    const facts = (await this.store.all<Fact>("memory")).filter((f) => isActive(f));
    const dupe = facts.find((f) => f.fact.toLowerCase() === v.value!.fact.toLowerCase());
    if (dupe) return { value: dupe };
    const f = await this.store.put<Fact>("memory", this.doc({ ...v.value, source, useCount: 0 }));
    this.emit("memory");
    return { value: f };
  }

  /** Supersede: the old fact stays as history, pointing at the new one. */
  updateFact(id: string, input: any) {
    return this.memoryLock.run(() => this.updateFactNow(id, input));
  }

  private async updateFactNow(id: string, input: any) {
    const old = await this.store.get<Fact>("memory", id);
    if (!old || old.supersededBy) return null;
    const v = validateFact({ ...old, ...input, fact: input.fact ?? old.fact });
    if (!v.value) return null;
    const f = await this.store.put<Fact>("memory", this.doc({ ...v.value, source: old.source, useCount: old.useCount, supersedes: old.id }));
    await this.store.put("memory", { ...old, supersededBy: f.id, updatedAt: f.createdAt });
    this.emit("memory");
    return f;
  }

  mergeFacts(ids: string[], input: any) {
    return this.memoryLock.run(() => this.mergeFactsNow(ids, input));
  }

  private async mergeFactsNow(ids: string[], input: any) {
    const olds = (await Promise.all(ids.map((id) => this.store.get<Fact>("memory", id)))).filter((f): f is Fact => !!f && !f.supersededBy);
    if (olds.length < 2) return null;
    const v = validateFact(input);
    if (!v.value) return null;
    const f = await this.store.put<Fact>("memory", this.doc({ ...v.value, source: "assistant" as const, useCount: Math.max(...olds.map((o) => o.useCount)), supersedes: olds[0].id }));
    for (const o of olds) await this.store.put("memory", { ...o, supersededBy: f.id });
    this.emit("memory");
    return f;
  }

  forgetFact(id: string) {
    return this.memoryLock.run(() => this.forgetFactNow(id));
  }

  private async forgetFactNow(id: string) {
    // Forget means gone, including the history chain behind it.
    let cur = await this.store.get<Fact>("memory", id);
    let ok = false;
    while (cur) { ok = (await this.store.remove("memory", cur.id)) || ok; cur = cur.supersedes ? await this.store.get<Fact>("memory", cur.supersedes) : null; }
    if (ok) this.emit("memory");
    return ok;
  }

  async markUsed(ids: string[]) {
    const now = this.clock().toISOString();
    for (const id of ids) {
      const f = await this.store.get<Fact>("memory", id);
      if (f) await this.store.put("memory", { ...f, useCount: (f.useCount || 0) + 1, lastUsedAt: now });
    }
  }

  async setNotebook(name: string, summary: string) {
    const key = name.trim().toLowerCase().slice(0, 40);
    if (!key) return;
    const existing = (await this.store.all<Notebook>("notebooks")).find((n) => n.name === key);
    await this.store.put<Notebook>("notebooks", { ...(existing || this.doc({})), name: key, summary: summary.trim().slice(0, 400), updatedAt: this.clock().toISOString() } as Notebook);
    this.emit("memory");
  }

  // ---------- teammates ----------

  async ensureTeammates() {
    if ((await this.store.all<Teammate>("teammates")).length) return;
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    for (const [i, t] of DEFAULT_TEAMMATES.entries()) {
      await this.store.put<Teammate>("teammates", { ...t, builtIn: true, createdAt: new Date(t0 + i * 1000).toISOString() });
    }
  }

  /** Message one teammate directly: no orchestrator, the job goes straight to them in their own thread. */
  async askTeammate(id: string, text: string) {
    const mate = await this.teammate(id);
    const clean = text.trim().slice(0, 4000);
    if (!mate) return { error: "No such teammate." };
    if (!clean) return { error: "Say something first." };
    const tid = (await this.dmThread(mate.id)).id;
    const m = await this.addMessage({ role: "user", text: clean, threadId: tid, teammateId: mate.id });
    await this.setPrefs({ lastUserAt: m.createdAt });
    const job = await this.store.put<Job>("jobs", { ...this.doc({}), threadId: tid, messageId: m.id, task: clean, teammateId: mate.id, status: "queued", effort: "light" } as Job);
    await this.store.put<Message>("messages", { ...m, jobIds: [job.id] });
    this.emit("job", job);
    this.pump(m.id);
    return { value: { message: m, job } };
  }

  /**
   * The roster (Grok Bot-style home): each teammate with its state, for the avatar to act out, and a one-line
   * status in its own voice.
   */
  async roster() {
    const now = this.clock().getTime();
    const team = await this.store.all<Teammate>("teammates");
    const jobs = (await this.store.all<Job>("jobs")).filter((j) => !j.parentId).sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
    const approvals = await this.store.all<Approval>("approvals");
    const prefs = await this.prefs();
    const hooks = (await this.store.all<Hook>("hooks")).filter((h) => h.status === "active" && h.nextAt && h.source !== "system").sort((a, b) => a.nextAt!.localeCompare(b.nextAt!));
    const first = (t: string) => t.split("\n").map((x) => x.replace(/^[-*•#\s]+/, "").trim()).find(Boolean) || "";
    const clip = (t: string, n = 90) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
    return team.map((t) => {
      const mine = jobs.filter((j) => j.teammateId === t.id);
      const pick = (...st: Job["status"][]) => mine.filter((j) => st.includes(j.status));
      const working = pick("working"), queued = pick("queued"), waiting = pick("waiting"), blocked = pick("blocked");
      const last = mine.find((j) => j.status === "done" || j.status === "failed");
      const recent = last && now - new Date(last.finishedAt || last.updatedAt || last.createdAt).getTime() < 3 * 60_000;
      let state = "idle", status = "", at = last?.finishedAt || last?.updatedAt;
      if (t.id === "hearth" && this.thinking) { state = "thinking"; status = "Sorting out who does what…"; at = this.clock().toISOString(); }
      else if (blocked.length) { state = "blocked"; status = `Stuck: ${blocked[0].blocked?.need || blocked[0].task}`; at = blocked[0].updatedAt; }
      else if (waiting.length) {
        const ap = approvals.find((a) => a.jobId === waiting[0].id && a.status === "pending");
        state = "waiting"; status = `Need your OK: ${ap?.summary || waiting[0].task}`; at = waiting[0].updatedAt;
      }
      else if (working.length) { state = "working"; status = `${working.length > 1 ? `${working.length} things. ` : ""}On it: ${working[0].task}`; at = working[0].startedAt; }
      else if (queued.length) { state = "thinking"; status = `Up next: ${queued[0].task}`; at = queued[0].createdAt; }
      else if (last) { state = recent ? "done" : "idle"; status = last.status === "failed" ? `Couldn't: ${last.task}` : first(last.result || "") || `Done: ${last.task}`; }
      if (!status) {
        const next = hooks.find((h) => h.teammateId === t.id);
        status = next ? `Next: ${next.title}, ${new Date(next.nextAt!).toLocaleString("en-US", { timeZone: prefs.tz, weekday: "short", hour: "numeric", minute: "2-digit" })}` : t.description;
      }
      return { id: t.id, name: t.name, color: t.color, description: t.description, builtIn: t.builtIn, state, status: clip(status), at,
        busy: working.length + queued.length, needsYou: waiting.length + blocked.length };
    });
  }

  /** Everything one teammate has done, across chats, plus its routines and direct messages. */
  async teammateDetail(id: string) {
    const teammate = await this.teammate(id);
    if (!teammate) return null;
    const jobs = (await this.store.all<Job>("jobs")).filter((j) => j.teammateId === id && !j.parentId).slice(-40);
    const messages = (await this.store.all<Message>("messages")).filter((m) => m.threadId === `tm-${id}`).slice(-60);
    const prefs = await this.prefs();
    const routines = (await this.store.all<Hook>("hooks")).filter((h) => h.teammateId === id && h.status !== "done").map((h) => ({ ...h, when: describeTrigger(h.trigger, prefs.tz) }));
    const approvals = (await this.store.all<Approval>("approvals")).filter((a) => jobs.some((j) => j.id === a.jobId));
    return { teammate, jobs, messages, routines, approvals };
  }

  async teammate(id?: string | null) {
    return id ? await this.store.get<Teammate>("teammates", id) : null;
  }

  async addTeammate(input: any) {
    const name = typeof input?.name === "string" ? input.name.trim().slice(0, 24) : "";
    const description = typeof input?.description === "string" ? input.description.trim().slice(0, 200) : "";
    if (!name || !description) return { error: "A teammate needs a name and what they do." };
    const color = /^#[0-9a-f]{6}$/i.test(input.color || "") ? input.color : ["#F97066", "#36BFFA", "#FDB022", "#9E77ED", "#32D583"][Math.floor(Math.random() * 5)];
    const t = await this.store.put<Teammate>("teammates", this.doc({
      name, color, description, builtIn: false,
      prompt: `You are ${name}. ${description} Stay in that lane; hand anything else back to Hearth.`,
    }));
    this.emit("teammates");
    return { value: t };
  }

  async removeTeammate(id: string) {
    const t = await this.teammate(id);
    if (!t || t.id === "hearth") return false;
    await this.store.remove("teammates", id);
    this.emit("teammates");
    return true;
  }

  // ---------- places & location ----------

  async addPlace(a: any) {
    const name = typeof a.name === "string" ? a.name.trim().toLowerCase().slice(0, 60) : "";
    if (!name) return { error: "needs a name" };
    let lat = Number(a.lat), lon = Number(a.lon);
    if (a.here) {
      const fix = (await this.store.recent<LocationFix>("locations", 1))[0];
      if (!fix) return { error: "share your location from the app first" };
      lat = fix.lat; lon = fix.lon;
    }
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return { error: "needs coordinates" };
    const radiusM = Math.min(5000, Math.max(50, Number(a.radiusM) || 150));
    const existing = (await this.store.all<Place>("places")).find((p) => p.name === name);
    const p = await this.store.put<Place>("places", { ...(existing || this.doc({})), name, lat, lon, radiusM } as Place);
    this.emit("places");
    return { value: p };
  }

  async recordLocation(lat: number, lon: number, accuracy: number | undefined, source: string) {
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return { error: "Invalid coordinates." };
    const fix = await this.store.put<LocationFix>("locations", this.doc({ lat, lon, accuracy, source }));
    const cutoff = new Date(this.clock().getTime() - LOCATION_KEEP_DAYS * 864e5).toISOString();
    for (const old of await this.store.all<LocationFix>("locations")) if (old.createdAt < cutoff) await this.store.remove("locations", old.id);

    const prefs = await this.prefs();
    const state = { ...prefs.placeState };
    const changes: { place: Place; event: "arrive" | "leave" }[] = [];
    for (const p of await this.store.all<Place>("places")) {
      const d = distanceMeters(fix, p);
      const was = !!state[p.id];
      const inside = was ? d <= p.radiusM * 1.5 : d <= p.radiusM; // hysteresis so GPS jitter doesn't flap
      if (inside !== was) changes.push({ place: p, event: inside ? "arrive" : "leave" });
      state[p.id] = inside;
    }
    await this.setPrefs({ placeState: state });
    this.emit("location", fix);
    if (changes.length) {
      const hooks = (await this.store.all<Hook>("hooks")).filter((h) => h.status === "active" && h.trigger.type === "place");
      for (const c of changes) {
        await this.log("place", `${c.event === "arrive" ? "Arrived at" : "Left"} ${c.place.name}`);
        for (const h of hooks) {
          if (h.trigger.type === "place" && h.trigger.place === c.place.name && h.trigger.event === c.event) {
            this.fire(h, `${c.event === "arrive" ? "You arrived at" : "You left"} ${c.place.name}`);
          }
        }
      }
    }
    return { value: fix };
  }

  // ---------- the proactive engine ----------

  async start(intervalMs = 15_000) {
    await this.ensureTeammates();
    await this.ensureSystemHooks();
    this.timer = setInterval(() => this.tick().catch((e) => console.error("tick failed", e)), intervalMs);
    await this.tick();
  }

  stop() { if (this.timer) clearInterval(this.timer); }

  /** Resolves when no job or brain call is running (or after `ms`). Used for graceful shutdown. */
  async idle(ms = 30_000) {
    const end = Date.now() + ms;
    while (Date.now() < end && (this.started.size || this.brain.running || this.thinking || this.inflight)) await Bun.sleep(25);
  }

  private async ensureSystemHooks() {
    const hooks = await this.store.all<Hook>("hooks");
    if (!hooks.some((h) => h.source === "system" && h.action.type === "think" && h.action.prompt === REVIEW_MARKER)) {
      await this.addHook({
        title: "Nightly memory review", why: "Keeps memory tidy: merges duplicates, expires stale facts.",
        trigger: { type: "schedule", time: "03:30", days: [] }, action: { type: "think", prompt: REVIEW_MARKER },
      }, "system");
    }
    if (!hooks.some((h) => h.source === "system" && h.action.type === "think" && h.action.prompt === PURGE_MARKER)) {
      await this.addHook({
        title: "Nightly library cleanup", why: "Removes skills, workflows and scripts that stopped being useful. Pinned ones stay.",
        trigger: { type: "schedule", time: "04:00", days: [] }, action: { type: "think", prompt: PURGE_MARKER },
      }, "system");
    }
  }

  async tick() {
    const now = this.clock();
    const prefs = await this.prefs();
    for (const h of await this.store.all<Hook>("hooks")) {
      if (h.status !== "active" || this.firing.has(h.id)) continue;
      if (h.nextAt && new Date(h.nextAt) <= now) {
        const lateMin = (now.getTime() - new Date(h.nextAt).getTime()) / 60000;
        if (lateMin > 360 && h.trigger.type !== "at") {
          await this.reschedule(h, now);
          await this.log("hook.missed", `${h.title}: missed while the hub was off`);
          continue;
        }
        await this.fire(h, describeTrigger(h.trigger, prefs.tz), lateMin > 10);
      } else if (h.trigger.type === "silence") {
        const since = prefs.lastUserAt || h.createdAt;
        const quietFor = (now.getTime() - new Date(since).getTime()) / 3.6e6;
        if (quietFor >= h.trigger.hours && (!h.lastFiredAt || h.lastFiredAt < since)) {
          await this.fire(h, `${Math.floor(quietFor)}h without hearing from you`);
        }
      }
    }
  }

  private async reschedule(h: Hook, now: Date) {
    const prefs = await this.prefs();
    const nextAt = computeNextAt(h.trigger, prefs.tz, now, true);
    const done = h.trigger.type === "at" && !nextAt;
    const cur = (await this.store.get<Hook>("hooks", h.id)) || h;
    await this.store.put<Hook>("hooks", { ...cur, nextAt, status: done ? "done" : cur.status });
    this.emit("hooks");
  }

  /** Decides whether a hook may message you right now. */
  private async gate(h: Hook, now: Date): Promise<"ok" | "quiet" | "cap" | "cooldown"> {
    if (isUserReminder(h)) return "ok";
    const prefs = await this.prefs();
    if (h.cooldownMin && h.lastFiredAt && now.getTime() - new Date(h.lastFiredAt).getTime() < h.cooldownMin * 60000) return "cooldown";
    if (inQuietHours(now, prefs.tz, prefs.quietStart, prefs.quietEnd)) return "quiet";
    const today = localDate(now, prefs.tz);
    const n = prefs.proactiveToday.date === today ? prefs.proactiveToday.n : 0;
    if (n >= prefs.maxProactivePerDay) return "cap";
    return "ok";
  }

  private async countProactive(h: Hook) {
    if (isUserReminder(h)) return;
    const prefs = await this.prefs();
    const today = localDate(this.clock(), prefs.tz);
    const n = prefs.proactiveToday.date === today ? prefs.proactiveToday.n : 0;
    await this.setPrefs({ proactiveToday: { date: today, n: n + 1 } });
  }

  async fire(h: Hook, reason: string, late = false) {
    if (this.firing.has(h.id)) return;
    this.firing.add(h.id);
    const now = this.clock();
    try {
      const isReview = h.source === "system" && h.action.type === "think" && h.action.prompt === REVIEW_MARKER;
      if (h.source === "system" && h.action.type === "think" && h.action.prompt === PURGE_MARKER) {
        await this.reschedule(h, now);
        await this.purgeLibrary();
        return;
      }
      const gate = isReview ? "ok" : await this.gate(h, now);
      if (gate !== "ok") {
        const prefs = await this.prefs();
        if (gate === "quiet" && h.nextAt) {
          await this.store.put<Hook>("hooks", { ...h, nextAt: quietEndsAt(now, prefs.tz, prefs.quietEnd).toISOString() });
          await this.log("hook.held", `${h.title}: held until quiet hours end`);
        } else {
          await this.reschedule(h, now);
          await this.log("hook.held", `${h.title}: skipped (${gate === "cap" ? "daily limit reached" : gate})`);
        }
        return;
      }
      await this.reschedule(h, now); // before running, so a slow brain can't double-fire
      const fresh = (await this.store.get<Hook>("hooks", h.id)) || h;
      await this.store.put<Hook>("hooks", { ...fresh, lastFiredAt: now.toISOString(), fireCount: (h.fireCount || 0) + 1 });

      if (isReview) {
        const r = await this.turn("review", "Review memory.", "nightly review", { profile: (await this.brains()).heavy });
        if (r.text && r.text !== QUIET) await this.log("memory.review", r.text);
        return;
      }

      let text = "";
      let did: Done[] = [];
      const teammate = await this.teammate(h.teammateId);
      const a = h.action;
      if (a.type === "notify") {
        text = a.text;
      } else if (a.type === "think") {
        const r = await this.turn("hook", `${h.title}\n${a.prompt}`, `hook: ${h.title}`, { teammate, threadId: h.threadId });
        text = r.text; did = r.did;
      } else if (a.type === "script") {
        const out = await this.scripts.run(a.script, a.args);
        if (out.needsApproval) {
          const ap = await this.requestApproval({ summary: `${h.title}: run ${a.script}`, script: a.script, args: a.args }, { threadId: h.threadId });
          text = `${h.title} wants to ${ap.value?.summary ?? `run ${a.script}`}. Tap Approve to let it.`;
        } else if (a.then === "notify" || !out.ok) text = out.ok ? out.output.slice(0, 1500) : `${h.title}: ${out.output}`;
        else { const r = await this.turn("hook", `${h.title}\nInterpret the output of script ${a.script} for the user.`, `hook: ${h.title}`, { teammate, threadId: h.threadId, extra: `## ${a.script}\n${out.output}` }); text = r.text; did = r.did; }
      }

      if (!text || text.trim() === QUIET || text.includes(QUIET)) {
        await this.log("hook.quiet", `${h.title}: checked, nothing worth saying`);
        return;
      }
      await this.countProactive(h);
      const msg = await this.addMessage({
        role: "assistant", teammateId: teammate?.id, threadId: h.threadId || (await this.updatesThread()), text: late ? `${text}\n\n(Late: the hub was offline when this was due.)` : text,
        proactive: { hookId: h.id, title: h.title, trigger: reason, why: h.why }, did: did.length ? did : undefined,
      });
      await this.touchThread(msg.threadId!, { preview: msg.text.slice(0, 120) });
      await this.log("hook.fired", `${h.title}: sent`);
      await this.push?.send({ title: h.title, body: msg.text.slice(0, 180), tag: h.id, url: `/#chat/${msg.threadId}` });
    } catch (err: any) {
      await this.log("hook.failed", `${h.title}: ${err.message}`);
    } finally {
      this.firing.delete(h.id);
    }
  }

  // ---------- your data ----------

  async exportAll() {
    const out: Record<string, unknown> = { exportedAt: this.clock().toISOString(), hub: this.config.name, storage: this.store.kind };
    for (const col of ["threads", "messages", "jobs", "teammates", "skills", "workflows", "approvals", "hooks", "memory", "notebooks", "places", "locations", "activity", "scripts"] as const) out[col] = await this.store.all(col);
    out.devices = (await this.store.all<any>("devices")).map(({ tokenHash, ...d }) => d);
    out.prefs = await this.prefs();
    return out;
  }

  async wipePersonal() {
    for (const col of ["threads", "messages", "jobs", "approvals", "hooks", "memory", "notebooks", "places", "locations", "activity"] as const) await this.store.clear(col);
    await this.ensureSystemHooks();
    await this.ensureTeammates();
    await this.log("data.wiped", "All personal data deleted from this hub.");
    this.emit("reset");
  }
}
