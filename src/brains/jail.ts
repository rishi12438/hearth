import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

// The brain's jail (Linux, bubblewrap). Jobs that work (job, legwork, chat, hooks) get a shell, files and the open internet,
// so they can write code that researches in bulk. The jail is what keeps that from reaching the hub's secrets: each run
// sees the machine as usual, except
//   - the data folder is empty (database, vault, keys, WhatsApp, files), apart from the brain's own folder
//   - the hub's .env, ~/.hearth (master key, Claude token) and ~/.ssh read as empty
//   - it has its own process list (a new pid namespace and /proc), so it can't read the hub's environment from /proc
// It keeps the network (the hearth-* tools ask the hub over 127.0.0.1, and the hub keeps the real keys) and its own
// Claude/Codex logins. It runs as the hub's user, so it needs nothing from sudo (the service has NoNewPrivileges).
//
// HEARTH_BRAIN_JAIL=off turns the jail off, and the shell and code tools with it. No bubblewrap (a Mac): no jail, no code.

export type JailPaths = {
  dataDir: string;
  /** The brain's folder (skills, tools, scratch). Stays visible and writable. */
  workDir: string;
  /** Files that read as empty inside (the hub's .env, a master key kept elsewhere). */
  hideFiles?: string[];
  home?: string;
  exists?: (p: string) => boolean;
};

export function jailArgs(p: JailPaths): string[] {
  const home = p.home ?? homedir();
  const exists = p.exists ?? existsSync;
  const data = resolve(p.dataDir), work = resolve(p.workDir);
  const args = ["bwrap", "--die-with-parent", "--unshare-pid", "--bind", "/", "/", "--dev-bind", "/dev", "/dev", "--proc", "/proc", "--tmpfs", data];
  if (work.startsWith(data + "/")) args.push("--bind", work, work);
  for (const d of [join(home, ".hearth"), join(home, ".ssh")]) if (exists(d)) args.push("--tmpfs", d);
  for (const f of new Set((p.hideFiles || []).filter(Boolean).map((f) => resolve(f)))) {
    if (exists(f) && !f.startsWith(data + "/") && !f.startsWith(join(home, ".hearth") + "/")) args.push("--ro-bind", "/dev/null", f);
  }
  args.push("--chdir", work);
  return args;
}

/** Whether brain runs here go in the jail: on Linux with bubblewrap that really works here, unless HEARTH_BRAIN_JAIL=off. */
export function jailWorks(args: string[], env: Record<string, string | undefined> = process.env): boolean {
  if (env.HEARTH_BRAIN_JAIL === "off" || platform() !== "linux" || !Bun.which("bwrap")) return false;
  try {
    const r = Bun.spawnSync([...args, "true"], { stdout: "ignore", stderr: "pipe", timeout: 10_000 });
    if (r.exitCode !== 0) console.warn(`brain jail unavailable, so no shell or code tools: ${r.stderr.toString().trim().slice(0, 200)}`);
    return r.exitCode === 0;
  } catch { return false; }
}
