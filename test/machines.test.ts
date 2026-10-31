import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createStore, COLLECTIONS } from "../src/store/index.ts";
import { Hub } from "../src/hub.ts";
import { Brain } from "../src/brain.ts";
import { Scripts } from "../src/scripts.ts";
import { loadConfig } from "../src/config.ts";
import { Machines, setupScript, type E2b, type Runner, type Ssh } from "../src/machines.ts";
import { writeLogins } from "../src/computer.ts";
import { newPairingCode, redeemPairingCode } from "../src/auth.ts";
import { startServer } from "../src/server.ts";
import type { Device, Job } from "../src/types.ts";

const until = async (fn: () => boolean | Promise<boolean>, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end && !(await fn())) await Bun.sleep(25); };
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";

/** A pretend E2B: records what it was asked, and runs commands with a runner the test picks. */
function fakeE2b(runner: Runner) {
  const calls: any[] = [];
  let n = 0;
  const e2b: E2b = {
    async create(apiKey, opts) { calls.push(["create", apiKey, opts]); return { sandboxId: `sb-${++n}`, runner }; },
    async kill(apiKey, id) { calls.push(["kill", id]); },
    async setTimeout(apiKey, id, ms) { calls.push(["setTimeout", id, ms]); },
  };
  return { e2b, calls };
}
function recorder(code = 0, stderr = "") {
  const runs: { cmd: string; stdin?: string }[] = [];
  const runner: Runner = {
    async run(cmd, o) { runs.push({ cmd, stdin: o.stdin }); o.onLine?.("@@step Installing Claude Code"); return { code, stderr }; },
  };
  return { runs, runner };
}
function machines(over: Partial<ConstructorParameters<typeof Machines>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hearth-mach-"));
  let t = 1_000_000, n = 0;
  const removed: string[] = [];
  const busy = new Set<string>();
  const m = new Machines({
    dataDir: dir, hubUrl: () => "https://hub.example.com",
    addComputer: async () => ({ token: "first", deviceId: `dev-${++n}` }),
    removeComputer: async (id) => { removed.push(id); },
    rekey: async (id) => `token-for-${id}`,
    isOnline: () => false, isBusy: (id) => busy.has(id), now: () => t, ...over,
  });
  return { m, dir, removed, busy, tick: (ms: number) => { t += ms; } };
}

test("the setup script gets the key on stdin, never in the command, and quotes everything", () => {
  const s = setupScript("https://hub.example.com", "dev-1", "Box");
  expect(s).toContain("read -r TOKEN");
  expect(s).toContain(`"$HUB/computer/bundle"`);
  expect(s).toContain("claude.ai/install.sh");
  expect(s).toContain('"cloud":true');
  expect(Bun.spawnSync(["bash", "-n"], { stdin: new TextEncoder().encode(s) }).exitCode).toBe(0);
});

test("E2B: needs a key, makes a sandbox, runs setup with a fresh key, and shows progress", async () => {
  const { runs, runner } = recorder();
  const { e2b, calls } = fakeE2b(runner);
  const { m } = machines({ e2b });
  expect((await m.addE2b({})).error).toContain("E2B API key");
  expect(await m.setE2bKey("nope")).toContain("doesn't look like");
  expect(await m.setE2bKey("e2b_" + "x".repeat(30), async () => "E2B didn't accept that key.")).toContain("didn't accept");
  expect(await m.setE2bKey("e2b_" + "x".repeat(30), async () => null)).toBeNull();
  expect(statSync(join((m as any).opts.dataDir, "keys/secrets.json")).mode & 0o777).toBe(0o600);

  const steps: string[] = [];
  m.onChange = () => { const s = m.list()[0]?.step; if (s && steps.at(-1) !== s) steps.push(s); };
  const r = await m.addE2b({ name: "Sandbox <1>", idleStopMin: 20 });
  expect(r.value!.name).toBe("Sandbox 1"); // odd characters dropped
  await until(() => m.list()[0].state === "running");
  expect(calls[0]).toEqual(["create", "e2b_" + "x".repeat(30), { timeoutMs: 30 * 60_000, metadata: { hearth: r.value!.id } }]);
  expect(runs[0].stdin).toBe("token-for-dev-1\n");
  expect(runs[0].cmd).not.toContain("token-for");
  expect(steps).toContain("Installing Claude Code");
  expect(m.list()[0]).toMatchObject({ state: "running", sandboxId: "sb-1" });
});

test("E2B: a busy sandbox stays up, an idle one is stopped so it stops costing, and a waiting job wakes it", async () => {
  const { runner } = recorder();
  const { e2b, calls } = fakeE2b(runner);
  const { m, busy, tick } = machines({ e2b });
  await m.setE2bKey("e2b_" + "x".repeat(30), async () => null);
  const id = (await m.addE2b({ idleStopMin: 10 })).value!.id;
  await until(() => m.get(id)!.state === "running");

  busy.add("dev-1");
  tick(25 * 60_000);
  await m.tick();
  expect(m.get(id)!.state).toBe("running");
  expect(calls.some((c) => c[0] === "setTimeout")).toBe(true);

  busy.clear();
  tick(11 * 60_000);
  await m.tick();
  expect(m.get(id)!.state).toBe("stopped");
  expect(m.get(id)!.sandboxId).toBeUndefined();
  expect(calls.at(-1)).toEqual(["kill", "sb-1"]);

  expect(await m.wake()).toBe(true);
  await until(() => m.get(id)!.state === "running");
  expect(m.get(id)!.sandboxId).toBe("sb-2");
});

test("E2B: a failed setup says why and doesn't leave a sandbox running", async () => {
  const { runner } = recorder(1, "curl: (7) Failed to connect\n");
  const { e2b, calls } = fakeE2b(runner);
  const { m } = machines({ e2b });
  await m.setE2bKey("e2b_" + "x".repeat(30), async () => null);
  const id = (await m.addE2b({})).value!.id;
  await until(() => m.get(id)!.state === "error");
  expect(m.get(id)).toMatchObject({ state: "error", error: "curl: (7) Failed to connect" });
  expect(m.get(id)!.sandboxId).toBeUndefined();
  expect(calls.at(-1)).toEqual(["kill", "sb-1"]);
});

test("a hub only reachable on this machine can't take cloud computers", async () => {
  const { m } = machines({ hubUrl: () => "http://127.0.0.1:8790" });
  await m.setE2bKey("e2b_" + "x".repeat(30), async () => null);
  expect((await m.addE2b({})).error).toContain("only reachable on this machine");
  expect((await machines({ hubUrl: () => null }).m.addE2b({})).error).toBeDefined();
});

test("your VM: checks the address and key, reaches it first, pins its host key, and keeps the key private", async () => {
  const seen: any[] = [];
  let answer = { code: 255, stderr: "ubuntu@1.2.3.4: Permission denied (publickey)." };
  const ssh: Ssh = {
    runner(t, pin) {
      return { async run(cmd, o) { seen.push({ t, cmd, stdin: o.stdin }); if (answer.code === 0 && !t.knownHosts) pin("1.2.3.4 ssh-ed25519 AAAAhost"); return answer; } };
    },
  };
  const { m, dir } = machines({ ssh });
  expect((await m.addSsh({ host: "bad host!", privateKey: KEY })).error).toContain("IP address");
  expect((await m.addSsh({ host: "1.2.3.4", privateKey: "hello" })).error).toContain("BEGIN and END");
  expect((await m.addSsh({ host: "1.2.3.4", user: "Root;rm", privateKey: KEY })).error).toContain("user name");
  expect((await m.addSsh({ host: "1.2.3.4", privateKey: KEY })).error).toContain("refused that key");
  expect(m.list()).toEqual([]); // nothing minted for a machine we couldn't reach

  answer = { code: 0, stderr: "" };
  const r = await m.addSsh({ name: "Hetzner", host: "1.2.3.4", privateKey: KEY });
  await until(() => m.get(r.value!.id)!.state === "running");
  const saved = m.get(r.value!.id)!;
  expect(saved).toMatchObject({ kind: "ssh", host: "1.2.3.4", port: 22, user: "ubuntu", knownHosts: "1.2.3.4 ssh-ed25519 AAAAhost" });
  expect(m.view(saved)).not.toHaveProperty("knownHosts");
  expect(JSON.stringify(m.list())).not.toContain("PRIVATE KEY");
  const keyFile = join(dir, "keys", `ssh-${saved.id}`);
  expect(statSync(keyFile).mode & 0o777).toBe(0o600);
  // The setup run is pinned to the host key seen the first time.
  expect(seen.at(-1).t.knownHosts).toBe("1.2.3.4 ssh-ed25519 AAAAhost");
  expect(seen.at(-1).stdin).toBe(`token-for-${saved.deviceId}\n`);

  await m.remove(saved.id);
  expect(existsSync(keyFile)).toBe(false);
  expect(m.list()).toEqual([]);
});

test("a cloud computer writes the logins it's handed where Claude and Codex look, and skips Claude's first-run questions", () => {
  const home = mkdtempSync(join(tmpdir(), "hearth-home-"));
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ theme: "light" }));
  expect(writeLogins(home, { claude: '{"claudeAiOauth":{"accessToken":"t"}}', codex: "not json", other: "{}" })).toEqual(["claude"]);
  expect(statSync(join(home, ".claude/.credentials.json")).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8"))).toEqual({ hasCompletedOnboarding: true, theme: "light" });
  expect(existsSync(join(home, ".codex/auth.json"))).toBe(false);
});

// ---- end to end: a real hub sets up a "sandbox" (a throwaway home folder on this machine) with the real setup script ----

test("end to end: the hub sets up a cloud computer that downloads Hearth from it, links back, gets its login, runs work, and is removed cleanly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-cloud-hub-"));
  const store = await createStore("sqlite::memory:", dir);
  for (const c of COLLECTIONS) await store.clear(c);
  const config = { ...loadConfig({ HEARTH_PORT: "0", HEARTH_TARGET: "lightsail", HEARTH_AGENT: "echo" }), dataDir: dir };
  const hub = new Hub(config, store, new Brain(config), new Scripts(store, dir, join(import.meta.dir, "../scripts")), null);
  await hub.setPrefs({ tz: "UTC" });
  await hub.ensureTeammates();
  const phone = await redeemPairingCode(store, (await newPairingCode(store, "owner")).code, "Phone");

  // The "sandbox": its own home folder, stub claude/codex so nothing is installed, and no crontab changes.
  const box = mkdtempSync(join(tmpdir(), "hearth-box-"));
  const bin = join(box, "bin"); mkdirSync(bin);
  for (const b of ["claude", "codex"]) { writeFileSync(join(bin, b), "#!/bin/sh\necho stub\n"); chmodSync(join(bin, b), 0o755); }
  const env = { HOME: box, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, HEARTH_NO_CRON: "1", BUN_INSTALL_CACHE_DIR: join(homedir(), ".bun/install/cache") };
  const local: Runner = {
    async run(cmd, o) {
      const p = Bun.spawn(["sh", "-c", cmd], { env, stdin: o.stdin !== undefined ? new TextEncoder().encode(o.stdin) : "ignore", stdout: "pipe", stderr: "pipe" });
      const out = await new Response(p.stdout).text();
      for (const l of out.split("\n")) o.onLine?.(l);
      return { code: await p.exited, stderr: await new Response(p.stderr).text() };
    },
  };
  const { e2b, calls } = fakeE2b(local);
  const was = { key: process.env.HEARTH_E2B_API_KEY, url: process.env.HEARTH_PUBLIC_URL };
  process.env.HEARTH_E2B_API_KEY = "e2b_test_key_0000000000";
  const { server, computers, machines: ms } = await startServer(hub, null, {
    e2b, allowLocalHub: true, readLogin: (item) => (item === "claude" ? '{"claudeAiOauth":{"accessToken":"from-the-hub"}}' : null),
  });
  const url = `http://127.0.0.1:${server.port}`;
  process.env.HEARTH_PUBLIC_URL = url;
  cleanups.push(async () => {
    for (const m of ms.list()) await ms.remove(m.id).catch(() => {});
    ms.stopTimer(); computers.stop(); server.stop(true); await store.close();
    if (was.key === undefined) delete process.env.HEARTH_E2B_API_KEY; else process.env.HEARTH_E2B_API_KEY = was.key;
    if (was.url === undefined) delete process.env.HEARTH_PUBLIC_URL; else process.env.HEARTH_PUBLIC_URL = was.url;
  });
  const api = (path: string, init: RequestInit = {}) => fetch(url + path, { ...init, headers: { Authorization: `Bearer ${phone!.token}`, "Content-Type": "application/json" } });

  const r = await api("/api/machines", { method: "POST", body: JSON.stringify({ kind: "e2b", name: "Sandbox" }) });
  expect(r.status).toBe(200);
  const id = ((await r.json()) as any).machines[0].id;
  await until(() => ["running", "error"].includes(ms.get(id)!.state), 90_000);
  expect(ms.get(id)!.error).toBeUndefined();
  expect(calls[0][0]).toBe("create");

  // It linked back to the hub on its own, with the hub-minted key.
  const deviceId = ms.get(id)!.deviceId;
  await until(() => computers.isOnline(deviceId), 20_000);
  expect(computers.status(deviceId, "")).toMatchObject({ state: "online", harnesses: expect.arrayContaining(["claude", "codex", "echo"]) });
  const link = JSON.parse(readFileSync(join(box, "hearth/data/computer.json"), "utf8"));
  expect(link).toMatchObject({ hub: url, deviceId, name: "Sandbox", cloud: true });
  expect(statSync(join(box, "hearth/data/computer.json")).mode & 0o777).toBe(0o600);

  // The hub handed it its Claude login.
  await until(() => existsSync(join(box, ".claude/.credentials.json")));
  expect(readFileSync(join(box, ".claude/.credentials.json"), "utf8")).toContain("from-the-hub");
  expect(JSON.parse(readFileSync(join(box, ".claude.json"), "utf8")).hasCompletedOnboarding).toBe(true);

  // Work runs there.
  await hub.ramble("find a cheap dinner spot");
  await until(async () => (await store.all<Job>("jobs")).some((j) => j.status === "done"), 10_000);
  expect((await store.all<Job>("jobs"))[0].ranOn).toBe("Sandbox");

  // The phone sees it as a computer that belongs to a machine.
  const devices = (await (await api("/api/devices")).json()) as any[];
  expect(devices.find((d) => d.id === deviceId)).toMatchObject({ role: "computer", machine: id, link: { state: "online" } });

  // Removing it stops the sandbox, unlinks the key, and the link process exits.
  await api(`/api/machines/${id}`, { method: "DELETE" });
  expect(calls.some((c) => c[0] === "kill")).toBe(true);
  expect(await store.get<Device>("devices", deviceId)).toBeNull();
  await until(() => Bun.spawnSync(["pgrep", "-f", `${box}/hearth/src/cli.ts computer`]).exitCode !== 0, 10_000);
  expect(Bun.spawnSync(["pgrep", "-f", `${box}/hearth/src/cli.ts computer`]).exitCode).not.toBe(0);
}, 120_000);

test("E2B's long errors become something you can act on", async () => {
  const { plainError } = await import("../src/machines.ts");
  expect(plainError("Unauthorized, please check your credentials. - Invalid API key")).toContain("didn't accept the API key");
  expect(plainError("429: rate limit")).toContain("at its limit");
  expect(plainError("something else")).toBe("something else");
});
