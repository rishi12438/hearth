// The sites read with your cookies, and which cookies must be present. Kept in its own tiny module so both the hub
// (connections.ts) and the Mac link (computer.ts) can share it without pulling in the vault or Google.

export const COOKIE_SITES = {
  linkedin: { label: "LinkedIn", domain: ".linkedin.com", required: ["li_at"], home: "https://www.linkedin.com" },
  x: { label: "X", domain: ".x.com", required: ["auth_token", "ct0"], home: "https://x.com" },
} as const;

export type CookieSite = keyof typeof COOKIE_SITES;
export const isCookieSite = (id: unknown): id is CookieSite => typeof id === "string" && Object.hasOwn(COOKIE_SITES, id);
export const COOKIE_SITE_IDS = Object.keys(COOKIE_SITES) as CookieSite[];
