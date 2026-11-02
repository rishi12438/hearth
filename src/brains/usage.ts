import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readClaudeToken } from "./logins.ts";

// Live usage of each brain's subscription, read from the provider (the way Mako does it), so work goes to the brain
// with the most room on its own limits instead of whichever we happened to use less.
//
//   Claude Code  GET api.anthropic.com/api/oauth/usage with the login's token (five_hour, seven_day, seven_day_opus…),
//                plus the `rate_limit_event` every `claude -p --output-format stream-json` run prints.
//   Codex        `codex app-server` JSON-RPC: initialize, initialized, account/rateLimits/read. Read-only, costs nothing.
//
// A brain's score is its "binding" window: the fullest of its windows, with a window already past its reset counted
// as empty. Each job goes to the chosen brain with the lowest score.

export type UsageWindow = { usedPercent: number; windowMinutes: number; resetsAt: number | null; scope?: string };
export type Reading = {
  harness: string;
  status: "ok" | "unknown" | "error";
  windows: UsageWindow[];
  plan?: string;
  /** When this reading was taken (ms). */
  at: number;
  detail?: string;
  /** The brain refused a job on its limit: treat it as full until then (ms). */
  fullUntil?: number;
};

/** At or past this, a brain is near its limit. */
export const LIMIT_NEAR_PERCENT = 90;
/** Work only moves to a brain this full or less. */
export const LIMIT_HEADROOM_PERCENT = 70;
/** How long a reading stays fresh. */
export const USAGE_TTL_MS = 5 * 60_000;
/** A brain with no reading yet counts as half full: below a busy one, above one we know is quiet. */
const UNKNOWN_PERCENT = 50;

const windowLabel = (w: UsageWindow) =>
  `${w.windowMinutes >= 10_080 ? "weekly" : w.windowMinutes >= 60 ? `${Math.round(w.windowMinutes / 60)}-hour` : `${w.windowMinutes}-min`}${w.scope ? ` ${w.scope}` : ""}`;
export { windowLabel };

/** Windows as they stand now: one past its reset is empty again. */
export function windowsAt(windows: readonly UsageWindow[], now: number): UsageWindow[] {
  return windows.map((w) => (w.resetsAt !== null && w.resetsAt <= now ? { ...w, usedPercent: 0 } : w));
}

/** The fullest window: the one that will stop this brain first. */
export function bindingWindow(windows: readonly UsageWindow[]): UsageWindow | null {
  let b: UsageWindow | null = null;
  for (const w of windows) if (!b || w.usedPercent > b.usedPercent) b = w;
  return b;
}

/** 0-100: how full this brain is right now. */
export function score(r: Reading | undefined, now: number): number {
  if (r?.fullUntil && r.fullUntil > now) return 100;
  if (!r || r.status !== "ok" || !r.windows.length) return UNKNOWN_PERCENT;
  return bindingWindow(windowsAt(r.windows, now))?.usedPercent ?? 0;
}

/** The earliest moment any of these brains has room again (ms), for "parked until …". */
export function nextRoom(readings: (Reading | undefined)[], now: number): number | null {
  const times = readings.flatMap((r) => {
    if (!r) return [];
    if (r.fullUntil && r.fullUntil > now) return [r.fullUntil];
    return r.windows.filter((w) => w.usedPercent >= LIMIT_NEAR_PERCENT && w.resetsAt && w.resetsAt > now).map((w) => w.resetsAt!);
  });
  return times.length ? Math.min(...times) : null;
}

export type Pick = { harness: string; percent: number } | { park: true; until: number | null };

/**
 * Which brain gets the next job. `preferred` keeps its job unless it's near its limit and another has real room, so
 * a two-brain setup doesn't flip on every percent; with no preference, the emptiest wins. Everyone near the limit: park.
 */
export function pickBrain(pool: readonly string[], readings: Record<string, Reading | undefined>, now: number, preferred?: string): Pick {
  if (!pool.length) return { park: true, until: null };
  const scored = pool.map((h) => ({ harness: h, percent: score(readings[h], now) })).sort((a, b) => a.percent - b.percent);
  const best = scored[0];
  if (best.percent >= LIMIT_NEAR_PERCENT) return { park: true, until: nextRoom(pool.map((h) => readings[h]), now) };
  const pref = preferred ? scored.find((s) => s.harness === preferred) : undefined;
  if (!pref) return best;
  if (pref.percent < LIMIT_NEAR_PERCENT) return pref.percent <= best.percent + 15 ? pref : best;
  return best.percent <= LIMIT_HEADROOM_PERCENT ? best : pref;
}

// ---------- Claude ----------

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const toMs = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string" && v) { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
  return null;
};

/** Claude's OAuth usage reply: each window its own field (null when unused); model caps may also sit in `limits`. */
export function parseClaudeUsage(body: any, now = Date.now()): Reading {
  const win = (v: any, minutes: number, scope?: string): UsageWindow | null => {
    const used = num(v?.utilization) ?? num(v?.used_percentage);
    if (used === undefined) return null;
    return { usedPercent: used, windowMinutes: minutes, resetsAt: toMs(v?.resets_at), ...(scope ? { scope } : {}) };
  };
  const windows = [win(body?.five_hour, 300), win(body?.seven_day, 10_080), win(body?.seven_day_opus, 10_080, "Opus"), win(body?.seven_day_sonnet, 10_080, "Sonnet")]
    .filter((w): w is UsageWindow => !!w);
  for (const l of Array.isArray(body?.limits) ? body.limits : []) {
    const scope = l?.scope?.model?.display_name;
    if (l?.kind === "weekly_scoped" && typeof scope === "string" && num(l.percent) !== undefined && !windows.some((w) => w.scope === scope))
      windows.push({ usedPercent: l.percent, windowMinutes: 10_080, resetsAt: toMs(l.resets_at), scope });
  }
  return { harness: "claude", status: "ok", windows, at: now, ...(typeof body?.subscription_type === "string" ? { plan: body.subscription_type } : {}) };
}

const CLAUDE_WINDOWS: Record<string, [number, string?]> = { five_hour: [300], seven_day: [10_080], seven_day_opus: [10_080, "Opus"], seven_day_sonnet: [10_080, "Sonnet"] };

/** The windows one `rate_limit_event` names (utilization is 0-1 there, resetsAt unix seconds). */
export function claudeEventWindows(info: any): UsageWindow[] {
  const out: UsageWindow[] = [];
  const add = (type: string, v: any) => {
    const known = CLAUDE_WINDOWS[type];
    const u = num(v?.utilization);
    if (!known || u === undefined) return;
    out.push({ usedPercent: u <= 1 ? u * 100 : u, windowMinutes: known[0], resetsAt: toMs(v?.resetsAt), ...(known[1] ? { scope: known[1] } : {}) });
  };
  if (info?.unifiedWindows && typeof info.unifiedWindows === "object") for (const [k, v] of Object.entries(info.unifiedWindows)) add(k, v);
  else if (info?.rateLimitType) add(info.rateLimitType, info);
  return out;
}

/** The OAuth token Claude Code is signed in with on this machine, without the Keychain (that prompts on a Mac). */
export function claudeToken(env: Record<string, string | undefined> = process.env, home = homedir()): string | null {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return env.CLAUDE_CODE_OAUTH_TOKEN;
  const long = readClaudeToken(home);
  if (long) return long;
  const path = join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), ".credentials.json");
  try { return JSON.parse(readFileSync(path, "utf8"))?.claudeAiOauth?.accessToken || null; } catch { return null; }
}

export async function readClaudeUsage(token: string | null, fetcher: typeof fetch = fetch): Promise<Reading> {
  const now = Date.now();
  if (!token) return { harness: "claude", status: "unknown", windows: [], at: now, detail: "Usage shows after Claude's next job" };
  try {
    const r = await fetcher("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-code/2.1.0", accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    // A rotated token, or a setup-token without the profile scope: not a failure, the next run's event fills it in.
    if (r.status === 401 || r.status === 403) return { harness: "claude", status: "unknown", windows: [], at: now, detail: "Usage shows after Claude's next job" };
    if (!r.ok) return { harness: "claude", status: "error", windows: [], at: now, detail: `Anthropic answered ${r.status}` };
    return parseClaudeUsage(await r.json(), now);
  } catch (e: any) {
    return { harness: "claude", status: "error", windows: [], at: now, detail: e?.message || "Couldn't reach Anthropic" };
  }
}

// ---------- Codex ----------

/** `account/rateLimits/read`'s result (the general "codex" limit, plus any model's own cap). */
export function parseCodexRateLimits(result: any, now = Date.now()): Reading {
  const snap = (s: any): UsageWindow[] => {
    const scope = !s?.limitId || s.limitId === "codex" ? undefined : s.limitName || s.limitId;
    return [s?.primary, s?.secondary].filter((w) => num(w?.usedPercent) !== undefined)
      .map((w) => ({ usedPercent: w.usedPercent, windowMinutes: num(w.windowDurationMins) ?? 0, resetsAt: toMs(w.resetsAt), ...(scope ? { scope } : {}) }));
  };
  if (!result?.rateLimits) return { harness: "codex", status: "error", windows: [], at: now, detail: "Codex answered with limits Hearth can't read" };
  const byId = result.rateLimitsByLimitId && typeof result.rateLimitsByLimitId === "object" ? result.rateLimitsByLimitId : {};
  const general = byId.codex ?? result.rateLimits;
  const windows = [...snap(general), ...Object.entries(byId).filter(([id]) => id !== "codex").flatMap(([, s]) => snap(s))];
  const reached = typeof general.rateLimitReachedType === "string" && general.rateLimitReachedType;
  return {
    harness: "codex", status: "ok", windows, at: now,
    ...(typeof general.planType === "string" ? { plan: general.planType } : {}),
    ...(reached ? { fullUntil: Math.max(...windows.map((w) => w.resetsAt ?? 0), now + 15 * 60_000) } : {}),
  };
}

/** Ask Codex's own read-only app-server for the account's limits. */
export async function readCodexUsage(program = "codex", env: Record<string, string | undefined> = process.env): Promise<Reading> {
  const now = Date.now();
  if (!Bun.which(program)) return { harness: "codex", status: "error", windows: [], at: now, detail: "Codex isn't installed here" };
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  try {
    proc = Bun.spawn([program, "app-server"], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: env as Record<string, string> });
    const stdin = proc.stdin as import("bun").FileSink;
    const send = (o: unknown) => stdin.write(JSON.stringify(o) + "\n");
    // LSP-shaped: initialize, then the initialized notification, and only then anything else. Keep stdin open.
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "hearth", version: "0.1.0" } } });
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: {} });
    stdin.flush();
    const answer = await Promise.race([
      (async () => {
        let buf = "";
        const dec = new TextDecoder();
        for await (const chunk of proc!.stdout as unknown as AsyncIterable<Uint8Array>) {
          buf += dec.decode(chunk, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            try { const j = JSON.parse(line); if (j.id === 2) return j; } catch {}
          }
        }
        return null;
      })(),
      new Promise<null>((r) => setTimeout(() => r(null), 15_000)),
    ]);
    if (!answer) return { harness: "codex", status: "error", windows: [], at: now, detail: "Codex didn't answer in time" };
    if (answer.error) return { harness: "codex", status: "error", windows: [], at: now, detail: String(answer.error.message || "Codex refused the read") };
    return parseCodexRateLimits(answer.result, now);
  } catch (e: any) {
    return { harness: "codex", status: "error", windows: [], at: now, detail: e?.message || "Couldn't start Codex" };
  } finally { try { proc?.kill(); } catch {} }
}

// ---------- the live board ----------

type Readers = { claude: () => Promise<Reading>; codex: () => Promise<Reading> };

/** Keeps the latest reading per brain: refreshed every few minutes, after each job, and when a brain refuses one. */
export class BrainUsage {
  private readings = new Map<string, Reading>();
  private inflight = new Map<string, Promise<Reading>>();
  constructor(private readers: Readers = {
    claude: () => readClaudeUsage(claudeToken()),
    codex: () => readCodexUsage(),
  }, private clock: () => number = Date.now) {}

  get(harness: string) { return this.readings.get(harness); }
  all() { return Object.fromEntries(this.readings); }

  /** Read again if stale (or `force`). Concurrent callers share one read. */
  async refresh(harness: string, force = false): Promise<Reading | undefined> {
    const read = (this.readers as Record<string, (() => Promise<Reading>) | undefined>)[harness];
    if (!read) return undefined;
    const cur = this.readings.get(harness);
    if (!force && cur && this.clock() - cur.at < USAGE_TTL_MS) return cur;
    let p = this.inflight.get(harness);
    if (!p) {
      p = read().then((r) => {
        const prev = this.readings.get(harness);
        // A failed read keeps the last good windows: old numbers beat none for routing.
        const next = r.status === "ok" ? r : prev?.status === "ok" ? { ...prev, detail: r.detail } : r;
        if (prev?.fullUntil && prev.fullUntil > this.clock() && !next.fullUntil) next.fullUntil = prev.fullUntil;
        this.readings.set(harness, next);
        return next;
      }).finally(() => this.inflight.delete(harness));
      this.inflight.set(harness, p);
    }
    return p;
  }

  /** A `rate_limit_event` from a Claude run: merge its windows into the reading. */
  noteClaudeEvent(info: any) {
    const ws = claudeEventWindows(info);
    if (!ws.length) return;
    const now = this.clock();
    const cur = this.readings.get("claude");
    const windows = [...(cur?.status === "ok" ? cur.windows : [])];
    for (const w of ws) {
      const i = windows.findIndex((x) => x.windowMinutes === w.windowMinutes && x.scope === w.scope);
      if (i >= 0) windows[i] = w; else windows.push(w);
    }
    const rejected = info?.status === "rejected";
    this.readings.set("claude", { ...(cur || {}), harness: "claude", status: "ok", windows, at: now,
      ...(rejected ? { fullUntil: toMs(info?.resetsAt) ?? now + 15 * 60_000 } : { fullUntil: cur?.fullUntil }) });
  }

  /** The brain refused a job on its limit: full until it resets, then read again. */
  noteRefused(harness: string, until?: number | null) {
    const now = this.clock();
    const cur = this.readings.get(harness) ?? { harness, status: "unknown" as const, windows: [], at: now };
    const resets = cur.windows.map((w) => w.resetsAt ?? 0).filter((t) => t > now);
    this.readings.set(harness, { ...cur, fullUntil: until ?? (resets.length ? Math.min(...resets) : now + 15 * 60_000) });
  }

  /** Pick for the next job; refreshes stale readings first. */
  async pick(pool: readonly string[], preferred?: string): Promise<Pick> {
    await Promise.all(pool.map((h) => this.refresh(h).catch(() => undefined)));
    return pickBrain(pool, Object.fromEntries(pool.map((h) => [h, this.readings.get(h)])), this.clock(), preferred);
  }

  /** What the brain tiles draw: each window's % and reset, the plan, and whether it's the one taking work now. */
  view(pool: readonly string[]) {
    const now = this.clock();
    return pool.map((h) => {
      const r = this.readings.get(h);
      return {
        harness: h, status: r?.status ?? "unknown", plan: r?.plan ?? null, at: r?.at ?? null, detail: r?.detail ?? null,
        percent: Math.round(score(r, now)), full: !!(r?.fullUntil && r.fullUntil > now), fullUntil: r?.fullUntil ?? null,
        windows: windowsAt(r?.windows || [], now).map((w) => ({ label: windowLabel(w), usedPercent: Math.round(w.usedPercent), resetsAt: w.resetsAt })),
      };
    });
  }
}

/** Does an error from a brain run mean it hit its plan limit? */
export function isLimitError(text: string) {
  return /usage limit|rate[ _-]?limit|limit reached|5-hour limit|weekly limit|quota|too many requests|429/i.test(text);
}
