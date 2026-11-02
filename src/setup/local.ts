import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { BRAIN_LABELS, detectBrains, isBrainId, type BrainId } from "../brains/logins.ts";
import { pairLink, srcDir, waitFor, type Emit } from "./steps.ts";

// This Mac as the hub: nothing is copied (it uses the logins already here), its settings go in hub.env, and it starts
// at every login (a LaunchAgent).

export type LocalOpts = { brains: BrainId[]; dataDir?: string; port?: number; lan?: boolean; service?: boolean; src?: string; bin?: string[] };

export const localDataDir = () => (platform() === "darwin" ? join(homedir(), "Library", "Application Support", "Hearth") : join(homedir(), ".local", "share", "hearth"));
const LABEL = "com.hearth.hub";

/** How to start the hub here: the Mac app's own binary, else bun + this checkout. */
function startCommand(o: LocalOpts) {
  return o.bin ?? [process.execPath, ...(process.execPath.endsWith("bun") ? [join(srcDir(o.src), "src", "cli.ts")] : []), "start"];
}

export async function installLocal(o: LocalOpts, emit: Emit): Promise<{ url: string; pair: string | null }> {
  if (!o.brains.length || !(o.brains as string[]).every(isBrainId)) { emit({ step: "check", state: "fail", text: "Pick at least one brain." }); throw new Error("Pick at least one brain."); }
  const dataDir = o.dataDir ?? localDataDir();
  const port = o.port ?? 8790;
  const url = `http://127.0.0.1:${port}`;

  emit({ step: "brains", state: "start", text: "Checking your brains on this Mac" });
  const found = detectBrains();
  for (const b of o.brains) {
    const d = found.find((x) => x.id === b)!;
    if (!d.installed) emit({ step: "brains", state: "warn", text: `${d.label} isn't installed here.` });
    else if (!d.loggedIn) emit({ step: "brains", state: "warn", text: `${d.label} isn't signed in here. Run \`${b === "claude" ? "claude" : "codex login"}\` once.` });
  }
  emit({ step: "brains", state: "ok", text: "This Mac is the hub, so it uses the logins already here. Nothing is copied." });

  emit({ step: "data", state: "start", text: `Hub data in ${dataDir}` });
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const env: Record<string, string> = { HEARTH_TARGET: "local", HEARTH_DATA: dataDir, HEARTH_PORT: String(port), HEARTH_HOST: o.lan ? "0.0.0.0" : "127.0.0.1",
    // Live Claude usage from the Keychain login (macOS asks once; choose Always Allow).
    ...(o.brains.includes("claude") && platform() === "darwin" ? { HEARTH_CLAUDE_USAGE_KEYCHAIN: "1" } : {}) };
  writeFileSync(join(dataDir, "hub.env"), Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  emit({ step: "data", state: "ok", text: o.lan ? "Your phone can reach it on this Wi-Fi (plain http: only on a network you trust)." : "Only this Mac can reach it." });

  if (o.service !== false && platform() === "darwin") {
    emit({ step: "service", state: "start", text: "Starting the hub, and at every login" });
    const plist = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
    const cmd = startCommand(o);
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${cmd.map((c) => `<string>${c.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string>`).join("")}</array>
  <key>WorkingDirectory</key><string>${srcDir(o.src)}</string>
  <key>EnvironmentVariables</key><dict>${Object.entries({ ...env, PATH: `${join(homedir(), ".local", "bin")}:${join(homedir(), ".bun", "bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` }).map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join("")}</dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(dataDir, "hub.log")}</string><key>StandardErrorPath</key><string>${join(dataDir, "hub.log")}</string>
</dict></plist>
`;
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plist, xml);
    Bun.spawnSync(["launchctl", "bootout", `gui/${process.getuid?.()}/${LABEL}`], { stdout: "ignore", stderr: "ignore" });
    const r = Bun.spawnSync(["launchctl", "bootstrap", `gui/${process.getuid?.()}`, plist], { stderr: "pipe" });
    if (r.exitCode !== 0) { const t = `launchctl: ${r.stderr.toString().trim()}`; emit({ step: "service", state: "fail", text: t }); throw new Error(t); }
  } else {
    emit({ step: "service", state: "start", text: "Starting the hub" });
    const p = Bun.spawn(startCommand(o), { cwd: srcDir(o.src), env: { ...process.env, ...env }, stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    p.unref();
  }
  const up = await waitFor(`${url}/api/health`, 30_000);
  if (!up) { const t = `The hub didn't start. See ${join(dataDir, "hub.log")}.`; emit({ step: "service", state: "fail", text: t }); throw new Error(t); }
  emit({ step: "service", state: "ok", text: `Hub running at ${url}` });

  emit({ step: "pick", state: "start", text: `Picking brains: ${o.brains.map((b) => BRAIN_LABELS[b]).join(", ")}` });
  const cli = [...startCommand(o).slice(0, -1)];
  const pick = Bun.spawnSync([...cli, "brains", "pick", o.brains.join(","), "--json"], { cwd: srcDir(o.src), env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  emit(pick.exitCode === 0 ? { step: "pick", state: "ok", text: o.brains.length > 1 ? "Each job goes to the brain with the most room on its plan" : "Brain set" }
    : { step: "pick", state: "warn", text: (pick.stdout.toString() + pick.stderr.toString()).trim().slice(-200) });

  const pairOut = Bun.spawnSync([...cli, "setup"], { cwd: srcDir(o.src), env: { ...process.env, ...env, HEARTH_PUBLIC_URL: url }, stdout: "pipe", stderr: "pipe" }).stdout.toString();
  const link = pairLink(pairOut);
  emit({ step: "done", state: "done", text: `Hearth is ready at ${url}`, data: { url, pair: link } });
  return { url, pair: link };
}

/** Read hub.env (the local hub's settings) into process.env, so `hearth …` here talks to that hub. */
export function loadLocalEnv(dataDir = localDataDir()) {
  const f = join(dataDir, "hub.env");
  if (!existsSync(f)) return false;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
  return true;
}

