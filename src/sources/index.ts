import type { Google } from "../google.ts";
import type { Cookie, readPage } from "../browser.ts";
import type { ConnectionId, CookieSite } from "../connections.ts";
import { gmail } from "./gmail.ts";
import { calendar } from "./calendar.ts";
import { linkedin } from "./linkedin.ts";
import { x } from "./x.ts";

// Trigger modules: one file per source of "something new" (Gmail, Calendar…). A module only says how to fetch
// recent items and give each a stable id. The hub does the rest: the timer, the first look (which only remembers
// what's there, so you aren't flooded), working out what's new, quiet hours, and handing it to a teammate.
// Same shape as Activepieces' polling triggers. To add a source, write one file and list it below.

export type Item = {
  /** Stable and unique: the hub remembers ids it has seen. */
  id: string;
  title: string;
  text: string;
  at?: string;
  url?: string;
};

export type SourceCtx = { google: Google; cookies: (site: CookieSite) => Cookie[]; readPage: typeof readPage; now: Date; tz: string };

export interface Source<C = Record<string, unknown>> {
  id: string;
  label: string;
  /** The connection it reads through; the hub won't poll until it's connected. */
  needs: ConnectionId;
  /** Shown to the brain: what config it takes, with an example. */
  doc: string;
  validate(config: any): C | string;
  minutes(config: C): { min: number; default: number };
  describe(config: C): string;
  /** Recent items, newest first. */
  items(config: C, ctx: SourceCtx): Promise<Item[]>;
}

export const SOURCES: Source<any>[] = [gmail, calendar, linkedin, x];

export const sourceById = (id: string) => SOURCES.find((s) => s.id === id) || null;

/** Items as the brain sees them: untrusted, capped. */
export function formatItems(items: Item[], max = 10) {
  if (!items.length) return "(nothing)";
  return items.slice(0, max).map((i) => `### ${i.title}${i.at ? ` (${i.at})` : ""}${i.url ? `\n${i.url}` : ""}\n${i.text.slice(0, 1500)}`).join("\n\n")
    + (items.length > max ? `\n\n…and ${items.length - max} more` : "");
}
