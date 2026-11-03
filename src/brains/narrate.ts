/**
 * Live status lines for long jobs. Most steps already have a plain label ("Searching: pottery gifts"); when the label is a
 * generic one ("Working it out") and has sat there a while, the quick model reads the job's last few raw actions and
 * writes one short line ("Checking Spin Art's November times").
 *
 * Cheap by construction: each call is a few hundred tokens (fixed instructions first, then the task, then the last few
 * actions, so the prefix stays the same for caching), runs only when there's something new since the last one, at most
 * one at a time, and at most `maxCalls` per job.
 */

/** Labels that say nothing about what's happening. Only these get narrated. */
export const GENERIC_STEPS = new Set(["Working it out", "Running code", "Reading a page", "Putting it together",
  "Looking through files", "Searching the web", "Planning the steps", "Reading through its notes", "On it"]);

export const NARRATE = [
  "Write the status line a user watches while their assistant works: what it is doing right now, in 3 to 8 words,",
  'present tense, naming the place or thing ("Checking Spin Art\'s November times", "Comparing workshop prices").',
  "No period, quotes, tool names, commands or URLs. Reply with only the line.",
].join("\n");

export function narratePrompt(task: string, actions: string[]) {
  return [NARRATE, "", "TASK:", task.replace(/\s+/g, " ").slice(0, 400), "", "LATEST ACTIONS (oldest first):", ...actions.map((a) => `- ${a}`)].join("\n");
}

/** The model's line, or null if it isn't a usable status line. */
export function cleanNarration(out: string): string | null {
  const line = String(out ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const t = line.replace(/^["'`*\s-]+|["'`*\s.]+$/g, "").replace(/\s+/g, " ");
  if (t.length < 6 || t.length > 70 || /https?:|[{}<>]/.test(t)) return null;
  return t.replace(/^./, (c) => c.toUpperCase());
}

export type NarratorOpts = {
  task: string;
  /** Runs the quick model on a prompt. */
  ask: (prompt: string) => Promise<string>;
  /** Shows a line in the job's progress. */
  show: (line: string) => void;
  now?: () => number;
  /** How long a generic label sits before it's narrated. */
  staleMs?: number;
  everyMs?: number;
  maxCalls?: number;
};

export class Narrator {
  private actions: string[] = [];
  private fresh = false;
  private label = "";
  private since = 0;
  private busy = false;
  private stopped = false;
  calls = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private now: () => number;

  constructor(private o: NarratorOpts) {
    this.now = o.now ?? Date.now;
    const every = o.everyMs ?? 3000;
    if (every > 0) { this.timer = setInterval(() => void this.tick(), every); (this.timer as any).unref?.(); }
  }

  /** A raw action the brain just took (a command, a search, a page). */
  action(raw: string) {
    const a = String(raw ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
    if (!a) return;
    this.actions = [...this.actions, a].slice(-6);
    this.fresh = true;
  }

  /** The label the job is showing now. */
  step(label: string) {
    if (label !== this.label) { this.label = label; this.since = this.now(); }
  }

  async tick() {
    const stale = this.o.staleMs ?? 10_000;
    if (this.stopped || this.busy || !this.fresh || this.calls >= (this.o.maxCalls ?? 15)) return;
    if (!GENERIC_STEPS.has(this.label) || this.now() - this.since < stale) return;
    this.busy = true; this.fresh = false; this.calls++;
    const asked = this.label;
    try {
      const line = cleanNarration(await this.o.ask(narratePrompt(this.o.task, this.actions)));
      // Something more specific showed up while it thought: that wins.
      if (line && this.label === asked && !this.stopped) { this.label = line; this.since = this.now(); this.o.show(line); }
    } catch {} finally { this.busy = false; }
  }

  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); this.timer = null; }
}
