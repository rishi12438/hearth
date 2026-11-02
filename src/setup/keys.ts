import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
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
