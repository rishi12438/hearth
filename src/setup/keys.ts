import { chmodSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Choosing the SSH key for a server hub: the keys already on this Mac (~/.ssh, and the .pem a cloud console like
// Lightsail puts in Downloads), a Finder dialog to pick any other file, and tightening a key's permissions so ssh
// accepts it (a downloaded .pem is readable by everyone, and ssh refuses those).

export const expandHome = (p: string) => p.replace(/^~(?=\/|$)/, homedir());
const tilde = (p: string) => (p.startsWith(homedir() + "/") ? "~" + p.slice(homedir().length) : p);

/** Private keys found in ~/.ssh and ~/Downloads (by their header, not their name). Paths use ~. */
export function sshKeys(home = homedir()): string[] {
  const found: string[] = [];
  for (const dir of [join(home, ".ssh"), join(home, "Downloads")]) {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (n.endsWith(".pub") || n.startsWith(".")) continue;
      if (dir.endsWith("Downloads") && !/\.(pem|key)$/i.test(n)) continue;
      const p = join(dir, n);
      try {
        if (!statSync(p).isFile() || statSync(p).size > 20_000) continue;
        if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(readFileSync(p, "utf8").slice(0, 200))) found.push(tilde(p));
      } catch {}
    }
  }
  return found;
}

/** A Finder dialog to choose the key file (macOS). Null if cancelled or not on a Mac. */
export async function pickKeyFile(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const start = existsSync(join(homedir(), ".ssh")) ? join(homedir(), ".ssh") : homedir();
  const script = `tell me to activate\nPOSIX path of (choose file with prompt "Choose the SSH key for your server" default location (POSIX file "${start}") with invisibles)`;
  const p = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(p.stdout).text()).trim();
  return (await p.exited) === 0 && out ? tilde(out) : null;
}

/** ssh refuses a key others can read. Make it owner-only; true if it had to change. */
export function tightenKey(path: string): boolean {
  const p = expandHome(path);
  try {
    if ((statSync(p).mode & 0o077) === 0) return false;
    chmodSync(p, 0o600);
    return true;
  } catch { return false; }
}
