import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import type { Store, Collection } from "./store/index.ts";
import type { Brain, BrainInput } from "./brain.ts";
import { QUIET } from "./brain.ts";
import type { Scripts } from "./scripts.ts";
import type { Push } from "./push.ts";
import { parseReply } from "./reply.ts";
import { validateHook, computeNextAt, describeTrigger, isUserReminder } from "./hooks.ts";
import { recall, isActive, validateFact } from "./memory.ts";
import { describeLocal, inQuietHours, quietEndsAt, localDate, distanceMeters } from "./time.ts";
import type { Activity, Done, Fact, Hook, LocationFix, Message, Notebook, Place, Prefs } from "./types.ts";

const DEFAULT_PREFS: Prefs = {
  userName: "", tz: "UTC", quietStart: "23:00", quietEnd: "07:30",
  maxProactivePerDay: 6, proactiveToday: { date: "", n: 0 }, placeState: {},
};
const REVIEW_MARKER = "[[memory-review]]";
const LOCATION_KEEP_DAYS = 7;

export type HubEvent = { type: string; data?: unknown };

export class Hub {
  clock = () => new Date();
  private listeners = new Set<(e: HubEvent) => void>();
  private firing = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  thinking = false;

  constructor(
    readonly config: Config, readonly store: Store, readonly brain: Brain,
    readonly scripts: Scripts, readonly push: Push | null,
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

  async setPrefs(patch: Partial<Prefs>) {
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

  async context(query: string, mode: BrainInput["mode"]) {
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
    return {
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
    };
  }

  // ---------- one brain turn, with an optional script round-trip ----------

  async turn(mode: BrainInput["mode"], input: string, evidence: string, extraResults?: string) {
    const ctx = await this.context(input, mode);
    const first = parseReply(await this.brain.think({ mode, context: ctx, input, toolResults: extraResults }));
    const applied = await this.applyActions(first.actions, evidence);
    if (!applied.runs.length) return { text: first.text, did: applied.done, used: applied.used };

    const results: string[] = [];
    for (const r of applied.runs.slice(0, 3)) {
      const out = await this.scripts.run(r.name, r.args);
      applied.done.push({ kind: "script", label: `Ran ${r.name}${out.ok ? "" : " (failed)"}` });
      results.push(`## ${r.name}\n${out.output}`);
    }
    const ctx2 = await this.context(input, mode);
    const second = parseReply(await this.brain.think({ mode, context: ctx2, input, toolResults: [extraResults, ...results].filter(Boolean).join("\n\n") }));
    const applied2 = await this.applyActions(second.actions.filter((a: any) => a?.type !== "script.run"), evidence);
    return { text: second.text || first.text, did: [...applied.done, ...applied2.done], used: [...applied.used, ...applied2.used] };
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

  /** Stores your message right away and answers in the background. */
  async userSays(text: string) {
    const clean = text.trim().slice(0, 4000);
    if (!clean) return { error: "Empty message." };
    const m = await this.addMessage({ role: "user", text: clean });
    await this.setPrefs({ lastUserAt: m.createdAt });
    this.reply(clean);
    return { value: m };
  }

  private async reply(text: string) {
    this.thinking = true;
    this.emit("thinking", true);
    try {
      const r = await this.turn("chat", text, text);
      await this.addMessage({ role: "assistant", text: r.text || "Done.", did: r.did.length ? r.did : undefined, used: r.used.length ? r.used : undefined });
    } catch (err: any) {
      await this.addMessage({ role: "assistant", text: `I couldn't think just now: ${err.message}`, error: true });
    } finally {
      this.thinking = false;
      this.emit("thinking", false);
    }
  }

  // ---------- actions proposed by the brain ----------

  async applyActions(actions: any[], evidence: string) {
    const done: Done[] = [];
    const used: string[] = [];
    const runs: { name: string; args: string[] }[] = [];
    for (const a of actions.slice(0, 12)) {
      if (!a || typeof a !== "object") continue;
      try {
        switch (a.type) {
          case "hook.add": {
            const r = await this.addHook(a, a.requestedByUser === true ? "you" : "assistant");
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
          case "script.run":
            if (typeof a.name === "string") runs.push({ name: a.name, args: Array.isArray(a.args) ? a.args.slice(0, 8).map(String) : [] });
            break;
          case "script.propose": {
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
    return { done, used, runs };
  }

  // ---------- hooks ----------

  async listHooks() {
    const prefs = await this.prefs();
    return (await this.store.all<Hook>("hooks")).map((h) => ({ ...h, when: describeTrigger(h.trigger, prefs.tz) }));
  }

  async addHook(input: any, source: Hook["source"]) {
    const v = validateHook(input);
    if (!v.value) return { error: v.error! };
    const prefs = await this.prefs();
    const nextAt = computeNextAt(v.value.trigger, prefs.tz, this.clock());
    const h = await this.store.put<Hook>("hooks", this.doc({ ...v.value, status: "active" as const, nextAt, fireCount: 0, source }));
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

  async addFact(input: any, source: Fact["source"]) {
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
  async updateFact(id: string, input: any) {
    const old = await this.store.get<Fact>("memory", id);
    if (!old || old.supersededBy) return null;
    const v = validateFact({ ...old, ...input, fact: input.fact ?? old.fact });
    if (!v.value) return null;
    const f = await this.store.put<Fact>("memory", this.doc({ ...v.value, source: old.source, useCount: old.useCount, supersedes: old.id }));
    await this.store.put("memory", { ...old, supersededBy: f.id, updatedAt: f.createdAt });
    this.emit("memory");
    return f;
  }

  async mergeFacts(ids: string[], input: any) {
    const olds = (await Promise.all(ids.map((id) => this.store.get<Fact>("memory", id)))).filter((f): f is Fact => !!f && !f.supersededBy);
    if (olds.length < 2) return null;
    const v = validateFact(input);
    if (!v.value) return null;
    const f = await this.store.put<Fact>("memory", this.doc({ ...v.value, source: "assistant" as const, useCount: Math.max(...olds.map((o) => o.useCount)), supersedes: olds[0].id }));
    for (const o of olds) await this.store.put("memory", { ...o, supersededBy: f.id });
    this.emit("memory");
    return f;
  }

  async forgetFact(id: string) {
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
    await this.ensureSystemHooks();
    this.timer = setInterval(() => this.tick().catch((e) => console.error("tick failed", e)), intervalMs);
    await this.tick();
  }

  stop() { if (this.timer) clearInterval(this.timer); }

  private async ensureSystemHooks() {
    const hooks = await this.store.all<Hook>("hooks");
    if (!hooks.some((h) => h.source === "system" && h.action.type === "think" && h.action.prompt === REVIEW_MARKER)) {
      await this.addHook({
        title: "Nightly memory review", why: "Keeps memory tidy: merges duplicates, expires stale facts.",
        trigger: { type: "schedule", time: "03:30", days: [] }, action: { type: "think", prompt: REVIEW_MARKER },
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
        const r = await this.turn("review", "Review memory.", "nightly review");
        if (r.text && r.text !== QUIET) await this.log("memory.review", r.text);
        return;
      }

      let text = "";
      let did: Done[] = [];
      const a = h.action;
      if (a.type === "notify") {
        text = a.text;
      } else if (a.type === "think") {
        const r = await this.turn("hook", `${h.title}\n${a.prompt}`, `hook: ${h.title}`);
        text = r.text; did = r.did;
      } else if (a.type === "script") {
        const out = await this.scripts.run(a.script, a.args);
        if (a.then === "notify" || !out.ok) text = out.ok ? out.output.slice(0, 1500) : `${h.title}: ${out.output}`;
        else { const r = await this.turn("hook", `${h.title}\nInterpret the output of script ${a.script} for the user.`, `hook: ${h.title}`, `## ${a.script}\n${out.output}`); text = r.text; did = r.did; }
      }

      if (!text || text.trim() === QUIET || text.includes(QUIET)) {
        await this.log("hook.quiet", `${h.title}: checked, nothing worth saying`);
        return;
      }
      await this.countProactive(h);
      const msg = await this.addMessage({
        role: "assistant", text: late ? `${text}\n\n(Late: the hub was offline when this was due.)` : text,
        proactive: { hookId: h.id, title: h.title, trigger: reason, why: h.why }, did: did.length ? did : undefined,
      });
      await this.log("hook.fired", `${h.title}: sent`);
      await this.push?.send({ title: h.title, body: msg.text.slice(0, 180), tag: h.id, url: "/#chat" });
    } catch (err: any) {
      await this.log("hook.failed", `${h.title}: ${err.message}`);
    } finally {
      this.firing.delete(h.id);
    }
  }

  // ---------- your data ----------

  async exportAll() {
    const out: Record<string, unknown> = { exportedAt: this.clock().toISOString(), hub: this.config.name, storage: this.store.kind };
    for (const col of ["messages", "hooks", "memory", "notebooks", "places", "locations", "activity", "scripts"] as const) out[col] = await this.store.all(col);
    out.devices = (await this.store.all<any>("devices")).map(({ tokenHash, ...d }) => d);
    out.prefs = await this.prefs();
    return out;
  }

  async wipePersonal() {
    for (const col of ["messages", "hooks", "memory", "notebooks", "places", "locations", "activity"] as const) await this.store.clear(col);
    await this.ensureSystemHooks();
    await this.log("data.wiped", "All personal data deleted from this hub.");
    this.emit("reset");
  }
}
