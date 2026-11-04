import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Cookie } from "../browser.ts";

// The logins enkidu-browser's Chrome opens with. Every Chrome it starts loads ~/.enkidu/chrome-logins.json (Chrome
// DevTools cookie params), so a site in there opens signed in. Hearth already holds your logins (Connectors: copied from
// Chrome on your Mac or pasted), so before a brain call that can browse it writes them there: the brain's browser is
// signed in to whatever you connected, with no `enkidu` CLI or app involved.
// Only the browser daemon reads the file. The brain never sees a cookie: the jail hides the file (see Brain.jail), and
// outside the jail Claude's Bash may only run the skills' own commands.

export const loginsFile = (home = homedir()) => join(home, ".enkidu", "chrome-logins.json");

type Entry = { name: string; value: string; url?: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean; sameSite?: string; expires?: number };

const bare = (d: string) => d.replace(/^\./, "").toLowerCase();
/** The site an entry in the file belongs to, from its domain or its url. */
function hostOf(e: Entry): string {
  if (e.domain) return bare(e.domain);
  try { return e.url ? new URL(e.url).hostname.toLowerCase() : ""; } catch { return ""; }
}
const under = (host: string, site: string) => host === site || host.endsWith(`.${site}`);

function toEntry(c: Cookie): Entry {
  const path = c.path || "/";
  return { name: c.name, value: c.value, url: `https://${bare(c.domain)}${path}`, domain: c.domain, path, secure: c.secure ?? true, httpOnly: !!c.httpOnly,
    ...(typeof c.expires === "number" && c.expires > 0 ? { expires: c.expires } : {}) };
}

/**
 * Puts these sites' cookies in the file, in place of what it had for them, and drops the sites Hearth wrote last time
 * that are gone now (you disconnected them). Other entries (logins you copied with `enkidu browser logins`) stay.
 * `managed` is where the list of sites Hearth wrote is kept. Writes only on a change; always leaves the file there,
 * so the jail can hide it. Returns whether it changed.
 */
export function syncBrowserLogins(sites: Record<string, Cookie[]>, managed: string, file = loginsFile()): boolean {
  const read = <T>(f: string, fallback: T): T => { try { return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : fallback; } catch { return fallback; } };
  const now = Object.fromEntries(Object.entries(sites).filter(([, c]) => c.length).map(([d, c]) => [bare(d), c]));
  const before = read<string[]>(managed, []);
  const mine = [...new Set([...(Array.isArray(before) ? before : []), ...Object.keys(now)])];
  const had = read<Entry[]>(file, []);
  const list = Array.isArray(had) ? had : [];
  const kept = list.filter((e) => !mine.some((s) => under(hostOf(e), s)));
  const next = [...kept, ...Object.values(now).flat().map(toEntry)];
  const text = JSON.stringify(next);
  const changed = !existsSync(file) || text !== JSON.stringify(list);
  if (changed) {
    const tmp = `${file}.hearth-tmp`;
    writeFileSync(tmp, text, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  }
  const sitesNow = Object.keys(now).sort();
  if (JSON.stringify(sitesNow) !== JSON.stringify(before)) writeFileSync(managed, JSON.stringify(sitesNow), { mode: 0o600 });
  return changed;
}
