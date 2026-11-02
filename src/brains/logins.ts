import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

// The brains Hearth supports (Claude Code and Codex), what's installed here, and getting their logins onto a hub.
//
// A hub on this machine just uses the logins already here. A hub on a server gets long-lived copies, the way Enkidu
// signs in its cloud agents:
//   Claude Code  `claude setup-token` (you approve once in the browser; lasts about a year). The token is caught from
//                the command's own output, never written to disk or shown, and goes to the hub, which passes it to
//                every `claude` run as CLAUDE_CODE_OAUTH_TOKEN.
//   Codex        ~/.codex/auth.json. Codex renews it itself and rotates the refresh token, so copies are compared by
//                `last_refresh` and the newest wins; otherwise one side's renewal would sign the other out.

export const BRAIN_IDS = ["claude", "codex"] as const;
export type BrainId = (typeof BRAIN_IDS)[number];
export const isBrainId = (x: unknown): x is BrainId => typeof x === "string" && (BRAIN_IDS as readonly string[]).includes(x);
export const BRAIN_LABELS: Record<BrainId, string> = { claude: "Claude Code", codex: "Codex" };

/** Where a hub keeps the long-lived Claude token copied up to it (0600, outside the data folder like the master key). */
export function claudeTokenFile(home = homedir()) { return join(home, ".hearth", "claude-token.json"); }
export function codexAuthFile(home = homedir(), env: Record<string, string | undefined> = process.env) {
  return join(env.CODEX_HOME || join(home, ".codex"), "auth.json");
}

export type Detected = { id: BrainId; label: string; installed: boolean; path: string | null; version: string | null; loggedIn: boolean; how: string | null };

function version(cmd: string): string | null {
  try {
    const r = Bun.spawnSync([cmd, "--version"], { stdout: "pipe", stderr: "ignore", timeout: 8000 });
    const out = r.stdout.toString().trim().split("\n")[0];
    return r.exitCode === 0 && out ? (out.match(/\d+\.\d+(\.\d+)?/)?.[0] ?? out.slice(0, 40)) : null;
  } catch { return null; }
}

/** Is Claude signed in here? Never reads the secret itself (a Keychain read prompts on a Mac). */
export function claudeLoggedIn(home = homedir(), env: Record<string, string | undefined> = process.env): string | null {
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return "CLAUDE_CODE_OAUTH_TOKEN";
  if (existsSync(claudeTokenFile(home))) return "long-lived token";
  if (existsSync(join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), ".credentials.json"))) return "Claude login";
  if (env.ANTHROPIC_API_KEY) return "API key";
  if (platform() === "darwin" && Bun.spawnSync(["security", "find-generic-password", "-s", "Claude Code-credentials"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0) return "Claude login (Keychain)";
  return null;
}

export function codexLoggedIn(home = homedir(), env: Record<string, string | undefined> = process.env): string | null {
  try {
    const j = JSON.parse(readFileSync(codexAuthFile(home, env), "utf8"));
    if (j?.tokens?.refresh_token || j?.tokens?.access_token) return "ChatGPT login";
    if (j?.OPENAI_API_KEY) return "API key";
  } catch {}
  return env.OPENAI_API_KEY ? "API key" : null;
}

/** Claude Code and Codex on this machine: installed, which version, signed in. */
export function detectBrains(opts: { home?: string; env?: Record<string, string | undefined>; which?: (c: string) => string | null; version?: (c: string) => string | null } = {}): Detected[] {
  const which = opts.which ?? ((c: string) => Bun.which(c));
  const ver = opts.version ?? version;
  const home = opts.home ?? homedir();
  const env = opts.env ?? process.env;
  return BRAIN_IDS.map((id) => {
    const path = which(id);
    const how = id === "claude" ? claudeLoggedIn(home, env) : codexLoggedIn(home, env);
    return { id, label: BRAIN_LABELS[id], installed: !!path, path, version: path ? ver(id) : null, loggedIn: !!path && !!how, how: path ? how : null };
  });
}

// ---------- Claude: a long-lived token ----------

const TOKEN_RE = /sk-ant-oat\d*-[A-Za-z0-9_-]{20,}/g;
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07|\r/g;

/** Replace every Claude token in some text with [redacted]. */
export function redactTokens(text: string) { return text.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "[redacted]"); }
/** The last Claude OAuth token in a terminal transcript, ignoring colours and line wraps. */
export function tokenInTranscript(text: string): string | null {
  const clean = text.replace(ANSI_RE, "");
  const all = clean.match(TOKEN_RE) || clean.replace(/\n/g, "").match(TOKEN_RE) || [];
  return all.at(-1) ?? null;
}
export const looksLikeClaudeToken = (t: string) => /^sk-ant-oat\d*-[A-Za-z0-9_-]{20,}$/.test(t.trim());

/**
 * Run `claude setup-token` in a terminal of its own (`script`, transcript to /dev/null, very wide so the token never
 * wraps) and catch the token from its output. `show` gets the output with the token redacted. Null if none came out.
 */
export async function mintClaudeToken(show: (text: string) => void = (t) => process.stdout.write(t), opts: { stdin?: "inherit" | "ignore" } = {}): Promise<string | null> {
  if (!Bun.which("claude")) throw new Error("Claude Code isn't installed on this computer.");
  const inner = "stty cols 2000 2>/dev/null; exec claude setup-token";
  const cmd = platform() === "darwin" ? ["script", "-q", "/dev/null", "sh", "-c", inner] : ["script", "-q", "-c", inner, "/dev/null"];
  const proc = Bun.spawn(cmd, { stdin: opts.stdin ?? "inherit", stdout: "pipe", stderr: "ignore" });
  let all = "", held = "";
  const dec = new TextDecoder();
  for await (const chunk of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
    const text = dec.decode(chunk, { stream: true });
    all += text;
    // Hold back anything that might be the start of a token until it's certain, so a token split across reads never shows.
    const pending = redactTokens(held + text);
    const cut = pending.lastIndexOf("sk-");
    const safe = cut >= 0 && !/[^A-Za-z0-9_-]/.test(pending.slice(cut + 3)) ? cut : pending.length;
    show(pending.slice(0, safe));
    held = pending.slice(safe);
  }
  if (held) show(redactTokens(held));
  await proc.exited;
  return tokenInTranscript(all);
}

/** Put a long-lived Claude token where this hub's brain runs find it. */
export function saveClaudeToken(token: string, home = homedir()) {
  const t = token.trim();
  if (!looksLikeClaudeToken(t)) throw new Error("That isn't a Claude token (it starts with sk-ant-oat). Run `claude setup-token` to make one.");
  writePrivate(claudeTokenFile(home), JSON.stringify({ token: t, savedAt: new Date().toISOString() }));
}
export function readClaudeToken(home = homedir()): string | null {
  try { const t = JSON.parse(readFileSync(claudeTokenFile(home), "utf8"))?.token; return typeof t === "string" && t ? t : null; } catch { return null; }
}

// ---------- Codex: auth.json, newest wins ----------

/** When Codex last renewed this login (ms), or 0. */
export function lastRefresh(authJson: string): number {
  try { const t = Date.parse(JSON.parse(authJson)?.last_refresh); return Number.isFinite(t) ? t : 0; } catch { return 0; }
}
export function readCodexAuth(home = homedir(), env: Record<string, string | undefined> = process.env): string | null {
  try { return readFileSync(codexAuthFile(home, env), "utf8"); } catch { return null; }
}

/** Take a Codex login unless the one here is newer. Returns "saved", "kept-newer" (ours wins) or throws on junk. */
export function saveCodexAuth(data: string, home = homedir(), env: Record<string, string | undefined> = process.env): "saved" | "kept-newer" {
  let j: any;
  try { j = JSON.parse(data); } catch { throw new Error("That isn't a Codex auth.json."); }
  if (!j?.tokens?.refresh_token && !j?.tokens?.access_token && !j?.OPENAI_API_KEY) throw new Error("That auth.json has no Codex login in it. Run `codex login` first.");
  const cur = readCodexAuth(home, env);
  if (cur && lastRefresh(cur) > lastRefresh(data)) return "kept-newer";
  writePrivate(codexAuthFile(home, env), data);
  return "saved";
}

/** Take a brain's login off this machine (only the copies Hearth wrote: the token file; Codex's auth.json if asked). */
export function removeLogin(id: BrainId, home = homedir(), env: Record<string, string | undefined> = process.env) {
  if (id === "claude") rmSync(claudeTokenFile(home), { force: true });
  else rmSync(codexAuthFile(home, env), { force: true });
}

function writePrivate(path: string, data: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}
