import { lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Sessions: a job's thread is one conversation with its brain, not a string of throwaway runs (the way Mako does it).
// The first working run in a thread starts a Claude Code or Codex session; every follow-up in that thread resumes it by
// its id (`claude --resume <id>`, Codex app-server `thread/resume`). So "can you try again?" picks up with everything it
// already read, ran and found, instead of working the whole task out from nothing.
//
// Each thread also gets its own folder that stays: <brain>/threads/<thread>/. Its runs work in it (it's their cwd), so
// whatever they save there (notes, data they pulled, a script that worked) is still there next turn. Claude and Codex
// key their sessions by folder as well, which is what makes resuming land in the same place.
//
// The ids live in <data>/brain-sessions.json: outside the brain's folder, so a run in the jail can't see or change them.
// Sessions are made on this hub only. A linked computer runs a call fresh, as before (its sessions would be on it).

export type SessionHarness = "claude" | "codex";
type Entry = Partial<Record<SessionHarness, string>> & { at: string };

/** A thread id we'll make a folder for: the hub's own ids (uuids), nothing with a path in it. */
export const THREAD_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,79}$/;
/** What Claude and Codex give as a session id. */
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,99}$/;

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

  /**
   * The thread's own folder, made on first use. It sees the hub's skills the way the brain's folder does (Claude Code
   * finds them under .claude/skills in its cwd), through a link, so a skill installed later shows up here too.
   */
  folder(thread: string): string | null {
    if (!THREAD_RE.test(thread)) return null;
    const dir = join(this.workDir, "threads", thread);
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { return null; }
    const link = join(dir, ".claude");
    // lstat, not exists: a link whose target isn't there yet (no skills installed) is still the link we want.
    try { lstatSync(link); } catch { try { symlinkSync(join(this.workDir, ".claude"), link); } catch {} }
    return dir;
  }
}
