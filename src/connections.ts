import { parseCookies, type Cookie } from "./browser.ts";
import { PRESETS, cleanDomain, isValidDomain, labelFor, requiredFor, presetFor } from "./cookie-sites.ts";
import { sha256 } from "./auth.ts";
import { browserProfiles, profileHasSite, readSiteCookies, canReadBrowser } from "./chrome.ts";
import type { Google } from "./google.ts";
import type { Vault } from "./vault.ts";

// Every account a teammate can read, in one place. Google signs in with OAuth (google.ts); any site you're logged
// into in Chrome is read with its cookies — a few (LinkedIn, X…) are presets, any other domain works too. All of it
// lives in the encrypted vault (vault.ts) next to the hub's other keys, and none reaches the model, the app or an export.

export { COOKIE_SITES, isCookieSite, type CookieSite } from "./cookie-sites.ts";

type Saved = { cookies: Cookie[]; savedAt: string; source?: "paste" | "browser" | "mac"; hash?: string; expiresAt?: number };

/** Earliest real (non-session) expiry among the cookies, in unix seconds, or undefined if all are session cookies. */
function earliestExpiry(cookies: Cookie[], required: string[]): number | undefined {
  const watch = required.length ? cookies.filter((c) => required.includes(c.name)) : cookies;
  const exps = watch.map((c) => c.expires).filter((e): e is number => typeof e === "number" && e > 0);
  return exps.length ? Math.min(...exps) : undefined;
}

export class Connections {
  /** The last problem reading each one ("signed out"), shown in Connectors until a read works again. */
  private problems = new Map<string, string>();

  constructor(private vault: Vault | null, private google: Google) {}

  /** Normalise any id to the storage key: a preset id or a domain -> its clean domain. */
  private key(idOrDomain: string): string | null {
    const p = PRESETS[idOrDomain];
    return p ? p.domain : cleanDomain(idOrDomain);
  }

  private saved(domain: string): Saved | null {
    try { const v = this.vault?.get(`cookies:${domain}`); return v ? JSON.parse(v) : null; } catch { return null; }
  }

  connected(id: string) { return id === "google" ? this.google.connected : !!this.saved(this.key(id) || id)?.cookies.length; }
  cookies(id: string): Cookie[] { const d = this.key(id); return (d && this.saved(d)?.cookies) || []; }

  private store(domain: string, cookies: Cookie[], source: Saved["source"], hash?: string) {
    this.vault!.set(`cookies:${domain}`, JSON.stringify({ cookies, savedAt: new Date().toISOString(), source, hash, expiresAt: earliestExpiry(cookies, requiredFor(domain)) } satisfies Saved));
    this.problems.delete(domain);
  }

  // ---- copying from a linked Mac (the hub runs on a server with no browser) ----

  /** Domains the user chose to keep fed from their Mac: the hub asks the Mac for these and re-asks when one dies. */
  macSites(): string[] {
    try { const m = JSON.parse(this.vault?.get("cookies:from-mac") || "[]"); return Array.isArray(m) ? m.filter(isValidDomain) : []; } catch { return []; }
  }
  private setMacSites(sites: string[]) { this.vault?.set("cookies:from-mac", JSON.stringify([...new Set(sites)])); }

  /** The hash of the cookies the hub already holds for a domain, so a Mac only re-copies on change. */
  cookieHave(domain: string): string | undefined { return isValidDomain(domain) ? this.saved(domain)?.hash : undefined; }

  /** Turn on "keep this fed from my Mac". The hub then asks any linked Mac to copy it up. */
  wantFromMac(id: string) {
    if (!this.vault) return { error: "This hub has no key vault." };
    const domain = this.key(id);
    if (!domain) return { error: "That isn't a valid site." };
    this.setMacSites([...this.macSites(), domain]);
    return { value: this.status() };
  }

  /** Cookies a linked Mac copied up (already decrypted there). Keeps only this domain's; checks the key cookies are present. */
  receiveFromMac(domain: string, data: string) {
    if (!this.vault || !isValidDomain(domain)) return;
    let cookies: Cookie[];
    try { const j = JSON.parse(data); cookies = Array.isArray(j.cookies) ? j.cookies : []; } catch { return; }
    cookies = cookies.filter((c) => c && typeof c.name === "string" && typeof c.value === "string" && String(c.domain || "").replace(/^\./, "").endsWith(domain));
    const required = requiredFor(domain);
    if (required.length ? !required.every((n) => cookies.some((c) => c.name === n && c.value)) : !cookies.length) return;
    this.store(domain, cookies, "mac", sha256(data));
  }

  /** A Cookie header or a cookie-extension JSON export. Keeps only this domain's cookies. */
  saveCookies(id: string, raw: string) {
    if (!this.vault) return { error: "This hub has no key vault." };
    const domain = this.key(id);
    if (!domain) return { error: "That isn't a valid site. Use a domain like example.com." };
    const cookies = parseCookies(raw, `.${domain}`).filter((c) => { const cd = c.domain.replace(/^\./, ""); return cd.endsWith(domain) || domain.endsWith(cd); });
    const required = requiredFor(domain);
    const missing = required.filter((n) => !cookies.some((c) => c.name === n && c.value));
    if (missing.length) return { error: `Those cookies are missing ${missing.join(" and ")}. Copy them while you're logged in to ${labelFor(domain)}.` };
    if (!cookies.length) return { error: `No ${domain} cookies in what you pasted.` };
    this.store(domain, cookies, "paste");
    return { value: this.status() };
  }

  /** Local browser profiles logged into a site, to import in one tap instead of pasting. */
  browserOptions(id: string): { id: string; label: string }[] {
    const domain = this.key(id);
    if (!canReadBrowser() || !domain) return [];
    const required = requiredFor(domain);
    return browserProfiles().filter((p) => required.length ? profileHasSite(p.cookiesDb, domain, required) : profileHasSite(p.cookiesDb, domain, []))
      .map((p) => ({ id: `${p.browser}/${p.profile}`, label: p.label }));
  }

  importFromBrowser(id: string, profileId: string) {
    if (!this.vault) return { error: "This hub has no key vault." };
    const domain = this.key(id);
    if (!domain) return { error: "That isn't a valid site." };
    const prof = browserProfiles().find((p) => `${p.browser}/${p.profile}` === profileId);
    if (!prof) return { error: "That browser profile isn't here anymore." };
    let cookies: Cookie[];
    try { cookies = readSiteCookies(prof, domain); }
    catch { return { error: `Couldn't read ${prof.label}'s cookies.` }; }
    if (!cookies.length) return { error: `No ${labelFor(domain)} cookies in ${prof.label}${canReadBrowser() ? ". If macOS asked and you clicked Deny, try again and Allow." : ""}.` };
    const missing = requiredFor(domain).filter((n) => !cookies.some((c) => c.name === n && c.value));
    if (missing.length) return { error: `${prof.label} is missing ${missing.join(" and ")} for ${labelFor(domain)}. Open ${labelFor(domain)} in it and sign in.` };
    this.store(domain, cookies, "browser");
    return { value: this.status() };
  }

  remove(id: string) {
    const domain = this.key(id) || id;
    this.setMacSites(this.macSites().filter((s) => s !== domain));
    this.vault?.delete(`cookies:${domain}`);
    this.problems.delete(domain);
    return this.status();
  }

  problem(id: string, message: string | null) { const d = this.key(id) || id; if (message) this.problems.set(d, message); else this.problems.delete(d); }
  /** The current problem for a connection (sign-out message), by preset id or domain. */
  problemFor(id: string): string | null { return this.problems.get(this.key(id) || id) ?? null; }

  /** Days until the stored login lapses by its own expiry (not sign-out), or null if session-only / not set. */
  private expiresInDays(s: Saved | null): number | null {
    if (!s?.expiresAt) return null;
    return Math.round((s.expiresAt * 1000 - Date.now()) / 86_400_000);
  }

  /** Domains that have a stored login but aren't a preset, so the UI can list them too. */
  private extraDomains(): string[] {
    const preset = new Set(Object.values(PRESETS).map((p) => p.domain));
    const names = this.vault?.names() ?? [];
    return names.filter((n) => n.startsWith("cookies:") && n !== "cookies:from-mac").map((n) => n.slice(8))
      .filter((d) => !preset.has(d) && isValidDomain(d));
  }

  private row(id: string, domain: string, label: string) {
    const s = this.saved(domain);
    const fromMac = this.macSites().includes(domain);
    const how = s?.source === "mac" ? "from your Mac" : s?.source === "browser" ? "from your browser" : s ? "pasted" : null;
    const days = this.expiresInDays(s);
    return {
      id, domain, label,
      connected: !!s?.cookies.length,
      detail: s ? `${how}, saved ${s.savedAt.slice(0, 10)}` : (fromMac ? "waiting for your Mac" : null),
      fromMac, expiresInDays: days, problem: this.problems.get(domain) ?? null,
    };
  }

  /** What the app may see: whether each is connected and since when; never a cookie or token. */
  status() {
    const g = this.google.status();
    return [
      { id: "google", domain: "google", label: "Google", connected: g.connected, detail: g.email, fromMac: false, expiresInDays: null, problem: this.problems.get("google") ?? null },
      ...Object.entries(PRESETS).map(([id, p]) => this.row(id, p.domain, p.label)),
      ...this.extraDomains().map((d) => this.row(d, d, d)),
    ];
  }
}
