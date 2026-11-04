import { join } from "node:path";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import type { Store, Collection } from "./store/index.ts";
import type { Brain, BrainInput, BrainProfile, Brains, Meter } from "./brain.ts";
import { QUIET, ESCALATE, escalateWhy, HAND_BACK, REDO, HARNESSES, MODEL_RE, availableHarnesses, NeedsComputer, BrainsFull, POOL_HARNESSES } from "./brain.ts";
import type { Scripts } from "./scripts.ts";
import type { Push } from "./push.ts";
import { parseReply } from "./reply.ts";
import { validateHook, computeNextAt, describeTrigger, isUserReminder } from "./hooks.ts";
import { look, lineDiff } from "./watch.ts";
import { Google } from "./google.ts";
import { Connections } from "./connections.ts";
import { readPage } from "./browser.ts";
import { SignedOut } from "./sources/pages.ts";
import type { Vault } from "./vault.ts";
import { SOURCES, sourceById, formatItems, needOf, type Item } from "./sources/index.ts";
import { recall, isActive, validateFact } from "./memory.ts";
import { describeLocal, inQuietHours, quietEndsAt, localDate, distanceMeters } from "./time.ts";
import { CHANNELS, CHANNEL_LABEL, type Channel } from "./types.ts";
import { badChatLink } from "./connectors/web-senders.ts";
import { googleAgent, CHANGE_KINDS, type GoogleChange } from "./connectors/google-agent.ts";
import type { Project } from "./types.ts";
import { channelWorkspace, workspaceName, type Place as WorkPlace } from "./brains/sessions.ts";
import type { ConnAudit, TriggerRecipe, Component, DayLog, Idea, MiniApp, Person, StoredFile, Activity, Approval, Done, Fact, Hook, Job, LocationFix, Message, Notebook, Place, Prefs, Script, Skill, Teammate, Thread, Workflow } from "./types.ts";
import { Library, validateSkill, validateWorkflow, validateTriggerRecipe, fillDeep, fill, type LibraryItem } from "./library.ts";
import { cleanTile, cleanOptions, extractTiles, type Tile } from "./tiles.ts";
import { Files, extractFiles } from "./files.ts";
import { Apps, appSize } from "./apps.ts";
import { sha256 } from "./auth.ts";
import { Narrator } from "./brains/narrate.ts";
import { syncBrowserLogins } from "./brains/browser-logins.ts";
import type { FreshLogin } from "./computers.ts";
import { labelFor } from "./cookie-sites.ts";

const DEFAULT_PREFS: Prefs = {
  userName: "", tz: "UTC", quietStart: "23:00", quietEnd: "07:30",
  maxProactivePerDay: 6, proactiveToday: { date: "", n: 0 }, placeState: {},
};
// Teammates are named after their job ("Reminders", "Research"), so "@Research is on it" explains itself.
export const DEFAULT_TEAMMATES: Pick<Teammate, "id" | "name" | "color" | "description" | "prompt" | "emoji">[] = [
  { id: "hearth", name: "Hearth", emoji: "🔥", color: "#F5A524", description: "Your front desk. Handles anything and remembers everything.",
    prompt: "You are Hearth, the user's main assistant. Handle anything; be brief and warm." },
  { id: "planner", name: "Reminders", emoji: "🔔", color: "#5B8CFF", description: "Reminders, routines, your day and week.",
    prompt: "You are Reminders. You own the user's time: reminders, routines, follow-ups, planning the day and week. Prefer creating hooks." },
  { id: "scout", name: "Research", emoji: "🔍", color: "#2FBF71", description: "Looks things up: places, products, prices, answers from the web.",
    prompt: "You are Research. You find things: places to eat, products, facts, prices. Search the web, give 3 good options with one line each." },
  { id: "money", name: "Bills", emoji: "💸", color: "#E36BD6", description: "Bills, subscriptions, spending, saving.",
    prompt: "You are Bills. You track bills, subscriptions and spending and nudge the user before due dates. Never move money; offer reminders and drafts." },
];
/** Names the built-in teammates had before they were named after their job; renamed on start. */
const OLD_NAMES: Record<string, string> = { planner: "Planner", scout: "Scout", money: "Money" };

const REVIEW_MARKER = "[[memory-review]]";
const PURGE_MARKER = "[[library-purge]]";
const IDEAS_MARKER = "[[ideas]]";
const MAX_OPEN_IDEAS = 4;
const LOCATION_KEEP_DAYS = 7;

type TurnOpts = { teammate?: Teammate | null; threadId?: string; jobId?: string; extra?: string; profile?: BrainProfile; meter?: Meter; allowedScripts?: string[]; top?: boolean };
const label = (p: BrainProfile) => `${p.harness}${p.model ? `/${p.model}` : ""}`;
/** A model in words for the app: "Claude opus", "Codex gpt-5.5", "Claude" (its default model). */
export const brainName = (w: { harness: string; model?: string }) =>
  `${w.harness === "claude" ? "Claude" : w.harness === "codex" ? "Codex" : w.harness}${w.model ? ` ${w.model.replace(/^claude-/, "")}` : ""}`;
/** Where a call ran, in words: "on the cloud", "on Rishi's MacBook Pro", or nothing on a laptop hub. */
const whereName = (ranOn?: string) => (ranOn ? ` on ${ranOn === "cloud" ? "the cloud" : ranOn}` : "");

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

// Screen-reader text LinkedIn puts in each conversation row: ". Active conversation", ". Press return to go to
// conversation details", "Open the options list in your conversation with …", "Status is online".
const HIDDEN_LABEL = /^(\.\s|open the options list|status is|active now|press return to go to|·$)/i;

export class Hub {
  clock = () => new Date();
  private listeners = new Set<(e: HubEvent) => void>();
  private firing = new Set<string>();
  private _google: Google | null = null;
  /** The encrypted key vault (vault.ts), set by the server. Connections keep their sign-ins in it. */
  vault: Vault | null = null;
  /** Your Google account (Gmail, Calendar), if you've connected one. */
  get google() {
    // Made again once the vault arrives, so an early look (before the server set it) doesn't stick.
    if (!this._google || this._googleVault !== this.vault) { this._google = new Google(this.vault); this._googleVault = this.vault; }
    return this._google;
  }
  private _googleVault: Vault | null = null;
  private _connections: Connections | null = null;
  /** Every account teammates can read (Google, LinkedIn, X), all kept in the vault. */
  get connections() {
    const g = this.google;
    if (!this._connections || (this._connections as any).google !== g) {
      const extra = this._connections?.extra ?? {};
      this._connections = new Connections(this.vault, g);
      this._connections.extra = extra;
    }
    return this._connections;
  }
  /** Headless Chrome for logged-in sites. Swapped in tests. */
  readPage = readPage;
  /** Linked computers (your Mac), set by the server. A Mac can copy browser logins up and be re-asked when one dies. */
  computers: { refreshCookies(site?: string): unknown; canCopyCookies(): boolean; freshLogin?(site: string, ms?: number): Promise<FreshLogin> } | null = null;
  /** How long a job waits for your Mac to answer "do you have this login?" (shorter in tests). */
  freshLoginWaitMs = 25_000;
  /** Jobs that got a fresh login mid-run: they run again as soon as this turn finishes. */
  private rerunAfterLogin = new Set<string>();
  /** Every logged-in read goes out as the browser its login came from (see Fingerprint), unless the caller set one. */
  private sourceCtx = async () => ({ google: this.google, cookies: (domain: string) => this.connections.cookies(domain),
    readPage: ((url, o = {}) => this.readPage(url, { fingerprint: this.connections.fingerprintFor(url), ...o })) as typeof readPage,
    now: this.clock(), tz: (await this.prefs()).tz });
  /** Webhook calls that arrived while their hook was still busy with the last one; handled together right after. */
  private webhookQueue = new Map<string, string[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  // Planning runs one batch at a time per ramble: messages sent while it's planning wait and are planned together next.
  private planning = new Set<string>();
  private planQueue = new Map<string, Message[]>();
  get thinking() { return this.planning.size > 0; }
  private prefsLock = new Lock();
  private memoryLock = new Lock();
  private started = new Set<string>();   // job ids already handed to runJob
  private stops = new Map<string, AbortController>(); // running jobs, so a new message can restart one
  private cancelled = new Set<string>();              // running jobs you tapped Stop on
  private running = new Map<string, string>();     // job id -> the model on it now and where ("Claude opus on the cloud")
  private additions = new Map<string, string[]>();    // what the user added to a running job, applied when it restarts
  private inflight = 0;                   // orchestrations, splits and retries still running
  private rambleSpend = new Map<string, number>(); // message id -> USD

  constructor(
    readonly config: Config, readonly store: Store, readonly brain: Brain,
    readonly scripts: Scripts, readonly push: Push | null,
    readonly library: Library = new Library(null),
    readonly files: Files = new Files(store, config.dataDir),
    readonly apps: Apps = new Apps(store),
  ) {
    brain.pool = () => this.brainPool();
    // The brain's browser (enkidu-browser) opens signed in to every site you connected.
    brain.beforeBrowse = () => this.giveBrowserLogins();
    brain.health.onChange = (st) => { void this.brainHealthChanged(st.harness, st.ok, st.message).catch(() => {}); };
    brain.health.onSeen = () => this.emit("brains");
    // Every phone notification also goes out on the live stream, so the Mac app can show it as a Mac notification.
    if (push) push.onSend = (payload, only) => this.emit("notify", { ...payload, only: only ?? null });
  }

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

  /** The audit trail for connected accounts: who touched which login, when. Kept long (not trimmed like activity). */
  async audit(action: ConnAudit["action"], site: string, by: string, extra: { ok?: boolean; detail?: string } = {}) {
    const e = await this.store.put<ConnAudit>("connAudit", this.doc({ action, site, by, ok: extra.ok, detail: extra.detail?.slice(0, 200) }));
    await this.trim("connAudit", 5000);
    this.emit("connAudit", e);
  }
  async connAudit() { return (await this.store.recent<ConnAudit>("connAudit", 200)).reverse(); }

  /** A readable actor name for the audit: a teammate's name, else a fallback ("you", "system"). */
  private async actorName(teammateId?: string | null, fallback = "a teammate") {
    if (!teammateId) return fallback;
    if (teammateId === "hearth") return "Hearth";
    return (await this.teammate(teammateId))?.name || fallback;
  }

  private async trim(col: Collection, keep: number) {
    const rows = await this.store.all(col);
    for (const r of rows.slice(0, Math.max(0, rows.length - keep))) await this.store.remove(col, r.id);
  }

  // ---------- context for the brain ----------

  async context(query: string, mode: BrainInput["mode"], teammate?: Teammate | null, threadId?: string) {
    const now = this.clock();
    const prefs = await this.prefs();
    // The voice pass only writes the answer from the legwork notes: who it is, who the user is, the time. Nothing else.
    if (mode === "voice") {
      return {
        you: teammate ? { name: teammate.name, role: teammate.prompt } : { name: "Hearth", role: "The user's main assistant." },
        now: describeLocal(now, prefs.tz), tz: prefs.tz, userName: prefs.userName || undefined, aboutYou: prefs.about || undefined,
        memory: recall(await this.store.all<Fact>("memory"), query, 8, now).map((f) => f.fact),
        components: (await this.searchLibrary(query)).filter((x) => x.kind === "component"), // ready-made visuals it can fill with data
      };
    }
    const facts = await this.store.all<Fact>("memory");
    // In a project's ramble: everything in its notebook comes first, then what's relevant from the rest.
    const project = await this.projectOf(threadId);
    const own = project ? facts.filter((f) => f.notebook === project.notebook && isActive(f, now)).slice(-30) : [];
    const memory = mode === "review" ? facts.filter((f) => isActive(f, now))
      : [...own, ...recall(facts.filter((f) => !own.includes(f)), query, 40 - own.length, now)];
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
      teammates: team.map((t) => ({ name: t.name, does: t.description, emoji: t.emoji })),
      hub: this.config.name,
      nowIso: now.toISOString(),
      now: describeLocal(now, prefs.tz),
      tz: prefs.tz,
      userName: prefs.userName || undefined,
      aboutYou: prefs.about || "(not written yet)",
      people: (await this.store.all<Person>("people")).slice(0, 80).map((p) => ({ name: p.name, relation: p.relation, notes: p.notes.slice(-4), links: p.links })),
      quietHours: `${prefs.quietStart}-${prefs.quietEnd}`,
      proactiveMessagesLeftToday: Math.max(0, prefs.maxProactivePerDay - used),
      location,
      places: places.map((p) => ({ name: p.name, radiusM: p.radiusM })),
      sources: SOURCES.map((s) => ({ id: s.id, label: s.label, connected: typeof s.needs === "function" ? undefined : this.connections.connected(s.needs) })),
      ...(project ? { project: { name: project.name, notebook: project.notebook, about: project.about || undefined,
        rambles: (await this.store.all<Thread>("threads")).filter((t) => t.projectId === project.id).map((t) => channelOf(t)).slice(0, 20) } } : {}),
      memory: memory.map((f) => ({ id: f.id, fact: f.fact, notebook: f.notebook, importance: f.importance, ...(f.expiresAt ? { expiresAt: f.expiresAt } : {}) })),
      notebooks: (await this.store.all<Notebook>("notebooks")).map((n) => ({ name: n.name, summary: n.summary })),
      // Every plan while there are few; with many, the ones that match this request plus the newest (search finds the rest).
      hooks: (hooks.length <= 30 ? hooks : await this.relevantHooks(hooks, query)).map((h) => ({ id: h.id, title: h.title, when: describeTrigger(h.trigger, prefs.tz), does: h.action.type, why: h.why, status: h.status, ...(h.teammateId ? { teammate: h.teammateId } : {}) })),
      ...(hooks.length > 30 ? { hooksTotal: hooks.length } : {}),
      scripts: (await this.scripts.list()).filter((s) => s.status !== "rejected").map((s) => ({ name: s.name, description: s.description, status: s.status })),
      recentMessages: history.map((m) => ({ role: m.role, at: m.createdAt, text: m.text.slice(0, 600) })),
      library: mode === "review" ? undefined : await this.searchLibrary(query),
      ...(mode === "review" || mode === "ideas" ? { recentDays: await this.recentDays(mode === "ideas" ? 3 : 2) } : {}),
      ...(mode === "ideas" ? { ideas: await this.ideaTitles() } : {}),
      apps: mode === "review" ? undefined : (await this.apps.list()).map((a) => {
        const data = JSON.stringify(a.data ?? null);
        return { name: a.name, title: a.title, does: a.description, onHome: a.pinned ? appSize(a.size) : false, data: data.length > 6000 ? `${data.slice(0, 6000)}… (truncated; send the full data when you change it)` : a.data };
      }),
    };
  }

  // ---------- one brain turn, with an optional script round-trip ----------

  async turn(mode: BrainInput["mode"], input: string, evidence: string, opts: TurnOpts = {}) {
    const { teammate, extra } = opts;
    const profile = opts.profile || (await this.brains()).workhorse;
    const where = { teammateId: teammate?.id, threadId: opts.threadId, jobId: opts.jobId, recipe: opts.allowedScripts };
    const ctx = await this.context(input, mode, teammate, opts.threadId);
    const first = parseReply(await this.brain.think({ mode, context: ctx, input, toolResults: extra, top: opts.top }, profile, opts.meter));
    // Keeps the model's reason with the marker: nothing it proposed is applied.
    if (first.text.includes(ESCALATE)) return { text: `${ESCALATE} ${escalateWhy(first.text)}`, did: [] as Done[], used: [] as string[] };
    if (first.text.includes(HAND_BACK)) return { text: HAND_BACK, did: [] as Done[], used: [] as string[] }; // nothing it proposed is applied
    const applied = await this.applyActions(first.actions, evidence, where);
    if (!applied.runs.length) return { text: first.text, did: applied.done, used: applied.used, split: applied.split, tiles: applied.tiles, fileIds: applied.fileIds };
    const scriptTiles: Tile[] = [];
    const scriptFiles: string[] = [];

    const results: string[] = [];
    for (const r of applied.runs.slice(0, 3)) {
      if (r.name === "@history") { results.push(`## Past conversations matching "${r.args[0]}"\n${await this.searchHistory(r.args[0])}`); continue; }
      if (r.name === "@source") { results.push(await this.readSource(JSON.parse(r.args[0]), teammate?.name || "a teammate")); continue; }
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
      const fx = extractFiles(out.output);
      for (const n of fx.names) {
        const f = await this.files.adopt(this.scripts.workDir, n, { source: "script", threadId: opts.threadId, jobId: opts.jobId, teammateId: teammate?.id });
        if (f.value) { scriptFiles.push(f.value.id); applied.done.push({ kind: "file", label: `Made ${f.value.name}`, id: f.value.id }); }
      }
      const ex = extractTiles(fx.text);
      scriptTiles.push(...ex.tiles);
      results.push(`## ${r.name}\n${ex.text}${ex.tiles.length ? `\n(${ex.tiles.length} tile(s) already shown to the user)` : ""}`);
    }
    const ctx2 = await this.context(input, mode, teammate, opts.threadId);
    const second = parseReply(await this.brain.think({ mode, context: ctx2, input, toolResults: [extra, ...results].filter(Boolean).join("\n\n"), top: opts.top }, profile, opts.meter));
    const applied2 = await this.applyActions(second.actions.filter((a: any) => a?.type !== "script.run"), evidence, where);
    const tiles = [...applied.tiles, ...applied2.tiles, ...scriptTiles].slice(0, 4);
    const fileIds = [...applied.fileIds, ...applied2.fileIds, ...scriptFiles];
    return { text: second.text || first.text, did: [...applied.done, ...applied2.done], used: [...applied.used, ...applied2.used], split: applied.split ?? applied2.split, tiles, fileIds };
  }

  // ---------- brains: who plans, who works ----------

  async brains(): Promise<Brains> {
    const saved = (await this.prefs()).brains;
    const b: Brains = { ...this.brain.defaults(), ...(saved || {}) };
    for (const role of ["orchestrator", "quick", "workhorse", "heavy"] as const) b[role] = { ...b[role], role };
    return b;
  }

  /** The brains the user picked. None picked yet: whichever ones the roles already use. */
  async brainPool(): Promise<string[]> {
    const saved = (await this.prefs()).brainPool;
    if (saved?.length) return saved;
    const b = await this.brains();
    return [...new Set([b.orchestrator, b.quick, b.workhorse, b.heavy].map((p) => p.harness))];
  }

  /** Pick the brains (multi-select). The roles move onto a picked brain if theirs was dropped. */
  async setBrainPool(list: unknown) {
    const allowed = availableHarnesses(this.config);
    const pool = [...new Set((Array.isArray(list) ? list : []).map(String))];
    if (!pool.length) return { error: "Pick at least one brain." };
    const bad = pool.find((h) => !(POOL_HARNESSES as readonly string[]).includes(h) || !allowed.includes(h));
    if (bad) return { error: `${bad} isn't installed on this hub.` };
    const cur = await this.brains();
    const next: Brains = { ...cur };
    for (const role of ["orchestrator", "quick", "workhorse", "heavy"] as const)
      if (!pool.includes(cur[role].harness)) { const { role: _, ...p } = this.brain.onBrain(cur[role], pool[0]); next[role] = p; }
    await this.setPrefs({ brainPool: pool, brains: next });
    await this.log("brains", `Brains: ${pool.join(", ")}${pool.length > 1 ? " (the one with the most room on its plan takes each job)" : ""}`);
    return { value: { pool, brains: next } };
  }

  async setBrains(patch: any) {
    const allowed = availableHarnesses(this.config);
    const cur = await this.brains();
    const next: Brains = { ...cur };
    for (const role of ["orchestrator", "quick", "workhorse", "heavy"] as const) {
      const p = patch?.[role];
      if (!p) continue;
      const harness = String(p.harness || "");
      const model = String(p.model ?? "");
      if (!(HARNESSES as readonly string[]).includes(harness) || !allowed.includes(harness)) return { error: `${harness} isn't available on this hub.` };
      if (!MODEL_RE.test(model)) return { error: "Model names are letters, digits, dots, dashes and slashes." };
      next[role] = { harness, model };
    }
    await this.setPrefs({ brains: next, ...(typeof patch?.hybrid === "boolean" ? { hybrid: patch.hybrid } : {}) });
    await this.log("brains", `Orchestrator ${label(next.orchestrator)}, workhorse ${label(next.workhorse)}, heavy ${label(next.heavy)}`);
    return { value: next };
  }

  // ---------- rambles: you talk, the orchestrator hands out jobs ----------

  /** Group chats (one per ramble), newest first, with who's in them and whether anything is running or needs you. */
  async listThreads() {
    const all = await this.store.all<Job>("jobs");
    const stale = supersededJobs(all);
    const jobs = all.filter((j) => !j.parentId && !stale.has(j.id));
    return (await this.store.all<Thread>("threads"))
      .filter((t) => !t.id.startsWith("tm-") && t.id !== "main")
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((t) => {
        const mine = jobs.filter((j) => j.threadId === t.id);
        return { ...t, name: channelOf(t), archived: !!t.archivedAt, members: [...new Set(mine.map((j) => j.teammateId))],
          working: mine.filter((j) => j.status === "working" || j.status === "queued").length,
          needsYou: mine.filter(needsYouBadge).length };
      });
  }

  /** A working job's latest live-view picture, or null. */
  liveFrame(jobId: string) {
    return this.frames.get(jobId) ?? null;
  }

  async threadDetail(id: string) {
    const thread = await this.store.get<Thread>("threads", id);
    if (!thread) return null;
    const messages = (await this.store.all<Message>("messages")).filter((m) => m.threadId === id);
    const jobs = (await this.store.all<Job>("jobs")).filter((j) => j.threadId === id);
    return { thread, messages, jobs, steps: Object.fromEntries(jobs.filter((j) => this.steps.has(j.id)).map((j) => [j.id, this.steps.get(j.id)!.at(-1)!.text])),
      stepLog: Object.fromEntries(jobs.filter((j) => this.steps.has(j.id)).map((j) => [j.id, this.steps.get(j.id)])),
      frames: Object.fromEntries(jobs.filter((j) => this.frames.has(j.id)).map((j) => [j.id, this.frames.get(j.id)!.n])),
      running: Object.fromEntries(jobs.filter((j) => this.running.has(j.id)).map((j) => [j.id, this.running.get(j.id)!])) };
  }

  async removeThread(id: string) {
    for (const m of (await this.store.all<Message>("messages")).filter((m) => m.threadId === id)) await this.store.remove("messages", m.id);
    for (const j of (await this.store.all<Job>("jobs")).filter((j) => j.threadId === id)) await this.store.remove("jobs", j.id);
    const ok = await this.store.remove("threads", id);
    this.emit("threads");
    return ok;
  }

  /** Name a ramble's channel ("japan-trip"). Names are lowercase words and dashes, unique among rambles. */
  // ---------- projects: folders of rambles, each with its own memory notebook ----------

  async projectOf(threadId?: string): Promise<Project | null> {
    if (!threadId) return null;
    const t = await this.store.get<Thread>("threads", threadId);
    return t?.projectId ? await this.store.get<Project>("projects", t.projectId) : null;
  }

  async listProjects() {
    const threads = (await this.store.all<Thread>("threads")).filter((t) => t.projectId);
    return (await this.store.all<Project>("projects")).sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ ...p, rambles: threads.filter((t) => t.projectId === p.id).length }));
  }

  async createProject(name: string, emoji?: string) {
    const n = name.trim().slice(0, 60);
    if (!n) return { error: "Give the project a name." };
    if ((await this.store.all<Project>("projects")).some((p) => p.name.toLowerCase() === n.toLowerCase())) return { error: `There's already a project called ${n}.` };
    const p = await this.store.put<Project>("projects", { ...this.doc({}), name: n, emoji: emoji?.slice(0, 8) || undefined, notebook: `project-${(slugOf(n) || "project").slice(0, 31)}` } as Project);
    await this.log("project.created", n);
    this.emit("projects");
    return { value: p };
  }

  async updateProject(id: string, patch: { name?: string; emoji?: string; about?: string }) {
    const p = await this.store.get<Project>("projects", id);
    if (!p) return { error: "No such project." };
    const next = { ...p, ...(patch.name?.trim() ? { name: patch.name.trim().slice(0, 60) } : {}), ...(patch.emoji !== undefined ? { emoji: patch.emoji.slice(0, 8) || undefined } : {}),
      ...(patch.about !== undefined ? { about: patch.about.slice(0, 1000) || undefined } : {}), updatedAt: this.clock().toISOString() };
    await this.store.put("projects", next);
    this.emit("projects");
    return { value: next };
  }

  /** Delete a project: its rambles stay (just not filed), and its memory stays in your memory. */
  async removeProject(id: string) {
    const p = await this.store.get<Project>("projects", id);
    if (!p) return false;
    for (const t of (await this.store.all<Thread>("threads")).filter((t) => t.projectId === id)) await this.store.put("threads", { ...t, projectId: undefined });
    await this.store.remove("projects", id);
    await this.log("project.removed", p.name);
    this.emit("projects"); this.emit("threads");
    return true;
  }

  /** File a ramble under a project (or take it out with null). */
  async fileThread(threadId: string, projectId: string | null) {
    const t = await this.store.get<Thread>("threads", threadId);
    if (!t || t.id.startsWith("tm-") || t.id === "main") return { error: "No such ramble." };
    if (projectId && !(await this.store.get<Project>("projects", projectId))) return { error: "No such project." };
    const saved = await this.store.put<Thread>("threads", { ...t, projectId: projectId || undefined });
    this.emit("threads"); this.emit("projects");
    return { value: saved };
  }

  /** A project's page: its rambles, what's in its memory, and files from its rambles. */
  async projectDetail(id: string) {
    const p = await this.store.get<Project>("projects", id);
    if (!p) return null;
    const rambles = (await this.listThreads()).filter((t: any) => t.projectId === id);
    const ids = new Set(rambles.map((t: any) => t.id));
    return {
      project: p, rambles,
      memory: (await this.store.all<Fact>("memory")).filter((f) => f.notebook === p.notebook && isActive(f, this.clock())).map((f) => ({ id: f.id, fact: f.fact, createdAt: f.createdAt })),
      files: (await this.store.all<StoredFile>("files")).filter((f) => f.threadId && ids.has(f.threadId)).reverse().slice(0, 50),
    };
  }

  async renameThread(id: string, name: string, byUser = true) {
    const t = await this.store.get<Thread>("threads", id);
    if (!t || t.id.startsWith("tm-")) return { error: "No such ramble." };
    const slug = slugOf(name);
    if (!slug) return { error: "Give it a name with letters or numbers." };
    const taken = new Set((await this.store.all<Thread>("threads")).filter((x) => x.id !== id).map((x) => channelOf(x)));
    let unique = slug;
    for (let n = 2; taken.has(unique); n++) unique = `${slug.slice(0, 27)}-${n}`;
    const saved = await this.store.put<Thread>("threads", { ...t, channel: unique, channelBy: byUser ? "you" : "hearth" });
    if (byUser) await this.log("ramble.renamed", `#${unique}`);
    this.emit("threads");
    return { value: saved };
  }

  /** Any activity in a ramble brings it back from the archive. */
  private async touchThread(id: string, patch: Partial<Thread>) {
    const t = await this.store.get<Thread>("threads", id);
    if (!t) return;
    await this.store.put<Thread>("threads", { ...t, ...patch, archivedAt: undefined, updatedAt: this.clock().toISOString() });
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
  async ramble(text: string, threadId?: string, fileIds: string[] = [], projectId?: string) {
    const clean = text.trim().slice(0, 8000) || (fileIds.length ? "Have a look at this." : "");
    if (!clean) return { error: "Say something first." };
    // Every new ramble starts its own group chat (Slack-style); a ramble inside a chat continues it.
    let thread = threadId ? await this.store.get<Thread>("threads", threadId) : null;
    if (threadId && !thread) return { error: "No such chat." };
    if (!thread) {
      const now = this.clock().toISOString();
      const num = Math.max(0, ...(await this.store.all<Thread>("threads")).map((t) => t.num || 0)) + 1;
      // Started from a project (or with one picked): filed before planning, so the first message already uses its memory.
      const project = projectId ? await this.store.get<Project>("projects", projectId) : null;
      thread = await this.store.put<Thread>("threads", { id: randomUUID(), createdAt: now, updatedAt: now, num, title: clean.split(/\s+/).slice(0, 6).join(" "), ...(project ? { projectId: project.id } : {}) });
      if (project) this.emit("projects");
    }
    const files = (await Promise.all(fileIds.slice(0, 5).map((id) => this.store.get<StoredFile>("files", id)))).filter(Boolean) as StoredFile[];
    for (const f of files) await this.store.put<StoredFile>("files", { ...f, threadId: thread.id });
    // Fast path: the ramble's latest task thread is idle, so it goes straight to that teammate with no planning call.
    // The teammate hands it back if it's something new, and only then is it planned (see handBack).
    const root = threadId && !thread.id.startsWith("tm-") && !this.planning.has(thread.id) ? await this.latestTask(thread.id) : null;
    const m = await this.addMessage({ role: "user", text: clean, threadId: thread.id, fileIds: files.map((f) => f.id), ...(root ? { continues: [root.id] } : {}) });
    await this.setPrefs({ lastUserAt: m.createdAt });
    await this.touchThread(thread.id, { preview: clean.slice(0, 120) });
    if (root) {
      const { job } = await this.followUp(root, m, clean, true);
      await this.store.put<Message>("messages", { ...m, jobIds: [job.id] });
      this.emit("job", job);
      this.pump(m.id);
    } else this.queuePlan(thread, m);
    return { value: { thread, message: m } };
  }

  /** The ramble's most recently active task thread, if nothing in it is still going and it was active in the last 3 hours.
   *  A stuck (blocked) thread counts: "where are you stuck?" belongs in it, not in a new task. */
  private async latestTask(threadId: string): Promise<Job | null> {
    const jobs = (await this.store.all<Job>("jobs")).filter((j) => j.threadId === threadId && !j.parentId);
    let best: Job | null = null, bestAt = "";
    for (const root of jobs.filter((j) => !j.followsUp)) {
      const line = jobs.filter((j) => j.id === root.id || j.followsUp === root.id);
      const at = line.map((j) => j.finishedAt || j.updatedAt || j.createdAt).sort().at(-1) || "";
      if (at > bestAt) { best = root; bestAt = at; }
    }
    if (!best) return null;
    if (jobs.some((j) => (j.id === best!.id || j.followsUp === best!.id) && !["done", "failed", "blocked"].includes(j.status))) return null;
    return this.clock().getTime() - new Date(bestAt).getTime() < 3 * 3600_000 ? best : null;
  }

  /** A teammate said a fast-pathed message isn't about its thread: drop the follow-up and plan the message as usual. */
  /** What each running job is doing right now, so a reload or another device sees it too. */
  /** Each working job's steps so far (newest last, capped), so the app can show the whole stream, not just the latest. */
  private steps = new Map<string, { at: string; text: string }[]>();
  /** Each working job's latest live-view picture (memory only, gone when the job ends). */
  private frames = new Map<string, { n: number; at: string; mime: string; data: Uint8Array }>();
  private handedBack = new Map<string, string>(); // message id -> the task thread that handed it back
  private async handBack(job: Job, meter: Meter) {
    this.stops.delete(job.id); this.steps.delete(job.id); this.frames.delete(job.id);
    await this.addSpend(job.messageId, meter.costUsd);
    await this.store.remove("jobs", job.id);
    this.emit("job", { ...job, handedBack: true });
    const m = await this.store.get<Message>("messages", job.messageId);
    const thread = await this.store.get<Thread>("threads", job.threadId);
    if (!m || !thread) return;
    const { continues: _, jobIds: __, ...rest } = m;
    const plain = await this.store.put<Message>("messages", rest as Message);
    this.emit("message", plain);
    if (job.followsUp) this.handedBack.set(m.id, job.followsUp);
    // It's a new topic: offer to move it to its own ramble (planning runs meanwhile, so the wait costs nothing extra).
    await this.offerMove(plain);
    this.queuePlan(thread, plain);
  }

  /** "Looks like a new topic": moves the message to its own ramble after 5s unless you keep it here. */
  private moves = new Map<string, { promise: Promise<"move" | "keep">; resolve: (how: "move" | "keep") => void }>();
  private async offerMove(m: Message) {
    if (this.moves.has(m.id)) return;
    let resolve!: (how: "move" | "keep") => void;
    const promise = new Promise<"move" | "keep">((ok) => { resolve = ok; });
    const timer = setTimeout(() => resolve("move"), 5000);
    this.moves.set(m.id, { promise, resolve: (how) => { clearTimeout(timer); resolve(how); } });
    const until = new Date(this.clock().getTime() + 5000).toISOString();
    this.emit("message", await this.store.put<Message>("messages", { ...m, newTopic: { until } }));
  }
  /** Your answer to the offer: move it now, or keep it in this ramble. */
  async decideMove(threadId: string, messageId: string, how: "move" | "keep") {
    const offer = this.moves.get(messageId);
    const m = await this.store.get<Message>("messages", messageId);
    if (!offer || !m || m.threadId !== threadId) return false;
    offer.resolve(how);
    return true;
  }
  /** Waits for the offer on this message (if there is one) and, if it's moving, makes its new ramble and moves it there. */
  private async settleMove(thread: Thread, m: Message): Promise<{ thread: Thread; m: Message }> {
    const offer = this.moves.get(m.id);
    if (!offer) return { thread, m };
    const how = await offer.promise;
    this.moves.delete(m.id);
    const cur = (await this.store.get<Message>("messages", m.id)) || m;
    const { newTopic: _, ...plain } = cur;
    if (how === "keep") { const kept = await this.store.put<Message>("messages", plain as Message); this.emit("message", kept); return { thread, m: kept }; }
    const now = this.clock().toISOString();
    const num = Math.max(0, ...(await this.store.all<Thread>("threads")).map((t) => t.num || 0)) + 1;
    const fresh = await this.store.put<Thread>("threads", { id: randomUUID(), createdAt: now, updatedAt: now, num, title: m.text.split(/\s+/).slice(0, 6).join(" "), preview: m.text.slice(0, 120), ...(thread.projectId ? { projectId: thread.projectId } : {}) });
    const moved = await this.store.put<Message>("messages", { ...(plain as Message), threadId: fresh.id, movedFrom: thread.id });
    for (const id of moved.fileIds || []) { const f = await this.store.get<StoredFile>("files", id); if (f) await this.store.put<StoredFile>("files", { ...f, threadId: fresh.id }); }
    await this.addMessage({ role: "assistant", teammateId: "hearth", threadId: thread.id, text: "Moved that to its own ramble.", movedTo: fresh.id });
    this.emit("threads");
    this.emit("message", moved);
    this.emit("thinking", { threadId: fresh.id, on: true });
    return { thread: fresh, m: moved };
  }

  /** What a teammate gets to see of attached files: the text of text-like ones, the name and type of the rest. */
  async attachmentNote(fileIds?: string[]) {
    if (!fileIds?.length) return "";
    const parts: string[] = [];
    for (const id of fileIds) {
      const f = await this.store.get<StoredFile>("files", id);
      if (!f) continue;
      const text = this.files.textOf(f);
      parts.push(text ? `### ${f.name}\n${text}` : `### ${f.name} (${f.mime}, ${Math.round(f.size / 1024)} KB; you can't open this type yet, say so if you need its contents)`);
    }
    return parts.length ? `\n\nAttached files:\n<untrusted>\n${parts.join("\n\n")}\n</untrusted>` : "";
  }

  /** Send as many messages as you like: if this ramble is being planned, the new one waits and joins the next batch. */
  private queuePlan(thread: Thread, m: Message) {
    if (this.planning.has(thread.id)) { this.planQueue.set(thread.id, [...(this.planQueue.get(thread.id) || []), m]); return; }
    this.planning.add(thread.id);
    this.inflight++;
    this.emit("thinking", { threadId: thread.id, on: true });
    (async () => {
      let batch: Message[] = [m];
      while (batch.length) {
        try { await this.orchestrate(thread, batch); } catch (err: any) { await this.log("orchestrator.failed", err.message); }
        batch = this.planQueue.get(thread.id) || [];
        this.planQueue.delete(thread.id);
      }
    })().finally(() => { this.planning.delete(thread.id); this.inflight--; this.emit("thinking", { threadId: thread.id, on: false }); });
  }

  private async orchestrate(thread: Thread, batch: Message[]) {
    let m = batch[batch.length - 1];
    const said = batch.length === 1 ? m.text : `The user sent these messages in a row; plan them together:\n${batch.map((x, i) => `${i + 1}. ${x.text}`).join("\n")}`;
    const attached = (await Promise.all(batch.map((x) => this.attachmentNote(x.fileIds)))).join("");
    let plan: any = null;
    // Threads that just handed one of these messages back: not offered to continue, and refused if named anyway.
    const declined = new Set(batch.map((b) => this.handedBack.get(b.id)).filter(Boolean));
    for (const b of batch) this.handedBack.delete(b.id);
    try {
      const brains = await this.brains();
      const ctx = await this.context(batch.map((x) => x.text).join(" "), "orchestrate", null);
      const team0 = await this.store.all<Teammate>("teammates");
      const openTasks = (await this.store.all<Job>("jobs"))
        .filter((j) => j.threadId === thread.id && !j.parentId && !j.followsUp && (j.status === "queued" || j.status === "working"))
        .map((j) => ({ id: j.id, label: j.label || shortLabel(undefined, j.task), teammate: team0.find((t) => t.id === j.teammateId)?.name, status: j.status, task: j.task.slice(0, 400) }));
      // Finished or stuck tasks in this ramble, so a follow-up about one goes on in its thread instead of starting a new one.
      const all0 = await this.store.all<Job>("jobs");
      const recentTasks = all0.filter((j) => j.threadId === thread.id && !j.parentId && !j.followsUp && !declined.has(j.id) && ["done", "failed", "blocked"].includes(j.status)).slice(-8)
        .map((j) => {
          const line = all0.filter((x) => x.followsUp === j.id);
          const last = line.filter((x) => x.result).at(-1);
          const stuck = [j, ...line].filter((x) => x.status === "blocked").at(-1)?.blocked;
          return { id: j.id, label: j.label || shortLabel(undefined, j.task), teammate: team0.find((t) => t.id === j.teammateId)?.name, task: j.task.slice(0, 300), answer: String(last?.result || j.result || "").slice(0, 300),
            ...(stuck ? { stuck: `${stuck.need}${stuck.why ? `: ${stuck.why}` : ""}`.slice(0, 300) } : {}) };
        });
      const history = (await this.store.all<Message>("messages")).filter((x) => x.threadId === thread.id && !batch.some((b) => b.id === x.id)).slice(-10)
        .map((x) => ({ role: x.role, text: x.text.slice(0, 500) }));
      // Workspaces (folders where earlier work left its files): this ramble's project's, or those outside any project.
      const project = workspaceName((await this.projectOf(thread.id))?.name);
      const workspaces = this.brain.sessions.workspaces(project);
      const raw = await this.brain.think({ mode: "orchestrate", context: { ...ctx, thisChat: history, openTasks, recentTasks, workspaces, thisChannel: thread.id.startsWith("tm-") ? undefined : (await this.store.get<Thread>("threads", thread.id))?.channel || null }, input: said + attached }, brains.orchestrator);
      plan = parsePlan(raw);
    } catch (err: any) {
      await this.log("orchestrator.failed", err.message);
    }
    if (!plan) plan = { reply: "On it.", facts: [], jobs: [{ task: batch.map((x) => x.text).join("\n"), teammate: "Hearth", effort: "light" }] };
    // The planner says this has nothing to do with the ramble so far: offer to move it (adds the 5s wait only here).
    const hadTasks = (await this.store.all<Job>("jobs")).some((j) => j.threadId === thread.id && !j.parentId);
    if (plan.newTopic === true && batch.length === 1 && hadTasks && !thread.id.startsWith("tm-")) await this.offerMove(m);
    const from = thread.id;
    if (batch.length === 1) ({ thread, m } = await this.settleMove(thread, m));
    const movedOut = thread.id !== from;

    for (const f of (plan.facts || []).slice(0, 10)) await this.addFact({ ...f, evidence: m.text.slice(0, 300) }, "assistant");
    const team = await this.store.all<Teammate>("teammates");
    const jobs: Job[] = [];
    const keyToId = new Map<string, string>();
    const wants = new Map<string, string[]>();
    const continued: Job[] = [];
    for (const j of (plan.jobs || []).slice(0, 8)) {
      if (typeof j?.task !== "string" || !j.task.trim()) continue;
      if (typeof j.addTo === "string" && (await this.addToJob(j.addTo, thread.id, j.task, j.label))) continue;
      if (typeof j.continue === "string" && !declined.has(j.continue)) { const c = await this.continueTask(j.continue, thread.id, m, j.task); if (c) { continued.push(c); continue; } }
      const wanted = String(j.teammate || "Hearth").toLowerCase();
      let mate = team.find((t) => t.name.toLowerCase() === wanted || t.id === wanted);
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
        ...this.doc({}), threadId: thread.id, messageId: m.id, task: j.task.trim().slice(0, 1000), label: shortLabel(j.label, j.task), teammateId: mate.id,
        status: "queued", effort: j.effort === "heavy" ? "heavy" : j.effort === "quick" ? "quick" : "light",
        skillId: skill?.status === "active" ? skill.id : undefined, workflowId: workflow?.id, inputs, workspace: workspaceName(j.workspace),
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

    const fresh = await this.store.get<Thread>("threads", thread.id);
    // Hearth names the ramble from its topic, and renames it when the topic changes, unless you named it yourself.
    // A ramble it just moved to is named from this message alone (plan.channel covered the old ramble too).
    const wanted = movedOut ? (typeof plan.title === "string" ? nameFrom(plan.title) : "") : typeof plan.channel === "string" ? plan.channel : !fresh?.channel && typeof plan.title === "string" ? nameFrom(plan.title) : "";
    // Hearth's names stay short however many topics a ramble covers: three words, 24 characters at most.
    const short = slugOf(wanted).split("-").filter(Boolean).slice(0, 3).join("-").slice(0, 24).replace(/-+$/, "");
    if (fresh && short && !thread.id.startsWith("tm-") && fresh.channelBy !== "you" && short !== fresh.channel) await this.renameThread(thread.id, short, false);
    if (plan.title && !thread.id.startsWith("tm-") && fresh?.title === batch[0].text.split(/\s+/).slice(0, 6).join(" ")) await this.touchThread(thread.id, { title: String(plan.title).slice(0, 60) });
    // Hearth's short reply, then one message per task; each task's thread (the teammate working, replies) hangs under it.
    // Keep Hearth's line short when there are task posts under it; they say the rest.
    let reply = String(plan.reply || "On it.").trim();
    if (jobs.length && reply.length > 160) reply = reply.match(/^.{20,160}?[.!?](\s|$)/)?.[0].trim() || `${reply.slice(0, 150).replace(/\s+\S*$/, "")}…`;
    // Continued threads get a link from Hearth's line instead of a new task post.
    const continues = [...new Set(continued.map((c) => c.followsUp || c.id))];
    await this.addMessage({ role: "assistant", teammateId: "hearth", threadId: thread.id, text: reply.slice(0, 1000), jobIds: jobs.map((j) => j.id), ...(continues.length ? { continues } : {}) });
    for (const j of jobs) await this.addMessage({ role: "assistant", teammateId: "hearth", threadId: thread.id, text: j.label || j.task, taskJobId: j.id });
    for (const j of [...jobs, ...continued]) this.emit("job", j);
    if (movedOut) this.emit("thinking", { threadId: thread.id, on: false });
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
        this.runJob(j, msg?.text || j.task, earlier).finally(async () => {
          this.started.delete(j.id);
          if ((await this.store.get<Job>("jobs", j.id))?.status === "queued") this.pump(messageId); // restarted with more to do
        });
      }
    }
  }

  /**
   * Reuse first: a job matched to a skill or workflow runs that directly (scripts need no model at all).
   * Otherwise it's worked out fresh: light jobs on the workhorse, heavy ones (and escalations) on heavy.
   * If a skill fails, the job is solved fresh and the teammate is asked to save a fixed version.
   */
  /**
   * The user said more about a task that hasn't finished ("…and I want to strengthen my lower body too"). A queued task
   * just gets the addition; a running one is stopped and starts over with the whole brief, so there's one answer.
   */
  private async addToJob(id: string, threadId: string, addition: string, label?: unknown) {
    const j = await this.store.get<Job>("jobs", id);
    if (!j || j.threadId !== threadId || j.parentId || !["queued", "working"].includes(j.status)) return false;
    const text = addition.trim().slice(0, 1000);
    const newLabel = typeof label === "string" && label.trim() ? shortLabel(label, j.task) : j.label;
    const stop = this.stops.get(id);
    if (stop) {
      this.additions.set(id, [...(this.additions.get(id) || []), text]);
      if (newLabel !== j.label) this.additions.set(`${id}:label`, [newLabel || ""]);
      stop.abort();
    } else {
      await this.saveJob({ ...j, task: `${j.task}\n\nThe user added: ${text}`.slice(0, 3000), label: newLabel });
    }
    await this.log("job.added", `${(newLabel || j.task).slice(0, 60)}: ${text.slice(0, 80)}`);
    return true;
  }

  /** The lead's brief before a cheaper model starts a job: the task, what came before, and the workspace's notes. */
  private async leadTips(job: Job, earlier: string, place?: WorkPlace): Promise<string> {
    const notes = this.brain.sessions.notes(job.parentId ? job.id : job.followsUp || job.id, place);
    const input = [`JOB: ${job.task}`, earlier ? `\nWHAT CAME BEFORE:\n<untrusted>\n${earlier.slice(0, 4000)}\n</untrusted>` : "",
      notes ? `\nTHEIR WORKSPACE'S NOTES.md (what earlier work left):\n<untrusted>\n${notes}\n</untrusted>` : ""].join("\n");
    const out = (await this.brain.think({ mode: "coach", context: {}, input }, (await this.brains()).heavy)).trim();
    return out.slice(0, 3000);
  }

  /** A job asked the lead mid-run (hearth-lead): the heavy model answers. See brains/lead.ts. */
  async askLead(question: string): Promise<string> {
    await this.log("lead.asked", question.replace(/\s+/g, " ").slice(0, 160));
    return (await this.brain.advise(question, (await this.brains()).heavy)).trim() || "No advice: go with your best judgement and say what you weren't sure of.";
  }

  /**
   * Where a job's thread works (see brains/sessions.ts): inside the ramble's project, if it's filed in one; in the
   * workspace the planner picked for it (or for the job it follows up / is part of), else the ramble's channel
   * ("aliexpress-orders-3" -> "aliexpress-orders"). A ramble with only a default name ("ramble-15") gets the project's
   * "general" workspace, or none (its own folder).
   */
  private async placeFor(job: Job): Promise<WorkPlace | undefined> {
    const up = job.followsUp || job.parentId;
    const root = up ? (await this.store.get<Job>("jobs", up)) || job : job;
    const t = job.threadId.startsWith("tm-") ? null : await this.store.get<Thread>("threads", job.threadId);
    const project = workspaceName((await this.projectOf(job.threadId))?.name);
    const named = t?.channel && !/^ramble(-\d+)?$/.test(t.channel) ? channelWorkspace(t.channel) : undefined;
    const workspace = workspaceName(job.workspace) || workspaceName(root.workspace) || named || (project ? "general" : undefined);
    return workspace ? { ...(project ? { project } : {}), workspace } : undefined;
  }

  private async runJob(job: Job, ramble: string, earlier = "") {
    const started = Date.now();
    const stop = new AbortController();
    this.stops.set(job.id, stop);
    // Live progress for the app ("Searching: pottery gifts"): an event only, not stored, so it can't race the job's own saves.
    const show = (what: string) => {
      const log = this.steps.get(job.id) ?? [];
      if (log.at(-1)?.text === what) return;
      const at = this.clock().toISOString();
      log.push({ at, text: what });
      if (log.length > 60) log.splice(0, log.length - 60);
      this.steps.set(job.id, log);
      this.emit("progress", { jobId: job.id, threadId: job.threadId, text: what, at });
    };
    // When the label is stuck on "Working it out", the quick model reads the last few actions and says what's going on.
    const narrator = this.config.narrate === false ? null : new Narrator({ task: job.label || job.task, show,
      ask: async (prompt) => this.brain.narrate(prompt, (await this.brains()).quick) });
    // Its thread's runs are one session on the hub: a follow-up resumes where the last one left off. A part of a split
    // job runs alongside its siblings, so it gets its own.
    const meter: Meter = { costUsd: 0, unknown: false, signal: stop.signal, thread: job.parentId ? job.id : job.followsUp || job.id, workspace: await this.placeFor(job),
      onProgress: (what) => { narrator?.step(what); show(what); }, onAction: (raw) => narrator?.action(raw),
      // A picture of the page or window it's on: kept in memory; the app fetches it when told there's a new one.
      onFrame: (f) => {
        const n = (this.frames.get(job.id)?.n ?? 0) + 1, at = this.clock().toISOString();
        this.frames.set(job.id, { n, at, mime: f.mime, data: f.data });
        this.emit("frame", { jobId: job.id, threadId: job.threadId, n, at });
      },
      // Which model is on it right now, and where: the working card shows it, the step log keeps each change.
      onBrain: (w) => {
        const name = brainName(w);
        if (!models.includes(name)) models.push(name);
        const text = `${name}${whereName(w.ranOn)}`;
        if (this.running.get(job.id) === text) return;
        this.running.set(job.id, text);
        this.emit("running", { jobId: job.id, threadId: job.threadId, text });
        show(`${text} started`);
      } };
    const models: string[] = [];
    const mate = await this.teammate(job.teammateId);
    let cur: Job = await this.saveJob({ ...job, status: "working", startedAt: this.clock().toISOString() });
    const finish = async (patch: Partial<Job>) => {
      narrator?.stop();
      this.stops.delete(job.id); this.steps.delete(job.id); this.frames.delete(job.id); this.running.delete(job.id);
      if (stop.signal.aborted && this.cancelled.delete(job.id)) {
        this.additions.delete(job.id); this.additions.delete(`${job.id}:label`);
        await this.addSpend(job.messageId, meter.costUsd);
        cur = await this.saveJob({ ...cur, status: "failed", result: "Stopped by you.", durationMs: Date.now() - started, finishedAt: this.clock().toISOString() });
        return;
      }
      if (stop.signal.aborted) {
        // Stopped for a restart: back in the queue with what the user added; pump picks it up again.
        const more = this.additions.get(job.id) || [];
        const label = this.additions.get(`${job.id}:label`)?.[0];
        this.additions.delete(job.id); this.additions.delete(`${job.id}:label`);
        await this.addSpend(job.messageId, meter.costUsd);
        cur = await this.saveJob({ ...cur, status: "queued", task: [cur.task, ...more.map((x) => `The user added: ${x}`)].join("\n\n").slice(0, 3000), label: label || cur.label, startedAt: undefined, tier: undefined });
        return;
      }
      const pending = (await this.store.all<Approval>("approvals")).some((a) => a.jobId === job.id && a.status === "pending");
      const stored = await this.store.get<Job>("jobs", job.id);
      const blocked = stored?.blocked;
      const status = patch.status === "failed" ? "failed" : blocked ? "blocked" : pending ? "waiting" : "done";
      await this.addSpend(job.messageId, meter.costUsd);
      cur = await this.saveJob({
        ...cur, ...patch, blocked, relogged: stored?.relogged, status, ranOn: meter.ranOn, ...(models.length ? { models } : {}),
        durationMs: Date.now() - started, costUsd: meter.unknown ? null : +meter.costUsd.toFixed(4),
        finishedAt: status === "done" || status === "failed" ? this.clock().toISOString() : undefined,
      });
      // It pulled a fresh login from your Mac mid-run: go again with it, without you tapping anything.
      if (this.rerunAfterLogin.delete(job.id) && status === "blocked") { await this.retryJob(job.id, { refreshed: true }); return; }
      // Tell the phone: "Fitness finished: Knee before volleyball". Tapping it opens the task's thread.
      if (!job.parentId && (status === "done" || status === "failed")) {
        const first = String(cur.result || "").split("\n").map((x) => x.replace(/^[-*#>\s]+|\*\*/g, "").trim()).find(Boolean) || "";
        this.push?.send({ title: `${mate?.name || "Hearth"} ${status === "done" ? "finished" : "couldn't finish"}: ${cur.label || shortLabel(undefined, cur.task)}`,
          body: first.slice(0, 180), tag: job.id, url: job.threadId.startsWith("tm-") ? threadLink(job.threadId) : `/#c/${job.threadId}/${job.followsUp || job.id}` }).catch(() => {});
      }
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
        return await finish({ how: job.workflowId ? "workflow" : "skill", tier: r.usedModel ? "workhorse" : undefined, result: r.output.slice(0, 4000), did: r.did, tiles: r.tiles, fileIds: r.did.filter((d) => d.kind === "file" && d.id).map((d) => d.id!) });
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
    const ask = await this.store.get<Message>("messages", job.messageId);
    const attached = await this.attachmentNote(ask?.fileIds);
    const handNote = job.mayHandBack ? `\n\nFIRST, before any work or tools: the user sent this in the ramble's channel and it came straight to you because you had the latest thread. If it isn't a follow-up on that thread's subject (a new request, or partly about something else), don't do it: reply with only ${HAND_BACK} and Hearth will route it.` : "";
    let input = `${job.task}${depNote}${handNote}${repairNote}${splitNote}${attached}\n\n(From the user's ramble: "${ramble.slice(0, 600)}")`;
    type Tier = "quick" | "workhorse" | "heavy";
    // Hybrid (on by default): a cheaper model does the legwork and the heavy model writes what you read.
    const hybrid = (await this.prefs()).hybrid !== false && label(brains.heavy) !== label(brains.workhorse);
    const attempt = async (tier: Tier) => {
      cur = await this.saveJob({ ...cur, status: "working", tier });
      meter.lead = hybrid && tier !== "heavy" && label(brains[tier]) !== label(brains.heavy);
      return this.turn(hybrid && tier !== "heavy" ? "legwork" : "job", input, job.task, { teammate: mate, threadId: job.threadId, jobId: job.id, profile: brains[tier], meter, top: tier === "heavy" });
    };
    // Start on the cheapest model the plan allows; move up a step when a model can't do it.
    const ladder: Tier[] = job.effort === "heavy" ? ["heavy"] : job.effort === "quick" ? ["quick", "workhorse", "heavy"] : ["workhorse", "heavy"];
    let tier: Tier = ladder[0];
    let escalated = false;
    // Each step up, with why: kept on the job (the thread shows it) and in the log.
    const escalations: NonNullable<Job["escalations"]> = [];
    const moveUp = async (from: Tier, to: Tier, why: string) => {
      escalated = true;
      escalations.push({ from: brainName(brains[from]), to: brainName(brains[to]), why, at: this.clock().toISOString() });
      cur = await this.saveJob({ ...cur, escalated, escalations });
      await this.log("job.escalated", `${job.task.slice(0, 80)} → ${label(brains[to])}: ${why.slice(0, 160)}`);
    };
    // The strongest model said it can't: the job fails with why it stopped ("Couldn't do it: …"), never the marker.
    const gaveUp = (text: string) => new Error(escalateWhy(text));
    if (await overCap()) return finish({ how: "fresh" });
    // The lead briefs a cheaper model before it starts: the approach, the traps, what to check (brains/lead.ts).
    // Only with hybrid on (Settings → Brains): off means one model does the job by itself.
    if (hybrid && ladder[0] !== "heavy" && job.effort !== "quick" && label(brains[ladder[0]]) !== label(brains.heavy) && !stop.signal.aborted) {
      meter.onProgress?.("Getting tips from the lead");
      const tips = await this.leadTips(job, earlier, meter.workspace).catch(() => "");
      if (tips) input += `\n\nTIPS FROM THE LEAD (a stronger model on your team, before you started):\n${tips}`;
    }
    try {
      let failed = "";
      const tryTier = (t: Tier) => attempt(t).catch((err) => {
        if (t === "heavy") throw err;
        failed = String(err?.message || err).slice(0, 300);
        return null;
      });
      let r: Awaited<ReturnType<typeof attempt>> | null = await tryTier(tier);
      if (stop.signal.aborted) throw new Error("Restarted with your new message.");
      if (job.mayHandBack && r?.text.includes(HAND_BACK)) return await this.handBack(cur, meter);
      while (tier !== "heavy" && (!r || r.text.includes(ESCALATE) || !r.text.trim())) {
        const why = !r ? `it hit an error: ${failed}` : r.text.includes(ESCALATE) ? escalateWhy(r.text) : "it replied with nothing";
        const from = tier;
        tier = ladder[ladder.indexOf(tier) + 1];
        await moveUp(from, tier, why);
        r = await tryTier(tier);
        if (stop.signal.aborted) throw new Error("Restarted with your new message.");
      }
      if (!r) throw new Error("Nobody could do this one.");
      if (r.text.includes(ESCALATE)) throw gaveUp(r.text);
      let voiced = false;
      const legwork = r;
      if (hybrid && tier !== "heavy" && !legwork.split) {
        const r0 = legwork;
        meter.onProgress?.("Writing it up");
        const v = await this.turn("voice", `${job.task}\n\n(From the user's ramble: "${ramble.slice(0, 600)}")\n\nNOTES FROM THE LEGWORK:\n<untrusted>\n${r0.text.slice(0, 8000)}\n</untrusted>`,
          job.task, { teammate: mate, threadId: job.threadId, jobId: job.id, profile: brains.heavy, meter });
        if (stop.signal.aborted) throw new Error("Restarted with your new message.");
        if (v.text.includes(REDO) || !v.text.trim()) {
          // The lead wasn't happy with the legwork: it does the job itself.
          const note = v.text.replace(REDO, "").trim().slice(0, 300) || "the notes came back empty";
          await this.log("job.redo", `${job.task.slice(0, 80)}: ${note.slice(0, 120)}`);
          await moveUp(tier, "heavy", `the lead redid it: ${note}`);
          tier = "heavy";
          const again = await attempt("heavy");
          if (stop.signal.aborted) throw new Error("Restarted with your new message.");
          if (again.text.includes(ESCALATE)) throw gaveUp(again.text);
          r = { ...again, split: again.split ?? null, did: [...r0.did, ...again.did], tiles: [...(r0.tiles || []), ...(again.tiles || [])].slice(0, 4), fileIds: [...(r0.fileIds || []), ...(again.fileIds || [])] };
        } else {
          r = { ...r0, split: r0.split ?? null, text: v.text, did: [...r0.did, ...v.did], tiles: [...(r0.tiles || []), ...(v.tiles || [])].slice(0, 4), fileIds: [...(r0.fileIds || []), ...(v.fileIds || [])] };
          voiced = true;
        }
      }
      if (!r) throw new Error("Nobody could do this one.");
      if (r.split && job.effort === "heavy" && !job.depth) {
        const merged = await this.runSplit(cur, r.split, ramble, meter);
        return await finish({ how: "fresh", tier, escalated, result: merged.text.slice(0, 4000), did: [...r.did, ...merged.did], tiles: merged.tiles });
      }
      await finish({ how: failedSkill ? "repaired" : "fresh", tier, escalated, voiced, result: r.text.slice(0, 4000), did: r.did, tiles: r.tiles, fileIds: r.fileIds });
    } catch (err: any) {
      if (err instanceof BrainsFull) {
        cur = await this.saveJob({ ...cur, blocked: { need: "Room on a brain", why: err.message, unblock: "It starts again by itself when a plan resets, or tap Try again", needs: "brains", until: err.until } });
        this.wakeForBrains(err.until);
        return await finish({ how: "fresh", tier });
      }
      if (err instanceof NeedsComputer) {
        // Parks instead of failing; resumeForComputer picks it up the moment a computer links in. A cloud sandbox that's
        // allowed to start on its own is woken for it.
        this.onNeedsComputer?.();
        cur = await this.saveJob({ ...cur, blocked: { need: "Your Mac", why: err.message, unblock: "Open your Mac, or copy your login to the cloud in Settings → Devices", needs: "computer" } });
        return await finish({ how: "fresh", tier });
      }
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
    const { job, folded } = await this.followUp(root, m, clean);
    if (!folded) { await this.store.put<Message>("messages", { ...m, jobIds: [job.id] }); this.emit("job", job); this.pump(m.id); }
    return { value: { message: m, job } };
  }

  /** The next turn in a task's thread: folded into the teammate's current run if it's still going, else a new follow-up job. */
  private async followUp(root: Job, m: Message, task: string, mayHandBack = false): Promise<{ job: Job; folded: boolean }> {
    const busy = (await this.store.all<Job>("jobs")).filter((j) => (j.id === root.id || j.followsUp === root.id) && (j.status === "queued" || j.status === "working")).at(-1);
    if (busy && (await this.addToJob(busy.id, root.threadId, task))) return { job: busy, folded: true };
    // Replying in a stuck thread picks it up: the stuck turn is settled (it stops saying "Stuck") and the new turn goes on from it.
    for (const j of (await this.store.all<Job>("jobs")).filter((x) => (x.id === root.id || x.followsUp === root.id) && x.status === "blocked"))
      await this.saveJob({ ...j, blocked: undefined, status: "done", finishedAt: j.finishedAt || this.clock().toISOString(),
        result: j.result || `Got stuck: ${j.blocked?.need || "needed something"}${j.blocked?.why ? ` (${j.blocked.why})` : ""}. The user followed up.` });
    const job = await this.store.put<Job>("jobs", { ...this.doc({}), threadId: root.threadId, messageId: m.id, task: task.trim().slice(0, 4000), teammateId: root.teammateId, status: "queued", effort: root.effort, followsUp: root.id, ...(mayHandBack ? { mayHandBack: true } : {}) } as Job);
    return { job, folded: false };
  }

  /** The orchestrator decided a message in the channel goes on with a task that's already finished: same thread, same teammate. */
  private async continueTask(rootId: string, threadId: string, m: Message, task: string) {
    const root = await this.store.get<Job>("jobs", rootId);
    if (!root || root.threadId !== threadId || root.followsUp || root.parentId) return null;
    return (await this.followUp(root, m, task)).job;
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

  /** Set by the server: wake a cloud computer when a job is waiting for one. */
  onNeedsComputer: (() => void) | null = null;

  private brainsTimer: ReturnType<typeof setTimeout> | null = null;
  /** Every brain was full: try the parked jobs again when the first plan resets (and at least every 30 min). */
  private wakeForBrains(until: number | null) {
    const wait = Math.min(Math.max((until ?? 0) - Date.now() + 60_000, 60_000), 30 * 60_000);
    if (this.brainsTimer) clearTimeout(this.brainsTimer);
    this.brainsTimer = setTimeout(async () => {
      this.brainsTimer = null;
      const all = await this.store.all<Job>("jobs"), stale = supersededJobs(all);
      const parked = all.filter((j) => j.status === "blocked" && j.blocked?.needs === "brains" && !stale.has(j.id));
      for (const j of parked) await this.retryJob(j.id);
    }, wait);
    (this.brainsTimer as any).unref?.();
  }

  /** A linked computer came online: run every job that was parked waiting for one. */
  async resumeForComputer() {
    const all = await this.store.all<Job>("jobs"), stale = supersededJobs(all);
    // Jobs stuck on a site's login go too: retrying checks the Mac for a fresh one first, and stays parked if there isn't.
    const parked = all.filter((j) => j.status === "blocked" && (j.blocked?.needs === "computer" || (j.blocked?.needs === "login" && j.blocked.site)) && !stale.has(j.id));
    for (const j of parked) await this.retryJob(j.id);
    if (parked.length) await this.log("computer.resumed", `${parked.length} job(s) picked up by your computer`);
  }

  /** Stop button: a running job is cut off where it is; a queued one never starts; a stuck one is let go (Dismiss). */
  async stopJob(id: string) {
    const j = await this.store.get<Job>("jobs", id);
    if (j?.status === "blocked") {
      await this.saveJob({ ...j, status: "failed", result: `Dismissed by you (was stuck: ${j.blocked?.need || "needed something"}).`, finishedAt: this.clock().toISOString() });
      await this.log("job.dismissed", (j.label || j.task).slice(0, 80));
      return { value: { ok: true } };
    }
    if (!j || !["queued", "working"].includes(j.status)) return { error: "That isn't running." };
    const stop = this.stops.get(id);
    if (stop) { this.cancelled.add(id); stop.abort(); }
    else await this.saveJob({ ...j, status: "failed", result: "Stopped by you.", finishedAt: this.clock().toISOString() });
    await this.log("job.stopped", (j.label || j.task).slice(0, 80));
    return { value: { ok: true } };
  }

  /** You unblocked it (opened the laptop, logged in, tapped Allow): run the job again from the top. */
  async retryJob(id: string, opts: { refreshed?: boolean } = {}) {
    let job = await this.store.get<Job>("jobs", id);
    if (!job || !["blocked", "failed"].includes(job.status)) return { error: "Only blocked or failed jobs can be retried." };
    // Stuck on a site's login: check your Mac for a fresh one first, so a run isn't spent on the same sign-out.
    const site = job.blocked?.site;
    if (site && !opts.refreshed) {
      const r = await this.refreshConnection(site, "Try again");
      if (r.state === "offline" || r.state === "missing") {
        const name = labelFor(site);
        const blocked = r.state === "offline"
          ? { need: `Your Mac, for the ${name} login`, why: `${name} signed Hearth out, and your Mac is offline.`, unblock: "Open your Mac: this picks up again by itself", needs: "computer" as const, site }
          : { need: `Sign in to ${name} on your Mac`, why: `Chrome on your Mac still isn't signed in to ${name}.`, unblock: `Sign in to ${name} in Chrome on your Mac, then tap Try again`, needs: "login" as const, site };
        const kept = await this.saveJob({ ...job, status: "blocked", blocked });
        return { value: kept };
      }
      // A fresh login came up: this run counts as the one retry with it.
      job = await this.saveJob({ ...job, relogged: [...new Set([...(job.relogged || []), site])] });
    }
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
    const [skills, workflows, scripts, components] = await Promise.all([this.store.all<Skill>("skills"), this.store.all<Workflow>("workflows"), this.scripts.list(), this.store.all<Component>("components")]);
    return this.library.search(query, skills, workflows, scripts, 8, components, await this.triggerItems());
  }

  /** Your live triggers and saved trigger setups, as library entries: searched before a new one is made. */
  private async triggerItems(): Promise<Omit<LibraryItem, "score">[]> {
    const tz = (await this.prefs()).tz;
    const hooks = (await this.store.all<Hook>("hooks")).filter((h) => h.status !== "done" && h.source !== "system");
    const recipes = await this.store.all<TriggerRecipe>("triggerRecipes");
    const does = (h: Hook) => h.action.type === "think" ? h.action.prompt.slice(0, 160) : h.action.type === "notify" ? h.action.text.slice(0, 160) : `runs ${h.action.script}`;
    return [
      ...hooks.map((h) => ({ kind: "trigger" as const, id: h.id, name: h.title, description: `${describeTrigger(h.trigger, tz)}. ${h.why} ${does(h)}`.trim(), how: h.status })),
      ...recipes.map((r) => ({ kind: "trigger-recipe" as const, name: r.name, description: r.description, inputs: r.inputs.map((i) => i.name), how: `${(r.hook.trigger as any)?.type || "?"} trigger, used ${r.uses}×` })),
    ];
  }

  private async relevantHooks(hooks: Hook[], query: string) {
    const hits = new Set((await this.searchLibrary(query)).filter((x) => x.kind === "trigger").map((x) => x.id));
    const newest = [...hooks].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
    return [...hooks.filter((h) => hits.has(h.id)), ...newest.filter((h) => !hits.has(h.id))];
  }

  /** hook.add and trigger.use: route to a named teammate, add, and report it. */
  private async addHookFrom(a: any, where: { teammateId?: string; threadId?: string }, done: Done[]) {
    // "teammate": hand the hook to another teammate (by name), who then speaks when it fires.
    const named = typeof a.teammate === "string" && a.teammate.trim()
      ? (await this.store.all<Teammate>("teammates")).find((t) => t.name.toLowerCase() === a.teammate.trim().toLowerCase()) : undefined;
    const r = await this.addHook(a, a.requestedByUser === true ? "you" : "assistant", named ? { ...where, teammateId: named.id } : where);
    const t = r.value?.trigger.type;
    const kind = t === "at" ? "Reminder" : t === "webhook" ? "Webhook" : t === "watch" || t === "check" || t === "source" ? "Watching" : "Hook";
    if (r.value) done.push({ kind: "hook", label: `${kind}: ${r.value.title}`, id: r.value.id });
    return r;
  }

  async listTriggerRecipes() { return this.store.all<TriggerRecipe>("triggerRecipes"); }
  async removeTriggerRecipe(id: string) { const ok = await this.store.remove("triggerRecipes", id); if (ok) this.emit("hooks"); return ok; }

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
        else {
          const fx = extractFiles(out.output);
          for (const n of fx.names) {
            const f = await this.files.adopt(this.scripts.workDir, n, { source: "script", threadId: ctx.job?.threadId, jobId: ctx.job?.id, teammateId: ctx.mate?.id });
            if (f.value) did.push({ kind: "file", label: `Made ${f.value.name}`, id: f.value.id });
          }
          const ex = extractTiles(fx.text); output = ex.text; tiles = ex.tiles;
        }
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

  /**
   * Rambles are temporary: once nothing in one is running, waiting or stuck, and it's been quiet for an hour,
   * it archives itself. Nothing is deleted; it leaves "Active rambles" and stays searchable.
   */
  async archiveQuietRambles() {
    const quietMs = Number(process.env.HEARTH_RAMBLE_ARCHIVE_MIN || 60) * 60_000;
    const now = this.clock().getTime();
    const jobs = await this.store.all<Job>("jobs");
    let changed = false;
    for (const t of await this.store.all<Thread>("threads")) {
      if (t.archivedAt || t.id.startsWith("tm-") || t.id === "main") continue;
      if (now - new Date(t.updatedAt).getTime() < quietMs) continue;
      const open = jobs.some((j) => j.threadId === t.id && !["done", "failed"].includes(j.status));
      if (open) continue;
      await this.store.put<Thread>("threads", { ...t, archivedAt: this.clock().toISOString() });
      changed = true;
    }
    if (changed) this.emit("threads");
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
    await this.push?.send({ title: "Needs your OK", body: ap.summary, tag: ap.id, url: ap.threadId ? threadLink(ap.threadId) : "/" });
    return { value: ap };
  }

  /** Every connector (set by the server). */
  connect: import("./connectors/index.ts").Connect | null = null;
  /** Senders for message.send, set at start (WhatsApp, Slack). */
  senders: Partial<Record<Channel, { connected(): boolean; send(to: string, text: string, extra?: { subject?: string; threadId?: string; from?: string }): Promise<string> }>> = {};

  /** A WhatsApp or Slack message a teammate drafted: an Approve card, sent only after the tap. */
  async requestMessage(a: any, where: { threadId?: string; jobId?: string }) {
    const channel = (CHANNELS as string[]).includes(String(a?.channel)) ? (a.channel as Channel) : null;
    const to = String(a?.to || "").trim().slice(0, 300);
    const text = String(a?.text || "").trim().slice(0, channel === "gmail" ? 20_000 : 4000);
    const subject = channel === "gmail" ? String(a?.subject || "").trim().slice(0, 200) || "(no subject)" : undefined;
    const threadId = channel === "gmail" && a?.threadId ? String(a.threadId).slice(0, 100) : undefined;
    // Which of your Gmail accounts it goes from (with several connected); default the first that may send.
    const from = channel === "gmail" && a?.from ? String(a.from).trim().replace(/^.*<|>$/g, "").slice(0, 200) : undefined;
    if (!channel) return { error: `channel is one of ${CHANNELS.join(", ")}.` };
    const label = CHANNEL_LABEL[channel];
    if (channel === "gmail" && from && this.google.connected && !this.google.accounts().some((x) => x.email.toLowerCase() === from.toLowerCase()))
      return { error: `No Gmail account ${from} is connected. Connected: ${this.google.accounts().map((x) => x.email).join(", ")}.` };
    if (!this.senders[channel]?.connected() || (channel === "gmail" && from && !this.google.canSend(from)))
      return { error: channel === "gmail" && this.google.connected ? `Google is connected without permission to send${from ? ` from ${from}` : ""}. Ask the user to reconnect that account in Connectors → Google and allow sending.` : `${label} isn't connected.` };
    if (!to || !text) return { error: "Say who it's to and what it says." };
    if (channel === "gmail" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to.replace(/^.*<|>$/g, ""))) return { error: "For Gmail, \"to\" is an email address." };
    if (channel === "instagram" || channel === "linkedin" || channel === "x") { const bad = badChatLink(channel, to); if (bad) return { error: bad }; }
    const action = { type: "message" as const, channel, to, text, ...(subject ? { subject } : {}), ...(threadId ? { threadId } : {}), ...(from ? { from } : {}) };
    const sendNow = () => this.senders[channel]!.send(to, text, { subject, threadId, from });
    // You said "Always allow" for this chat before: send now, and leave a note in Activity instead of asking.
    if ((await this.alwaysAllowed()).includes(allowKey(channel, to))) {
      const out = await sendNow().then(() => ({ ok: true, output: "Sent (always allowed)." }), (e: any) => ({ ok: false, output: String(e?.message || e) }));
      const ap = await this.store.put<Approval>("approvals", {
        ...this.doc({}), threadId: where.threadId, jobId: where.jobId,
        summary: String(a.summary || `${label} to ${to}: ${subject ? subject + " · " : ""}${text.slice(0, 80)}`).slice(0, 200), details: text,
        action, status: out.ok ? "done" : "failed", result: out.output, decidedAt: this.clock().toISOString(), auto: true,
      } as Approval);
      await this.log(out.ok ? "message.sent" : "message.failed", `${ap.summary} (always allowed)`);
      this.emit("approval", ap);
      return out.ok ? { value: ap } : { error: `Couldn't send: ${out.output}` };
    }
    const ap = await this.store.put<Approval>("approvals", {
      ...this.doc({}), threadId: where.threadId, jobId: where.jobId,
      summary: String(a.summary || `${label} to ${to}: ${subject ? subject + " · " : ""}${text.slice(0, 80)}`).slice(0, 200), details: text,
      action, status: "pending",
    } as Approval);
    if (where.jobId) {
      const job = await this.store.get<Job>("jobs", where.jobId);
      if (job) await this.saveJob({ ...job, approvalIds: [...(job.approvalIds || []), ap.id] });
    }
    await this.log("approval.requested", ap.summary);
    this.emit("approval", ap);
    await this.push?.send({ title: "Needs your OK", body: ap.summary, tag: ap.id, url: ap.threadId ? threadLink(ap.threadId) : "/" });
    return { value: ap };
  }

  // ---------- Google changes that wait for your Approve (connectors/google-agent.ts) ----------

  /** Changes a command staged, by id, until the agent's google.change action turns one into an Approve card. A day at most. */
  private stagedGoogle = new Map<string, GoogleChange & { until: number }>();
  stageGoogleChange(c: GoogleChange): string {
    const now = Date.now();
    for (const [k, v] of this.stagedGoogle) if (v.until < now) this.stagedGoogle.delete(k);
    const id = `gc_${randomUUID().slice(0, 12)}`;
    this.stagedGoogle.set(id, { ...c, until: now + 86_400_000 });
    return id;
  }
  /** "Always allow" for this kind of Google change ("google:calendar:move"). */
  async googleAllowed(kind: string) { return (await this.alwaysAllowed()).includes(`google:${kind}`); }

  /** Run an approved Google change. JSON of what Google answered (a link, the moved event…). */
  private async runGoogle(act: { service: "gmail" | "drive" | "calendar"; args: string[]; body?: string }) {
    return googleAgent(this.google, act.service, act.args, { body: act.body }).then((r) => ({ ok: true, output: JSON.stringify(r) }), (e: any) => ({ ok: false, output: String(e?.message || e) }));
  }

  /** The agent's google.change {id}: an Approve card for the staged change, or done now if you said "Always allow" for its kind. */
  async requestGoogleChange(a: any, where: { threadId?: string; jobId?: string }) {
    const c = this.stagedGoogle.get(String(a?.id || ""));
    if (!c) return { error: "That change expired or was never staged. Run the command again to get a fresh action." };
    this.stagedGoogle.delete(String(a.id));
    const action = { type: "google" as const, service: c.service, args: c.args, ...(c.body != null ? { body: c.body } : {}), kind: c.kind };
    const base = { ...this.doc({}), threadId: where.threadId, jobId: where.jobId, summary: c.summary, details: c.details, action };
    if (await this.googleAllowed(c.kind)) {
      const out = await this.runGoogle(action);
      const ap = await this.store.put<Approval>("approvals", { ...base, status: out.ok ? "done" : "failed", result: out.output.slice(0, 2000), decidedAt: this.clock().toISOString(), auto: true } as Approval);
      await this.log(out.ok ? "google.changed" : "google.failed", `${ap.summary} (always allowed)`);
      this.emit("approval", ap);
      return out.ok ? { value: ap } : { error: `Couldn't: ${out.output}` };
    }
    const ap = await this.store.put<Approval>("approvals", { ...base, status: "pending" } as Approval);
    if (where.jobId) {
      const job = await this.store.get<Job>("jobs", where.jobId);
      if (job) await this.saveJob({ ...job, approvalIds: [...(job.approvalIds || []), ap.id] });
    }
    await this.log("approval.requested", ap.summary);
    this.emit("approval", ap);
    await this.push?.send({ title: "Needs your OK", body: ap.summary, tag: ap.id, url: ap.threadId ? threadLink(ap.threadId) : "/" });
    return { value: ap };
  }

  /** Chats you've said "Always allow" for: a teammate's message there sends without asking ("whatsapp:<to>"). */
  async alwaysAllowed(): Promise<string[]> { return ((await this.store.get<any>("settings", "always-allow"))?.keys as string[]) || []; }
  async setAlwaysAllowed(keys: string[]) {
    await this.store.put("settings", { id: "always-allow", createdAt: "1970-01-01T00:00:00.000Z", keys: [...new Set(keys)].slice(0, 500) });
    this.emit("prefs");
  }

  async decideApproval(id: string, yes: boolean, always = false) {
    const ap = await this.store.get<Approval>("approvals", id);
    if (!ap || ap.status !== "pending") return { error: "Already decided." };
    if (yes && always && ap.action.type === "message") {
      await this.setAlwaysAllowed([...(await this.alwaysAllowed()), allowKey(ap.action.channel, ap.action.to)]);
      await this.log("approval.always", `Always allow ${CHANNEL_LABEL[ap.action.channel]} messages to ${ap.action.to}`);
    }
    if (yes && always && ap.action.type === "google" && CHANGE_KINDS[ap.action.kind]) {
      await this.setAlwaysAllowed([...(await this.alwaysAllowed()), `google:${ap.action.kind}`]);
      await this.log("approval.always", `Always allow: ${CHANGE_KINDS[ap.action.kind]}`);
    }
    let next: Approval = { ...ap, status: yes ? "approved" : "rejected", decidedAt: this.clock().toISOString() };
    await this.store.put("approvals", next);
    if (yes) {
      const act = ap.action;
      const out = act.type === "google" ? await this.runGoogle(act)
        : act.type === "message"
        ? await (this.senders[act.channel]?.send(act.to, act.text, { subject: act.subject, threadId: act.threadId, from: act.from }).then(() => ({ ok: true, output: "Sent." }), (e: any) => ({ ok: false, output: String(e?.message || e) }))
          ?? { ok: false, output: `${act.channel} isn't connected.` })
        : await this.scripts.run(act.script, act.args, { approvedRun: true });
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
    const fileIds: string[] = [];
    for (const a of actions.slice(0, 12)) {
      if (!a || typeof a !== "object") continue;
      try {
        switch (a.type) {
          case "hook.add": {
            const r = await this.addHookFrom(a, where, done);
            if (!r.value) await this.log("action.rejected", `hook.add: ${r.error}`);
            break;
          }
          case "hook.update": {
            // Change a plan instead of adding a near-copy (a wider Gmail search, a new time, another teammate).
            const cur = await this.store.get<Hook>("hooks", String(a.id));
            if (!cur || cur.source === "system") break;
            const patch: any = {};
            for (const k of ["title", "trigger", "action", "why"]) if (a[k] !== undefined) patch[k] = a[k];
            const h = await this.updateHook(cur.id, patch);
            if (h && typeof a.teammate === "string") {
              const t = (await this.store.all<Teammate>("teammates")).find((x) => x.name.toLowerCase() === a.teammate.trim().toLowerCase());
              if (t) await this.store.put<Hook>("hooks", { ...h, teammateId: t.id });
            }
            if (h) done.push({ kind: "hook", label: `Updated: ${h.title}`, id: h.id });
            else await this.log("action.rejected", `hook.update: couldn't apply to ${cur.title}`);
            break;
          }
          case "trigger.save": {
            if (where.recipe) break;
            const v = validateTriggerRecipe(a);
            if (!v.value) { await this.log("action.rejected", `trigger.save: ${v.error}`); break; }
            // Check the setup works by filling every blank with a stand-in.
            const sample = fillDeep(v.value.hook, Object.fromEntries(v.value.inputs.map((i) => [i.name, "x"])));
            const ok = validateHook(sample);
            if (ok.error) { await this.log("action.rejected", `trigger.save: ${ok.error}`); break; }
            const prev = (await this.store.all<TriggerRecipe>("triggerRecipes")).find((r) => r.name === v.value.name);
            await this.store.put<TriggerRecipe>("triggerRecipes", prev ? { ...prev, ...v.value, updatedAt: this.clock().toISOString() } : this.doc({ ...v.value, uses: 0 }));
            done.push({ kind: "skill", label: `Saved setup: ${v.value.name}` });
            this.emit("hooks");
            break;
          }
          case "trigger.use": {
            const rec = (await this.store.all<TriggerRecipe>("triggerRecipes")).find((r) => r.name === String(a.name || "").toLowerCase());
            if (!rec) { await this.log("action.rejected", `trigger.use: no setup called ${a.name}`); break; }
            const inputs = Object.fromEntries(Object.entries(a.inputs && typeof a.inputs === "object" ? a.inputs : {}).map(([k, x]) => [k, String(x).slice(0, 300)]));
            const r = await this.addHookFrom({ ...fillDeep(rec.hook, inputs), requestedByUser: false }, where, done);
            if (r.value) await this.store.put<TriggerRecipe>("triggerRecipes", { ...rec, uses: (rec.uses || 0) + 1, lastUsedAt: this.clock().toISOString() });
            else await this.log("action.rejected", `trigger.use ${rec.name}: ${r.error}`);
            break;
          }
          case "trigger.forget": {
            const rec = (await this.store.all<TriggerRecipe>("triggerRecipes")).find((r) => r.name === String(a.name || "").toLowerCase());
            if (rec && (await this.removeTriggerRecipe(rec.id))) done.push({ kind: "skill", label: `Forgot setup: ${rec.name}` });
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
          case "file.create": {
            if (typeof a.content !== "string" || !a.content || a.content.length > 200_000 || fileIds.length >= 5) break;
            const r = await this.files.save(new TextEncoder().encode(a.content), { name: String(a.name || "notes.txt"), source: "teammate", threadId: where.threadId, jobId: where.jobId, teammateId: where.teammateId });
            if (r.value) { fileIds.push(r.value.id); done.push({ kind: "file", label: `Made ${r.value.name}`, id: r.value.id }); this.emit("files"); }
            break;
          }
          case "app.save": {
            if (where.recipe) break;
            // Artifacts reuse a component's code with new data, or (with code) become a component others can reuse.
            if (a.inline && typeof a.component === "string" && typeof a.html !== "string") {
              const c = await this.componentByName(a.component);
              if (c) { a.html = c.html; await this.store.put<Component>("components", { ...c, uses: c.uses + 1, lastUsedAt: this.clock().toISOString() }); }
            }
            const r = await this.apps.save(a, where);
            if (r.value && a.inline && typeof a.html === "string" && !(typeof a.component === "string" && (await this.componentByName(a.component))?.html === a.html)) {
              await this.saveComponent({ name: a.component || a.name, title: a.title || r.value.title, description: a.componentDescription || a.description, data: r.value.data, html: a.html }, where.teammateId);
            }
            if (r.error) { await this.log("action.rejected", `app.save: ${r.error}`); done.push({ kind: "note", label: `Couldn't build the app: ${r.error}` }); break; }
            const app = r.value!;
            done.push({ kind: "app", label: `${r.created ? "Built" : r.changedCode ? "Updated" : "Updated content of"} ${app.title}`, id: app.id });
            this.emit("apps");
            break;
          }
          case "app.pin":
          case "app.unpin": {
            if (where.recipe) break;
            const app = await this.apps.pin(String(a.name || ""), a.type === "app.pin", a.size);
            if (app) { done.push({ kind: "app", label: `${a.type === "app.pin" ? "Pinned to Home" : "Took off Home"}: ${app.title}`, id: app.id }); this.emit("apps"); }
            break;
          }
          case "teammate.update": {
            if (where.recipe) break;
            const r = await this.updateTeammate(String(a.name || ""), { emoji: a.emoji, description: a.description, color: a.color });
            if (r.value) done.push({ kind: "note", label: `${r.value.emoji ? `${r.value.emoji} ` : ""}${r.value.name} updated` });
            break;
          }
          case "app.delete": {
            if (where.recipe) break;
            const app = await this.apps.byName(String(a.name || ""));
            if (app && (await this.apps.remove(app.id))) { done.push({ kind: "note", label: `Deleted ${app.title}` }); this.emit("apps"); }
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
          case "source.read":
            if (typeof a.source === "string") runs.push({ name: "@source", args: [JSON.stringify({ source: a.source, config: a.config || {} })] });
            break;
          case "connection.refresh": {
            const site = String(a.site || "").trim();
            if (!site) break;
            const r = await this.refreshConnection(site, await this.actorName(where.teammateId));
            if (where.jobId) done.push(await this.reloginForJob(where.jobId, site, r));
            else done.push({ kind: "memory", label: r.ok ? `Refreshed the ${site} login (${r.how})` : r.state === "offline" ? `Couldn't refresh ${site}: your Mac is offline` : `Couldn't refresh ${site}: sign in to it in Chrome on your Mac` });
            break;
          }
          case "history.search":
            if (typeof a.query === "string" && a.query.trim()) runs.push({ name: "@history", args: [a.query.trim().slice(0, 200)] });
            break;
          case "person.upsert": {
            if (where.recipe) break;
            const r = await this.upsertPerson(a);
            if (r.value && r.created) done.push({ kind: "memory", label: `Added ${r.value.name} to your people` });
            break;
          }
          case "person.forget": {
            const p = await this.personByName(String(a.name || ""));
            if (p) { await this.store.remove("people", p.id); this.emit("people"); done.push({ kind: "memory", label: `Forgot ${p.name}` }); }
            break;
          }
          case "about.update": {
            if (where.recipe || typeof a.text !== "string" || !a.text.trim()) break;
            await this.setAbout(a.text, false);
            done.push({ kind: "memory", label: "Updated what I know about you" });
            break;
          }
          case "day.log": {
            if (typeof a.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(a.date) || typeof a.summary !== "string") break;
            await this.store.put<DayLog>("days", { id: a.date, createdAt: this.clock().toISOString(), summary: a.summary.trim().slice(0, 800) });
            break;
          }
          case "idea.add": {
            if (where.recipe) break;
            const r = await this.addIdea(a);
            if (r.value) done.push({ kind: "note", label: `Idea: ${r.value.title}` });
            break;
          }
          case "blocked": {
            const b = { need: String(a.need || "Something from you").slice(0, 200), why: String(a.why || "").slice(0, 300), unblock: String(a.unblock || "Tap Try again when it's sorted").slice(0, 200) };
            if (where.jobId) {
              const job = await this.store.get<Job>("jobs", where.jobId);
              if (job) await this.saveJob({ ...job, blocked: b });
            }
            done.push({ kind: "blocked", label: `Blocked: ${b.need}` });
            await this.log("job.blocked", `${b.need} (${b.unblock})`);
            await this.push?.send({ title: "I'm stuck", body: `${b.need}. ${b.unblock}`, tag: where.jobId, url: where.threadId ? threadLink(where.threadId) : "/" });
            break;
          }
          case "message.send": {
            if (where.recipe) break;
            const r = await this.requestMessage(a, where);
            done.push({ kind: "approval", label: r.value ? `Waiting for your Approve: ${r.value.summary}` : `Couldn't draft: ${r.error}`, id: r.value?.id });
            break;
          }
          case "google.change": {
            if (where.recipe) break;
            const r = await this.requestGoogleChange(a, where);
            done.push({ kind: "approval", label: r.value ? (r.value.status === "pending" ? `Waiting for your Approve: ${r.value.summary}` : `Done (always allowed): ${r.value.summary}`) : `Couldn't: ${r.error}`, id: r.value?.id });
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
    return { done, used, runs, split, tiles, fileIds };
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
      // Editing a webhook hook keeps its URL working.
      if (h.trigger.type === "webhook" && next.trigger.type === "webhook") next.trigger = h.trigger;
      if (JSON.stringify(next.trigger) !== JSON.stringify(h.trigger)) delete next.seen;
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
    const have = await this.store.all<Teammate>("teammates");
    for (const t of have) {
      const def = DEFAULT_TEAMMATES.find((d) => d.id === t.id);
      if (def && t.builtIn && OLD_NAMES[t.id] === t.name) await this.store.put<Teammate>("teammates", { ...t, name: def.name, description: def.description, prompt: def.prompt, emoji: def.emoji });
      else if (def && t.builtIn && !t.emoji) await this.store.put<Teammate>("teammates", { ...t, emoji: def.emoji });
    }
    if (have.length) return;
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    for (const [i, t] of DEFAULT_TEAMMATES.entries()) {
      await this.store.put<Teammate>("teammates", { ...t, builtIn: true, createdAt: new Date(t0 + i * 1000).toISOString() });
    }
  }

  private appAsks = new Map<string, number[]>();

  /** A mini app's hearth.ask(text): a message to the teammate who made it, in your DM with them. Rate-limited per app. */
  async askFromApp(id: string, text: string) {
    const app = await this.store.get<MiniApp>("apps", id);
    if (!app) return { error: "No such app." };
    const now = Date.now();
    const recent = (this.appAsks.get(id) || []).filter((t) => now - t < 60 * 60_000);
    if (recent.length >= 30 || (recent.length && now - recent[recent.length - 1] < 3000)) return { error: "That app is asking too often. Try again in a moment." };
    this.appAsks.set(id, [...recent, now]);
    return this.askTeammate(app.teammateId || "hearth", `[from the mini app "${app.title}" (${app.name})] ${String(text).trim().slice(0, 2000)}`);
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
    // Still working on your last message? This one goes into that task, so you get one answer.
    const busy = (await this.store.all<Job>("jobs")).filter((j) => j.threadId === tid && !j.parentId && (j.status === "queued" || j.status === "working")).at(-1);
    if (busy && (await this.addToJob(busy.id, tid, clean))) return { value: { message: m, job: busy } };
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
    const all = await this.store.all<Job>("jobs");
    const stale = supersededJobs(all);
    const jobs = all.filter((j) => !j.parentId && !stale.has(j.id)).sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
    const approvals = await this.store.all<Approval>("approvals");
    const prefs = await this.prefs();
    const hooks = (await this.store.all<Hook>("hooks")).filter((h) => h.status === "active" && h.nextAt && h.source !== "system").sort((a, b) => a.nextAt!.localeCompare(b.nextAt!));
    const first = (t: string) => t.split("\n").map((x) => x.replace(/^[-*•#\s]+/, "").trim()).find(Boolean) || "";
    const clip = (t: string, n = 90) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
    // When each teammate last wrote in your DM, so the app can show an unread dot.
    const lastDm = new Map<string, string>();
    for (const m of await this.store.all<Message>("messages")) {
      if (m.role !== "assistant" || !m.threadId?.startsWith("tm-")) continue;
      const id = m.threadId.slice(3);
      if ((lastDm.get(id) || "") < m.createdAt) lastDm.set(id, m.createdAt);
    }
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
      return { id: t.id, name: t.name, color: t.color, emoji: t.emoji, description: t.description, builtIn: t.builtIn, state, status: clip(status), at,
        busy: working.length + queued.length, needsYou: mine.filter(needsYouBadge).length, lastDmAt: lastDm.get(t.id) };
    });
  }

  /**
   * Activity (Slack's Activity tab): what needs you first (approvals, stuck jobs), then proactive messages
   * and recently finished work, newest first.
   */
  async inbox() {
    const all = await this.store.all<Job>("jobs");
    const stale = supersededJobs(all);
    const jobs = all.filter((j) => !j.parentId && !stale.has(j.id));
    const approvals = (await this.store.all<Approval>("approvals")).filter((a) => a.status === "pending");
    const msgs = await this.store.recent<Message>("messages", 200);
    const rootOf = (j: Job) => j.followsUp || j.id;
    const items: any[] = [];
    for (const a of approvals) {
      const j = jobs.find((x) => x.id === a.jobId);
      items.push({ kind: "approval", at: a.createdAt, id: a.id, summary: a.summary, approval: a, teammateId: j?.teammateId || "hearth", threadId: a.threadId, jobId: j ? rootOf(j) : undefined });
    }
    for (const j of jobs.filter((x) => x.status === "blocked")) items.push({ kind: "blocked", at: j.updatedAt || j.createdAt, id: j.id, summary: j.blocked?.need || j.task, unblock: j.blocked?.unblock, seen: stuckSeen(j), teammateId: j.teammateId, threadId: j.threadId, jobId: rootOf(j) });
    for (const m of msgs.filter((x) => x.proactive)) items.push({ kind: "proactive", at: m.createdAt, id: m.id, summary: m.text, title: m.proactive!.title, teammateId: m.teammateId || "hearth", threadId: m.threadId });
    for (const j of jobs.filter((x) => (x.status === "done" || x.status === "failed") && x.finishedAt).sort((a, b) => b.finishedAt!.localeCompare(a.finishedAt!)).slice(0, 25)) {
      items.push({ kind: j.status === "failed" ? "failed" : "done", at: j.finishedAt, id: j.id, summary: j.task, result: (j.result || "").split("\n").find((l) => l.trim()) || "", teammateId: j.teammateId, threadId: j.threadId, jobId: rootOf(j) });
    }
    // Everyone working right now, and what's waiting its turn.
    for (const j of jobs.filter((x) => x.status === "working" || x.status === "queued")) {
      items.push({ kind: j.status === "working" ? "running" : "queued", at: j.startedAt || j.createdAt, startedAt: j.startedAt, id: j.id, summary: j.label || shortLabel(undefined, j.task), teammateId: j.teammateId, threadId: j.threadId, jobId: rootOf(j) });
    }
    const urgent = (k: string) => (k === "running" || k === "queued" ? 0 : k === "approval" || k === "blocked" ? 1 : 2);
    return items.sort((a, b) => urgent(a.kind) - urgent(b.kind) || String(b.at).localeCompare(String(a.at))).slice(0, 80);
  }

  /** When you last looked at Activity (any device). Results after this count as new, like unread notifications. */
  async inboxSeen(): Promise<string> {
    return (await this.store.get<{ id: string; createdAt: string; at: string }>("settings", "inboxSeen"))?.at || "";
  }

  /** Mark Activity as seen up to now. Only moves forward, so a slow device can't bring old results back. */
  async markInboxSeen(): Promise<string> {
    await this.markStuckSeen(); // Activity lists every stuck job, so looking at it is seeing them
    const cur = await this.inboxSeen();
    const at = new Date().toISOString();
    if (at <= cur) return cur;
    await this.store.put("settings", { id: "inboxSeen", createdAt: "1970-01-01T00:00:00.000Z", at });
    this.emit("inbox");
    return at;
  }

  /**
   * You looked at these stuck jobs (their thread, the teammate's page, or Activity): like a read notification, they stop
   * counting in the badges. They stay stuck, with Try again and Dismiss, and count again if they get stuck again.
   */
  async markStuckSeen(where: { threadId?: string; teammateId?: string } = {}) {
    const at = this.clock().toISOString();
    const fresh = (await this.store.all<Job>("jobs")).filter((j) => j.status === "blocked" && !stuckSeen(j) &&
      (!where.threadId || j.threadId === where.threadId) && (!where.teammateId || j.teammateId === where.teammateId));
    // Not saveJob: seeing it isn't news, so updatedAt (what "stuck again" is measured against) stays put.
    for (const j of fresh) this.emit("job", await this.store.put<Job>("jobs", { ...j, seenAt: at }));
    return fresh.length;
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
    const same = (await this.store.all<Teammate>("teammates")).find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (same) return { value: same };
    const color = /^#[0-9a-f]{6}$/i.test(input.color || "") ? input.color : ["#F97066", "#36BFFA", "#FDB022", "#9E77ED", "#32D583"][Math.floor(Math.random() * 5)];
    const t = await this.store.put<Teammate>("teammates", this.doc({
      name, color, description, builtIn: false, emoji: cleanEmoji(input.emoji),
      prompt: `You are ${name}. ${description} Stay in that lane; hand anything else back to Hearth.`,
    }));
    this.emit("teammates");
    return { value: t };
  }

  /** Change a teammate's badge, description or color (the user from the app, or a teammate via teammate.update). */
  async updateTeammate(idOrName: string, patch: { emoji?: unknown; description?: unknown; color?: unknown }) {
    const team = await this.store.all<Teammate>("teammates");
    const t = team.find((x) => x.id === idOrName || x.name.toLowerCase() === String(idOrName).toLowerCase());
    if (!t) return { error: "No such teammate." };
    const emoji = patch.emoji === undefined ? t.emoji : cleanEmoji(patch.emoji);
    if (patch.emoji !== undefined && patch.emoji !== "" && !emoji) return { error: "The badge has to be a single emoji." };
    const description = typeof patch.description === "string" && patch.description.trim() ? patch.description.trim().slice(0, 200) : t.description;
    const color = typeof patch.color === "string" && /^#[0-9a-f]{6}$/i.test(patch.color) ? patch.color : t.color;
    const saved = await this.store.put<Teammate>("teammates", { ...t, emoji, description, color });
    this.emit("teammates");
    return { value: saved };
  }

  // ---------- ideas: things the team could do for you, suggested on its own (Leon's "pulse") ----------

  async listIdeas() {
    return (await this.store.all<Idea>("ideas")).filter((i) => i.status === "open").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Titles the model must not repeat: what's open, what you said yes to, and what you dismissed (it learns from those). */
  private async ideaTitles() {
    const all = (await this.store.all<Idea>("ideas")).sort((a, b) => (b.decidedAt || b.createdAt).localeCompare(a.decidedAt || a.createdAt));
    const pick = (st: Idea["status"], n: number) => all.filter((i) => i.status === st).slice(0, n).map((i) => i.title);
    return { open: pick("open", MAX_OPEN_IDEAS), accepted: pick("accepted", 20), dismissed: pick("dismissed", 40) };
  }

  async addIdea(a: any) {
    const title = typeof a?.title === "string" ? a.title.trim().slice(0, 90) : "";
    const prompt = typeof a?.prompt === "string" ? a.prompt.trim().slice(0, 1000) : "";
    if (!title || !prompt) return { error: "An idea needs a title and what to do." };
    const all = await this.store.all<Idea>("ideas");
    if (all.filter((i) => i.status === "open").length >= MAX_OPEN_IDEAS) return { error: "Enough ideas waiting already." };
    const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9']{3,}/g) || []);
    const w = words(title);
    const like = all.find((i) => { const o = words(i.title); const both = [...w].filter((x) => o.has(x)).length; return both / Math.max(1, Math.min(w.size, o.size)) >= 0.6; });
    if (like) return { error: `Too close to "${like.title}".` };
    const team = await this.store.all<Teammate>("teammates");
    const mate = team.find((t) => t.name.toLowerCase() === String(a.teammate || "").toLowerCase());
    const idea = await this.store.put<Idea>("ideas", this.doc({
      title, prompt, body: typeof a.body === "string" ? a.body.trim().slice(0, 400) : "", emoji: cleanEmoji(a.emoji), teammateId: mate?.id, status: "open" as const,
    }));
    this.emit("ideas");
    return { value: idea };
  }

  ideaTitlesForTest() { return this.ideaTitles(); }

  /** Ask the team for ideas now (the system hook does this every few hours, outside quiet hours). */
  async thinkOfIdeas() {
    const r = await this.turn("ideas", "Suggest ideas.", "ideas", { profile: (await this.brains()).workhorse });
    await this.log("ideas", r.text && r.text !== QUIET ? r.text : "nothing worth suggesting");
    return this.listIdeas();
  }

  /** Yes: it runs as a ramble, like you'd typed it. */
  async acceptIdea(id: string) {
    const i = await this.store.get<Idea>("ideas", id);
    if (!i || i.status !== "open") return { error: "That idea is gone." };
    const r = await this.ramble(i.prompt);
    if (r.error) return r;
    await this.store.put<Idea>("ideas", { ...i, status: "accepted", decidedAt: this.clock().toISOString(), threadId: r.value!.thread.id });
    this.emit("ideas");
    return r;
  }

  /** No: it goes away and stays in the "don't suggest" list, so the team learns what you don't want. */
  async dismissIdea(id: string) {
    const i = await this.store.get<Idea>("ideas", id);
    if (!i || i.status !== "open") return false;
    await this.store.put<Idea>("ideas", { ...i, status: "dismissed", decidedAt: this.clock().toISOString() });
    this.emit("ideas");
    return true;
  }

  /** Tidy a dictation on the quick model; if that fails, the raw words are fine. */
  async cleanDictation(text: string) {
    const raw = text.trim().slice(0, 8000);
    if (raw.split(/\s+/).length < 4) return raw;
    try {
      const out = (await this.brain.think({ mode: "clean", context: {}, input: raw }, (await this.brains()).quick)).trim();
      return out && out.length > raw.length * 0.3 && out.length < raw.length * 1.5 + 40 ? out : raw;
    } catch { return raw; }
  }

  // ---------- components: reusable artifacts ----------

  async componentByName(name: string) {
    const n = slugOf(name);
    return n ? (await this.store.all<Component>("components")).find((c) => c.name === n) || null : null;
  }

  /**
   * The starter components that ship with Hearth (components/*.html + starters.json): itinerary, comparison, checklist,
   * timeline, budget, recipe, countdown. Added once; refreshed with new releases unless the team has improved one.
   */
  async ensureStarterComponents(dir = join(import.meta.dir, "..", "components")) {
    let list: { name: string; title: string; description: string; example: unknown }[] = [];
    try { list = JSON.parse(readFileSync(join(dir, "starters.json"), "utf8")); } catch { return; }
    for (const s of list) {
      let html = "";
      try { html = readFileSync(join(dir, `${s.name}.html`), "utf8"); } catch { continue; }
      const prev = await this.componentByName(s.name);
      if (prev && (!prev.builtIn || prev.versions.length || prev.sha256 === sha256(html))) continue;
      await this.store.put<Component>("components", {
        ...(prev || { ...this.doc({}), uses: 0, versions: [] }), name: s.name, title: s.title, description: s.description,
        shape: JSON.stringify(s.example).slice(0, 1500), html, sha256: sha256(html), builtIn: true, updatedAt: this.clock().toISOString(),
      } as Component);
    }
  }

  /** Save (or improve) a component from an artifact's code. Missing descriptions are written by the quick model. */
  async saveComponent(input: { name: string; title?: string; description?: string; data?: unknown; html: string }, teammateId?: string) {
    const name = slugOf(input.name);
    if (!name || !input.html.trim()) return null;
    const prev = await this.componentByName(name);
    const shape = JSON.stringify(input.data ?? null).slice(0, 1500);
    const sha = sha256(input.html);
    const now = this.clock().toISOString();
    const c = await this.store.put<Component>("components", {
      ...(prev || { ...this.doc({}), uses: 0, versions: [] }),
      name, title: String(input.title || prev?.title || name).slice(0, 60), shape: shape !== "null" ? shape : prev?.shape || "",
      description: String(input.description || prev?.description || "").slice(0, 300),
      html: input.html, sha256: sha, uses: (prev?.uses || 0) + 1, lastUsedAt: now, teammateId: prev?.teammateId || teammateId,
      versions: prev && prev.sha256 !== sha ? [...prev.versions, { html: prev.html, at: prev.updatedAt || prev.createdAt }].slice(-5) : prev?.versions || [],
      updatedAt: now,
    } as Component);
    await this.log("component.saved", `${name}${prev ? " (improved)" : ""}`);
    if (!c.description) this.describeComponent(c.id).catch(() => {});
    return c;
  }

  /** One sentence on what a component shows and when to use it, so it can be found later. */
  async describeComponent(id: string) {
    const c = await this.store.get<Component>("components", id);
    if (!c) return;
    const text = (await this.brain.think({ mode: "describe", context: {}, input: `Title: ${c.title}\nName: ${c.name}\nData it draws: ${c.shape.slice(0, 800)}\nCode (start): ${c.html.replace(/\s+/g, " ").slice(0, 1500)}` }, (await this.brains()).quick)).trim();
    if (text) await this.store.put<Component>("components", { ...c, description: text.split("\n")[0].slice(0, 300) });
  }

  // ---------- boards: everyone's (or one teammate's) work as a to-do board ----------

  /** Up next (queued tasks, upcoming reminders and routines), Working, Needs you, Done (last 7 days). */
  async board(teammateId?: string) {
    const prefs = await this.prefs();
    const now = this.clock().getTime();
    const threads = new Map((await this.store.all<Thread>("threads")).map((t) => [t.id, t]));
    const where = (id?: string) => !id ? "" : id.startsWith("tm-") ? "DM" : threads.get(id) ? `#${channelOf(threads.get(id)!)}` : "";
    const mine = (id?: string) => !teammateId || id === teammateId;
    const all = await this.store.all<Job>("jobs");
    const stale = supersededJobs(all);
    const jobs = all.filter((j) => !j.parentId && !stale.has(j.id) && mine(j.teammateId));
    const card = (j: Job) => ({ kind: "task" as const, id: j.id, root: j.followsUp || j.id, title: j.label || shortLabel(undefined, j.task), teammateId: j.teammateId, threadId: j.threadId, where: where(j.threadId),
      status: j.status, at: j.finishedAt || j.startedAt || j.createdAt, startedAt: j.startedAt, need: j.blocked?.need });
    const by = (st: Job["status"][]) => jobs.filter((j) => st.includes(j.status));
    const recent = (a: { at: string }, b: { at: string }) => b.at.localeCompare(a.at);
    const plans = (await this.store.all<Hook>("hooks")).filter((h) => h.status === "active" && h.nextAt && h.source !== "system" && mine(h.teammateId || "hearth"))
      .sort((a, b) => a.nextAt!.localeCompare(b.nextAt!)).slice(0, 15)
      .map((h) => ({ kind: "plan" as const, id: h.id, title: h.title, teammateId: h.teammateId || "hearth", threadId: h.threadId, where: h.trigger.type === "at" ? "Reminder" : describeTrigger(h.trigger, prefs.tz), status: "planned", at: h.nextAt! }));
    return {
      next: [...by(["queued"]).map(card), ...plans],
      working: by(["working"]).map(card).sort(recent),
      needsYou: by(["waiting", "blocked"]).map(card).sort(recent),
      done: by(["done", "failed"]).map(card).filter((c) => now - new Date(c.at).getTime() < 7 * 864e5).sort(recent).slice(0, 25),
    };
  }

  // ---------- people: the relationship map ----------

  async personByName(name: string) {
    const n = name.trim().toLowerCase();
    return n ? (await this.store.all<Person>("people")).find((p) => p.name.toLowerCase() === n) || null : null;
  }

  async upsertPerson(a: any) {
    const name = typeof a?.name === "string" ? a.name.trim().replace(/\s+/g, " ").slice(0, 40) : "";
    if (!name || /^(me|myself|i|the user|user)$/i.test(name)) return { error: "Who?" };
    const prev = await this.personByName(name);
    const str = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : "");
    const notes = [...(prev?.notes || [])];
    const note = str(a.note, 200);
    if (note && !notes.some((x) => x.toLowerCase() === note.toLowerCase())) notes.push(note);
    const links = [...(prev?.links || [])];
    for (const l of Array.isArray(a.links) ? a.links.slice(0, 8) : []) {
      const to = str(l?.to, 40), relation = str(l?.relation, 40);
      if (!to || !relation || to.toLowerCase() === name.toLowerCase()) continue;
      const i = links.findIndex((x) => x.to.toLowerCase() === to.toLowerCase());
      if (i >= 0) links[i] = { to, relation }; else links.push({ to, relation });
    }
    const person = await this.store.put<Person>("people", {
      ...(prev || this.doc({})), name: prev?.name || name, relation: str(a.relation, 60) || prev?.relation || "",
      emoji: cleanEmoji(a.emoji) || prev?.emoji, notes: notes.slice(-20), links: links.slice(0, 12), lastMentionedAt: this.clock().toISOString(),
    } as Person);
    this.emit("people");
    return { value: person, created: !prev };
  }

  // ---------- about you, the daily log, and searching what was said ----------

  async setAbout(text: string, byUser: boolean) {
    await this.setPrefs({ about: String(text).trim().slice(0, 2500) || undefined, aboutUpdatedAt: this.clock().toISOString() });
    await this.log("about.updated", byUser ? "you edited it" : "the assistant updated it");
    this.emit("about");
  }

  /** The last few days: what was said (for the nightly log) and any logs already written. */
  private async recentDays(n: number) {
    const prefs = await this.prefs();
    const now = this.clock();
    const since = new Date(now.getTime() - n * 864e5).toISOString();
    const logs = await this.store.all<DayLog>("days");
    const msgs = (await this.store.all<Message>("messages")).filter((m) => m.createdAt >= since);
    const days = new Map<string, string[]>();
    for (const m of msgs) {
      const d = localDate(new Date(m.createdAt), prefs.tz);
      if (!days.has(d)) days.set(d, []);
      days.get(d)!.push(`${m.role === "user" ? "user" : "team"}: ${m.text.replace(/\s+/g, " ").slice(0, 200)}`);
    }
    return [...days.entries()].map(([date, lines]) => ({ date, log: logs.find((l) => l.id === date)?.summary || null, said: lines.slice(-40) }));
  }

  /** Plain word search over messages, task answers and day logs; newest first among equals. */
  async searchHistory(query: string) {
    const terms = [...new Set(query.toLowerCase().match(/[a-z0-9']{3,}/g) || [])].slice(0, 8);
    if (!terms.length) return "(nothing to search for)";
    const threads = new Map((await this.store.all<Thread>("threads")).map((t) => [t.id, t]));
    const team = new Map((await this.store.all<Teammate>("teammates")).map((t) => [t.id, t.name]));
    const where = (id?: string) => !id ? "" : id.startsWith("tm-") ? `DM with ${team.get(id.slice(3)) || "a teammate"}` : threads.get(id) ? `#${channelOf(threads.get(id)!)}` : "chat";
    const items: { at: string; where: string; text: string }[] = [
      ...(await this.store.all<Message>("messages")).map((m) => ({ at: m.createdAt, where: `${where(m.threadId)} · ${m.role === "user" ? "you" : team.get(m.teammateId || "hearth") || "Hearth"}`, text: m.text })),
      ...(await this.store.all<Job>("jobs")).filter((j) => j.result).map((j) => ({ at: j.finishedAt || j.createdAt, where: `${where(j.threadId)} · ${team.get(j.teammateId) || "teammate"}'s answer to "${(j.label || j.task).slice(0, 60)}"`, text: j.result! })),
      ...(await this.store.all<DayLog>("days")).map((d) => ({ at: `${d.id}T12:00:00Z`, where: `daily log ${d.id}`, text: d.summary })),
    ];
    const scored = items.map((it) => { const t = it.text.toLowerCase(); return { it, score: terms.filter((w) => t.includes(w)).length }; })
      .filter((x) => x.score > 0).sort((a, b) => b.score - a.score || b.it.at.localeCompare(a.it.at)).slice(0, 8);
    if (!scored.length) return "(no matches)";
    return scored.map(({ it }) => `- ${it.at.slice(0, 10)} (${it.where}): ${it.text.replace(/\s+/g, " ").slice(0, 350)}`).join("\n");
  }

  /**
   * Is a new ramble really about an earlier one (still open or closed)? A quick word match, no model call, so the app can
   * offer "this goes with #robinhood-money" before anything is planned. Names, titles and task labels count double.
   */
  async similarRamble(text: string) {
    const words = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9]{3,}/g) || []).map((w) => w.replace(/(?<=\w{3})s$/, "")).filter((w) => !STOP.has(w)));
    const q = words(text);
    if (!q.size) return null;
    const since = this.clock().getTime() - 60 * 86400_000;
    const threads = (await this.store.all<Thread>("threads")).filter((t) => !t.id.startsWith("tm-") && t.id !== "main" && new Date(t.updatedAt || t.createdAt).getTime() > since);
    if (!threads.length) return null;
    const msgs = await this.store.all<Message>("messages"), jobs = await this.store.all<Job>("jobs");
    const docs = threads.map((t) => {
      const mine = jobs.filter((j) => j.threadId === t.id && !j.parentId);
      return { t, strong: words([channelOf(t).replace(/-/g, " "), t.title, ...mine.filter((j) => !j.followsUp).map((j) => j.label || "")].join(" ")),
        weak: words([...msgs.filter((m) => m.threadId === t.id && m.role === "user").map((m) => m.text), ...mine.map((j) => j.task)].join(" ")) };
    });
    const df = (w: string) => docs.filter((d) => d.strong.has(w) || d.weak.has(w)).length;
    let best: { score: number; d: (typeof docs)[number]; hits: string[] } | null = null;
    for (const d of docs) {
      let score = 0, strong = 0; const hits: string[] = [];
      for (const w of q) {
        const s = d.strong.has(w), wk = d.weak.has(w);
        if (!s && !wk) continue;
        const idf = Math.log(1 + docs.length / df(w));
        score += (s ? 2 : 1) * idf; hits.push(w); if (s) strong++;
      }
      // One word in its name or a task's label, or two in what was said there: enough to ask.
      if ((strong >= 1 || hits.length >= 2) && (!best || score > best.score)) best = { score, d, hits };
    }
    if (!best) return null;
    const t = best.d.t;
    return { threadId: t.id, channel: channelOf(t), title: t.title, archived: !!t.archivedAt, why: best.hits.slice(0, 4) };
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
    await this.ensureStarterComponents();
    // Rambles from before they had names: name them from their titles (Hearth refines it on the next message).
    for (const t of await this.store.all<Thread>("threads")) if (t.num && !t.channel && t.title) await this.renameThread(t.id, nameFrom(t.title), false);
    this.timer = setInterval(() => this.tick().catch((e) => console.error("tick failed", e)), intervalMs);
    if (this.config.agent !== "echo") {
      this.checkBrainsSoon();
      // Find out now, not at the first job, if the browser can't get your logins (e.g. the service can't write them).
      // Only where jobs browse with enkidu-browser, the same check the brain makes before each call.
      try { if (this.brain.skills().skills.some((s) => s.name === "enkidu-browser")) this.giveBrowserLogins(); } catch {}
    }
    await this.tick();
  }

  /** Why the brain's browser can't get your logins right now, or null. Said once when it starts and once when it's fixed. */
  loginsProblem: string | null = null;
  /** Where the browser's logins go; undefined means ~/.enkidu/chrome-logins.json. Tests point it elsewhere. */
  browserLoginsFile: string | undefined = undefined;

  /** Write your connected logins where the brain's browser opens with them (brains/browser-logins.ts). Throws on failure. */
  giveBrowserLogins() {
    try {
      syncBrowserLogins(this.connections.allCookies(), join(this.config.dataDir, "browser-logins.json"), this.browserLoginsFile);
    } catch (e: any) {
      const why = String(e?.code || e?.message || e).slice(0, 200);
      if (this.loginsProblem !== why) {
        this.loginsProblem = why;
        const text = `Jobs' browser will open signed out of every site: the hub couldn't write its logins file (${why}).`;
        void this.log("browser.logins", text).catch(() => {});
        void this.push?.send({ title: "Signed-in browsing is off", body: text.slice(0, 180), tag: "browser-logins", url: "/" }).catch(() => {});
      }
      throw e;
    }
    if (this.loginsProblem) {
      this.loginsProblem = null;
      void this.log("browser.logins", "Jobs' browser opens signed in to your connected sites again").catch(() => {});
    }
  }

  stop() { if (this.timer) clearInterval(this.timer); if (this.brainsTimer) clearTimeout(this.brainsTimer); if (this.healthTimer) clearTimeout(this.healthTimer); }

  // ---------- are the brains signed in? ----------

  private healthTimer: ReturnType<typeof setTimeout> | null = null;

  /** Your picked brains that are signed out right now (Home's banner, Connectors' "Needs you"). */
  async brainProblems(): Promise<{ id: string; label: string; message: string }[]> {
    const pool = await this.brainPool().catch(() => [] as string[]);
    return pool.flatMap((id) => {
      const message = this.brain.health.problem(id);
      return message ? [{ id, label: id === "claude" ? "Claude Code" : "Codex", message }] : [];
    });
  }

  /** Every brain you picked and whether it's working: the sidebar's dots. ok null = not checked yet. */
  async brainStatus(): Promise<{ id: string; label: string; ok: boolean | null; message: string | null }[]> {
    const pool = await this.brainPool().catch(() => [] as string[]);
    return pool.filter((id) => id === "claude" || id === "codex").map((id) => ({
      id, label: id === "claude" ? "Claude Code" : "Codex", ok: this.brain.health.ok(id), message: this.brain.health.problem(id),
    }));
  }

  /** One tiny real call per picked brain, soon after start and every 6 hours, so a bad login shows before a job hits it. */
  checkBrainsSoon(firstMs = 20_000, everyMs = 6 * 3600_000) {
    if (this.healthTimer) clearTimeout(this.healthTimer);
    this.healthTimer = setTimeout(async () => {
      this.healthTimer = null;
      const pool = await this.brainPool().catch(() => [] as string[]);
      const here = availableHarnesses(this.config);
      for (const h of pool) if ((h === "claude" || h === "codex") && here.includes(h)) await this.brain.check(h).catch(() => {});
      this.checkBrainsSoon(everyMs, everyMs);
    }, firstMs);
    (this.healthTimer as any).unref?.();
  }

  /** A brain was signed out (tell you once, with a way to reconnect) or works again. */
  private async brainHealthChanged(id: string, ok: boolean, message: string | null) {
    const label = id === "claude" ? "Claude Code" : "Codex";
    if (ok) { await this.log("brains.health", `${label} is signed in again`); return; }
    await this.log("brains.health", `${label} is signed out: ${message}`);
    const text = `${label} is signed out on this hub, so it can't think for the team (it said: “${message}”). `
      + `Reconnect it in Connectors → ${label}.${(await this.brainPool().catch(() => [])).length > 1 ? " Your other brain is doing the work meanwhile." : ""}`;
    const msg = await this.addMessage({ role: "assistant", threadId: await this.updatesThread(), text });
    await this.push?.send({ title: `${label} needs reconnecting`, body: text.slice(0, 180), tag: `brain-signedout-${id}`, url: "/" });
    void msg;
  }

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
    if (!hooks.some((h) => h.source === "system" && h.action.type === "think" && h.action.prompt === IDEAS_MARKER)) {
      await this.addHook({
        title: "Ideas", why: "Every few hours the team looks for something useful it could do for you, and suggests it on Home.",
        trigger: { type: "every", minutes: 240 }, action: { type: "think", prompt: IDEAS_MARKER },
      }, "system");
    }
    if (!hooks.some((h) => h.source === "system" && h.action.type === "think" && h.action.prompt === PURGE_MARKER)) {
      await this.addHook({
        title: "Nightly library cleanup", why: "Removes skills, workflows and scripts that stopped being useful. Pinned ones stay.",
        trigger: { type: "schedule", time: "04:00", days: [] }, action: { type: "think", prompt: PURGE_MARKER },
      }, "system");
    }
  }

  /** When workspaces were last tidied (see brains/archive.ts): once a day, starting soon after the hub starts. */
  private tidiedAt = 0;

  async tick() {
    await this.archiveQuietRambles();
    if (Date.now() - this.tidiedAt > 86_400_000) {
      this.tidiedAt = Date.now();
      try {
        const r = this.brain.tidyWorkspaces();
        if (r.packed.length || r.notes.length || r.files) await this.log("workspaces.tidied", `packed ${r.packed.length} unused (${r.packed.join(", ").slice(0, 200)}), trimmed notes in ${r.notes.length}, archived ${r.files} old files`);
      } catch (e: any) { console.warn(`couldn't tidy workspaces: ${String(e?.message || e).slice(0, 200)}`); }
    }
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
        if (h.held) await this.fire({ ...h, held: undefined }, h.held.reason, false, h.held.extra);
        else await this.fire(h, describeTrigger(h.trigger, prefs.tz), lateMin > 10);
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

  /** Something POSTed to a webhook hook's secret URL: wake its teammate with what was sent. */
  async webhook(token: string, payload: string) {
    const h = (await this.store.all<Hook>("hooks")).find((x) => x.trigger.type === "webhook" && x.trigger.token === token);
    if (!h || h.status !== "active") return false;
    await this.log("hook.webhook", `${h.title}: called (${payload.length} bytes)`);
    const sent = `## What the webhook sent\n<untrusted>\n${payload.slice(0, 20_000) || "(empty)"}\n</untrusted>`;
    if (this.firing.has(h.id) || this.webhookQueue.has(h.id)) {
      const q = this.webhookQueue.get(h.id) || [];
      if (q.length < 20) q.push(sent);
      this.webhookQueue.set(h.id, q);
      if (!this.firing.has(h.id)) this.drainWebhook(h.id);
      return true;
    }
    this.fireWebhook(h, sent);
    return true;
  }

  private fireWebhook(h: Hook, sent: string) {
    this.inflight++;
    this.fire(h, "its webhook was called", false, sent).catch(() => {}).finally(() => { this.inflight--; this.drainWebhook(h.id); });
  }

  /** Calls that came in while the hook was busy go to it in one batch, so none are dropped. */
  private async drainWebhook(id: string) {
    const q = this.webhookQueue.get(id);
    if (!q?.length || this.firing.has(id)) return;
    this.webhookQueue.delete(id);
    const h = await this.store.get<Hook>("hooks", id);
    if (!h || h.status !== "active") return;
    this.fireWebhook(h, q.length === 1 ? q[0] : `${q.length} calls came in:\n\n${q.join("\n\n")}`);
  }

  /** A watch hook's look at its page: what changed since last time, or null (first look, no change, or an error). */
  private async lookAt(h: Hook & { trigger: { type: "watch" } }) {
    const r = await look(h.trigger.url, this.clock());
    const cur = (await this.store.get<Hook>("hooks", h.id)) || h;
    if (!r.value) { await this.log("hook.watch", `${h.title}: couldn't read the page (${r.error})`); return null; }
    await this.store.put<Hook>("hooks", { ...cur, seen: r.value });
    if (!cur.seen) { await this.log("hook.watch", `${h.title}: first look saved`); return null; }
    if (cur.seen.hash === r.value.hash) return null;
    const d = lineDiff(cur.seen.text, r.value.text);
    if (!d.added && !d.removed) return null;
    return `## ${h.trigger.url} changed since ${cur.seen.at} (${d.added} lines added, ${d.removed} removed)\n<untrusted>\n${d.text}\n</untrusted>`;
  }

  /** A check hook's run of its script, with no model: its output if it should speak, else null. */
  private async runCheck(h: Hook & { trigger: { type: "check" } }) {
    const t = h.trigger;
    const cur = (await this.store.get<Hook>("hooks", h.id)) || h;
    // Unattended, so only scripts that just read: one that sends or changes things never runs from a check.
    const out = await this.scripts.run(t.script, t.args, { last: cur.seen?.text ?? "" });
    if (out.needsApproval) { await this.log("hook.check", `${h.title}: ${t.script} can change things, so it can't run on its own`); return null; }
    if (!out.ok) { await this.log("hook.check", `${h.title}: ${out.output.slice(0, 200)}`); return null; }
    const text = out.output === "(no output)" ? "" : out.output;
    const seen = { hash: sha256(text), text, at: this.clock().toISOString() };
    await this.store.put<Hook>("hooks", { ...cur, seen });
    if (t.when === "output" ? !text : !cur.seen || cur.seen.hash === seen.hash || !text) return null;
    return text;
  }

  /** source.read: what a trigger module sees right now, for a teammate answering a question. */
  async readSource(req: { source: string; config: unknown }, by = "a teammate") {
    const src = sourceById(req.source);
    if (!src) return `## ${req.source}\nNo such source. Sources: ${SOURCES.map((s) => s.id).join(", ")}.`;
    const config = src.validate(req.config);
    if (typeof config === "string") return `## ${src.label}\n${config}`;
    const need = needOf(src, config);
    if (!this.connections.connected(need)) return `## ${src.label}\n${src.label} isn't connected. Tell the user to connect it in Menu → Connectors.`;
    try {
      const items = await src.items(config, await this.sourceCtx());
      this.connections.problem(need, null);
      await this.audit("read", need, by, { ok: true, detail: `read ${src.label} (${items.length})` });
      return `## ${src.label}: ${src.describe(config)}\n<untrusted>\n${formatItems(items)}\n</untrusted>`;
    } catch (e: any) {
      if (e instanceof SignedOut) this.connections.problem(need, e.message);
      await this.audit("read", need, by, { ok: false, detail: String(e.message).slice(0, 120) });
      return `## ${src.label}\nCouldn't read it: ${e.message}`;
    }
  }

  /** A source hook's check: items it hasn't seen before, or null. The first check only remembers what's there. */
  /** A source says something changed (a Plaid webhook): check its hooks now instead of waiting for their timer. */
  async pollNow(sourceId: string, why: string) {
    for (const h of await this.store.all<Hook>("hooks"))
      if (h.status === "active" && h.trigger.type === "source" && h.trigger.source === sourceId && !this.firing.has(h.id)) await this.fire(h, why);
  }
  private async pollSource(h: Hook & { trigger: { type: "source" } }) {
    const t = h.trigger, src = sourceById(t.source);
    if (!src) { await this.log("hook.source", `${h.title}: unknown source ${t.source}`); return null; }
    const need = needOf(src, t.config);
    if (!this.connections.connected(need)) { await this.log("hook.source", `${h.title}: ${src.label} isn't connected`); return null; }
    let items;
    const by = await this.actorName(h.teammateId, "Hearth");
    try { items = await src.items(t.config as never, await this.sourceCtx()); this.connections.problem(need, null); await this.audit("read", need, by, { ok: true, detail: `${h.title} (${items.length})` }); }
    catch (e: any) {
      await this.log("hook.source", `${h.title}: ${String(e.message).slice(0, 200)}`);
      await this.audit("read", need, by, { ok: false, detail: String(e.message).slice(0, 120) });
      if (e instanceof SignedOut) await this.signedOut(need, e.message);
      return null;
    }
    const cur = (await this.store.get<Hook>("hooks", h.id)) || h;
    const known = new Set((cur.seen?.text || "").split("\n").filter(Boolean));
    const fresh = cur.seen ? items.filter((i) => !known.has(i.id)) : [];
    // Remember what we've seen, newest first, capped so the list doesn't grow forever.
    const ids = [...new Set([...items.map((i) => i.id), ...known])].slice(0, 1000);
    await this.store.put<Hook>("hooks", { ...cur, seen: { hash: sha256(ids.join("\n")), text: ids.join("\n"), at: this.clock().toISOString() } });
    if (!cur.seen) { await this.log("hook.source", `${h.title}: first look saved (${items.length} already there)`); return null; }
    return fresh.length ? { count: fresh.length, text: `## ${fresh.length} new from ${src.label}\n<untrusted>\n${formatItems(fresh)}\n</untrusted>`, items: fresh } : null;
  }

  /** A site signed Hearth out: say so once (not on every check), until it's connected again. */
  private async signedOut(id: string, message: string) {
    const was = this.connections.problemFor(id);
    this.connections.problem(id, message);
    this.emit("connections");
    // Just flag it (Connectors shows "needs reconnecting") and tell you once. No auto-pull: a teammate or you can
    // run connection.refresh when you actually want a fresh login, so a transient blip doesn't churn the Mac.
    if (was) return;
    const msg = await this.addMessage({ role: "assistant", threadId: await this.updatesThread(), text: message });
    await this.push?.send({ title: "Reconnect needed", body: message.slice(0, 180), tag: `signedout-${id}`, url: threadLink(msg.threadId!) });
  }

  /** Connectors' "Save and test": read one list now and say what came back. */
  /**
   * The agent's one tool to (re)load a logged-in site's cookies on demand, wherever the hub runs:
   * a server hub asks the linked Mac; a laptop hub reads its own browser. Logged every time.
   */
  async refreshConnection(site: string, by = "a teammate"): Promise<{ ok: boolean; how: string; state: FreshLogin["state"] | "asked"; why?: string }> {
    const domain = this.connections.domainFor(site) || site;
    if (this.computers?.canCopyCookies()) {
      this.connections.wantFromMac(site);
      this.emit("connections");
      // An older hub wiring without freshLogin: ask and don't wait, as before.
      if (!this.computers.freshLogin) {
        this.computers.refreshCookies(domain);
        await this.log("connection.refresh", `${domain}: ${by} asked your Mac for a fresh login`);
        await this.audit("refresh", domain, by, { ok: true, detail: "asked the Mac" });
        return { ok: true, how: "mac", state: "asked" };
      }
      const r = await this.computers.freshLogin(domain, this.freshLoginWaitMs);
      const said = r.state === "fresh" ? `got a fresh login from ${r.from || "your Mac"}`
        : r.state === "missing" ? (r.why === "unreadable" ? "your Mac couldn't read its browser" : r.why === "same" ? "your Mac has the same signed-out login" : "your Mac isn't signed in to it")
        : r.state === "timeout" ? "asked your Mac (no answer yet)" : "no Mac online";
      if (r.state === "fresh") { this.connections.problem(domain, null); this.emit("connections"); }
      await this.log("connection.refresh", `${domain}: ${by} ${said}`);
      await this.audit("refresh", domain, by, { ok: r.state === "fresh", detail: said });
      return { ok: r.state === "fresh" || r.state === "timeout", how: "mac", state: r.state, why: r.why };
    }
    const opt = this.connections.browserOptions(site)[0];
    if (opt) {
      const r = this.importFromBrowser(site, opt.id);
      await this.log("connection.refresh", `${domain}: ${by} ${r.value ? `read from ${opt.label}` : `couldn't read it (${r.error})`}`);
      await this.audit("refresh", domain, by, { ok: !!r.value, detail: r.value ? `read from ${opt.label}` : r.error });
      return { ok: !!r.value, how: "browser", state: r.value ? "fresh" : "missing" };
    }
    await this.log("connection.refresh", `${domain}: no Mac online and no local browser to read`);
    await this.audit("refresh", domain, by, { ok: false, detail: "no Mac or local browser" });
    return { ok: false, how: "none", state: "offline" };
  }

  /**
   * A job hit a site that signed Hearth out and asked for a fresh login. Hearth checks your Mac itself instead of telling
   * you to reconnect: a fresh login runs the job again (once); a Mac that isn't signed in either, or is offline, parks the
   * job saying exactly that, and it picks up again when you sign in and tap Try again, or when the Mac comes online.
   */
  private async reloginForJob(jobId: string, site: string, r: Awaited<ReturnType<Hub["refreshConnection"]>>): Promise<Done> {
    const job = await this.store.get<Job>("jobs", jobId);
    const domain = this.connections.domainFor(site) || site, name = labelFor(domain);
    if (!job) return { kind: "memory", label: r.ok ? `Refreshed the ${name} login` : `Couldn't refresh ${name}` };
    const tried = (job.relogged || []).includes(domain);
    const park = async (b: NonNullable<Job["blocked"]>, push = true) => {
      await this.saveJob({ ...job, relogged: [...new Set([...(job.relogged || []), domain])], blocked: { ...b, site: domain } });
      await this.log("job.blocked", `${b.need} (${b.unblock})`);
      if (push) await this.push?.send({ title: "I'm stuck", body: `${b.need}. ${b.unblock}`, tag: jobId, url: threadLink(job.threadId) });
      return { kind: "blocked" as const, label: `Blocked: ${b.need}` };
    };
    // The hub couldn't hand any login to the jobs' browser (giveBrowserLogins): a fresh one wouldn't help and your Mac isn't
    // the problem, so say the real cause and don't spend a rerun on it.
    if (this.loginsProblem)
      return park({ need: `The hub's browser can't get your logins`, why: `${name} shows signed out because the hub couldn't give the jobs' browser your logins (${this.loginsProblem}). Your Mac's login is fine.`, unblock: "Tap Try again once the hub is fixed (a redeploy with the browser-logins fix)", needs: "login" });
    if ((r.state === "fresh" || r.state === "timeout") && !tried) {
      // Got one (or a Mac that's still reading): run the job again with it as soon as this turn ends.
      this.rerunAfterLogin.add(jobId);
      await park({ need: `A fresh ${name} login`, why: r.state === "fresh" ? `${name} signed Hearth out, so I pulled a fresh login from your Mac.` : `${name} signed Hearth out; I asked your Mac for a fresh login.`, unblock: "Running it again by itself" }, false);
      return { kind: "memory", label: `Refreshed the ${name} login from your Mac; running it again` };
    }
    if (r.state === "offline")
      return park({ need: `Your Mac, for the ${name} login`, why: `${name} signed Hearth out, and your Mac is where the login lives. It's offline right now.`, unblock: "Open your Mac: this picks up again by itself", needs: "computer" });
    const why = tried ? `${name} still shows Hearth signed out, even with the latest login from your Mac.`
      : r.why === "unreadable" ? `${name} signed Hearth out, and Hearth couldn't read Chrome on your Mac.`
      : `${name} signed Hearth out, and Chrome on your Mac isn't signed in to ${name} either.`;
    return park({ need: `Sign in to ${name} on your Mac`, why, unblock: `Sign in to ${name} in Chrome on your Mac, then tap Try again`, needs: "login" });
  }

  importFromBrowser(site: string, profileId: string) {
    const r = this.connections.importFromBrowser(site, profileId);
    if (r.value) this.emit("connections");
    return r;
  }

  /**
   * Your recent conversations (LinkedIn, Instagram) or notifications (X) on a logged-in site, for its Connectors screen, like WhatsApp's
   * chat list. Kept from the last read (encrypted in the vault); a new read happens only when that's over 15 minutes
   * old, or you tap Refresh (not more than once a minute), so opening the screen doesn't keep hitting the site.
   */
  async recentConversations(id: string, fresh = false, what = "messages"): Promise<{ items: { name: string; preview: string; lines: string[]; when: string; unread: boolean; url: string }[]; readAt: string | null; error?: string }> {
    const src = sourceById(id);
    if (!src || !["linkedin", "instagram", "x"].includes(id)) return { items: [], readAt: null, error: "Not a site with a list." };
    const config = src.validate({ what });
    const kind = String((config as any).what || "messages");
    const key = kind === "messages" ? `recent:${id}` : `recent:${id}:${kind}`;
    let kept: { items: any[]; readAt: string } | null = null;
    try { kept = JSON.parse(this.vault?.get(key) || "null"); } catch {}
    const age = kept ? Date.now() - Date.parse(kept.readAt) : Infinity;
    if (kept && (fresh ? age < 60_000 : age < 15 * 60_000)) return kept;
    const r = await this.readConnection(id, config);
    if (!r.ok) return { items: kept?.items || [], readAt: kept?.readAt || null, error: r.error };
    return JSON.parse(this.vault?.get(key) || "null") || { items: [], readAt: null };
  }

  private keepRecent(id: string, kind: string, items: Item[]) {
    if (!this.vault || !["linkedin", "instagram", "x"].includes(id)) return;
    const list = items.slice(0, 30).map((i) => {
      // LinkedIn puts screen-reader labels in each row ("Open the options list in your conversation with …",
      // "Status is online"); they're not the message, so they never become the preview.
      const lines = i.text.split("\n").map((l) => l.trim()).filter((l) => l && !HIDDEN_LABEL.test(l)).slice(0, 6).map((l) => l.slice(0, 200));
      return { name: i.title.replace(/^● /, "").slice(0, 120), preview: (lines[0] || "").slice(0, 160), lines, when: i.when || "", unread: !!i.unread, url: i.url || "" };
    });
    this.vault.set(kind === "messages" ? `recent:${id}` : `recent:${id}:${kind}`, JSON.stringify({ items: list, readAt: new Date().toISOString() }));
  }

  /** One read of a logged-in site's list; keeps it for the Connectors screen and flags a sign-out. */
  private async readConnection(id: string, config: any) {
    const src = sourceById(id)!;
    try {
      const items = await src.items(config, await this.sourceCtx());
      this.connections.problem(id, null);
      this.keepRecent(id, String(config?.what || "messages"), items);
      this.emit("connections");
      return { ok: true as const, count: items.length, sample: items.slice(0, 3).map((i) => i.title) };
    } catch (e: any) {
      if (e instanceof SignedOut) this.connections.problem(id, e.message);
      return { ok: false as const, error: String(e.message) };
    }
  }

  async testConnection(id: string): Promise<{ ok: boolean; count?: number; sample?: string[]; error?: string }> {
    return this.readConnection(id, sourceById(id)!.validate({}));
  }

  async fire(h: Hook, reason: string, late = false, extra?: string) {
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
        if (gate === "quiet" && (h.nextAt || extra !== undefined)) {
          // A webhook call keeps what it sent (calls during the night pile up, newest last) and is handled in the morning.
          const cur = (await this.store.get<Hook>("hooks", h.id)) || h;
          const held = extra === undefined ? cur.held : { reason, extra: [cur.held?.extra, extra].filter(Boolean).join("\n\n").slice(-30_000) };
          await this.store.put<Hook>("hooks", { ...cur, held, nextAt: quietEndsAt(now, prefs.tz, prefs.quietEnd).toISOString() });
          await this.log("hook.held", `${h.title}: held until quiet hours end`);
        } else {
          await this.reschedule(h, now);
          await this.log("hook.held", `${h.title}: skipped (${gate === "cap" ? "daily limit reached" : gate})`);
        }
        return;
      }
      await this.reschedule(h, now); // before running, so a slow brain can't double-fire
      { const c = await this.store.get<Hook>("hooks", h.id); if (c?.held) await this.store.put<Hook>("hooks", { ...c, held: undefined }); }
      // A watch speaks only when its page changed. Looked at after the gate, so a change in quiet hours isn't lost.
      if (h.trigger.type === "watch" && extra === undefined) {
        const changed = await this.lookAt(h as Hook & { trigger: { type: "watch" } });
        if (!changed) return;
        extra = changed;
      }
      let checked = "";
      if (h.trigger.type === "source" && extra === undefined) {
        const found = await this.pollSource(h as Hook & { trigger: { type: "source" } });
        if (!found) return;
        extra = found.text;
        checked = found.items.slice(0, 5).map((i) => `• ${i.title}`).join("\n") + (found.count > 5 ? `\n…and ${found.count - 5} more` : "");
      }
      if (h.trigger.type === "check" && extra === undefined) {
        checked = (await this.runCheck(h as Hook & { trigger: { type: "check" } })) || "";
        if (!checked) return;
        extra = `## ${h.trigger.script} printed\n<untrusted>\n${checked}\n</untrusted>`;
      }
      const fresh = (await this.store.get<Hook>("hooks", h.id)) || h;
      await this.store.put<Hook>("hooks", { ...fresh, lastFiredAt: now.toISOString(), fireCount: (h.fireCount || 0) + 1 });

      if (h.source === "system" && h.action.type === "think" && h.action.prompt === IDEAS_MARKER) {
        const prefs = await this.prefs();
        if (!inQuietHours(now, prefs.tz, prefs.quietStart, prefs.quietEnd)) await this.thinkOfIdeas();
        return;
      }
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
        text = h.trigger.type === "watch" ? `${a.text}\n${h.trigger.url}` : checked ? `${a.text}\n${checked.slice(0, 1200)}` : a.text;
      } else if (a.type === "think") {
        const r = await this.turn("hook", `${h.title}\n${a.prompt}`, `hook: ${h.title}`, { teammate, threadId: h.threadId, extra });
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
      // A hook made in a ramble talks there while the ramble is open. Once it's archived, it talks in the
      // teammate's DM instead, so a background watch doesn't keep pulling an old ramble back into Active.
      const home = h.threadId ? await this.store.get<Thread>("threads", h.threadId) : null;
      const threadId = home && !home.archivedAt ? home.id : teammate ? (await this.dmThread(teammate.id)).id : await this.updatesThread();
      const msg = await this.addMessage({
        role: "assistant", teammateId: teammate?.id, threadId, fromThreadId: home && home.id !== threadId ? home.id : undefined, text: late ? `${text}\n\n(Late: the hub was offline when this was due.)` : text,
        proactive: { hookId: h.id, title: h.title, trigger: reason, why: h.why }, did: did.length ? did : undefined,
      });
      await this.touchThread(msg.threadId!, { preview: msg.text.slice(0, 120) });
      await this.log("hook.fired", `${h.title}: sent`);
      await this.push?.send({ title: h.title, body: msg.text.slice(0, 180), tag: h.id, url: threadLink(msg.threadId!) });
    } catch (err: any) {
      await this.log("hook.failed", `${h.title}: ${err.message}`);
    } finally {
      this.firing.delete(h.id);
    }
  }

  // ---------- your data ----------

  async exportAll() {
    const out: Record<string, unknown> = { exportedAt: this.clock().toISOString(), hub: this.config.name, storage: this.store.kind };
    for (const col of ["threads", "messages", "jobs", "teammates", "skills", "workflows", "approvals", "hooks", "memory", "notebooks", "places", "locations", "activity", "scripts", "apps", "appState", "ideas", "days", "people", "components"] as const) out[col] = await this.store.all(col);
    out.devices = (await this.store.all<any>("devices")).map(({ tokenHash, ...d }) => d);
    out.prefs = await this.prefs();
    return out;
  }

  async wipePersonal() {
    for (const f of await this.store.all<StoredFile>("files")) await this.files.remove(f.id);
    for (const col of ["threads", "messages", "jobs", "approvals", "hooks", "memory", "notebooks", "places", "locations", "activity", "apps", "appState", "ideas", "days", "people"] as const) await this.store.clear(col);
    await this.setPrefs({ about: undefined, aboutUpdatedAt: undefined });
    await this.ensureSystemHooks();
    await this.ensureTeammates();
    await this.log("data.wiped", "All personal data deleted from this hub.");
    this.emit("reset");
  }
}

/**
 * Blocked jobs that a newer follow-up in the same thread has taken over. You only ever see (and can retry) the newest
 * job of a thread, so an older stuck one would otherwise count as "needs you" forever with nothing to tap.
 */
export function supersededJobs(jobs: Job[]): Set<string> {
  const newest = new Map<string, string>();
  for (const j of jobs) {
    if (j.parentId) continue;
    const root = j.followsUp || j.id;
    if ((newest.get(root) || "") < j.createdAt) newest.set(root, j.createdAt);
  }
  return new Set(jobs.filter((j) => !j.parentId && j.status === "blocked" && (newest.get(j.followsUp || j.id) || "") > j.createdAt).map((j) => j.id));
}

/** You've seen this job stuck since it last got stuck. */
export const stuckSeen = (j: Job) => !!j.seenAt && j.seenAt >= (j.updatedAt || j.createdAt);
/** Counts in a needs-you badge: an approval waiting on you, or a stuck job you haven't seen yet. */
const needsYouBadge = (j: Job) => j.status === "waiting" || (j.status === "blocked" && !stuckSeen(j));

/** The few words shown in the chat for a job: the orchestrator's label, else the first clause of the task. */
export function shortLabel(label: unknown, task: string) {
  const l = typeof label === "string" ? label.trim() : "";
  if (l) return l.slice(0, 60);
  const first = task.trim().split(/[.!?\n]|,\s|\s(?:and|then)\s/)[0].replace(/^(please|can you|could you)\s+/i, "");
  const words = first.split(/\s+/);
  const out = words.slice(0, 7).join(" ");
  return (out.charAt(0).toUpperCase() + out.slice(1)).slice(0, 60) + (words.length > 7 ? "…" : "");
}

/** Where a notification about a thread opens in the app: a DM (#t/<teammate>) or a ramble (#c/<id>). */
export const threadLink = (threadId: string) => (threadId.startsWith("tm-") ? `/#t/${threadId.slice(3)}` : `/#c/${threadId}`);

/** One emoji (with its skin-tone/variation/ZWJ parts), or undefined. Nothing else can become a badge. */
export function cleanEmoji(v: unknown) {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s || s.length > 16) return undefined;
  const parts = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)];
  const flag = /^[\u{1F1E6}-\u{1F1FF}]{2}$/u.test(s);
  return parts.length === 1 && (flag || (/\p{Extended_Pictographic}/u.test(s) && !/[\p{L}\p{N}\s<>&"']/u.test(s))) ? s : undefined;
}

/** A ramble's channel name: its own ("japan-trip"), or ramble-N. */
export const channelOf = (t: Thread) => t.channel || (t.num ? `ramble-${t.num}` : t.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30));
const slugOf = (name: string) => String(name).toLowerCase().replace(/^#/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
/** A short channel name from a title: its first three words that carry meaning ("Lisbon trip and Portuguese" -> lisbon-trip-portuguese). */
const FILLER = new Set(["a", "an", "the", "and", "or", "in", "on", "at", "to", "for", "of", "with", "before", "after", "from", "my", "your", "about", "this", "that"]);
/** Words too common to say two rambles are about the same thing (stems: a trailing "s" is dropped first). */
const STOP = new Set(("the and for with this that from into your you yours mine about what when where which who how why are was were will would could "
  + "should can cant don dont does did have has had just also some any more most much many very really thing stuff lot get got make made find help want "
  + "need please tell show give check look know like think let put take use done going doing day today tomorrow tonight week weekend month year time "
  + "now next last good best new old one two remind reminder plan quick idea there here then than them they their our out all not but yes okay hey hi "
  + "thank thanks hearth again other another way back keep sure same").split(" "));
const nameFrom = (title: string) => title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !FILLER.has(w)).slice(0, 3).join(" ");

/** The key an "Always allow" is saved under: one chat on one app. */
export const allowKey = (channel: string, to: string) => `${channel}:${to.trim().toLowerCase()}`;
