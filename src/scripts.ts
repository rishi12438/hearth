import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { sha256 } from "./auth.ts";
import type { Store } from "./store/index.ts";
import type { Script } from "./types.ts";

// Scripts are the assistant's hands: small Bun/TS files that fetch, check or compute something.
//  - scripts/ in the repo: yours, trusted, approved on load.
//  - <data>/scripts/: written by the brain. They start as "proposed" and never run until you
//    read the code and approve it in the app. Approval pins the file's SHA-256: if the file
//    changes afterwards, it won't run until it is approved again.
// Scripts run with a minimal environment (no hub secrets, no DB URL), a timeout and an output cap.

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const OUTPUT_CAP = 8000;

/**
 * Does this code look like it sends, posts, pays or changes something outside the hub?
 * A guard rail, not a proof: an explicit "// effects: external" header, or write-style HTTP calls / known senders.
 * The real gate is you reading the code before approving it.
 */
export function detectEffects(code: string): "read" | "external" {
  if (/^\s*(\/\/|#)\s*effects:\s*external/m.test(code)) return "external";
  // Python and shell: write-style requests, curl with a body or method, subprocesses, file writes.
  if (/\b(requests|httpx|session)\.(post|put|patch|delete)\b|\burlopen\([^)]*data\s*=|\bsubprocess\b|\bos\.(system|popen|remove|unlink)\b|\bopen\([^)]*,\s*["'][wa]/.test(code)) return "external";
  if (langOf(code) === "sh") {
    if (/\bcurl\b[^\n]*(\s-X\s*(POST|PUT|PATCH|DELETE)|\s(-d|--data[\w-]*|-F|--form)\s)/.test(code)) return "external";
    if (/(^|[\s;|&])(rm|mv|tee|cp)\s/m.test(code) || /[^2&]>\s*[\w~/.$]/.test(code)) return "external";
  }
  if (/method\s*:\s*["'`](POST|PUT|PATCH|DELETE)["'`]/i.test(code)) return "external";
  if (/\b(sendmail|nodemailer|smtp|twilio|stripe|child_process|Bun\.spawn|spawnSync|execSync|writeFile|unlink|rmSync)\b/.test(code)) return "external";
  return "read";
}

export function describeScript(code: string) {
  const m = code.replace(/^#!.*\n/, "").match(/^\s*(?:\/\/|#(?!!))\s*(?:description:\s*)?(.+)$/m);
  return (m?.[1] || "No description").trim().slice(0, 200);
}

/** The languages a script can be written in, by file extension. */
export type ScriptLang = "ts" | "py" | "sh";
const LANGS: ScriptLang[] = ["ts", "py", "sh"];
/** From its first line: a python or shell shebang; TypeScript (Bun) otherwise. */
export function langOf(code: string, asked?: unknown): ScriptLang {
  if (typeof asked === "string") {
    const a = asked.toLowerCase();
    if (a === "py" || a === "python" || a === "python3") return "py";
    if (a === "sh" || a === "bash" || a === "shell") return "sh";
    if (a === "ts" || a === "typescript" || a === "js" || a === "bun") return "ts";
  }
  const first = code.split("\n", 1)[0];
  if (/^#!.*\bpython/.test(first)) return "py";
  if (/^#!.*\b(ba|z)?sh\b/.test(first)) return "sh";
  return "ts";
}
/** What runs a script of that language. */
function interpreter(lang: ScriptLang): string[] {
  if (lang === "py") return [Bun.which("python3") || "python3", "-I"];
  if (lang === "sh") return [Bun.which("bash") || "/bin/bash"];
  return [process.execPath];
}

/** Keys a script can ask for by name, and the env var it gets. */
export const SCRIPT_KEYS: Record<string, string> = { serper: "SERPER_API_KEY", plaid: "HEARTH_PLAID_KEY" };

export class Scripts {
  readonly repoDir: string;
  readonly ownDir: string;
  readonly workDir: string;

  /**
   * Runs you approved that are going right now, by a one-time token in their env (HEARTH_RUN). hearth-mcp sends it, so
   * an MCP call the run makes is covered by the Approve you already gave that run (no second card).
   */
  private approvedRuns = new Set<string>();
  isApprovedRun(token: string | null | undefined) { return !!token && this.approvedRuns.has(token); }

  /** API keys a script may ask for with a `// needs: serper` header (the hub's vault). Only the named ones are passed. */
  keys: (name: string) => string | null = () => null;
  /** This hub on its own machine, for scripts given a hub key (HEARTH_HUB). Set by the hub. */
  hubUrl: string | null = null;

  constructor(private store: Store, dataDir: string, repoDir = resolve("scripts")) {
    this.repoDir = repoDir;
    this.ownDir = join(dataDir, "scripts");
    this.workDir = join(dataDir, "script-work");
    for (const d of [this.ownDir, this.workDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
  }

  fileFor(s: Pick<Script, "name" | "origin" | "lang">) {
    return join(s.origin === "repo" ? this.repoDir : this.ownDir, `${s.name}.${s.lang || "ts"}`);
  }

  /** Register (or refresh) scripts shipped in the repo's scripts/ folder. */
  async syncRepo() {
    if (!existsSync(this.repoDir)) return;
    const existing = await this.store.all<Script>("scripts");
    for (const file of readdirSync(this.repoDir).filter((f) => /\.(ts|py|sh)$/.test(f))) {
      const name = file.slice(0, -3), lang = file.slice(-2) as ScriptLang;
      if (!NAME_RE.test(name)) continue;
      const code = readFileSync(join(this.repoDir, file), "utf8");
      const prev = existing.find((s) => s.name === name && s.origin === "repo");
      await this.store.put<Script>("scripts", {
        ...(prev || { id: randomUUID(), createdAt: new Date().toISOString() }),
        name, origin: "repo", lang, status: "approved", sha256: sha256(code), description: describeScript(code), effects: detectEffects(code),
      });
    }
  }

  async list() { return this.store.all<Script>("scripts"); }

  async byName(name: string) {
    return (await this.list()).find((s) => s.name === name) || null;
  }

  code(s: Script) {
    const file = this.fileFor(s);
    return existsSync(file) ? readFileSync(file, "utf8") : "";
  }

  /** lang: "ts" (Bun, the default), "py" (python3) or "sh" (bash); a shebang on the first line works too. */
  async propose(input: { name?: unknown; description?: unknown; code?: unknown; lang?: unknown }) {
    const name = String(input.name || "").toLowerCase();
    const code = typeof input.code === "string" ? input.code : "";
    if (!NAME_RE.test(name)) return { error: "Script name must be lowercase letters, digits and dashes." };
    if (!code.trim() || code.length > 20000) return { error: "Script code is empty or too long." };
    const existing = await this.byName(name);
    if (existing?.origin === "repo") return { error: `A repo script called ${name} already exists.` };
    const lang = langOf(code, input.lang);
    // One file per script: a rewrite in another language drops the old file.
    for (const l of LANGS) if (l !== lang) rmSync(join(this.ownDir, `${name}.${l}`), { force: true });
    const file = join(this.ownDir, `${name}.${lang}`);
    writeFileSync(file, code, { mode: 0o600 });
    const description = typeof input.description === "string" ? input.description.slice(0, 200) : describeScript(code);
    const s = await this.store.put<Script>("scripts", {
      ...(existing || { id: randomUUID(), createdAt: new Date().toISOString() }),
      name, origin: "assistant", lang, status: "proposed", sha256: sha256(code), description, effects: detectEffects(code),
    });
    return { value: s };
  }

  /** The app sends the hash of the code you read, so you approve exactly what you saw. */
  async approve(id: string, seenSha: string) {
    const s = await this.store.get<Script>("scripts", id);
    if (!s) return { error: "No such script." };
    const current = sha256(this.code(s));
    if (current !== seenSha) return { error: "The script changed since you opened it. Reload and review again." };
    return { value: await this.store.put("scripts", { ...s, status: "approved" as const, sha256: current, updatedAt: new Date().toISOString() }) };
  }

  /** Deletes an assistant-written script (file and record). Repo scripts are yours and are never removed. */
  async remove(id: string) {
    const s = await this.store.get<Script>("scripts", id);
    if (!s || s.origin === "repo") return false;
    rmSync(this.fileFor(s), { force: true });
    return this.store.remove("scripts", id);
  }

  async reject(id: string) {
    const s = await this.store.get<Script>("scripts", id);
    if (!s) return { error: "No such script." };
    return { value: await this.store.put("scripts", { ...s, status: "rejected" as const }) };
  }

  /**
   * Runs an approved script. Scripts with external effects only run with `approvedRun` set, which the hub
   * sets only after you tap Approve on that specific run.
   */
  /** `// needs: serper` -> SERPER_API_KEY, when the key is connected. Nothing else from the vault reaches a script. */
  private neededKeys(code: string): Record<string, string> {
    const out: Record<string, string> = {};
    const m = /^\s*(?:\/\/|#)\s*needs:\s*([a-z, -]+)$/m.exec(code);
    for (const n of (m?.[1] || "").split(/[ ,]+/).filter((x) => SCRIPT_KEYS[x])) { const v = this.keys(n); if (v) out[SCRIPT_KEYS[n]] = v; }
    // plaid: call it as  curl -H "X-Hearth-Agent: $HEARTH_PLAID_KEY" "$HEARTH_HUB/api/agent/plaid?a=transactions&a=--days&a=3"
    if (out.HEARTH_PLAID_KEY && this.hubUrl) out.HEARTH_HUB = this.hubUrl;
    return out;
  }

  /**
   * opts.event: the pipeline event this run is for. The script gets it whole, as JSON on stdin and in HEARTH_EVENT
   * ({id, source, variables, payload, receivedAt, test}), so it can work on the object in any language.
   */
  async run(name: string, args: string[] = [], opts: { approvedRun?: boolean; timeoutMs?: number; last?: string; event?: unknown; cap?: number } = {}): Promise<{ ok: boolean; output: string; needsApproval?: boolean }> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const s = await this.byName(name);
    if (!s) return { ok: false, output: `No script called ${name}.` };
    if (s.status !== "approved") return { ok: false, output: `Script ${name} is waiting for your approval.` };
    if ((s.effects ?? "external") === "external" && !opts.approvedRun) {
      return { ok: false, needsApproval: true, output: `Script ${name} can change things outside the hub, so it needs your Approve for this run.` };
    }
    const file = this.fileFor(s);
    const code = existsSync(file) ? readFileSync(file) : null;
    if (!code || sha256(code) !== s.sha256) {
      await this.store.put("scripts", { ...s, status: "proposed" as const });
      return { ok: false, output: `Script ${name} changed after approval; it needs approving again.` };
    }
    try { chmodSync(this.workDir, 0o700); } catch {}
    const runToken = opts.approvedRun ? randomUUID() : null;
    if (runToken) this.approvedRuns.add(runToken);
    try {
      const event = opts.event === undefined ? null : JSON.stringify(opts.event);
      const proc = Bun.spawn([...interpreter(s.lang || "ts"), file, ...args.map(String)], {
        cwd: this.workDir,
        // HEARTH_LAST: what this script printed last time, for check hooks (so it can say only what's new).
        env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: this.workDir, LANG: process.env.LANG || "en_US.UTF-8", TZ: process.env.TZ || "", ...(opts.last !== undefined ? { HEARTH_LAST: opts.last } : {}), ...this.neededKeys(code.toString()), ...(runToken ? { HEARTH_RUN: runToken } : {}), ...(event !== null ? { HEARTH_EVENT: event } : {}) },
        stdin: event !== null ? new TextEncoder().encode(event) : "ignore", stdout: "pipe", stderr: "pipe",
      });
      const timer = setTimeout(() => proc.kill(), timeoutMs);
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      const code2 = await proc.exited;
      clearTimeout(timer);
      const output = (out + (code2 !== 0 && err ? `\n[stderr]\n${err}` : "")).trim().slice(0, opts.cap ?? OUTPUT_CAP) || "(no output)";
      await this.store.put("scripts", { ...s, lastRunAt: new Date().toISOString(), lastResult: output.slice(0, 500) });
      return { ok: code2 === 0, output };
    } finally { if (runToken) this.approvedRuns.delete(runToken); }
  }
}
