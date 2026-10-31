// Who can touch what in a shared folder. Used by the hub when it copies a folder in and when changes come back,
// and by the box when the teammate reads or writes. Pure functions: no file system, no network.

export type Access = "edit" | "read" | "hidden";
export type PathRules = { edit?: string[]; read?: string[]; hidden?: string[] };

/** Never copied into a box and never written back, whatever the rules say. */
export const ALWAYS_HIDDEN = [
  ".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa*", "id_ed25519*", "id_ecdsa*", ".npmrc", ".netrc",
  ".git", "node_modules", ".DS_Store", ".hearth-share", "*.sqlite", "*.db",
];

/** A relative path we're willing to use: no absolute paths, no "..", no backslashes or control characters. */
export function safePath(p: unknown): string | null {
  if (typeof p !== "string" || !p || p.length > 400) return null;
  if (/[\x00-\x1f\\]/.test(p) || p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return null;
  const parts = p.split("/").filter((s) => s && s !== ".");
  if (!parts.length || parts.some((s) => s === "..")) return null;
  return parts.join("/");
}

const cache = new Map<string, RegExp>();
/**
 * gitignore-style patterns: `*` and `?` stay inside one folder, `**` crosses folders, a pattern without a slash
 * matches a name at any depth, a leading `/` anchors it, and a folder pattern covers everything under it.
 */
export function globRegex(pattern: string): RegExp {
  const hit = cache.get(pattern);
  if (hit) return hit;
  let p = pattern.trim().replace(/\/+$/, "");
  const anchored = p.startsWith("/") || p.slice(0, -1).includes("/");
  p = p.replace(/^\/+/, "");
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*") {
      const slash = p[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const out = new RegExp(`${anchored ? "^" : "^(?:.*/)?"}${re}(?:/.*)?$`);
  cache.set(pattern, out);
  return out;
}

export const matches = (pattern: string, path: string) => globRegex(pattern).test(path);

/** How specific a pattern is: its literal characters. `src/core/**` beats `src/**` beats `**`. */
const specificity = (p: string) => p.replace(/\*|\?/g, "").length;
const RANK: Record<Access, number> = { hidden: 3, read: 2, edit: 1 }; // ties go to the safer rule

/** What a path may do under these rules. Anything not listed is hidden. */
export function accessFor(rules: PathRules, path: string): Access {
  const safe = safePath(path);
  if (!safe || ALWAYS_HIDDEN.some((p) => matches(p, safe))) return "hidden";
  let best: { access: Access; score: number } | null = null;
  for (const access of ["edit", "read", "hidden"] as Access[]) {
    for (const p of rules[access] || []) {
      if (typeof p !== "string" || !matches(p, safe)) continue;
      const score = specificity(p);
      if (!best || score > best.score || (score === best.score && RANK[access] > RANK[best.access])) best = { access, score };
    }
  }
  return best?.access ?? "hidden";
}

export function cleanRules(r: any): PathRules {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim() && x.length <= 200).slice(0, 100).map((x) => x.trim()) : []);
  return { edit: list(r?.edit), read: list(r?.read), hidden: list(r?.hidden) };
}

/** Lines from a .gitignore, as patterns we understand (negations are skipped, so they stay ignored: the safe side). */
export function gitignorePatterns(text: string) {
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#") && !l.startsWith("!"));
}

const SECRET_RES: [string, RegExp][] = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Anthropic key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["OpenAI key", /\bsk-(?:proj-)?[A-Za-z0-9]{32,}/],
  ["AWS key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{20,}/],
  ["Slack token", /\bxox[abpors]-[A-Za-z0-9-]{10,}/],
  ["Stripe key", /\b[rs]k_live_[A-Za-z0-9]{16,}/],
  ["password", /\b(?:password|passwd|secret|api[_-]?key|token)\b\s*[:=]\s*["']?[^\s"'`]{8,}/i],
];

/** The first thing in this text that looks like a password or key, if any. */
export function findSecret(text: string): string | null {
  for (const [name, re] of SECRET_RES) if (re.test(text)) return name;
  return null;
}
