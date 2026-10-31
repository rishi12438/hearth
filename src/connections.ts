import { parseCookies, type Cookie } from "./browser.ts";
import { COOKIE_SITES, COOKIE_SITE_IDS, isCookieSite, type CookieSite } from "./cookie-sites.ts";
import { sha256 } from "./auth.ts";
import { browserProfiles, profileHasSite, readSiteCookies, canReadBrowser, type BrowserProfile } from "./chrome.ts";
import type { Google } from "./google.ts";
import type { Vault } from "./vault.ts";

// Every account a teammate can read, in one place. Google signs in with OAuth (google.ts); LinkedIn and X use the
// cookies from your own logged-in browser, pasted once. All of it lives in the encrypted vault (vault.ts) next to the
// hub's other keys, and none of it reaches the model, the app or an export.

export type ConnectionId = "google" | "linkedin" | "x";

export { COOKIE_SITES, isCookieSite, type CookieSite } from "./cookie-sites.ts";

type Saved = { cookies: Cookie[]; savedAt: string; source?: "paste" | "browser" | "mac"; hash?: string };

export class Connections {
  /** The last problem reading each one ("signed out"), shown in Connectors until a read works again. */
  private problems = new Map<ConnectionId, string>();

  constructor(private vault: Vault | null, private google: Google) {}

  private saved(site: CookieSite): Saved | null {
    try { const v = this.vault?.get(`cookies:${site}`); return v ? JSON.parse(v) : null; } catch { return null; }
  }

  connected(id: ConnectionId) { return id === "google" ? this.google.connected : !!this.saved(id)?.cookies.length; }

  private store(site: CookieSite, cookies: Cookie[], source: Saved["source"], hash?: string) {
    this.vault!.set(`cookies:${site}`, JSON.stringify({ cookies, savedAt: new Date().toISOString(), source, hash } satisfies Saved));
    this.problems.delete(site);
  }

  // ---- copying from a linked Mac (the hub runs on a server with no browser) ----

  /** Sites the user chose to keep fed from their Mac: the hub asks the Mac for these and re-asks when one dies. */
  macSites(): string[] {
    try { const m = JSON.parse(this.vault?.get("cookies:from-mac") || "[]"); return Array.isArray(m) ? m.filter((x) => COOKIE_SITE_IDS.includes(x)) : []; } catch { return []; }
  }
  private setMacSites(sites: string[]) { this.vault?.set("cookies:from-mac", JSON.stringify([...new Set(sites)])); }

  /** The hash of the cookies the hub already holds for a site, so a Mac only re-copies on change. */
  cookieHave(site: string): string | undefined { return isCookieSite(site) ? this.saved(site)?.hash : undefined; }

  /** Turn on "keep this fed from my Mac". The hub then asks any linked Mac to copy it up. */
  wantFromMac(site: CookieSite) {
    if (!this.vault) return { error: "This hub has no key vault." };
    this.setMacSites([...this.macSites(), site]);
    return { value: this.status() };
  }

  /** Cookies a linked Mac copied up (already decrypted there). Keeps only this site's, checks the key cookies are present. */
  receiveFromMac(site: string, data: string) {
    if (!this.vault || !isCookieSite(site)) return;
    let cookies: Cookie[];
    try { const j = JSON.parse(data); cookies = Array.isArray(j.cookies) ? j.cookies : []; } catch { return; }
    const s = COOKIE_SITES[site];
    const bare = s.domain.replace(/^\./, "");
    cookies = cookies.filter((c) => c && typeof c.name === "string" && typeof c.value === "string" && String(c.domain || "").replace(/^\./, "").endsWith(bare));
    if (!s.required.every((n) => cookies.some((c) => c.name === n && c.value))) return;
    this.store(site, cookies, "mac", sha256(data));
  }

  cookies(site: CookieSite): Cookie[] { return this.saved(site)?.cookies ?? []; }

  /** A Cookie header ("li_at=…; JSESSIONID=…") or a cookie extension's JSON export. Keeps only this site's cookies. */
  saveCookies(site: CookieSite, raw: string) {
    if (!this.vault) return { error: "This hub has no key vault." };
    const s = COOKIE_SITES[site];
    const bare = s.domain.replace(/^\./, "");
    const cookies = parseCookies(raw, s.domain).filter((c) => c.domain.replace(/^\./, "").endsWith(bare) || bare.endsWith(c.domain.replace(/^\./, "")));
    const missing = s.required.filter((n) => !cookies.some((c) => c.name === n && c.value));
    if (missing.length) return { error: `Those cookies are missing ${missing.join(" and ")}. Copy them while you're logged in to ${s.label}.` };
    this.store(site, cookies, "paste");
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
    this.store(site, cookies, "browser");
    return { value: this.status() };
  }

  remove(site: CookieSite) { this.setMacSites(this.macSites().filter((s) => s !== site)); this.vault?.delete(`cookies:${site}`); this.problems.delete(site); return this.status(); }

  problem(id: ConnectionId, message: string | null) { if (message) this.problems.set(id, message); else this.problems.delete(id); }

  /** What the app may see: whether each is connected and since when; never a cookie or token. */
  status() {
    const g = this.google.status();
    return [
      { id: "google" as const, connected: g.connected, detail: g.email, problem: this.problems.get("google") ?? null },
      ...(Object.keys(COOKIE_SITES) as CookieSite[]).map((id) => {
        const s = this.saved(id);
        const fromMac = this.macSites().includes(id);
        const how = s?.source === "mac" ? "from your Mac" : s?.source === "browser" ? "from your browser" : s ? "pasted" : null;
        return { id, connected: !!s?.cookies.length, detail: s ? `${how}, saved ${s.savedAt.slice(0, 10)}` : (fromMac ? "waiting for your Mac" : null), fromMac, problem: this.problems.get(id) ?? null };
      }),
    ];
  }
}
