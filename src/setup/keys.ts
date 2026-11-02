import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The SSH key for a server hub. In the setup window you pick the key file like any upload; the page sends its text
// here and it's kept as a private copy in ~/.hearth/ssh (owner-only, which ssh insists on; a .pem downloaded from a
// cloud console is readable by everyone). Nothing scans your folders.

export const expandHome = (p: string) => p.replace(/^~(?=\/|$)/, homedir());
export const keyDir = () => join(homedir(), ".hearth", "ssh");

/** Keep an uploaded private key. Returns its path, or an error if it isn't a private key. */
export function saveKey(name: string, text: string, dir = keyDir()): { path: string } | { error: string } {
  if (text.length > 20_000 || !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
    return { error: /^ssh-|-----BEGIN [A-Z ]*PUBLIC KEY/.test(text.trim()) ? "That's the public key (.pub). Choose the private one, without .pub." : "That file isn't an SSH private key." };
  }
  const safe = (name.split(/[\\/]/).pop() || "key").replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "") || "key";
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, safe);
  writeFileSync(path, text.endsWith("\n") ? text : text + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return { path };
}

/** ssh refuses a key others can read (a path typed into the CLI). Make it owner-only; true if it had to change. */
export function tightenKey(path: string): boolean {
  const p = expandHome(path);
  try {
    if ((statSync(p).mode & 0o077) === 0) return false;
    chmodSync(p, 0o600);
    return true;
  } catch { return false; }
}

// What you'd typed into the setup window, so closing it (or the app) doesn't lose it. Only the form: no keys or tokens,
// just the path of the key copy kept above. Removed once setup finishes.
export const draftPath = () => join(homedir(), ".hearth", "setup-draft.json");
const DRAFT_FIELDS = ["host", "user", "key", "keyName", "domain", "email", "skipDns", "lan"] as const;

export function readDraft(path = draftPath()): Record<string, unknown> | null {
  try {
    const d = JSON.parse(readFileSync(path, "utf8"));
    if (d?.f?.key && !existsSync(expandHome(String(d.f.key)))) { d.f.key = ""; d.f.keyName = ""; }
    return d;
  } catch { return null; }
}

export function writeDraft(d: any, path = draftPath()) {
  const f: Record<string, unknown> = {};
  for (const k of DRAFT_FIELDS) if (d?.f?.[k] !== undefined) f[k] = typeof d.f[k] === "boolean" ? d.f[k] : String(d.f[k]).slice(0, 500);
  const clean = { step: Math.min(1, Math.max(0, Number(d?.step) || 0)), where: d?.where === "remote" ? "remote" : "local",
    picked: Array.isArray(d?.picked) ? d.picked.filter((b: unknown) => b === "claude" || b === "codex") : [], f };
  mkdirSync(join(homedir(), ".hearth"), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(clean, null, 2), { mode: 0o600 });
}

export const clearDraft = (path = draftPath()) => rmSync(path, { force: true });

// A finished setup: which hub it made, so reopening the app goes to that hub instead of starting setup over. Holds the
// server's address and the path of the key copy (no secrets). "Run setup again" removes it.
export const finishedPath = () => join(homedir(), ".hearth", "setup-done.json");
export type Finished = { where: "local" | "remote"; url: string; pair?: string | null; at: string; remote?: { host: string; user: string; key?: string; domain: string } };
export function writeFinished(d: Finished, path = finishedPath()) {
  mkdirSync(join(homedir(), ".hearth"), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(d, null, 2), { mode: 0o600 });
}
export function readFinished(path = finishedPath()): Finished | null { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } }
export const clearFinished = (path = finishedPath()) => rmSync(path, { force: true });
