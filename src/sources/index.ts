import type { Google } from "../google.ts";
import type { Cookie, readPage } from "../browser.ts";
// (connection ids are plain strings now: a preset id, a domain, or "google")
import { gmail } from "./gmail.ts";
import { calendar } from "./calendar.ts";
import { drive } from "./drive.ts";
import { linkedin } from "./linkedin.ts";
import { x } from "./x.ts";
import { site } from "./site.ts";
import { instagram } from "./instagram.ts";

// Trigger modules: one file per source of "something new" (Gmail, Calendar…). A module only says how to fetch
// recent items and give each a stable id. The hub does the rest: the timer, the first look (which only remembers
// what's there, so you aren't flooded), working out what's new, and handing it to a teammate.
// Same shape as Activepieces' polling triggers. To add a source, write one file and list it below.

export type Item = {
  /** Stable and unique: the hub remembers ids it has seen. */
  id: string;
  title: string;
  text: string;
  at?: string;
  url?: string;
  /** For a conversation list: when it was last active, as the site shows it ("2:14 PM", "Oct 28"), and whether it's unread. */
  when?: string;
  unread?: boolean;
};

export type SourceCtx = { google: Google; cookies: (domain: string) => Cookie[]; readPage: typeof readPage; now: Date; tz: string };

export interface Source<C = Record<string, unknown>> {
  id: string;
  label: string;
  /** The connection it reads through (hub won't poll until it's connected): a fixed id, or one derived from config. */
  needs: string | ((config: C) => string);
  /** Shown to the brain: what config it takes, with an example. */
  doc: string;
  validate(config: any): C | string;
  minutes(config: C): { min: number; default: number };
  describe(config: C): string;
  /** Recent items, newest first. */
  items(config: C, ctx: SourceCtx): Promise<Item[]>;
}

export const SOURCES: Source<any>[] = [gmail, calendar, drive, linkedin, x, instagram, site];

/** Sources the hub adds at start (WhatsApp, Slack: they read through objects the hub owns). Replaces one with the same id. */
export function registerSource(s: Source<any>) {
  const i = SOURCES.findIndex((x) => x.id === s.id);
  if (i >= 0) SOURCES[i] = s; else SOURCES.splice(SOURCES.length - 1, 0, s);
}

/** The connection a source needs for this config (a preset id, a domain, or "google"). */
export function needOf(src: Source<any>, config: any): string {
  return typeof src.needs === "function" ? src.needs(config) : src.needs;
}

export const sourceById = (id: string) => SOURCES.find((s) => s.id === id) || null;

/** Items as the brain sees them: untrusted, capped. With `page` (a source that pages), that page of `max` rows. */
export function formatItems(items: Item[], max = 10, page?: number) {
  const p = page && page > 1 ? page : 1;
  const shown = items.slice((p - 1) * max, p * max);
  if (!shown.length) return p > 1 ? `(nothing on page ${p}: the list ends after ${items.length} rows)` : "(nothing)";
  const more = items.length > p * max;
  return shown.map((i) => `### ${i.title}${i.at ? ` (${i.at})` : ""}${i.url ? `\n${i.url}` : ""}\n${i.text.slice(0, 1500)}`).join("\n\n")
    + (page === undefined ? (more ? `\n\n…and ${items.length - max} more` : "")
      : `\n\n(page ${p}, rows ${(p - 1) * max + 1}–${(p - 1) * max + shown.length}${more ? `; more on page ${p + 1}: read again with "page": ${p + 1}` : "; that's the end of the list"})`);
}
