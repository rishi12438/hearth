/**
 * Transcripts: every brain run Hearth starts (Claude Code or Codex) is a throwaway session (--no-session-persistence,
 * --ephemeral), so once it ends there's nothing left to tell why a job said what it said. This keeps the whole run for
 * debugging: the prompt it got, every event it streamed (its reasoning, each command and that command's output), stderr,
 * and how it ended.
 *
 * One JSONL file per run under <data>/transcripts/<day>/: a "run" header, the raw event lines as they came, then an
 * "end" line. Owner-only (0600), outside the brain's work folder, so a later run can't read an earlier one. Files older
 * than KEEP_DAYS are deleted.
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const KEEP_DAYS = 14;

export type RunInfo = { harness: string; model?: string; mode: string; owner?: string | null; prompt: string; cmd: string[] };
export type RunEnd = { code: number | null; reply?: string; stderr?: string; timedOut?: boolean; aborted?: boolean };

export type Transcript = { file: string; line(raw: string): void; end(e: RunEnd): void };

const NONE: Transcript = { file: "", line() {}, end() {} };

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const time = (d: Date) => [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join("");

/** Starts a run's transcript. Never throws: a full disk mustn't stop a job, it just isn't recorded. */
export function startTranscript(root: string, info: RunInfo, now = new Date()): Transcript {
  try {
    const dir = join(root, day(now));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${time(now)}-${info.mode}-${info.harness}-${randomBytes(3).toString("hex")}.jsonl`);
    const started = now.getTime();
    // The command without the jail's prefix and the prompt (it has its own field).
    const cmd = info.cmd.slice(Math.max(0, info.cmd.indexOf(info.harness === "codex" ? "codex" : info.harness)));
    writeFileSync(file, JSON.stringify({ type: "hearth.run", at: started, harness: info.harness, model: info.model || null, mode: info.mode,
      owner: info.owner || null, cmd, prompt: info.prompt }) + "\n", { mode: 0o600 });
    let ok = true;
    const put = (s: string) => { if (!ok) return; try { appendFileSync(file, s); } catch { ok = false; } };
    return {
      file,
      // Event lines are JSON already; anything else (a custom harness's plain text) is wrapped so the file stays JSONL.
      line(raw) {
        const l = raw.replace(/\r?\n$/, "");
        if (!l.trim()) return;
        put((l.startsWith("{") ? l : JSON.stringify({ type: "hearth.text", text: l })) + "\n");
      },
      end(e) {
        put(JSON.stringify({ type: "hearth.end", at: Date.now(), ms: Date.now() - started, code: e.code, timedOut: !!e.timedOut,
          aborted: !!e.aborted, reply: e.reply ?? null, stderr: (e.stderr || "").slice(-20_000) || null }) + "\n");
        ok = false;
      },
    };
  } catch { return NONE; }
}

/** Deletes day folders older than keepDays. */
export function pruneTranscripts(root: string, keepDays = KEEP_DAYS, now = Date.now()) {
  let days: string[] = [];
  try { days = readdirSync(root); } catch { return; }
  for (const d of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const p = join(root, d);
    try { if (now - statSync(p).mtimeMs > keepDays * 86_400_000) rmSync(p, { recursive: true, force: true }); } catch {}
  }
}
