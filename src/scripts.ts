import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
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
  if (/^\s*\/\/\s*effects:\s*external/m.test(code)) return "external";
  if (/method\s*:\s*["'`](POST|PUT|PATCH|DELETE)["'`]/i.test(code)) return "external";
  if (/\b(sendmail|nodemailer|smtp|twilio|stripe|child_process|Bun\.spawn|spawnSync|execSync|writeFile|unlink|rmSync)\b/.test(code)) return "external";
  return "read";
}

export function describeScript(code: string) {
  const m = code.match(/^\s*\/\/\s*(?:description:\s*)?(.+)$/m);
  return (m?.[1] || "No description").trim().slice(0, 200);
}

export class Scripts {
  readonly repoDir: string;
  readonly ownDir: string;
  readonly workDir: string;

  constructor(private store: Store, dataDir: string, repoDir = resolve("scripts")) {
    this.repoDir = repoDir;
    this.ownDir = join(dataDir, "scripts");
    this.workDir = join(dataDir, "script-work");
    for (const d of [this.ownDir, this.workDir]) mkdirSync(d, { recursive: true, mode: 0o700 });
  }

  fileFor(s: Pick<Script, "name" | "origin">) {
    return join(s.origin === "repo" ? this.repoDir : this.ownDir, `${s.name}.ts`);
  }

  /** Register (or refresh) scripts shipped in the repo's scripts/ folder. */
  async syncRepo() {
    if (!existsSync(this.repoDir)) return;
    const existing = await this.store.all<Script>("scripts");
    for (const file of readdirSync(this.repoDir).filter((f) => f.endsWith(".ts"))) {
      const name = file.slice(0, -3);
      if (!NAME_RE.test(name)) continue;
      const code = readFileSync(join(this.repoDir, file), "utf8");
      const prev = existing.find((s) => s.name === name && s.origin === "repo");
      await this.store.put<Script>("scripts", {
        ...(prev || { id: randomUUID(), createdAt: new Date().toISOString() }),
        name, origin: "repo", status: "approved", sha256: sha256(code), description: describeScript(code), effects: detectEffects(code),
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

  async propose(input: { name?: unknown; description?: unknown; code?: unknown }) {
    const name = String(input.name || "").toLowerCase();
    const code = typeof input.code === "string" ? input.code : "";
    if (!NAME_RE.test(name)) return { error: "Script name must be lowercase letters, digits and dashes." };
    if (!code.trim() || code.length > 20000) return { error: "Script code is empty or too long." };
    const existing = await this.byName(name);
    if (existing?.origin === "repo") return { error: `A repo script called ${name} already exists.` };
    const file = join(this.ownDir, `${name}.ts`);
    writeFileSync(file, code, { mode: 0o600 });
    const description = typeof input.description === "string" ? input.description.slice(0, 200) : describeScript(code);
    const s = await this.store.put<Script>("scripts", {
      ...(existing || { id: randomUUID(), createdAt: new Date().toISOString() }),
      name, origin: "assistant", status: "proposed", sha256: sha256(code), description, effects: detectEffects(code),
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

  async reject(id: string) {
    const s = await this.store.get<Script>("scripts", id);
    if (!s) return { error: "No such script." };
    return { value: await this.store.put("scripts", { ...s, status: "rejected" as const }) };
  }

  /**
   * Runs an approved script. Scripts with external effects only run with `approvedRun` set, which the hub
   * sets only after you tap Approve on that specific run.
   */
  async run(name: string, args: string[] = [], opts: { approvedRun?: boolean; timeoutMs?: number } = {}): Promise<{ ok: boolean; output: string; needsApproval?: boolean }> {
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
    const proc = Bun.spawn([process.execPath, file, ...args.map(String)], {
      cwd: this.workDir,
      env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: this.workDir, LANG: process.env.LANG || "en_US.UTF-8", TZ: process.env.TZ || "" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code2 = await proc.exited;
    clearTimeout(timer);
    const output = (out + (code2 !== 0 && err ? `\n[stderr]\n${err}` : "")).trim().slice(0, OUTPUT_CAP) || "(no output)";
    await this.store.put("scripts", { ...s, lastRunAt: new Date().toISOString(), lastResult: output.slice(0, 500) });
    return { ok: code2 === 0, output };
  }
}
