import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Share } from "./types.ts";

// Where a shared teammate's box runs. Always a sandbox, your choice of which (like cloud computers in Settings → Devices):
//   docker  a container on this machine: internal network, egress only to the Claude API, a gateway on 127.0.0.1
//   e2b     an E2B cloud sandbox: its own VM, nowhere near your hub's disk
// Either way the hub talks to the box over HTTP with the link's secret, and pulls its outbox; the box can't call the hub.

export type SandboxKind = "docker" | "e2b";
/** What a box gets in its environment: the Claude key (API key or `claude setup-token` token) and its link secret. */
export type BoxEnv = { key: string; secret: string };

export interface Sandbox {
  readonly kind: SandboxKind;
  start(s: Share, bundleDir: string, env: BoxEnv): Promise<Partial<Share>>;
  stop(s: Share): Promise<void>;
  remove(s: Share): Promise<void>;
  /** Base URL for a link's box (the hub adds the path and the secret). */
  url(s: Share): string | null;
  /** Push a new bundle (E2B; Docker mounts the bundle folder read-only, so it sees changes itself). */
  sync?(s: Share, bundleDir: string): Promise<void>;
  /** A paused box, woken for a visitor. */
  wake?(s: Share, env: BoxEnv): Promise<Partial<Share>>;
  shutdown?(): void;
}

const REPO = resolve(import.meta.dir, "..");
const keyVar = (key: string) => (key.startsWith("sk-ant-oat") ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY");
const SAFE = /^[A-Za-z0-9_-]{16,400}$/;

/** Is the box answering? */
export async function ping(url: string | null, secret: string, ms = 2500) {
  if (!url) return false;
  try { return (await fetch(`${url}/api/info`, { headers: { "X-Box-Secret": secret }, signal: AbortSignal.timeout(ms) })).ok; }
  catch { return false; }
}

const sh = (cmd: string[], opts: { stdin?: string } = {}) => {
  const r = Bun.spawnSync(cmd, { stdin: opts.stdin ? new TextEncoder().encode(opts.stdin) : undefined, env: { PATH: process.env.PATH || "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", HOME: process.env.HOME || "/tmp", DOCKER_HOST: process.env.DOCKER_HOST || "" } });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
};

/**
 * Docker. Two ways to drive it, same containers and flags either way:
 *   helper  a server where the hub has no Docker access: `hearth-boxctl` (root, systemd path unit) does it on request
 *   direct  a machine where the hub's user can run Docker (your Mac with Docker Desktop)
 */
export class DockerSandbox implements Sandbox {
  readonly kind = "docker" as const;
  readonly mode: "helper" | "direct";
  constructor(private dataDir: string, private opts: { mode?: "helper" | "direct"; gatewayPort?: number; boxesRoot?: string; image?: string } = {}) {
    this.mode = opts.mode ?? (sh(["docker", "info", "--format", "{{.ServerVersion}}"]).ok ? "direct" : "helper");
  }
  static available() { return sh(["docker", "info", "--format", "{{.ServerVersion}}"]).ok || existsSync("/usr/local/sbin/hearth-boxctl"); }
  private get port() { return this.opts.gatewayPort ?? Number(process.env.HEARTH_BOX_GATEWAY_PORT || 18790); }
  private get image() { return this.opts.image ?? "hearth-box:latest"; }
  private boxDir(s: Share) { return this.mode === "helper" ? join(this.opts.boxesRoot ?? "/var/lib/hearth-boxes", s.id) : join(this.dataDir, "boxes", s.id); }
  url(s: Share) { return `http://127.0.0.1:${this.port}/b/${s.id}`; }

  async start(s: Share, bundleDir: string, env: BoxEnv) {
    if (!SAFE.test(env.key) || !SAFE.test(env.secret)) throw new Error("Add a Claude key for shared links first (Settings → Shared links).");
    // The env file only ever holds the key and the secret; the helper re-checks every line before using it.
    const envFile = join(this.dataDir, "shares", s.id, "box.env");
    writeFileSync(envFile, `${keyVar(env.key)}=${env.key}\nBOX_SECRET=${env.secret}\n`, { mode: 0o600 });
    if (this.mode === "helper") this.request("start", s.id);
    else this.runDirect(s, bundleDir, envFile);
    for (let i = 0; i < 120; i++) { if (await ping(this.url(s), env.secret, 1500)) return {}; await Bun.sleep(500); }
    throw new Error(this.mode === "helper" ? "The box didn't start. Check `journalctl -u hearth-boxctl` on the server." : "The box didn't start. Check `docker logs hearth-box-" + s.id + "`.");
  }

  private request(action: "start" | "stop" | "remove", id: string) {
    const dir = join(this.dataDir, "boxctl");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = `${Date.now()}-${randomUUID()}.json`;
    writeFileSync(join(dir, `.${name}`), JSON.stringify({ action, id }));
    renameSync(join(dir, `.${name}`), join(dir, name)); // the helper only sees complete files
  }

  /** Same network, gateway and flags as hearth-boxctl, for a machine where the hub can run Docker itself. */
  private runDirect(s: Share, bundleDir: string, envFile: string) {
    if (!sh(["docker", "image", "inspect", this.image]).ok) {
      const b = sh(["docker", "build", "-q", "-t", this.image, "-f", join(REPO, "deploy/box.Dockerfile"), REPO]);
      if (!b.ok) throw new Error(`Couldn't build the box image: ${b.err.slice(-200)}`);
    }
    if (!sh(["docker", "network", "inspect", "hearth-boxes"]).ok) sh(["docker", "network", "create", "--internal", "hearth-boxes"]);
    const locked = ["--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "10001:10001"];
    const running = (n: string) => sh(["docker", "inspect", "-f", "{{.State.Running}}", n]).out === "true";
    if (!running("hearth-egress")) {
      sh(["docker", "rm", "-f", "hearth-egress"]);
      sh(["docker", "run", "-d", "--name", "hearth-egress", "--restart", "unless-stopped", ...locked, "--pids-limit", "64", "--memory", "64m", "--cpus", "0.25", "--entrypoint", "bun", this.image, "src/public/egress.ts"]);
      sh(["docker", "network", "connect", "hearth-boxes", "hearth-egress"]);
    }
    if (!running("hearth-gateway")) {
      sh(["docker", "rm", "-f", "hearth-gateway"]);
      const g = sh(["docker", "run", "-d", "--name", "hearth-gateway", "--restart", "unless-stopped", ...locked, "--pids-limit", "64", "--memory", "64m", "--cpus", "0.25",
        "-p", `127.0.0.1:${this.port}:8080`, "--entrypoint", "bun", this.image, "src/public/gateway.ts"]);
      if (!g.ok) throw new Error(`Couldn't start the gateway: ${g.err.slice(-200)}`);
      sh(["docker", "network", "connect", "hearth-boxes", "hearth-gateway"]);
    }
    const dir = this.boxDir(s);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o777); // the box runs as uid 10001; the hub's data folder above it stays 0700
    sh(["docker", "rm", "-f", `hearth-box-${s.id}`]);
    const r = sh(["docker", "run", "-d", "--name", `hearth-box-${s.id}`, "--label", `hearth.box=${s.id}`, "--restart", "unless-stopped",
      "--network", "hearth-boxes", ...locked, "--tmpfs", "/tmp:size=16m,mode=1777", "--pids-limit", "128", "--memory", "256m", "--cpus", "0.5",
      "-v", `${bundleDir}:/bundle:ro`, "-v", `${dir}:/data`, "--env-file", envFile,
      "-e", "BOX_PORT=8080", "-e", "BOX_PROXY=http://hearth-egress:3128", "-e", "BOX_BUNDLE=/bundle", "-e", "BOX_DATA=/data", this.image]);
    if (!r.ok) throw new Error(`Couldn't start the box: ${r.err.slice(-200)}`);
  }

  async stop(s: Share) { if (this.mode === "helper") this.request("stop", s.id); else sh(["docker", "stop", `hearth-box-${s.id}`]); }
  async remove(s: Share) {
    if (this.mode === "helper") { this.request("remove", s.id); return; }
    sh(["docker", "rm", "-f", `hearth-box-${s.id}`]);
    rmSync(this.boxDir(s), { recursive: true, force: true });
  }
}

/** The bits of the e2b SDK this uses, so tests can stand in for it. */
export type E2bApi = {
  create(apiKey: string, opts: { timeoutMs: number; metadata: Record<string, string> }): Promise<{ sandboxId: string; host: (port: number) => string; run: (cmd: string, stdin?: string) => Promise<{ code: number; stderr: string }> }>;
  connect(apiKey: string, sandboxId: string, timeoutMs: number): Promise<{ sandboxId: string; host: (port: number) => string; run: (cmd: string, stdin?: string) => Promise<{ code: number; stderr: string }> }>;
  pause(apiKey: string, sandboxId: string): Promise<void>;
  kill(apiKey: string, sandboxId: string): Promise<void>;
};

export const realE2bApi: E2bApi = {
  async create(apiKey, opts) {
    const { Sandbox } = await import("e2b");
    return wrap(await Sandbox.create("base", { apiKey, timeoutMs: opts.timeoutMs, metadata: opts.metadata, lifecycle: { onTimeout: { action: "pause", mode: "filesystem" }, autoResume: false } } as any));
  },
  async connect(apiKey, sandboxId, timeoutMs) { const { Sandbox } = await import("e2b"); return wrap(await Sandbox.connect(sandboxId, { apiKey, timeoutMs })); },
  async pause(apiKey, sandboxId) { const { Sandbox } = await import("e2b"); await (Sandbox as any).pause(sandboxId, { apiKey, mode: "filesystem" }); },
  async kill(apiKey, sandboxId) { const { Sandbox } = await import("e2b"); await Sandbox.kill(sandboxId, { apiKey }); },
};

function wrap(sb: any) {
  return {
    sandboxId: sb.sandboxId as string,
    host: (port: number) => sb.getHost(port) as string,
    async run(cmd: string, stdin?: string) {
      const h = await sb.commands.run(cmd, { background: true, stdin: stdin !== undefined, user: "user", timeoutMs: 300_000 });
      if (stdin !== undefined) { await h.sendStdin(stdin); try { await h.closeStdin(); } catch {} }
      try { const r = await h.wait(); return { code: r.exitCode as number, stderr: String(r.stderr || "") }; }
      catch (e: any) { if (typeof e?.exitCode === "number") return { code: e.exitCode, stderr: String(e.stderr || "") }; throw e; }
    },
  };
}

/** A folder as a base64 tar.gz, to send over a command's stdin. */
function tarB64(cwd: string, paths: string[]) {
  const r = Bun.spawnSync(["tar", "-czf", "-", "-C", cwd, ...paths]);
  if (r.exitCode !== 0) throw new Error(`tar failed: ${r.stderr.toString().slice(-200)}`);
  return Buffer.from(r.stdout).toString("base64");
}

/**
 * E2B: one cloud sandbox per link, paused (disk kept) when it times out and woken when a visitor comes back. Uses the
 * E2B key you add for cloud computers. The box can reach the internet from there, but nothing of yours is on that VM
 * except the bundle, and the hub only accepts its outbox through the same checks as Docker.
 */
export class E2bSandbox implements Sandbox {
  readonly kind = "e2b" as const;
  constructor(private apiKey: () => string, private api: E2bApi = realE2bApi, private timeoutMs = 60 * 60_000) {}
  url(s: Share) { return s.sandboxUrl || null; }

  private async install(sb: Awaited<ReturnType<E2bApi["create"]>>, bundleDir: string, env: BoxEnv) {
    const code = tarB64(REPO, ["src/public", "node_modules/@anthropic-ai/sdk", "package.json"]);
    let r = await sb.run(`set -e; mkdir -p ~/box/data ~/box/bundle; base64 -d | tar -xz -C ~/box
      export PATH="$HOME/.bun/bin:$PATH"; command -v bun >/dev/null || curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1`, code);
    if (r.code !== 0) throw new Error(`Couldn't set up the sandbox: ${r.stderr.slice(-200)}`);
    await this.push(sb, bundleDir);
    // The key and secret go over stdin, never into the command line or E2B's logs.
    r = await sb.run(`read -r KEY; read -r SECRET; cd ~/box; export PATH="$HOME/.bun/bin:$PATH"
      pkill -f src/public/box.ts 2>/dev/null || true
      case "$KEY" in sk-ant-oat*) export CLAUDE_CODE_OAUTH_TOKEN="$KEY";; *) export ANTHROPIC_API_KEY="$KEY";; esac
      BOX_SECRET="$SECRET" BOX_PORT=8080 BOX_BUNDLE=~/box/bundle BOX_DATA=~/box/data setsid nohup bun src/public/box.ts > ~/box/box.log 2>&1 < /dev/null &
      sleep 1`, `${env.key}\n${env.secret}\n`);
    if (r.code !== 0) throw new Error(`Couldn't start the box: ${r.stderr.slice(-200)}`);
  }

  private async push(sb: { run: (cmd: string, stdin?: string) => Promise<{ code: number; stderr: string }> }, bundleDir: string) {
    const r = await sb.run("set -e; rm -rf ~/box/bundle.new; mkdir -p ~/box/bundle.new; base64 -d | tar -xz -C ~/box/bundle.new; rm -rf ~/box/bundle.old; [ -d ~/box/bundle ] && mv ~/box/bundle ~/box/bundle.old; mv ~/box/bundle.new ~/box/bundle", tarB64(bundleDir, ["."]));
    if (r.code !== 0) throw new Error(`Couldn't send the bundle: ${r.stderr.slice(-200)}`);
  }

  async start(s: Share, bundleDir: string, env: BoxEnv) {
    if (!this.apiKey()) throw new Error("Add your E2B key first (Settings → Devices → Add a cloud computer).");
    if (!SAFE.test(env.key)) throw new Error("Add a Claude key for shared links first (Settings → Shared links).");
    const sb = s.sandboxId ? await this.api.connect(this.apiKey(), s.sandboxId, this.timeoutMs).catch(() => null) : null;
    const box = sb || await this.api.create(this.apiKey(), { timeoutMs: this.timeoutMs, metadata: { hearth: "share", share: s.id } });
    await this.install(box, bundleDir, env);
    const url = `https://${box.host(8080)}`;
    for (let i = 0; i < 60; i++) { if (await ping(url, env.secret, 3000)) return { sandboxId: box.sandboxId, sandboxUrl: url }; await Bun.sleep(1000); }
    throw new Error("The sandbox started but the box isn't answering.");
  }

  async sync(s: Share, bundleDir: string) {
    if (!s.sandboxId) return;
    const sb = await this.api.connect(this.apiKey(), s.sandboxId, this.timeoutMs);
    await this.push(sb, bundleDir);
  }

  /** E2B paused it (timeout): resume from its kept disk and start the box again. */
  async wake(s: Share, env: BoxEnv) {
    if (!s.sandboxId) throw new Error("No sandbox.");
    const sb = await this.api.connect(this.apiKey(), s.sandboxId, this.timeoutMs);
    const url = `https://${sb.host(8080)}`;
    if (await ping(url, env.secret, 3000)) return { sandboxUrl: url };
    const r = await sb.run(`read -r KEY; read -r SECRET; cd ~/box; export PATH="$HOME/.bun/bin:$PATH"
      case "$KEY" in sk-ant-oat*) export CLAUDE_CODE_OAUTH_TOKEN="$KEY";; *) export ANTHROPIC_API_KEY="$KEY";; esac
      BOX_SECRET="$SECRET" BOX_PORT=8080 BOX_BUNDLE=~/box/bundle BOX_DATA=~/box/data setsid nohup bun src/public/box.ts >> ~/box/box.log 2>&1 < /dev/null &
      sleep 1`, `${env.key}\n${env.secret}\n`);
    if (r.code !== 0) throw new Error(`Couldn't restart the box: ${r.stderr.slice(-200)}`);
    for (let i = 0; i < 30; i++) { if (await ping(url, env.secret, 3000)) return { sandboxUrl: url }; await Bun.sleep(1000); }
    throw new Error("The sandbox woke up but the box isn't answering.");
  }

  async stop(s: Share) { if (s.sandboxId) await this.api.pause(this.apiKey(), s.sandboxId).catch(() => {}); }
  async remove(s: Share) { if (s.sandboxId) await this.api.kill(this.apiKey(), s.sandboxId).catch(() => {}); }
}
