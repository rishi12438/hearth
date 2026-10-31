import { randomBytes } from "node:crypto";
import { REPEATS, type Repeat, nextOccurrence, nextScheduledRun, describeLocal } from "./time.ts";
import type { Hook, HookAction, Trigger } from "./types.ts";
import { NAME_RE } from "./scripts.ts";
import { sourceById, SOURCES } from "./sources/index.ts";

// A hook is a rule for when the assistant speaks first: a trigger, an action, and a reason.
//   at        a moment, optionally repeating         -> reminders, follow-ups
//   schedule  HH:MM on chosen weekdays (cron-like)   -> briefings, weekly reviews
//   every     every N minutes (min 15)               -> watches: "tell me only if…"
//   place     arriving at / leaving a saved place    -> "when I get to the office…"
//   silence   no message from you for N hours        -> check-ins
//   watch     a web page's text changed (checked every N min) -> "tell me when tickets drop"
//   webhook   something POSTed to the hook's secret URL       -> Shortcuts, Zapier, changedetection.io, GitHub…
//   check     an approved script, run every N min with no model -> any check you can write in code
//   source    a trigger module (src/sources/): new Gmail, calendar events… -> "tell me when the school emails"
// Actions: notify (send fixed text), think (run the brain; it may stay quiet), script (run an approved script).

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

type Draft = Pick<Hook, "title" | "trigger" | "action" | "why" | "cooldownMin">;

export function validateTrigger(t: any): Trigger | string {
  switch (t?.type) {
    case "at": {
      const at = new Date(t.at);
      if (Number.isNaN(at.getTime())) return "Trigger 'at' needs a valid ISO time.";
      const repeat: Repeat = REPEATS.includes(t.repeat) ? t.repeat : "none";
      return { type: "at", at: at.toISOString(), repeat };
    }
    case "schedule": {
      if (!TIME_RE.test(t.time || "")) return "Trigger 'schedule' needs time as HH:MM.";
      const days = Array.isArray(t.days) && t.days.length
        ? [...new Set<number>(t.days.map(Number).filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
        : [0, 1, 2, 3, 4, 5, 6];
      return { type: "schedule", time: t.time, days };
    }
    case "every": {
      const minutes = Math.round(Number(t.minutes));
      if (!(minutes >= 15 && minutes <= 10080)) return "Trigger 'every' needs minutes between 15 and 10080.";
      return { type: "every", minutes };
    }
    case "place": {
      const place = str(t.place, 60);
      if (!place) return "Trigger 'place' needs a saved place name.";
      return { type: "place", place: place.toLowerCase(), event: t.event === "leave" ? "leave" : "arrive" };
    }
    case "silence": {
      const hours = Number(t.hours);
      if (!(hours >= 6 && hours <= 720)) return "Trigger 'silence' needs hours between 6 and 720.";
      return { type: "silence", hours };
    }
    case "watch": {
      let u: URL;
      try { u = new URL(String(t.url || "")); } catch { return "Trigger 'watch' needs a web address."; }
      if (!/^https?:$/.test(u.protocol)) return "Trigger 'watch' needs an http(s) address.";
      const minutes = t.minutes === undefined ? 60 : Math.round(Number(t.minutes));
      if (!(minutes >= 15 && minutes <= 10080)) return "Trigger 'watch' needs minutes between 15 and 10080.";
      return { type: "watch", url: u.toString(), minutes };
    }
    case "webhook": {
      // The token is the hook's password, so the hub makes it; a brain or a client can't pick one.
      return { type: "webhook", token: randomBytes(24).toString("base64url") };
    }
    case "check": {
      const script = String(t.script || "").toLowerCase();
      if (!NAME_RE.test(script)) return "Trigger 'check' needs a script name.";
      const minutes = t.minutes === undefined ? 30 : Math.round(Number(t.minutes));
      if (!(minutes >= 5 && minutes <= 10080)) return "Trigger 'check' needs minutes between 5 and 10080.";
      const args = Array.isArray(t.args) ? t.args.slice(0, 8).map((x: unknown) => String(x).slice(0, 200)) : [];
      return { type: "check", script, args, minutes, when: t.when === "output" ? "output" : "changed" };
    }
    case "source": {
      const src = sourceById(String(t.source || ""));
      if (!src) return `Unknown source. Use one of: ${SOURCES.map((s) => s.id).join(", ")}.`;
      const config = src.validate(t.config || {});
      if (typeof config === "string") return config;
      const m = src.minutes(config);
      const minutes = t.minutes === undefined ? m.default : Math.round(Number(t.minutes));
      if (!(minutes >= m.min && minutes <= 10080)) return `${src.label} checks need minutes between ${m.min} and 10080.`;
      return { type: "source", source: src.id, config, minutes };
    }
  }
  return "Unknown trigger type.";
}

export function validateAction(a: any): HookAction | string {
  switch (a?.type) {
    case "notify": {
      const text = str(a.text, 500);
      return text ? { type: "notify", text } : "Action 'notify' needs text.";
    }
    case "think": {
      const prompt = str(a.prompt, 2000);
      return prompt ? { type: "think", prompt } : "Action 'think' needs a prompt.";
    }
    case "script": {
      const script = str(a.script, 40);
      if (!script) return "Action 'script' needs a script name.";
      const args = Array.isArray(a.args) ? a.args.slice(0, 8).map((x: unknown) => String(x).slice(0, 200)) : [];
      return { type: "script", script, args, then: a.then === "think" ? "think" : "notify" };
    }
  }
  return "Unknown action type.";
}

export function validateHook(input: any): { value?: Draft; error?: string } {
  const title = str(input?.title, 80);
  if (!title) return { error: "Hook needs a title." };
  const trigger = validateTrigger(input.trigger);
  if (typeof trigger === "string") return { error: trigger };
  const action = validateAction(input.action);
  if (typeof action === "string") return { error: action };
  const why = str(input.why, 300) || "You asked for this.";
  const cooldownMin = input.cooldownMin ? Math.max(0, Math.min(10080, Number(input.cooldownMin) || 0)) : undefined;
  return { value: { title, trigger, action, why, cooldownMin } };
}

/** When a time-driven hook should next fire. Place, silence and webhook hooks are event-driven (null). */
export function computeNextAt(trigger: Trigger, tz: string, now = new Date(), firedJustNow = false): string | null {
  switch (trigger.type) {
    case "at": {
      if (!firedJustNow) return trigger.at;
      return nextOccurrence(trigger.at, trigger.repeat, tz, now)?.toISOString() ?? null;
    }
    case "schedule": return nextScheduledRun(trigger.time, trigger.days, tz, now)?.toISOString() ?? null;
    case "every": case "watch": case "check": case "source": return new Date(now.getTime() + trigger.minutes * 60000).toISOString();
    default: return null;
  }
}

function dayList(days: number[]) {
  const s = days.join(",");
  if (s === "0,1,2,3,4,5,6") return "every day";
  if (s === "1,2,3,4,5") return "weekdays";
  if (s === "0,6") return "weekends";
  return days.map((d) => DAY_NAMES[d]).join(", ");
}

/** Plain-language "when" for the UI and the brain. */
export function describeTrigger(t: Trigger, tz: string) {
  switch (t.type) {
    case "at": return t.repeat === "none" ? describeLocal(new Date(t.at), tz) : `${t.repeat}, from ${describeLocal(new Date(t.at), tz)}`;
    case "schedule": return `${dayList(t.days)} at ${t.time}`;
    case "every": return t.minutes % 60 === 0 ? `every ${t.minutes / 60}h` : `every ${t.minutes} min`;
    case "place": return `when you ${t.event === "arrive" ? "arrive at" : "leave"} ${t.place}`;
    case "silence": return `after ${t.hours}h without hearing from you`;
    case "watch": return `when ${hostOf(t.url)} changes (checked every ${t.minutes % 60 === 0 ? `${t.minutes / 60}h` : `${t.minutes} min`})`;
    case "webhook": return "when its webhook is called";
    case "source": {
      const src = sourceById(t.source);
      return `${src ? src.describe(t.config as never) : t.source} (checked every ${t.minutes % 60 === 0 ? `${t.minutes / 60}h` : `${t.minutes} min`})`;
    }
    case "check": return `when ${t.script} ${t.when === "output" ? "finds something" : "sees a change"} (runs every ${t.minutes % 60 === 0 ? `${t.minutes / 60}h` : `${t.minutes} min`})`;
  }
}

const hostOf = (url: string) => { try { return new URL(url).host.replace(/^www\./, ""); } catch { return url; } };

/** Plain user reminders fire even in quiet hours and don't count toward the daily cap. */
export function isUserReminder(h: Hook) {
  return h.trigger.type === "at" && h.action.type === "notify" && h.source === "you";
}
