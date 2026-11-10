import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_AGE_MS, serveFolder, Tunnels, tunnelSkill, type Proc } from "../src/tunnels.ts";

const who = { by: "Research", jobId: "j1", threadId: "th1" };

function fakes(over: Partial<{ ok: boolean; devtools: boolean; inJob: boolean | null }> = {}) {
  const spawned: string[][] = [];
  const procs: { kill: () => void; killed: boolean; exit: (n: number) => void }[] = [];
  let n = 0, now = 1_000_000;
  const state = { ok: over.ok ?? true, devtools: over.devtools ?? false, inJob: over.inJob === undefined ? true : over.inJob };
  const spawn = (cmd: string[]): Proc => {
    spawned.push(cmd);
    let exit!: (n: number) => void;
    const exited = new Promise<number>((r) => (exit = r));
    const p = { killed: false, kill: () => { p.killed = true; exit(0); }, exit };
    procs.push(p);
    const id = ++n;
    return { exited, kill: p.kill, lines: (on) => setTimeout(() => { on("INF Requesting new quick Tunnel..."); on(`INF |  https://fake-${id}.trycloudflare.com  |`); on("INF Registered tunnel connection connIndex=0"); }, 1) };
  };
  const tunnels = new Tunnels({
    hubPort: 8790, roots: [], bin: () => "/usr/bin/cloudflared", spawn,
    probe: async () => ({ ok: state.ok, devtools: state.devtools }), inJob: () => state.inJob, ready: async () => {}, now: () => now,
  });
  return { tunnels, spawned, procs, state, advance: (ms: number) => { now += ms; } };
}

describe("hearth-tunnel open", () => {
  test("opens a quick tunnel to the job's port with a localhost Host header, and reuses it", async () => {
    const f = fakes();
    const out = await f.tunnels.agent(["open", "5173"], who);
    expect(out.split("\n")[0]).toBe("https://fake-1.trycloudflare.com");
    expect(f.spawned[0]).toEqual(["/usr/bin/cloudflared", "tunnel", "--no-autoupdate", "--http-host-header", "localhost", "--url", "http://127.0.0.1:5173"]);
    expect(await f.tunnels.agent(["open", "http://localhost:5173/"], who)).toContain("already open");
    expect(f.spawned.length).toBe(1);
    expect(f.tunnels.list()[0]).toMatchObject({ port: 5173, by: "Research", jobId: "j1", threadId: "th1" });
  });

  test("refuses the hub, low ports, nothing listening, a debugging port and the hub's own services", async () => {
    expect(await fakes().tunnels.agent(["open", "8790"], who)).toContain("the hub itself");
    expect(await fakes().tunnels.agent(["open", "80"], who)).toContain("Error");
    expect(await fakes({ ok: false }).tunnels.agent(["open", "3000"], who)).toContain("nothing answers");
    expect(await fakes({ devtools: true }).tunnels.agent(["open", "9222"], who)).toContain("debugging port");
    expect(await fakes({ inJob: false }).tunnels.agent(["open", "3000"], who)).toContain("isn't one a job started");
    const unknown = fakes({ inJob: null }); // a Mac hub can't tell: allowed
    expect(await unknown.tunnels.agent(["open", "3000"], who)).toContain("trycloudflare.com");
  });

  test("closes when the server stops answering twice, or after 24 hours", async () => {
    const f = fakes();
    await f.tunnels.agent(["open", "3000"], who);
    f.state.ok = false;
    await f.tunnels.check();
    expect(f.tunnels.list().length).toBe(1);
    await f.tunnels.check();
    expect(f.tunnels.list().length).toBe(0);
    expect(f.procs[0].killed).toBe(true);

    f.state.ok = true;
    await f.tunnels.agent(["open", "3001"], who);
    f.advance(MAX_AGE_MS + 1);
    await f.tunnels.check();
    expect(f.tunnels.list().length).toBe(0);
  });

  test("close by port, list, and a cloudflared that dies drops its tunnel", async () => {
    const f = fakes();
    await f.tunnels.agent(["open", "3000"], who);
    await f.tunnels.agent(["open", "3001"], who);
    expect(await f.tunnels.agent(["list"], who)).toContain("port 3001");
    expect(await f.tunnels.agent(["close", "3000"], who)).toContain("Closed https://fake-1");
    f.procs[1].exit(1);
    await Bun.sleep(5);
    expect(await f.tunnels.agent(["list"], who)).toBe("No tunnels open.");
  });

  test("no cloudflared: says so", async () => {
    const t = new Tunnels({ hubPort: 8790, roots: [], bin: () => null, probe: async () => ({ ok: true }), inJob: () => true });
    expect(await t.agent(["open", "3000"], who)).toContain("cloudflared isn't installed");
  });
});

describe("hearth-tunnel serve", () => {
  const root = mkdtempSync(join(tmpdir(), "hearth-tun-"));
  const site = join(root, "ws", "dist");
  mkdirSync(join(site, "assets"), { recursive: true });
  writeFileSync(join(site, "index.html"), "<h1>hi</h1>");
  writeFileSync(join(site, "assets", "app.js"), "console.log(1)");
  writeFileSync(join(site, ".env"), "SECRET=1");
  writeFileSync(join(root, "outside.txt"), "no");

  test("only folders inside the workspaces, with an index.html", async () => {
    const f = fakes();
    (f.tunnels as any).o.roots = [join(root, "ws")];
    expect(await f.tunnels.agent(["serve", root], who)).toContain("only a folder inside your workspace");
    expect(await f.tunnels.agent(["serve", join(root, "ws")], who)).toContain("no index.html");
    const out = await f.tunnels.agent(["serve", site], who);
    expect(out).toContain("stays up after you finish");
    const t = f.tunnels.list()[0];
    expect(t.kind).toBe("folder");
    const base = `http://127.0.0.1:${t.port}`;
    expect(await (await fetch(base + "/")).text()).toBe("<h1>hi</h1>");
    expect((await fetch(base + "/assets/app.js")).headers.get("content-type")).toContain("javascript");
    expect((await fetch(base + "/.env")).status).toBe(404);
    expect((await fetch(base + "/%2e%2e/%2e%2e/outside.txt")).status).toBe(404);
    f.tunnels.stopAll();
  });

  test("the file server never leaves its folder", async () => {
    const s = serveFolder(site);
    try {
      expect((await fetch(`http://127.0.0.1:${s.port}/../../outside.txt`)).status).not.toBe(200);
      expect((await fetch(`http://127.0.0.1:${s.port}/assets/`)).status).toBe(404);
    } finally { s.stop(); }
  });
});

test("the skill's command sends a full folder path and the job", () => {
  const s = tunnelSkill("http://127.0.0.1:8790", "KEY");
  expect(s.commands).toEqual(["hearth-tunnel"]);
  expect(s.common).toBe(true);
  expect(s.scripts["hearth-tunnel"]).toContain("pwd -P");
  expect(s.scripts["hearth-tunnel"]).toContain("/api/agent/tunnel");
  expect(s.body).toContain("hearth-tunnel serve");
});
