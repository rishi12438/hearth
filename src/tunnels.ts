import { existsSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";

// Tunnels: a link the user can open (on their phone too) to something an agent made, like a web app it's running on
// 127.0.0.1 or a site it built into a folder. The hub owns each tunnel, not the job: a job runs in a jail whose processes
// all die when the run ends, so a tunnel it started itself would die with it. Each is a Cloudflare quick tunnel
// (cloudflared, no account), so the page gets its own https origin: absolute paths, websockets and dev-server reloads
// work, and it can't touch the hub's own pages or storage.
//
//   hearth-tunnel open <port>      a server the job is running (it lasts while that server answers)
//   hearth-tunnel serve <folder>   a built site in the workspace (the hub serves it; it outlives the job)
//   hearth-tunnel list · close <port|id>
//
// Guard rails: only a port a job's own server listens on (never the hub, its browser's debugging port, or another
// service on the box), only folders in the brains' workspaces, at most MAX_OPEN at once, each closed after MAX_AGE_MS.

export const MAX_OPEN = 6;
export const MAX_AGE_MS = 24 * 3600_000;
const CHECK_EVERY_MS = 30_000;
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export type TunnelWho = { by: string; jobId: string | null; threadId: string | null };
export type Tunnel = TunnelWho & {
  id: string;
  kind: "port" | "folder";
  /** The local port the tunnel points at (for a folder, the hub's own little file server). */
  port: number;
  folder?: string;
  url: string;
  startedAt: number;
};
type Live = Tunnel & { stop: () => void; fails: number };

export type Proc = { exited: Promise<number>; kill: () => void; lines: (onLine: (s: string) => void) => void };
export type TunnelOpts = {
  hubPort: number;
  /** Folders `serve` may share from (the brains' workspaces). */
  roots: string[];
  /** The cloudflared binary, or null when it isn't installed. */
  bin?: () => string | null;
  /** Starts cloudflared (tests swap it). */
  spawn?: (cmd: string[]) => Proc;
  /** Whether something answers HTTP on 127.0.0.1:port, and what (tests swap it). */
  probe?: (port: number) => Promise<{ ok: boolean; devtools?: boolean }>;
  /** Whether that port's listener is a job's (in a jail): true / false, or null when this machine can't tell. */
  inJob?: (port: number) => boolean | null;
  /** Waits until the new link answers (Cloudflare's DNS takes a few seconds). */
  ready?: (url: string) => Promise<void>;
  now?: () => number;
  log?: (s: string) => void;
};

export function findCloudflared(home = homedir()): string | null {
  const w = Bun.which("cloudflared");
  if (w) return w;
  for (const p of ["/usr/local/bin/cloudflared", "/usr/bin/cloudflared", "/opt/homebrew/bin/cloudflared", join(home, ".hearth", "bin", "cloudflared")]) if (existsSync(p)) return p;
  return null;
}

function realSpawn(cmd: string[]): Proc {
  const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  return {
    exited: p.exited,
    kill: () => { try { p.kill(); } catch {} },
    lines: (onLine) => {
      void (async () => {
        const dec = new TextDecoder();
        let buf = "";
        for await (const chunk of p.stderr as any as AsyncIterable<Uint8Array>) {
          buf += dec.decode(chunk, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
          if (buf.length > 10_000) buf = "";
        }
      })().catch(() => {});
    },
  };
}

async function realProbe(port: number): Promise<{ ok: boolean; devtools?: boolean }> {
  const get = async (path: string) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(3000), redirect: "manual" });
    const text = await r.text().catch(() => "");
    return text.slice(0, 4000);
  };
  try { await get("/"); } catch { return { ok: false }; }
  // Chrome's remote debugging port (enkidu-browser's Chrome is signed in to the user's sites): never.
  try { if (/webSocketDebuggerUrl|"Browser"\s*:/.test(await get("/json/version"))) return { ok: true, devtools: true }; } catch {}
  return { ok: true };
}

/** Linux: is the process listening on this port in another pid namespace than the hub's (a job's jail)? */
export function realInJob(port: number): boolean | null {
  if (platform() !== "linux") return null;
  try {
    const p = Bun.spawnSync(["ss", "-Hltnp", `sport = :${port}`], { stdout: "pipe", stderr: "ignore" });
    const pids = [...new TextDecoder().decode(p.stdout).matchAll(/pid=(\d+)/g)].map((m) => m[1]);
    if (!pids.length) return null;
    const mine = readlinkSync("/proc/self/ns/pid");
    return pids.every((pid) => { try { return readlinkSync(`/proc/${pid}/ns/pid`) !== mine; } catch { return false; } });
  } catch { return null; }
}

/**
 * The new name only resolves a few seconds after the link is printed, and a lookup before then is remembered as "no such
 * host" (by Bun, the system resolver, the user's phone): so ask Cloudflare's DNS-over-HTTPS directly, with curl, until the
 * page answers. Nothing on this machine sees the early miss.
 */
async function realReady(url: string) {
  const curl = Bun.which("curl");
  if (!curl) { await Bun.sleep(5000); return; }
  for (let i = 0; i < 25; i++) {
    const p = Bun.spawn([curl, "-s", "-o", "/dev/null", "-m", "5", "--doh-url", "https://1.1.1.1/dns-query", "-w", "%{http_code}", url], { stdout: "pipe", stderr: "ignore" });
    const code = Number((await new Response(p.stdout).text()).trim());
    if (code && code !== 530 && code !== 502) return;
    await Bun.sleep(1000);
  }
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".woff": "font/woff", ".woff2": "font/woff2", ".map": "application/json",
  ".csv": "text/csv; charset=utf-8", ".geojson": "application/geo+json", ".pdf": "application/pdf",
};

/** A file server for one folder on 127.0.0.1: no listings, no dotfiles, nothing outside the folder (symlinks included). */
export function serveFolder(folder: string): { port: number; stop: () => void } {
  const root = realpathSync(folder);
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req) {
      let path: string;
      try { path = decodeURIComponent(new URL(req.url).pathname); } catch { return new Response("Bad path", { status: 400 }); }
      if (path.split("/").some((seg) => seg.startsWith("."))) return new Response("Not found", { status: 404 });
      let file = resolve(root, "." + path);
      try {
        if (statSync(file).isDirectory()) file = join(file, "index.html");
        const real = realpathSync(file);
        if (real !== root && !real.startsWith(root + sep)) return new Response("Not found", { status: 404 });
        return new Response(Bun.file(real), { headers: { "Content-Type": TYPES[extname(real).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" } });
      } catch { return new Response("Not found", { status: 404 }); }
    },
  });
  return { port: server.port!, stop: () => server.stop(true) };
}

export class Tunnels {
  private open = new Map<string, Live>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private o: Required<Omit<TunnelOpts, "log">> & { log: (s: string) => void };

  constructor(opts: TunnelOpts) {
    this.o = {
      bin: () => findCloudflared(), spawn: realSpawn, probe: realProbe, inJob: realInJob, ready: realReady, now: Date.now, log: () => {},
      ...opts,
    } as any;
  }

  list(): Tunnel[] {
    return [...this.open.values()].map(({ stop, fails, ...t }) => t);
  }

  /** The agent's hearth-tunnel command. */
  async agent(argv: string[], who: TunnelWho): Promise<string> {
    const [cmd = "list", arg = ""] = argv;
    if (cmd === "open") return this.openPort(arg, who);
    if (cmd === "serve") return this.serve(arg, who);
    if (cmd === "close") return this.close(arg);
    if (cmd === "list") {
      const all = this.list();
      if (!all.length) return "No tunnels open.";
      return all.map((t) => `${t.id}  ${t.url}  -> ${t.kind === "folder" ? t.folder : `port ${t.port}`}  (${t.by}, ${Math.round((this.o.now() - t.startedAt) / 60_000)} min)`).join("\n");
    }
    return USAGE;
  }

  private async openPort(arg: string, who: TunnelWho): Promise<string> {
    const port = Number(arg.replace(/^.*:/, "").replace(/\/.*$/, ""));
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return `Error: give the port your server listens on (1024-65535), like hearth-tunnel open 5173.\n${USAGE}`;
    if (port === this.o.hubPort) return "Error: that's the hub itself; it can't be tunneled.";
    const have = [...this.open.values()].find((t) => t.kind === "port" && t.port === port);
    if (have) return `${have.url}\n(already open for port ${port})`;
    const p = await this.o.probe(port);
    if (!p.ok) return `Error: nothing answers on 127.0.0.1:${port}. Start your server first (bound to 127.0.0.1 or 0.0.0.0, running in the background), check it with curl, then run this again.`;
    if (p.devtools) return "Error: that's a browser's debugging port; it can't be tunneled.";
    if (this.o.inJob(port) === false) return `Error: the server on port ${port} isn't one a job started (it's part of the hub), so it can't be tunneled.`;
    return this.start({ kind: "port", port }, who);
  }

  private async serve(arg: string, who: TunnelWho): Promise<string> {
    if (!arg) return `Error: give the folder to share, like hearth-tunnel serve dist.\n${USAGE}`;
    let folder: string;
    try { folder = realpathSync(resolve(arg)); } catch { return `Error: no folder ${arg}.`; }
    const roots = this.o.roots.map((r) => { try { return realpathSync(r); } catch { return resolve(r); } });
    const root = roots.find((r) => folder === r || folder.startsWith(r + sep));
    if (!root || folder.slice(root.length).split(sep).some((s) => s.startsWith("."))) return "Error: only a folder inside your workspace can be shared.";
    if (!statSync(folder).isDirectory()) return `Error: ${arg} isn't a folder.`;
    if (!existsSync(join(folder, "index.html"))) return `Error: ${arg} has no index.html. Share the folder your build writes (dist/, build/, out/).`;
    const have = [...this.open.values()].find((t) => t.kind === "folder" && t.folder === folder);
    if (have) return `${have.url}\n(already open for this folder; it shows the folder's files as they are now)`;
    const files = serveFolder(folder);
    return this.start({ kind: "folder", port: files.port, folder }, who, files.stop);
  }

  private close(arg: string): string {
    const t = this.find(arg);
    if (!t) return `Error: no tunnel ${arg}. hearth-tunnel list shows them.`;
    this.drop(t.id, "closed by the agent");
    return `Closed ${t.url}`;
  }

  private find(arg: string): Live | undefined {
    const n = Number(arg);
    return this.open.get(arg) || [...this.open.values()].find((t) => t.url === arg.replace(/\/$/, "") || (Number.isInteger(n) && t.kind === "port" && t.port === n));
  }

  private async start(what: { kind: "port" | "folder"; port: number; folder?: string }, who: TunnelWho, stopFiles?: () => void): Promise<string> {
    const fail = (s: string) => { stopFiles?.(); return s; };
    if (this.open.size >= MAX_OPEN) return fail(`Error: ${MAX_OPEN} tunnels are open already. Close one you're done with (hearth-tunnel list, then close <id>).`);
    const bin = this.o.bin();
    if (!bin) return fail("Error: cloudflared isn't installed on this hub, so there's no tunnel. Say so in your reply (the hub's setup installs it: deploy/install-tools.sh).");
    // localhost as the Host header: dev servers (Vite, webpack, Next) refuse a host they don't know.
    const proc = this.o.spawn([bin, "tunnel", "--no-autoupdate", "--http-host-header", "localhost", "--url", `http://127.0.0.1:${what.port}`]);
    // The link is printed before Cloudflare has the connection: wait for "Registered tunnel connection" too.
    const url = await new Promise<string | null>((done) => {
      let found: string | null = null;
      const t = setTimeout(() => done(found), 30_000);
      proc.lines((s) => {
        const m = s.match(URL_RE);
        if (m) found = m[0];
        if (found && /Registered tunnel connection/i.test(s)) { clearTimeout(t); done(found); }
      });
      void proc.exited.then(() => { clearTimeout(t); done(null); });
    });
    if (!url) { proc.kill(); return fail("Error: Cloudflare didn't hand out a link (it may be busy). Try again in a minute."); }
    await this.o.ready(url);
    const id = `t${randomBytes(3).toString("hex")}`;
    const live: Live = { id, ...what, url, startedAt: this.o.now(), ...who, fails: 0, stop: () => { proc.kill(); stopFiles?.(); } };
    this.open.set(id, live);
    void proc.exited.then(() => { if (this.open.get(id) === live) this.drop(id, "cloudflared stopped"); });
    this.o.log(`tunnel ${id} open: ${url} -> ${what.kind === "folder" ? what.folder : `port ${what.port}`} (${who.by})`);
    this.watch();
    return `${url}\nOpen for ${what.kind === "folder" ? "this folder (it stays up after you finish, for 24 hours)" : `port ${what.port}, while your server answers there (at most 24 hours)`}. Anyone with the link can open it. Put the link in your reply.`;
  }

  private drop(id: string, why: string) {
    const t = this.open.get(id);
    if (!t) return;
    this.open.delete(id);
    t.stop();
    this.o.log(`tunnel ${id} closed (${why}): ${t.url}`);
    if (!this.open.size && this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private watch() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    (this.timer as any).unref?.();
  }

  /** Closes what's too old and what's stopped answering (a port twice in a row: the job ended or the server stopped). */
  async check() {
    for (const t of [...this.open.values()]) {
      if (this.o.now() - t.startedAt > MAX_AGE_MS) { this.drop(t.id, "24 hours"); continue; }
      if (t.kind !== "port") continue;
      const ok = (await this.o.probe(t.port)).ok;
      t.fails = ok ? 0 : t.fails + 1;
      if (t.fails >= 2) this.drop(t.id, "the server stopped answering");
    }
  }

  stopAll() { for (const id of [...this.open.keys()]) this.drop(id, "hub stopping"); }
}

export const USAGE = `hearth-tunnel:
  open <port>      a link to a server you're running on 127.0.0.1:<port> (lasts while it answers)
  serve <folder>   a link to a built site in your workspace (a folder with index.html; stays up after you finish)
  list             the open links
  close <port|id>  close one`;

/** The agent's hearth-tunnel command: curl to the hub with its agent key (like hearth-help). */
export function tunnelSkill(hubUrl: string, key: string) {
  const script = `#!/usr/bin/env bash
# hearth-tunnel: a link the user can open to a web app you're running or a site you built.
set -uo pipefail
if [ $# -eq 0 ]; then set -- list; fi
# serve sends the folder's full path: the hub isn't in your folder.
if [ "$1" = "serve" ] && [ $# -ge 2 ] && [ -d "$2" ]; then set -- serve "$(cd "$2" && pwd -P)"; fi
args=()
for a in "$@"; do args+=(--data-urlencode "a=$a"); done
job=()
if [ -n "\${HEARTH_JOB:-}" ]; then job=(-H "X-Hearth-Job: \${HEARTH_JOB}"); fi
exec curl -sS -m 90 -H "X-Hearth-Agent: ${key}" \${job[@]+"\${job[@]}"} "\${args[@]}" "${hubUrl}/api/agent/tunnel"
`;
  return {
    name: "hearth-tunnel", common: true, commands: ["hearth-tunnel"], reads: [] as string[], scripts: { "hearth-tunnel": script },
    description: "Made something the user should open and use in a browser (a web app, dashboard, demo, simulation, a site you're running on localhost or built into a folder)? hearth-tunnel gives them a real link that works on their phone.",
    body: `# Giving the user a link to what you built

localhost / 127.0.0.1 only works on the machine you run on. The user is somewhere else (often on their phone), so a
localhost URL in your reply is a dead link to them, and so is a screenshot when they asked for something to use.
When you've made something they should open (a web app, a dashboard, a demo, a simulation, a game), give them a tunnel.

## A server you're running
1. Start it listening on 127.0.0.1 (or 0.0.0.0), and check it answers. To keep it up after your turn, start it with
   hearth-bg: \`hearth-bg start --name site -- python3 -m http.server 8000\` then \`curl -sI http://127.0.0.1:8000\`.
   A dev server is fine (npm run dev, vite, next dev, flask, uvicorn); the tunnel sends Host: localhost, so its host
   check passes.
2. \`hearth-tunnel open 8000\` prints an https link. Put that link in your reply, on its own line.
3. It works while your server answers. A server you started yourself (not with hearth-bg) stops when this run ends; then
   say so: "open while I'm working on it".

## Something that should stay up after you finish
Build it into a folder of static files (index.html plus its js/css/data; \`npm run build\` → dist/) and
\`hearth-tunnel serve dist\`. The hub serves that folder itself, so the link keeps working for 24 hours after this run.
Rebuild into the same folder and the same link shows the new version. Prefer this when the page doesn't need a server of
its own: call APIs from the page, or ship the data as files.

## Rules
- Anyone with the link can open it. Never tunnel a page that shows the user's keys, tokens or private data, or one
  that does something on their behalf without asking. A key the user types into the page stays in their browser; fine.
- \`hearth-tunnel list\` shows what's open; \`hearth-tunnel close <port|id>\` closes one you're done with. Reusing a port or
  folder gives back the same link.
- Check the link yourself before you send it (WebFetch or curl it; or open it in your browser).
- If it fails, say what it said, word for word. Don't fall back to telling the user to open localhost.`,
  };
}
