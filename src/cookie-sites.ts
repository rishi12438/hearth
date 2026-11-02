// Sites read with your cookies. Any domain you're logged into in Chrome works; a few well-known ones have presets
// (a nicer label, the cookies that prove you're signed in, and selectors for a per-item read). Shared by the hub
// (connections.ts) and the Mac link (computer.ts) so neither pulls in the other's deps.

export type Preset = { label: string; domain: string; required: string[]; home: string };

export const PRESETS: Record<string, Preset> = {
  linkedin: { label: "LinkedIn", domain: "linkedin.com", required: ["li_at"], home: "https://www.linkedin.com" },
  x: { label: "X", domain: "x.com", required: ["auth_token", "ct0"], home: "https://x.com" },
  instagram: { label: "Instagram", domain: "instagram.com", required: ["sessionid"], home: "https://www.instagram.com" },
  reddit: { label: "Reddit", domain: "reddit.com", required: ["reddit_session"], home: "https://www.reddit.com" },
  github: { label: "GitHub", domain: "github.com", required: ["user_session"], home: "https://github.com" },
  youtube: { label: "YouTube", domain: "youtube.com", required: ["SID"], home: "https://www.youtube.com" },
  amazon: { label: "Amazon", domain: "amazon.com", required: ["at-main"], home: "https://www.amazon.com" },
};

// Back-compat alias (older imports). LinkedIn and X keep dedicated modules; the rest read through the generic site reader.
export const COOKIE_SITES = PRESETS;
export type CookieSite = string;

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/** A clean registrable-ish domain ("www.linkedin.com" -> "linkedin.com", a full URL -> its host). */
export function cleanDomain(input: string): string | null {
  let d = String(input || "").trim().toLowerCase();
  if (!d) return null;
  if (d.includes("/") || d.includes(":")) { try { d = new URL(d.includes("://") ? d : `https://${d}`).hostname; } catch { return null; } }
  d = d.replace(/^www\./, "");
  return DOMAIN_RE.test(d) && d.length <= 100 ? d : null;
}

export const isValidDomain = (d: unknown): d is string => typeof d === "string" && cleanDomain(d) === d;
/** A preset keyed by id (linkedin) or domain (linkedin.com). */
export const presetFor = (idOrDomain: string): Preset | null =>
  PRESETS[idOrDomain] || Object.values(PRESETS).find((p) => p.domain === cleanDomain(idOrDomain)) || null;
export const labelFor = (domain: string) => Object.values(PRESETS).find((p) => p.domain === domain)?.label || domain;
export const requiredFor = (domain: string) => Object.values(PRESETS).find((p) => p.domain === domain)?.required || [];

// Old enum-style predicate some callers still use: now "is this a usable site key?"
export const isCookieSite = (id: unknown): id is string => typeof id === "string" && (!!PRESETS[id] || isValidDomain(id));
export const COOKIE_SITE_IDS = Object.keys(PRESETS);
