import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

// Keeps workspaces (brains/sessions.ts) from filling up the hub, once a day:
//   - NOTES.md: the playbook at the top stays; dated sections past the newest KEEP_SECTIONS move to archive/NOTES-old.md
//     once the file is over NOTES_MAX bytes.
//   - data/, out/ and history/: files nobody touched for FILE_DAYS are gzipped into archive/<yyyy-mm>/<path>.gz.
//     scripts/, skills/ and NOTES.md are never touched: they're what the next run reuses.
//   - a whole workspace nobody used for WORKSPACE_DAYS is packed into <brain>/archive/<its path>-<date>.tar.gz and removed.
//     A thread pinned to it gets an empty folder again next time (its session starts over; the files are in the tarball).
// The runs are told archive/ exists, so they can look there for something old.

export const NOTES_MAX = 16_000;
export const KEEP_SECTIONS = 6;
export const FILE_DAYS = 30;
export const WORKSPACE_DAYS = 90;
const DAY = 86_400_000;
/** Folders whose old files are archived; everything else in a workspace is left alone. */
const BULKY = ["data", "out", "history"];

export type TidyReport = { notes: string[]; files: number; packed: string[] };

/** Every workspace folder under the brain's folder: projects/<p>/<w>, workspaces/<w> and threads/<t>. */
export function workspaceDirs(workDir: string): string[] {
  const kids = (d: string) => { try { return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => join(d, e.name)); } catch { return []; } };
  return [...kids(join(workDir, "projects")).flatMap(kids), ...kids(join(workDir, "workspaces")), ...kids(join(workDir, "threads"))];
}

/** The newest time anything in this folder changed (archive/ and the skills link don't count). */
function lastUsed(dir: string): number {
  let t = 0;
  const walk = (d: string, depth: number) => {
    let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      if (e.name === ".claude" || (depth === 0 && e.name === "archive")) continue;
      const p = join(d, e.name);
      try { t = Math.max(t, statSync(p).mtimeMs); } catch {}
      if (e.isDirectory() && depth < 6) walk(p, depth + 1);
    }
  };
  try { t = statSync(dir).mtimeMs; } catch {}
  walk(dir, 0);
  return t;
}

/** NOTES.md split into its playbook (everything before the first dated "## yyyy-mm-dd" heading) and dated sections. */
export function splitNotes(text: string): { head: string; sections: string[] } {
  const parts = text.split(/^(?=## \d{4}-\d{2}-\d{2})/m);
  const head = /^## \d{4}-\d{2}-\d{2}/.test(parts[0] || "") ? "" : parts.shift() || "";
  return { head, sections: parts };
}

/** Moves NOTES.md's older dated sections out once it's too long. Newest sections are kept, wherever they are in the file. */
export function trimNotes(dir: string, max = NOTES_MAX, keep = KEEP_SECTIONS): boolean {
  const f = join(dir, "NOTES.md");
  let text: string;
  try { text = readFileSync(f, "utf8"); } catch { return false; }
  if (Buffer.byteLength(text) <= max) return false;
  const { head, sections } = splitNotes(text);
  if (sections.length <= keep) return false;
  const date = (s: string) => s.slice(3, 13);
  const order = sections.map((s, i) => ({ s, i })).sort((a, b) => date(b.s).localeCompare(date(a.s)) || b.i - a.i);
  const kept = new Set(order.slice(0, keep).map((x) => x.i));
  const old = sections.filter((_, i) => !kept.has(i));
  mkdirSync(join(dir, "archive"), { recursive: true });
  appendFileSync(join(dir, "archive", "NOTES-old.md"), old.map((s) => s.trimEnd() + "\n\n").join(""));
  const note = `_Older notes (${old.length} section${old.length === 1 ? "" : "s"}) are in archive/NOTES-old.md._\n\n`;
  writeFileSync(f, (head.trimEnd() ? head.trimEnd() + "\n\n" : "") + (head.includes("archive/NOTES-old.md") ? "" : note) + sections.filter((_, i) => kept.has(i)).join(""));
  return true;
}

/** Gzips files in data/ and out/ that nobody touched for `days` into archive/<yyyy-mm>/. Returns how many. */
export function archiveOldFiles(dir: string, now = Date.now(), days = FILE_DAYS): number {
  let n = 0;
  const walk = (d: string) => {
    let es; try { es = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { walk(p); try { if (!readdirSync(p).length) rmSync(p, { recursive: true }); } catch {} continue; }
      let st; try { st = statSync(p); } catch { continue; }
      if (now - st.mtimeMs < days * DAY) continue;
      const month = new Date(st.mtimeMs).toISOString().slice(0, 7);
      const to = join(dir, "archive", month, relative(dir, p) + ".gz");
      try {
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, Bun.gzipSync(readFileSync(p)));
        rmSync(p);
        n++;
      } catch {}
    }
  };
  for (const b of BULKY) if (existsSync(join(dir, b))) walk(join(dir, b));
  return n;
}

/** Packs a workspace nobody used for `days` into <brain>/archive/ and removes it. Returns the tarball, or null. */
export function packIfStale(workDir: string, dir: string, now = Date.now(), days = WORKSPACE_DAYS): string | null {
  if (now - lastUsed(dir) < days * DAY) return null;
  const rel = relative(workDir, dir);
  const to = join(workDir, "archive", `${rel}-${new Date(now).toISOString().slice(0, 10)}.tar.gz`);
  mkdirSync(dirname(to), { recursive: true });
  const r = Bun.spawnSync(["tar", "-czf", to, "--exclude", ".claude", "-C", dirname(dir), relative(dirname(dir), dir)], { stdout: "ignore", stderr: "pipe" });
  if (r.exitCode !== 0 || !existsSync(to)) { rmSync(to, { force: true }); return null; }
  rmSync(dir, { recursive: true, force: true });
  return to;
}

/** The daily tidy of every workspace. Never throws: a failed tidy just tries again tomorrow. */
export function tidyWorkspaces(workDir: string, now = Date.now()): TidyReport {
  const report: TidyReport = { notes: [], files: 0, packed: [] };
  for (const dir of workspaceDirs(workDir)) {
    try {
      const packed = packIfStale(workDir, dir, now);
      if (packed) { report.packed.push(relative(workDir, dir)); continue; }
      if (trimNotes(dir)) report.notes.push(relative(workDir, dir));
      report.files += archiveOldFiles(dir, now);
    } catch {}
  }
  return report;
}
