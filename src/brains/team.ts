import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Teammates working at the same time on one ramble talk to each other (like Enkidu's send-message). Each run gets a mailbox folder (HEARTH_TEAM_DIR) and the `hearth-team` command:
//   hearth-team who                 who else is working on this ramble right now
//   hearth-team send [--to <id>|all] "..."   a note to them (arrives at their next safe moment)
//   hearth-team inbox               new notes from teammates
// Claude gets new notes by itself after each tool call (a PostToolUse hook: exit 2 shows its stderr to the model).
// Codex has no hooks, so it's told to look. The process that started the agent (the hub, or your Mac) moves notes
// between the folder and the hub, which routes them between the runs of one ramble.

export type TeamNote = { n: number; from: string; text: string };

/** One run's line to its teammates: notes in (numbered), notes out, who's around, and how far it has read. */
export class TeamLine {
  notes: TeamNote[] = [];
  roster = "";
  read = 0;
  private subs = new Set<{ note: (n: TeamNote) => void; roster: (r: string) => void }>();
  constructor(readonly send: (to: string, text: string) => void, private onRead?: (n: number) => void) {}

  deliver(from: string, text: string) {
    const note: TeamNote = { n: this.notes.length + 1, from: from.slice(0, 80), text: text.slice(0, 2000) };
    this.notes.push(note);
    for (const s of this.subs) s.note(note);
    return note;
  }
  setRoster(r: string) {
    if (r === this.roster) return;
    this.roster = r;
    for (const s of this.subs) s.roster(r);
  }
  markRead(n: number) {
    if (!(n > this.read)) return;
    this.read = Math.min(n, this.notes.length || n);
    this.onRead?.(this.read);
  }
  /** Notes so far and from now on (and the roster), until the returned function is called. */
  subscribe(note: (n: TeamNote) => void, roster: (r: string) => void) {
    const s = { note, roster };
    for (const n of this.notes) note(n);
    if (this.roster) roster(this.roster);
    this.subs.add(s);
    return () => { this.subs.delete(s); };
  }
}

/** What a run's prompt says about it (only when its mailbox is really there). */
export const TEAM_NOTE = `

TEAM: other teammates may be working alongside you on this ramble.
- \`hearth-team inbox\`: new messages from them. Check it every few steps and before your final answer.
- \`hearth-team who\`: who else is working now, and on what.
- \`hearth-team send --to <id|all> "..."\`: tell them something that helps (a finding they need, "I've got X, skip it").
  Short, only when it matters; never wait for a reply.`;

const SCRIPT = `#!/usr/bin/env bash
# hearth-team: talk to the teammates working alongside you (written by Hearth, src/brains/team.ts).
set -uo pipefail
d="\${HEARTH_TEAM_DIR:-}"
if [ -z "$d" ] || [ ! -d "$d" ]; then
  [ "\${1:-}" = hook ] && exit 0
  echo "Nobody else is working alongside you right now."; exit 0
fi
unread() {
  local last n f out=""
  last=$(cat "$d/read" 2>/dev/null); last="\${last//[^0-9]/}"; last="\${last:-0}"
  for f in "$d"/inbox/*.txt; do
    [ -e "$f" ] || continue
    n=$(basename "$f" .txt); n=$((10#$n))
    [ "$n" -gt "$last" ] || continue
    out+="$(cat "$f")"$'\\n\\n'; last=$n
  done
  echo "$last" > "$d/read.tmp" && mv "$d/read.tmp" "$d/read"
  printf '%s' "$out"
}
case "\${1:-}" in
  who) cat "$d/who.txt" 2>/dev/null || echo "Nobody else is working alongside you right now." ;;
  send)
    shift; to=all
    if [ "\${1:-}" = "--to" ]; then to="\${2:-all}"; shift 2 || shift; fi
    msg="$*"
    [ -n "$msg" ] || { echo 'Usage: hearth-team send [--to <id>|all] "message"' >&2; exit 1; }
    f="$d/outbox/$(date +%s)-$$-$RANDOM.txt"
    printf '%s\\n%s' "$to" "$msg" > "$f.tmp" && mv "$f.tmp" "$f"
    echo "Sent to $to."
    m=$(unread); [ -n "$m" ] && printf '\\nNew messages:\\n%s\\n' "$m"
    ;;
  inbox) m=$(unread); if [ -n "$m" ]; then printf '%s\\n' "$m"; else echo "No new messages."; fi ;;
  hook)
    cat > /dev/null
    m=$(unread); [ -n "$m" ] || exit 0
    printf 'New team messages (hearth-team inbox):\\n%s\\n' "$m" >&2; exit 2
    ;;
  *) echo 'Usage: hearth-team who | send [--to <id>|all] "message" | inbox' >&2; exit 1 ;;
esac
`;

/** The command in <workDir>/bin, and Claude's hook for it in <workDir>/.claude/settings.json (it does nothing outside a team run). */
export function installTeam(workDir: string) {
  const bin = join(workDir, "bin");
  mkdirSync(bin, { recursive: true });
  const cmd = join(bin, "hearth-team");
  writeFileSync(cmd, SCRIPT);
  chmodSync(cmd, 0o755);
  const settings = join(workDir, ".claude", "settings.json");
  mkdirSync(join(workDir, ".claude"), { recursive: true });
  writeFileSync(settings, JSON.stringify({ hooks: { PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `${cmd} hook` }] }] } }, null, 1));
  return bin;
}

/**
 * One run's mailbox folder, kept in step with its line: notes and the roster are written in, sent notes and the read
 * mark are picked up (every 500ms, and once more at the end).
 */
export function openMailbox(root: string, id: string, line: TeamLine) {
  const dir = join(root, "team", id);
  mkdirSync(join(dir, "inbox"), { recursive: true });
  mkdirSync(join(dir, "outbox"), { recursive: true });
  const put = (f: string, text: string) => { writeFileSync(`${f}.tmp`, text); renameSync(`${f}.tmp`, f); };
  const unsub = line.subscribe(
    (n) => put(join(dir, "inbox", `${String(n.n).padStart(6, "0")}.txt`), `From ${n.from}:\n${n.text}`),
    (r) => put(join(dir, "who.txt"), r));
  const poll = () => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(join(dir, "outbox")).filter((x) => x.endsWith(".txt")).sort()) {
      const p = join(dir, "outbox", f);
      let raw = "";
      try { raw = readFileSync(p, "utf8"); rmSync(p, { force: true }); } catch { continue; }
      const i = raw.indexOf("\n");
      const to = (i < 0 ? "all" : raw.slice(0, i)).trim() || "all";
      const text = (i < 0 ? raw : raw.slice(i + 1)).trim();
      if (text) line.send(to.slice(0, 80), text.slice(0, 2000));
    }
    const mark = join(dir, "read");
    const read = existsSync(mark) ? Number(readFileSync(mark, "utf8").trim()) || 0 : 0;
    if (read) line.markRead(read);
  };
  const timer = setInterval(() => { try { poll(); } catch {} }, 500);
  return {
    dir,
    close() {
      clearInterval(timer);
      try { poll(); } catch {}
      unsub();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
