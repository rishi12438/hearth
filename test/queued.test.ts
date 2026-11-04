import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, COLLECTIONS, type Store } from "../src/store/index.ts";
import { Hub } from "../src/hub.ts";
import { Brain } from "../src/brain.ts";
import { Scripts } from "../src/scripts.ts";
import { loadConfig } from "../src/config.ts";
import type { Job, Message } from "../src/types.ts";

// Messages you send while a teammate is mid-run wait for the run instead of stopping and restarting it.

const FIXTURE = join(import.meta.dir, "fixtures/fake-agent.ts");
let dir: string, store: Store, hub: Hub, log: string;

async function setup() {
  dir = mkdtempSync(join(tmpdir(), "hearth-q-"));
  log = join(dir, "calls.log");
  store = await createStore(process.env.TEST_DB || "sqlite::memory:", dir);
  for (const c of COLLECTIONS) await store.clear(c);
  const config = { ...loadConfig({ HEARTH_AGENT: "custom", HEARTH_AGENT_CMD: JSON.stringify([process.execPath, FIXTURE]) }), dataDir: dir };
  hub = new Hub(config, store, new Brain(config), new Scripts(store, dir, join(import.meta.dir, "../scripts")), null);
  await hub.setPrefs({ tz: "UTC" });
  await hub.ensureTeammates();
  process.env.FAKE_LOG = log;
  process.env.FAKE_MS = "50";
}
const jobs = () => store.all<Job>("jobs");
const msgs = () => store.all<Message>("messages");
const until = async (fn: () => Promise<boolean>, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end && !(await fn())) await Bun.sleep(25); };
const settled = async (n: number) => { const j = await jobs(); return j.length === n && j.every((x) => x.status === "done" || x.status === "failed"); };
const working = async () => (await jobs()).some((j) => j.status === "working");
const starts = () => readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("start")).length;

afterEach(async () => { hub.stop(); await hub.idle(20_000); await store.close(); });

test("thread replies sent mid-run queue, then go out together as the next turn when the run ends", async () => {
  await setup();
  process.env.FAKE_PLAN = JSON.stringify({ title: "t", reply: "On it", jobs: [{ task: "find a restaurant", teammate: "Scout" }] });
  await hub.ramble("dinner");
  await until(() => settled(1));
  const [root] = await jobs();
  process.env.FAKE_MS = "1200";
  const first = (await hub.replyToJob(root.id, "somewhere quiet")).value!; // not queued: nothing running yet
  await until(working);
  await Bun.sleep(150);
  const before = starts();
  process.env.FAKE_MS = "50";
  const a = (await hub.replyToJob(root.id, "anything vegetarian?", { queue: true })).value!;
  const b = (await hub.replyToJob(root.id, "and near the park", { queue: true })).value!;
  expect(a.message.queued).toBe(true);
  expect(b.message.queued).toBe(true);
  // The run kept going: not restarted, brief unchanged.
  const run = (await store.get<Job>("jobs", first.job.id))!;
  expect(run.status).toBe("working");
  expect(run.task).not.toContain("vegetarian");
  expect(starts()).toBe(before);
  // It ends: both go out as one follow-up turn, filed under the last one.
  await until(() => settled(3));
  const next = (await jobs()).find((j) => j.followsUp === root.id && j.id !== first.job.id)!;
  expect(next.task).toBe("anything vegetarian?\n\nand near the park");
  expect(next.messageId).toBe(b.message.id);
  expect((await msgs()).filter((m) => m.queued).length).toBe(0);
  expect((await store.get<Job>("jobs", first.job.id))!.task).not.toContain("vegetarian");
});

test("Send now puts a queued DM into the run (it starts over with it); × drops one unsent", async () => {
  await setup();
  process.env.FAKE_MS = "1500";
  const first = (await hub.askTeammate("scout", "find a pottery studio")).value!;
  await until(working);
  await Bun.sleep(200);
  process.env.FAKE_MS = "50";
  const keep = (await hub.askTeammate("scout", "in Oakland please", { queue: true })).value!;
  const drop = (await hub.askTeammate("scout", "never mind the price", { queue: true })).value!;
  expect(keep.message.queued).toBe(true);
  expect((await hub.unqueueMessage(drop.message.id)).value).toBeTruthy();
  expect(await store.get("messages", drop.message.id)).toBeNull();
  expect((await hub.sendQueuedNow(keep.message.id)).value).toBeTruthy();
  expect((await hub.sendQueuedNow(keep.message.id)).error).toBeTruthy(); // already sent
  await until(() => settled(1));
  await Bun.sleep(150); // nothing left queued, so no second turn appears
  const all = await jobs();
  expect(all.length).toBe(1);
  expect(all[0].id).toBe(first.job.id);
  expect(all[0].task).toContain("The user added: in Oakland please");
  expect(all[0].task).not.toContain("never mind");
});

test("without queue (voice, apps, older clients) a mid-run DM still folds in as before", async () => {
  await setup();
  process.env.FAKE_MS = "1500";
  const first = (await hub.askTeammate("scout", "find a pottery studio")).value!;
  await until(working);
  await Bun.sleep(200);
  process.env.FAKE_MS = "50";
  const second = (await hub.askTeammate("scout", "in Oakland please")).value!;
  expect(second.message.queued).toBeUndefined();
  expect(second.job.id).toBe(first.job.id);
});
