import { parseCookies, type Cookie } from "./browser.ts";
import { browserProfiles, profileHasSite, readSiteCookies, canReadBrowser, type BrowserProfile } from "./chrome.ts";
import type { Google } from "./google.ts";
import type { Vault } from "./vault.ts";

// Every account a teammate can read, in one place. Google signs in with OAuth (google.ts); LinkedIn and X use the
// cookies from your own logged-in browser, pasted once. All of it lives in the encrypted vault (vault.ts) next to the
// hub's other keys, and none of it reaches the model, the app or an export.

export type ConnectionId = "google" | "linkedin" | "x";

/** Sites read with your cookies: which cookies must be there for the session to work. */
export const COOKIE_SITES = {
  linkedin: { label: "LinkedIn", domain: ".linkedin.com", required: ["li_at"], home: "https://www.linkedin.com" },
  x: { label: "X", domain: ".x.com", required: ["auth_token", "ct0"], home: "https://x.com" },
} as const;
export type CookieSite = keyof typeof COOKIE_SITES;
export const isCookieSite = (id: unknown): id is CookieSite => typeof id === "string" && Object.hasOwn(COOKIE_SITES, id);

type Saved = { cookies: Cookie[]; savedAt: string };

export class Connections {
  /** The last problem reading each one ("signed out"), shown in Connectors until a read works again. */
  private problems = new Map<ConnectionId, string>();

  constructor(private vault: Vault | null, private google: Google) {}

  private saved(site: CookieSite): Saved | null {
    try { const v = this.vault?.get(`cookies:${site}`); return v ? JSON.parse(v) : null; } catch { return null; }
  }

  connected(id: ConnectionId) { return id === "google" ? this.google.connected : !!this.saved(id)?.cookies.length; }

  cookies(site: CookieSite): Cookie[] { return this.saved(site)?.cookies ?? []; }

  /** A Cookie header ("li_at=…; JSESSIONID=…") or a cookie extension's JSON export. Keeps only this site's cookies. */
  saveCookies(site: CookieSite, raw: string) {
    if (!this.vault) return { error: "This hub has no key vault." };
    const s = COOKIE_SITES[site];
    const bare = s.domain.replace(/^\./, "");
    const cookies = parseCookies(raw, s.domain).filter((c) => c.domain.replace(/^\./, "").endsWith(bare) || bare.endsWith(c.domain.replace(/^\./, "")));
    const missing = s.required.filter((n) => !cookies.some((c) => c.name === n && c.value));
    if (missing.length) return { error: `Those cookies are missing ${missing.join(" and ")}. Copy them while you're logged in to ${s.label}.` };
    this.vault.set(`cookies:${site}`, JSON.stringify({ cookies, savedAt: new Date().toISOString() } satisfies Saved));
    this.problems.delete(site);
    return { value: this.status() };
  }

  /** Profiles on this Mac logged into a site, so the user can import its cookies in one tap instead of pasting. */
  browserOptions(site: CookieSite): { id: string; label: string }[] {
    if (!canReadBrowser()) return [];
    const s = COOKIE_SITES[site];
    return browserProfiles().filter((p) => profileHasSite(p.cookiesDb, s.domain.replace(/^\./, ""), [...s.required]))
      .map((p) => ({ id: `${p.browser}/${p.profile}`, label: p.label }));
  }

  /** Import a site's cookies straight from a local browser profile (no pasting). Returns the same as saveCookies. */
  importFromBrowser(site: CookieSite, profileId: string) {
    if (!this.vault) return { error: "This hub has no key vault." };
    const prof = browserProfiles().find((p) => `${p.browser}/${p.profile}` === profileId);
    if (!prof) return { error: "That browser profile isn't here anymore." };
    const s = COOKIE_SITES[site];
    let cookies: Cookie[];
    try { cookies = readSiteCookies(prof, s.domain.replace(/^\./, "")); }
    catch { return { error: `Couldn't read ${prof.label}'s cookies.` }; }
    if (!cookies.length) return { error: `No ${s.label} cookies in ${prof.label}${canReadBrowser() ? ". If macOS asked and you clicked Deny, try again and Allow." : ""}.` };
    const missing = s.required.filter((n) => !cookies.some((c) => c.name === n && c.value));
    if (missing.length) return { error: `${prof.label} is missing ${missing.join(" and ")} for ${s.label}. Open ${s.label} in it and sign in.` };
    this.vault.set(`cookies:${site}`, JSON.stringify({ cookies, savedAt: new Date().toISOString() } satisfies Saved));
    this.problems.delete(site);
    return { value: this.status() };
  }

  remove(site: CookieSite) { this.vault?.delete(`cookies:${site}`); this.problems.delete(site); return this.status(); }

  problem(id: ConnectionId, message: string | null) { if (message) this.problems.set(id, message); else this.problems.delete(id); }

  /** What the app may see: whether each is connected and since when; never a cookie or token. */
  status() {
    const g = this.google.status();
    return [
      { id: "google" as const, connected: g.connected, detail: g.email, problem: this.problems.get("google") ?? null },
      ...(Object.keys(COOKIE_SITES) as CookieSite[]).map((id) => {
        const s = this.saved(id);
        return { id, connected: !!s?.cookies.length, detail: s ? `cookies saved ${s.savedAt.slice(0, 10)}` : null, problem: this.problems.get(id) ?? null };
      }),
    ];
  }
}
