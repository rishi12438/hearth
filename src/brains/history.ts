import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Every command a thread's run executes (Claude's Bash calls, Codex's shell commands), kept in its workspace, so the
// code it ran is never lost even when it didn't save it as a script: a one-off `python3 -c ...`, a heredoc, a pipeline
// that finally worked. One file per day and thread: <workspace>/history/<yyyy-mm-dd>-<thread>.sh. Written by Brain as
// the run goes (not by the model), so it's there even if the run is stopped. Old ones are archived like data/
// (see brains/archive.ts).

/** One command can be a whole script in a heredoc; past this it's cut (the rest is rarely what you'd want back). */
const MAX_COMMAND = 200_000;

export type CommandLog = { file: string; command(cmd: unknown): void; wrote(path: unknown): void };

export function commandLog(dir: string, thread: string, now = () => new Date()): CommandLog {
  const d = now();
  const day = d.toISOString().slice(0, 10);
  const file = join(dir, "history", `${day}-${thread.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)}.sh`);
  let ok = true;
  const put = (text: string) => {
    if (!ok) return;
    try { mkdirSync(join(dir, "history"), { recursive: true }); appendFileSync(file, text); } catch { ok = false; }
  };
  const stamp = () => now().toISOString().slice(11, 19);
  return {
    file,
    command(cmd) {
      const c = String(cmd ?? "").trim();
      if (!c) return;
      put(`# ${stamp()}\n${c.length > MAX_COMMAND ? c.slice(0, MAX_COMMAND) + "\n# ...(cut)" : c}\n\n`);
    },
    wrote(path) {
      const p = String(path ?? "").trim();
      if (p) put(`# ${stamp()} wrote ${p}\n\n`);
    },
  };
}
