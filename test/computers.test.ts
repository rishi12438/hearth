import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, COLLECTIONS, type Store } from "../src/store/index.ts";
import { Hub } from "../src/hub.ts";
import { Brain, NeedsComputer, ComputerGone, type BrainInput, type Meter } from "../src/brain.ts";
import { Scripts } from "../src/scripts.ts";
import { loadConfig } from "../src/config.ts";
import { Computers, levelFor } from "../src/computers.ts";
import { connect } from "../src/computer.ts";
import { addDevice, newPairingCode, redeemPairingCode } from "../src/auth.ts";
import { startServer } from "../src/server.ts";
import type { Job } from "../src/types.ts";

const FIXTURE = join(import.meta.dir, "fixtures/fake-agent.ts");
const until = async (fn: () => boolean | Promise<boolean>, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end && !(await fn())) await Bun.sleep(20); };
const input: BrainInput = { mode: "job", input: "find dinner", context: { tz: "UTC", nowIso: new Date().toISOString() } } as any;
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

/** A pretend computer socket: records what the hub sends it. */
function fakeSocket() {
  const sent: any[] = [];
  return { sent, closed: null as null | number, send(d: string) { sent.push(JSON.parse(d)); }, close(code?: number) { this.closed = code ?? 1000; } };
}
function registry(opts: Partial<ConstructorParameters<typeof Computers>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hearth-cmp-"));
  let t = 1_000_000;
  const c = new Computers({ dataDir: dir, homeDir: join(dir, "home"), acceptCopies: true, now: () => t, ...opts });
  return { c, dir, tick: (ms: number) => { t += ms; } };
}

test("signal bars follow the round trip, and an asleep or offline computer shows low", () => {
  expect([levelFor("online", 40), levelFor("online", 180), levelFor("online", 400), levelFor("online", 900)]).toEqual([4, 3, 2, 1]);
  expect([levelFor("asleep", 40), levelFor("offline", 40), levelFor("online", null)]).toEqual([1, 0, 1]);
});

test("a computer says hello, gets picked for its harnesses, runs the call and reports cost and progress", async () => {
  const { c, tick } = registry();
  const ws = fakeSocket();
  c.attach("mac1", "Studio (Mac)", ws);
  expect(c.pick({ harness: "claude", model: "" })).toBeNull(); // no hello yet: harnesses unknown
  c.message("mac1", JSON.stringify({ t: "hello", harnesses: ["claude", "echo"], platform: "darwin" }));
  tick(42);
  c.message("mac1", JSON.stringify({ t: "pong", ts: ws.sent.find((m) => m.t === "ping").ts }));
  expect(c.status("mac1", "x")).toMatchObject({ state: "online", level: 4, rttMs: 42, harnesses: ["claude", "echo"] });
  expect(c.pick({ harness: "codex", model: "" })).toBeNull();

  const runner = c.pick({ harness: "claude", model: "claude-sonnet-5-5" })!;
  expect(runner.name).toBe("Studio (Mac)");
  const steps: string[] = [];
  const meter: Meter = { costUsd: 0, unknown: false, onProgress: (s) => steps.push(s) };
  const p = runner.run(input, { harness: "claude", model: "claude-sonnet-5-5" }, meter);
  const run = ws.sent.find((m) => m.t === "run");
  expect(run.profile).toEqual({ harness: "claude", model: "claude-sonnet-5-5" });
  expect(c.status("mac1", "x").running).toBe(1);
  c.message("mac1", JSON.stringify({ t: "step", id: run.id, text: "Searching: dinner" }));
  c.message("mac1", JSON.stringify({ t: "done", id: run.id, reply: "Try Nopa.", costUsd: 0.03 }));
  expect(await p).toBe("Try Nopa.");
  expect([meter.costUsd, steps]).toEqual([0.03, ["Searching: dinner"]]);
});

test("a quiet computer turns asleep, then gets dropped; calls in flight fail over", async () => {
  const { c, tick } = registry();
  const ws = fakeSocket();
  c.attach("mac1", "Mac", ws);
  c.message("mac1", JSON.stringify({ t: "hello", harnesses: ["claude"] }));
  const p = c.pick({ harness: "claude", model: "" })!.run(input, { harness: "claude", model: "" });
  tick(16_000);
  expect(c.status("mac1", "Mac").state).toBe("asleep");
  expect(c.pick({ harness: "claude", model: "" })).toBeNull(); // asleep computers get no new work
  tick(16_000);
  c.tick();
  expect(ws.closed).toBe(4000);
  expect(c.status("mac1", "Mac")).toMatchObject({ state: "offline", level: 0 });
  await expect(p).rejects.toBeInstanceOf(ComputerGone);
});

test("a stale socket closing doesn't knock out the computer's new connection", () => {
  const { c } = registry();
  const old = fakeSocket(), fresh = fakeSocket();
  c.attach("mac1", "Mac", old);
  c.attach("mac1", "Mac", fresh);
  expect(old.closed).toBe(4000);
  c.detach("mac1", old);
  expect(c.isOnline("mac1")).toBe(true);
});

test("stopping a job tells the computer to stop it", async () => {
  const { c } = registry();
  const ws = fakeSocket();
  c.attach("mac1", "Mac", ws);
  c.message("mac1", JSON.stringify({ t: "hello", harnesses: ["claude"] }));
  const ctl = new AbortController();
  const p = c.pick({ harness: "claude", model: "" })!.run(input, { harness: "claude", model: "" }, { costUsd: 0, unknown: false, signal: ctl.signal });
  const id = ws.sent.find((m) => m.t === "run").id;
  ctl.abort();
  expect(ws.sent.at(-1)).toEqual({ t: "stop", id });
  c.message("mac1", JSON.stringify({ t: "error", id, message: "stopped" }));
  await expect(p).rejects.toThrow("stopped");
});

test("Brain runs on the computer when one can, falls back to the cloud, and parks when neither can", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-br-"));
  const config = { ...loadConfig({ HEARTH_AGENT: "echo" }), dataDir: dir };
  const brain = new Brain(config);
  let gone = false;
  brain.remote = {
    linked: () => true,
    pick: (p) => (p.harness === "custom" ? null : { name: "Mac", run: async () => { if (gone) throw new ComputerGone("x"); return "from the mac"; } }),
  };
  const m1: Meter = { costUsd: 0, unknown: false };
  expect(await brain.think(input, { harness: "echo", model: "" }, m1)).toBe("from the mac");
  expect(m1.ranOn).toBe("Mac");

  gone = true; // dropped mid-call: the cloud does it instead
  const m2: Meter = { costUsd: 0, unknown: false };
  expect(await brain.think(input, { harness: "echo", model: "" }, m2)).toContain("demo brain");
  expect(m2.ranOn).toBe("cloud");

  // custom isn't set up on this hub and no computer has it
  await expect(brain.think(input, { harness: "custom", model: "" })).rejects.toBeInstanceOf(NeedsComputer);
});

test("copies only what the owner asked for, privately, and removes only its own copy", () => {
  const { c, dir } = registry();
  const ws = fakeSocket();
  c.attach("mac1", "Mac", ws, ["claude"]);
  c.message("mac1", JSON.stringify({ t: "hello", harnesses: ["claude"] }));
  expect(ws.sent.find((m) => m.t === "want")).toEqual({ t: "want", items: ["claude"], have: {} });

  c.message("mac1", JSON.stringify({ t: "copy", item: "codex", data: '{"x":1}' })); // not asked for
  c.message("mac1", JSON.stringify({ t: "copy", item: "claude", data: "not json" }));
  expect(existsSync(join(dir, "home/.codex/auth.json")) || existsSync(join(dir, "home/.claude/.credentials.json"))).toBe(false);

  c.message("mac1", JSON.stringify({ t: "copy", item: "claude", data: '{"claudeAiOauth":{"accessToken":"t"}}' }));
  const file = join(dir, "home/.claude/.credentials.json");
  expect(readFileSync(file, "utf8")).toContain("accessToken");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(Object.keys(c.copied())).toEqual(["claude"]);

  // Turning it off removes the copy we wrote...
  c.setWant("mac1", []);
  expect(existsSync(file)).toBe(false);
  // ...but never a login someone changed by hand afterwards.
  c.setWant("mac1", ["claude"]);
  c.message("mac1", JSON.stringify({ t: "copy", item: "claude", data: '{"a":1}' }));
  writeFileSync(file, '{"set":"by hand"}');
  c.setWant("mac1", []);
  expect(readFileSync(file, "utf8")).toContain("by hand");
});

test("a hub that isn't a server takes no copies", () => {
  const { c, dir } = registry({ acceptCopies: false });
  const ws = fakeSocket();
  c.attach("mac1", "Mac", ws, ["claude"]);
  c.message("mac1", JSON.stringify({ t: "hello", harnesses: [] }));
  expect(ws.sent.find((m) => m.t === "want").items).toEqual([]);
  c.message("mac1", JSON.stringify({ t: "copy", item: "claude", data: '{"a":1}' }));
  expect(existsSync(join(dir, "home/.claude/.credentials.json"))).toBe(false);
});

// ---- end to end: a real hub, a real computer link over a WebSocket ----

async function realHub(env: Record<string, string> = {}) {
  // Brain.defaults() reads role settings from process.env, so pin the planner to the demo one for these tests.
  const was = process.env.HEARTH_ORCHESTRATOR_AGENT;
  process.env.HEARTH_ORCHESTRATOR_AGENT = "echo";
  cleanups.push(() => { if (was === undefined) delete process.env.HEARTH_ORCHESTRATOR_AGENT; else process.env.HEARTH_ORCHESTRATOR_AGENT = was; });
  const dir = mkdtempSync(join(tmpdir(), "hearth-e2e-"));
  const store: Store = await createStore("sqlite::memory:", dir);
  for (const c of COLLECTIONS) await store.clear(c);
  const config = { ...loadConfig({ HEARTH_PORT: "0", HEARTH_TARGET: "lightsail", ...env }), dataDir: dir };
  const hub = new Hub(config, store, new Brain(config), new Scripts(store, dir, join(import.meta.dir, "../scripts")), null);
  await hub.setPrefs({ tz: "UTC" });
  await hub.ensureTeammates();
  const phone = await redeemPairingCode(store, (await newPairingCode(store, "owner")).code, "Phone");
  const { server, computers } = await startServer(hub, null);
  cleanups.push(async () => { computers.stop(); server.stop(true); await store.close(); });
  const url = `http://127.0.0.1:${server.port}`;
  const api = (path: string, token: string, init: RequestInit = {}) =>
    fetch(url + path, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) } });
  return { hub, store, url, api, phoneToken: phone!.token, computers };
}

function macBrain(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hearth-mac-"));
  const config = { ...loadConfig({ HEARTH_AGENT: "custom", HEARTH_AGENT_CMD: JSON.stringify([process.execPath, FIXTURE]), ...env }), dataDir: dir };
  return config;
}

test("end to end: a Mac links in, shows online on the phone, runs jobs on its own login, and its key opens nothing else", async () => {
  const { hub, store, url, api, phoneToken } = await realHub({ HEARTH_AGENT: "custom" });
  const { token, device } = await addDevice(store, "Studio (Mac)", "computer");
  const logs: string[] = [];
  const stop = connect({ config: macBrain(), link: { hub: url, token, deviceId: device.id, name: "Studio (Mac)" }, log: (s) => logs.push(s) });
  cleanups.push(stop);

  const devices = async () => (await (await api("/api/devices", phoneToken)).json()) as any[];
  await until(async () => (await devices()).find((d) => d.role === "computer")?.link?.state === "online");
  const mac = (await devices()).find((d) => d.role === "computer");
  expect(mac.link).toMatchObject({ state: "online", harnesses: expect.arrayContaining(["custom", "echo"]) });
  expect(mac.link.level).toBeGreaterThan(0);
  expect((await (await api("/api/state", phoneToken)).json()).computers).toMatchObject({ linked: 1, online: ["Studio (Mac)"] });

  // The hub can't run "custom" itself; the Mac can, so the job runs there.
  process.env.FAKE_MS = "50";
  await hub.ramble("find a cheap dinner spot");
  await until(async () => (await store.all<Job>("jobs")).some((j) => j.status === "done"));
  const job = (await store.all<Job>("jobs"))[0];
  expect([job.status, job.ranOn, job.result]).toEqual(["done", "Studio (Mac)", "done: find a cheap dinner spot"]);

  // A computer's key is for the link only.
  expect((await api("/api/state", token)).status).toBe(403);
  // A wrong key can't open the link.
  expect((await fetch(url + "/computer", { headers: { Authorization: "Bearer " + "x".repeat(40) } })).status).toBe(401);
  // A computer can't be made primary.
  expect((await api(`/api/devices/${device.id}/primary`, phoneToken, { method: "POST", body: "{}" })).status).toBe(409);

  // Signing it out from the phone cuts the line, and the Mac stops trying.
  await api(`/api/devices/${device.id}`, phoneToken, { method: "DELETE" });
  await until(() => logs.some((l) => l.includes("signed out")));
  expect(logs.some((l) => l.includes("signed out"))).toBe(true);
});

test("end to end: with the Mac off, a job parks as 'needs your Mac' and finishes by itself when it comes back", async () => {
  const { hub, store, url } = await realHub({ HEARTH_AGENT: "custom" });
  const { token, device } = await addDevice(store, "Studio (Mac)", "computer");
  // Added straight to the store, so tell the registry it exists (the server re-counts after a real approval).
  (hub.brain.remote as Computers).known = 1;
  process.env.FAKE_MS = "50";

  await hub.ramble("find a cheap dinner spot");
  await until(async () => (await store.all<Job>("jobs")).some((j) => j.status === "blocked"));
  const parked = (await store.all<Job>("jobs"))[0];
  expect([parked.status, parked.blocked?.needs, parked.blocked?.need]).toEqual(["blocked", "computer", "Your Mac"]);

  const stop = connect({ config: macBrain(), link: { hub: url, token, deviceId: device.id, name: "Studio (Mac)" }, log: () => {} });
  cleanups.push(stop);
  await until(async () => (await store.all<Job>("jobs")).some((j) => j.status === "done"));
  const done = (await store.all<Job>("jobs"))[0];
  expect([done.status, done.ranOn, done.blocked]).toEqual(["done", "Studio (Mac)", undefined]);
});

test("end to end: the owner picks what to copy, and the Mac's login lands on the server", async () => {
  const { store, url, api, phoneToken, computers } = await realHub({ HEARTH_AGENT: "echo" });
  const home = mkdtempSync(join(tmpdir(), "hearth-home-"));
  (computers as any).opts.homeDir = home;
  const { token, device } = await addDevice(store, "Studio (Mac)", "computer");
  const stop = connect({ config: macBrain(), link: { hub: url, token, deviceId: device.id, name: "Studio (Mac)" }, log: () => {},
    readCopy: (item) => (item === "claude" ? '{"claudeAiOauth":{"accessToken":"from-mac"}}' : null) });
  cleanups.push(stop);
  await until(() => computers.isOnline(device.id));

  const r = await api(`/api/devices/${device.id}/copy`, phoneToken, { method: "PUT", body: JSON.stringify({ claude: true, codex: false }) });
  expect((await r.json()).copy).toEqual(["claude"]);
  const file = join(home, ".claude/.credentials.json");
  await until(() => existsSync(file));
  expect(readFileSync(file, "utf8")).toContain("from-mac");
  expect((await (await api("/api/devices", phoneToken)).json()).find((d: any) => d.id === device.id).copy).toEqual(["claude"]);

  await api(`/api/devices/${device.id}/copy`, phoneToken, { method: "PUT", body: JSON.stringify({ claude: false }) });
  expect(existsSync(file)).toBe(false);
});
