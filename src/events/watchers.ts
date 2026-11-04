import { NAME_RE } from "../scripts.ts";
import { sourceById, SOURCES } from "../sources/index.ts";
import type { SourceVar } from "./pipeline.ts";

// Watchers: publishers the hub runs itself. Each one looks at something now and then and pushes what's new into its
// own source as events, where triggers pick them up like any other event:
//
//   page     a web page's text changed               -> one event with the lines that came and went
//   script   an approved script printed something    -> one event with its output (no model runs)
//   app      a connected app has new items (Gmail, Calendar, LinkedIn…) -> one event per new item
//   silence  you haven't written for N hours          -> one event, once per silence
//
// The first look only remembers what's there, so a new watcher doesn't flood you with what already existed.

export type WatcherKind = "page" | "script" | "app" | "silence";
export type WatchConfig =
  | { url: string }
  | { script: string; args: string[]; when: "changed" | "output" }
  | { app: string; config: Record<string, unknown> }
  | { hours: number };

export const WATCH_VARIABLES: Record<WatcherKind, SourceVar[]> = {
  page: [
    { name: "url", description: "the page" },
    { name: "changes", description: "the lines that came (+) and went (-)" },
    { name: "added", description: "the lines that came, joined" },
    { name: "removed", description: "the lines that went, joined" },
    { name: "text", description: "the page's text now (first 4000 characters)" },
  ],
  script: [
    { name: "output", description: "what the script printed" },
    { name: "previous", description: "what it printed last time" },
  ],
  app: [
    { name: "app", description: "which app (gmail, calendar…)" },
    { name: "title", description: "the item's title (subject, event name, sender…)" },
    { name: "text", description: "the item's text" },
    { name: "url", description: "a link to it, if any" },
    { name: "at", description: "when it happened (ISO), if known" },
    { name: "when", description: "the time as the site shows it" },
    { name: "unread", description: "true when it's unread, if the app says" },
    { name: "id", description: "the item's id" },
  ],
  silence: [
    { name: "hours", description: "hours since you last wrote" },
    { name: "last_message_at", description: "when you last wrote (ISO)" },
  ],
};

const hostOf = (url: string) => { try { return new URL(url).host.replace(/^www\./, ""); } catch { return url; } };
const mins = (n: number) => (n % 60 === 0 ? `${n / 60}h` : `${n} min`);

/** Check a watcher's settings. Returns its config, how often it looks, and what it's about (for duplicate checks). */
export function cleanWatch(kind: unknown, x: any): { kind: WatcherKind; config: WatchConfig; everyMin: number; scope: string } | string {
  const every = (def: number, min: number) => {
    const n = x?.everyMin ?? x?.minutes;
    const v = n === undefined ? def : Math.round(Number(n));
    return v >= min && v <= 10080 ? v : `everyMin must be between ${min} and 10080.`;
  };
  switch (kind) {
    case "page": {
      let u: URL;
      try { u = new URL(String(x?.url || "")); } catch { return "A page watcher needs url: a web address."; }
      if (!/^https?:$/.test(u.protocol)) return "A page watcher needs an http(s) address.";
      const everyMin = every(60, 15);
      if (typeof everyMin === "string") return everyMin;
      return { kind, config: { url: u.toString() }, everyMin, scope: u.toString() };
    }
    case "script": {
      const script = String(x?.script || "").toLowerCase();
      if (!NAME_RE.test(script)) return "A script watcher needs script: the name of an approved script.";
      const everyMin = every(30, 5);
      if (typeof everyMin === "string") return everyMin;
      const args = Array.isArray(x?.args) ? x.args.slice(0, 8).map((a: unknown) => String(a).slice(0, 200)) : [];
      const when = x?.when === "output" ? "output" : "changed";
      return { kind, config: { script, args, when }, everyMin, scope: `${script} ${args.join(" ")}`.trim() };
    }
    case "app": {
      const src = sourceById(String(x?.app || ""));
      if (!src) return `An app watcher needs app: one of ${SOURCES.map((s) => s.id).join(", ")}.`;
      const config = src.validate(x?.config || {});
      if (typeof config === "string") return config;
      const m = src.minutes(config);
      const everyMin = every(m.default, m.min);
      if (typeof everyMin === "string") return everyMin;
      return { kind, config: { app: src.id, config }, everyMin, scope: `${src.id} ${JSON.stringify(config)}` };
    }
    case "silence": {
      const hours = Number(x?.hours);
      if (!(hours >= 6 && hours <= 720)) return "A silence watcher needs hours between 6 and 720.";
      return { kind, config: { hours }, everyMin: 15, scope: `${hours}h` };
    }
  }
  return 'A watcher\'s kind is "page", "script", "app" or "silence".';
}

/** What a watcher looks at, in words. */
export function describeWatch(kind: WatcherKind, c: any, everyMin: number) {
  switch (kind) {
    case "page": return `${hostOf(c.url)} changes (checked every ${mins(everyMin)})`;
    case "script": return `${c.script} ${c.when === "output" ? "prints something" : "prints something new"} (runs every ${mins(everyMin)})`;
    case "app": { const src = sourceById(c.app); return `${src ? src.describe(c.config as never) : c.app} (checked every ${mins(everyMin)})`; }
    case "silence": return `${c.hours}h without hearing from you`;
  }
}
