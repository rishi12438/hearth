import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Sessions: a job's thread is one conversation with its brain, not a string of throwaway runs (the way Mako does it).
// The first working run in a thread starts a Claude Code or Codex session; every follow-up in that thread resumes it by
// its id (`claude --resume <id>`, Codex app-server `thread/resume`). So "can you try again?" picks up with everything it
// already read, ran and found, instead of working the whole task out from nothing.
//
// Each thread works in a folder that stays (it's the run's cwd), so whatever it saves there (notes, data it pulled, a
// script that worked) is still there next turn. Threads about the same subject share one: a WORKSPACE, so a new thread
// on that subject starts where the earlier ones left off, with their files. A project holds its workspaces:
//   <brain>/projects/<project>/<workspace>/   rambles filed in a project ("lego-zero/aliexpress-orders")
//   <brain>/workspaces/<workspace>/           rambles that aren't
// The hub picks the names (project from the ramble; workspace from the planner, else the channel). A thread is pinned to
// its folder on its first run: Claude and Codex key sessions by folder, so resuming must land in the same place. A thread
// with no workspace name gets a folder of its own, <brain>/threads/<thread>/.
//
// The ids live in <data>/brain-sessions.json: outside the brain's folder, so a run in the jail can't see or change them.
// Sessions are made on this hub only. A linked computer runs a call fresh, as before (its sessions would be on it).

export type SessionHarness = "claude" | "codex";
/** folder: where the thread is pinned, relative to the brain's folder ("projects/lego-zero/aliexpress-orders"). */
type Entry = Partial<Record<SessionHarness, string>> & { at: string; folder?: string };
/** Where a thread works: a workspace, inside a project or not. */
export type Place = { project?: string; workspace: string };

/** A workspace name: lowercase-dashed, like a channel. */
export const WORKSPACE_RE = /^[a-z0-9][a-z0-9-]{1,47}$/;
/** Any text as a workspace name ("Lego Zero" -> "lego-zero"), or undefined when nothing usable is left. */
export function workspaceName(s: unknown): string | undefined {
  const n = String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
  return WORKSPACE_RE.test(n) ? n : undefined;
}
/** A ramble's channel as a workspace: "aliexpress-orders-3" is the same subject as "aliexpress-orders". */
export const channelWorkspace = (channel: unknown) => workspaceName(String(channel ?? "").replace(/-\d+$/, ""));
const FOLDER_RE = /^(projects\/[a-z0-9][a-z0-9-]{1,47}\/|workspaces\/)[a-z0-9][a-z0-9-]{1,47}$/;
const rel = (p: Place) => (p.project ? `projects/${p.project}/${p.workspace}` : `workspaces/${p.workspace}`);
const placeOf = (rel: string): Place => { const x = rel.split("/"); return x[0] === "projects" ? { project: x[1], workspace: x[2] } : { workspace: x[1] }; };

/** A thread id we'll make a folder for: the hub's own ids (uuids), nothing with a path in it. */
export const THREAD_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,79}$/;
/** What Claude and Codex give as a session id. */
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,99}$/;

/** What a new workspace starts with, so the playbook and skills have a place from the first run (see workspaceNote). */
export const NOTES_TEMPLATE = (name: string) => `# ${name}

## Playbook
_How to do the work here now: the steps, tools, logins, URLs and scripts (in scripts/) that work, and the traps to avoid.
Rewrite this section whenever you find a better way. Reusable methods go in skills/<name>.md._

`;

function seed(dir: string, name: string) {
  try { if (!existsSync(join(dir, "NOTES.md"))) writeFileSync(join(dir, "NOTES.md"), NOTES_TEMPLATE(name)); } catch {}
  try { mkdirSync(join(dir, "skills"), { recursive: true }); } catch {}
}

export class Sessions {
  constructor(private file: string, private workDir: string, private now = () => new Date()) {}

  private read(): Record<string, Entry> {
    try { const o = JSON.parse(readFileSync(this.file, "utf8")); return o && typeof o === "object" ? o : {}; } catch { return {}; }
  }
  private write(all: Record<string, Entry>) {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** The session to resume for this thread on this brain, if it has one. */
  get(thread: string, harness: SessionHarness): string | undefined {
    if (!THREAD_RE.test(thread)) return undefined;
    const id = this.read()[thread]?.[harness];
    return typeof id === "string" && SESSION_RE.test(id) ? id : undefined;
  }

  set(thread: string, harness: SessionHarness, id: string) {
    if (!THREAD_RE.test(thread) || !SESSION_RE.test(id)) return;
    const all = this.read();
    if (all[thread]?.[harness] === id) return;
    all[thread] = { ...all[thread], [harness]: id, at: this.now().toISOString() };
    this.write(all);
  }

  /** The saved session is gone (its files were cleared): the next run starts a new one. */
  forget(thread: string, harness: SessionHarness) {
    const all = this.read();
    if (!all[thread]?.[harness]) return;
    delete all[thread][harness];
    this.write(all);
  }

  /** The workspace (and project) this thread is pinned to, if any. */
  placeOf(thread: string): Place | undefined {
    const f = this.read()[thread]?.folder;
    return typeof f === "string" && FOLDER_RE.test(f) ? placeOf(f) : undefined;
  }

  /**
   * The folder a thread's runs work in, made on first use: where it's pinned; else (first run) the place asked for, which
   * pins it; else its own folder. A thread that already has a folder of its own keeps it (its sessions live there). The
   * folder sees the hub's skills the way the brain's folder does (Claude Code finds them under .claude/skills in its
   * cwd), through a link, so a skill installed later shows up here too.
   */
  folder(thread: string, want?: Place): string | null {
    if (!THREAD_RE.test(thread)) return null;
    const own = join(this.workDir, "threads", thread);
    let f = this.read()[thread]?.folder;
    if (!(typeof f === "string" && FOLDER_RE.test(f))) f = undefined;
    if (!f && want && FOLDER_RE.test(rel(want)) && !existsSync(own)) {
      f = rel(want);
      const all = this.read();
      all[thread] = { ...all[thread], folder: f, at: all[thread]?.at || this.now().toISOString() };
      this.write(all);
    }
    const dir = f ? join(this.workDir, f) : own;
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { return null; }
    seed(dir, f ? placeOf(f).workspace : "This thread");
    const link = join(dir, ".claude");
    // lstat, not exists: a link whose target isn't there yet (no skills installed) is still the link we want.
    try { lstatSync(link); } catch { try { symlinkSync(join(this.workDir, ".claude"), link); } catch {} }
    return dir;
  }

  /**
   * The workspaces in a project (or, with none, those outside any project), most recently used first, with the start of
   * each one's NOTES.md (what was done there): for the planner to put a new job in the right one.
   */
  workspaces(project?: string, limit = 20): { name: string; usedAt: string; notes: string }[] {
    if (project && !WORKSPACE_RE.test(project)) return [];
    const root = project ? join(this.workDir, "projects", project) : join(this.workDir, "workspaces");
    let names: string[] = [];
    try { names = readdirSync(root).filter((n) => WORKSPACE_RE.test(n)); } catch { return []; }
    const out = names.map((name) => {
      const dir = join(root, name);
      let notes = "", at = 0;
      try { at = statSync(dir).mtimeMs; } catch {}
      try { const f = join(dir, "NOTES.md"); notes = readFileSync(f, "utf8").replace(/\s+/g, " ").trim().slice(0, 300); at = Math.max(at, statSync(f).mtimeMs); } catch {}
      return { name, at, notes };
    });
    return out.sort((a, b) => b.at - a.at).slice(0, limit).map((w) => ({ name: w.name, usedAt: new Date(w.at).toISOString().slice(0, 10), notes: w.notes }));
  }
}
