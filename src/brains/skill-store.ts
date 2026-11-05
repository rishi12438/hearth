import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { frontMatter, NAME_RE } from "./skills.ts";

// Skills from outside: the public catalog (skills.sh, which indexes skill folders on GitHub) or any GitHub folder with a
// SKILL.md. Search it, read one, install it into <data>/skills/<name>/ (the same place as your own), where every brain
// picks it up on its next run, with all its files (scripts/, reference .md…) beside the SKILL.md.
// The hub never installs what an agent asked for by itself: that's an Approve card (hub.requestSkillInstall). The card is
// pinned to the commit and to a hash of every file it showed, so Approve installs exactly that, nothing newer.
// From the Skills page you install straight away (you're the one asking).
// A skill's folder keeps where it came from in .hearth-source.json, so it can be updated and shown with its source.

type Result<T> = { value: T; error?: undefined } | { error: string; value?: undefined };
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Where a skill lives on GitHub. skill: its folder's name (owner/repo@skill); path: the folder itself; ref: branch/tag/commit. */
export type SkillRef = { repo: string; skill?: string; path?: string; ref?: string };

/** One public skill, from a search. id is what `install` takes. */
export type RemoteSkill = { id: string; name: string; repo: string; skill: string; installs: number; url: string };

/** A skill folder fetched at one commit: what an Approve card shows and what install writes. */
export type Bundle = {
  name: string; description: string;
  repo: string; path: string; sha: string;
  /** The folder on GitHub at that commit, for the user to read. */
  url: string;
  files: { path: string; bytes: Uint8Array }[];
  /** sha256 over every file's path and bytes: Approve installs only this. */
  hash: string;
};

/** What .hearth-source.json says. */
export type Source = { repo: string; path: string; sha: string; url: string; hash: string; installedAt: string; by: string };

/** A skill in <data>/skills, installed or written by you. */
export type InstalledSkill = { name: string; description: string; files: number; source: Source | null };

const MAX_FILES = 200, MAX_FILE = 2_000_000, MAX_TOTAL = 10_000_000;
const SOURCE_FILE = ".hearth-source.json";
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/**
 * Reads what you'd paste or what search gave: owner/repo@skill, owner/repo/skill (a skills.sh id), owner/repo,
 * https://skills.sh/owner/repo/skill, https://github.com/owner/repo[/tree/<ref>/<path>].
 */
export function parseRef(input: string): Result<SkillRef> {
  let s = String(input || "").trim();
  if (!s) return { error: "Which skill? Give an id from find (owner/repo/skill) or a GitHub link." };
  if (/^https?:\/\//i.test(s)) {
    let u: URL;
    try { u = new URL(s); } catch { return { error: "That isn't a web address." }; }
    const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (u.hostname === "skills.sh" || u.hostname === "www.skills.sh") {
      if (parts.length < 2) return { error: "That skills.sh link doesn't point at a skill." };
      s = parts.slice(0, 3).join("/");
    } else if (u.hostname === "github.com" || u.hostname === "www.github.com") {
      if (parts.length < 2) return { error: "That GitHub link doesn't point at a repository." };
      const repo = `${parts[0]}/${parts[1].replace(/\.git$/, "")}`;
      if (!REPO_RE.test(repo)) return { error: "That isn't a GitHub repository." };
      if ((parts[2] === "tree" || parts[2] === "blob") && parts[3]) {
        let path = parts.slice(4).join("/");
        if (/(^|\/)SKILL\.md$/.test(path)) path = posix.dirname(path) === "." ? "" : posix.dirname(path);
        return { value: { repo, ref: parts[3], path } };
      }
      return { value: { repo } };
    } else return { error: "Skills install from GitHub or skills.sh links." };
  }
  const at = s.match(/^([^@\s]+)@([^@\s]+)$/);
  if (at) return REPO_RE.test(at[1]) && NAME_RE.test(at[2].toLowerCase()) ? { value: { repo: at[1], skill: at[2] } } : { error: `Can't read "${s}". Try owner/repo@skill.` };
  const parts = s.split("/").filter(Boolean);
  if (parts.length === 2 && REPO_RE.test(s)) return { value: { repo: s } };
  if (parts.length === 3 && REPO_RE.test(`${parts[0]}/${parts[1]}`)) return { value: { repo: `${parts[0]}/${parts[1]}`, skill: parts[2] } };
  return { error: `Can't read "${s}". Give an id from find (owner/repo/skill), owner/repo@skill, or a GitHub link.` };
}

/** The public catalog, best matches first. */
export async function searchRemote(query: string, f: Fetch = fetch): Promise<RemoteSkill[]> {
  const q = query.trim().slice(0, 100);
  if (!q) return [];
  const r = await f(`https://skills.sh/api/search?q=${encodeURIComponent(q)}`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`skills.sh answered ${r.status}`);
  const j: any = await r.json();
  const list = Array.isArray(j?.skills) ? j.skills : [];
  return list.filter((x: any) => typeof x?.source === "string" && typeof x?.skillId === "string" && REPO_RE.test(x.source))
    .map((x: any) => ({ id: `${x.source}/${x.skillId}`, name: String(x.name || x.skillId), repo: x.source, skill: x.skillId, installs: Number(x.installs) || 0, url: `https://skills.sh/${x.source}/${x.skillId}` }))
    .slice(0, 20);
}

function gh(f: Fetch, token?: string) {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "hearth-skills" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return async (path: string) => {
    const r = await f(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(20_000) });
    if (r.status === 404) throw new Error("GitHub doesn't have that repository (or it's private).");
    if (r.status === 403 || r.status === 429) throw new Error("GitHub is rate-limiting this hub; try again in a while (or set GITHUB_TOKEN in the hub's .env).");
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    return r.json() as Promise<any>;
  };
}

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
export function bundleHash(files: { path: string; bytes: Uint8Array }[]) {
  return sha256([...files].sort((a, b) => a.path.localeCompare(b.path)).map((x) => `${x.path}\0${sha256(x.bytes)}`).join("\n"));
}

/** A name that fits the hub's skills (lowercase, digits, -), from the skill's own name or its folder. */
export function skillName(declared: string | undefined, folder: string): string | null {
  for (const c of [declared, folder]) {
    const n = String(c || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
    if (NAME_RE.test(n)) return n;
  }
  return null;
}

/** The skill's folder at one commit, every file in it. sha pins the commit (Approve passes the one it showed). */
export async function fetchBundle(ref: SkillRef, o: { fetch?: Fetch; token?: string; sha?: string } = {}): Promise<Result<Bundle>> {
  const f = o.fetch || fetch;
  const api = gh(f, o.token ?? process.env.GITHUB_TOKEN);
  try {
    const sha: string = o.sha || (await api(`/repos/${ref.repo}/commits/${encodeURIComponent(ref.ref || "HEAD")}`)).sha;
    if (!/^[0-9a-f]{40}$/.test(sha)) return { error: "GitHub didn't say which commit that is." };
    const tree = await api(`/repos/${ref.repo}/git/trees/${sha}?recursive=1`);
    const items: { path: string; type: string; size?: number }[] = Array.isArray(tree?.tree) ? tree.tree : [];
    const skillDirs = items.filter((x) => x.type === "blob" && /(^|\/)SKILL\.md$/.test(x.path)).map((x) => (x.path === "SKILL.md" ? "" : posix.dirname(x.path)));
    let dir: string | undefined;
    const wantPath = ref.path?.replace(/^\/+|\/+$/g, "");
    if (wantPath !== undefined) dir = skillDirs.find((d) => d === wantPath);
    else if (ref.skill) {
      const want = ref.skill.toLowerCase();
      dir = skillDirs.filter((d) => posix.basename(d || ref.repo.split("/")[1]).toLowerCase() === want).sort((a, b) => a.length - b.length)[0];
    } else if (skillDirs.length === 1) dir = skillDirs[0];
    else if (skillDirs.includes("")) dir = "";
    if (dir === undefined) {
      if (!skillDirs.length) return { error: `${ref.repo} has no SKILL.md.` };
      const names = skillDirs.map((d) => posix.basename(d)).slice(0, 30);
      return { error: ref.skill || ref.path !== undefined
        ? `No skill ${ref.skill || ref.path} in ${ref.repo}. It has: ${names.join(", ")}.`
        : `${ref.repo} has ${skillDirs.length} skills; say which (${ref.repo}@<skill>): ${names.join(", ")}.` };
    }
    const prefix = dir ? `${dir}/` : "";
    const blobs = items.filter((x) => x.type === "blob" && x.path.startsWith(prefix))
      // Not another skill nested inside this one, and not git plumbing.
      .filter((x) => !skillDirs.some((d) => d !== dir && d.startsWith(prefix) && x.path.startsWith(`${d}/`)))
      .filter((x) => !x.path.slice(prefix.length).split("/").some((p) => p === ".git" || p === ".github" || p === ".." || !p));
    if (blobs.length > MAX_FILES) return { error: `That skill has ${blobs.length} files; Hearth installs ones with up to ${MAX_FILES}.` };
    const total = blobs.reduce((n, x) => n + (x.size || 0), 0);
    if (total > MAX_TOTAL || blobs.some((x) => (x.size || 0) > MAX_FILE)) return { error: "That skill is too big to install (over 10 MB, or a file over 2 MB)." };
    // 8 at a time: a big skill (pptx) has dozens of files.
    const files: Bundle["files"] = [];
    for (let i = 0; i < blobs.length; i += 8) {
      const got = await Promise.all(blobs.slice(i, i + 8).map(async (b) => {
        const r = await f(`https://raw.githubusercontent.com/${ref.repo}/${sha}/${b.path.split("/").map(encodeURIComponent).join("/")}`, { signal: AbortSignal.timeout(20_000) });
        if (!r.ok) throw new Error(`Couldn't download ${b.path} (${r.status}).`);
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (bytes.length > MAX_FILE) throw new Error(`${b.path} is too big.`);
        return { path: b.path.slice(prefix.length), bytes };
      }));
      files.push(...got);
    }
    const md = files.find((x) => x.path === "SKILL.md");
    if (!md) return { error: "The skill's SKILL.md is missing." };
    const fm = frontMatter(new TextDecoder().decode(md.bytes));
    if (!fm.description) return { error: "That SKILL.md has no description, so the brain couldn't tell when to use it." };
    const name = skillName(fm.name, posix.basename(dir || ref.repo.split("/")[1]));
    if (!name) return { error: "That skill's name doesn't work here (letters, digits and - only)." };
    return { value: {
      name, description: fm.description.slice(0, 1000), repo: ref.repo, path: dir, sha,
      url: `https://github.com/${ref.repo}/tree/${sha}${dir ? `/${dir}` : ""}`, files, hash: bundleHash(files),
    } };
  } catch (e: any) { return { error: String(e?.message || e).slice(0, 300) }; }
}

/** Files that run (scripts): by extension, a #! line, or no extension in a scripts/ or bin/ folder. The card lists these. */
export function scriptFiles(b: Bundle): string[] {
  return b.files.filter((x) => /\.(py|sh|bash|zsh|js|mjs|cjs|ts|rb|pl|php|ps1)$/i.test(x.path)
    || (x.bytes[0] === 0x23 && x.bytes[1] === 0x21) || (/(^|\/)(scripts?|bin)\/[^/.]+$/.test(x.path))).map((x) => x.path);
}

/** For the Approve card: what it is, where from, and what it brings. */
export function bundleDetails(b: Bundle): string {
  const scripts = scriptFiles(b);
  const other = b.files.map((x) => x.path).filter((p) => p !== "SKILL.md" && !scripts.includes(p));
  return [b.description.slice(0, 300), `From ${b.repo}${b.path ? `/${b.path}` : ""} at ${b.sha.slice(0, 7)}: ${b.url}`,
    scripts.length ? `Brings code (it runs in the sandbox): ${scripts.slice(0, 12).join(", ")}${scripts.length > 12 ? ` and ${scripts.length - 12} more` : ""}` : "Instructions only, no code.",
    other.length ? `Other files: ${other.slice(0, 8).join(", ")}${other.length > 8 ? ` and ${other.length - 8} more` : ""}` : null].filter(Boolean).join("\n").slice(0, 1000);
}

/** The skill's own SKILL.md, as text. */
export const skillMd = (b: Bundle) => new TextDecoder().decode(b.files.find((x) => x.path === "SKILL.md")!.bytes);

/** Reads .hearth-source.json, if the skill was installed. */
export function readSource(dir: string): Source | null {
  try { const j = JSON.parse(readFileSync(join(dir, SOURCE_FILE), "utf8")); return typeof j?.repo === "string" && typeof j?.sha === "string" ? j : null; } catch { return null; }
}

/** Writes the folder (a fresh copy, swapped in whole) with where it came from. */
export function installBundle(dataDir: string, b: Bundle, by: string, now = new Date()): Source {
  const root = join(dataDir, "skills");
  const dest = join(root, b.name);
  const tmp = join(root, `.installing-${b.name}-${process.pid}-${Date.now()}`);
  rmSync(tmp, { recursive: true, force: true });
  for (const x of b.files) {
    const p = join(tmp, x.path);
    if (!p.startsWith(tmp + "/")) throw new Error(`Bad file path: ${x.path}`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, x.bytes, { mode: /\.(py|sh|bash)$/.test(x.path) || (x.bytes[0] === 0x23 && x.bytes[1] === 0x21) ? 0o755 : 0o644 });
  }
  const source: Source = { repo: b.repo, path: b.path, sha: b.sha, url: b.url, hash: b.hash, installedAt: now.toISOString(), by };
  writeFileSync(join(tmp, SOURCE_FILE), JSON.stringify(source, null, 1));
  const old = `${dest}.old-${Date.now()}`;
  if (existsSync(dest)) renameSync(dest, old);
  renameSync(tmp, dest);
  rmSync(old, { recursive: true, force: true });
  return source;
}

function countFiles(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir)) {
    if (e === SOURCE_FILE) continue;
    const p = join(dir, e);
    n += statSync(p).isDirectory() ? countFiles(p) : 1;
  }
  return n;
}

/** Every skill in <data>/skills: installed ones with their source, yours without. */
export function installedSkills(dataDir: string): InstalledSkill[] {
  const root = join(dataDir, "skills");
  if (!existsSync(root)) return [];
  const out: InstalledSkill[] = [];
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name);
    const f = join(dir, "SKILL.md");
    if (!NAME_RE.test(name) || !existsSync(f)) continue;
    const fm = frontMatter(readFileSync(f, "utf8"));
    out.push({ name, description: fm.description || "", files: countFiles(dir), source: readSource(dir) });
  }
  return out;
}

export function removeSkill(dataDir: string, name: string): boolean {
  if (!NAME_RE.test(name)) return false;
  const dir = join(dataDir, "skills", name);
  if (!existsSync(join(dir, "SKILL.md"))) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** The agent's hearth-skill-store command: a few lines of curl to the hub with its agent key (like hearth-mcp). */
export function storeSkill(hubUrl: string, key: string) {
  const script = `#!/usr/bin/env bash
# hearth-skill-store: public skills. find <words...> | show <id> | install <id>
set -uo pipefail
if [ $# -eq 0 ]; then set -- help; fi
args=()
for a in "$@"; do args+=(--data-urlencode "a=$a"); done
run=()
# The job this run is for: an install that waits for an Approve goes to its thread.
if [ -n "\${HEARTH_JOB:-}" ]; then run=(-H "X-Hearth-Job: \${HEARTH_JOB}"); fi
exec curl -sS -m 120 -H "X-Hearth-Agent: ${key}" \${run[@]+"\${run[@]}"} "\${args[@]}" "${hubUrl}/api/agent/skills"
`;
  return {
    name: "install-skills", common: true, commands: ["hearth-skill-store"], reads: [] as string[], scripts: { "hearth-skill-store": script },
    description: "No skill on this hub fits the task, or the user wants a new skill? Search the public catalog of skills (skills.sh, GitHub), read one, and install it.",
    body: `# Installing skills

Skills already here come first (\`hearth-skill search\`). When none fits the task, or the user asks for a skill
("get a skill for PowerPoint", "install anthropics/skills@pdf", a GitHub link), use the public catalog:

- \`hearth-skill-store find <a few words>\`: public skills, best matches first, each with its installs and the id to install
  and whether it's installed here already.
- \`hearth-skill-store show <id>\`: its SKILL.md and the files it brings (scripts, references). Read it before installing.
- \`hearth-skill-store install <id>\`: install it. The id from find (owner/repo/skill), owner/repo@skill, or a GitHub link
  to the skill's folder. Installing it again updates it to the latest.

Pick the one that fits the task best: read two or three with \`show\` when several match. Many installs and a known
publisher (anthropics, openai, vercel-labs, github…) are good signs.

An install the user didn't do themselves waits for their Approve: the answer says so. Say in your reply which skill
and what it's for. Once they approve, it's installed and you carry on: \`hearth-skill show <name>\` reads it, and its
files are in its folder. A skill's scripts run in your sandbox like your own code.`,
  };
}
