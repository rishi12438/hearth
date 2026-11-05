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

afterEach(async () => { delete process.env.FAKE_PROMPTS; hub.stop(); await hub.idle(20_000); await store.close(); });

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

test("Send now puts a queued DM into the run, which carries on with it; × drops one unsent", async () => {
  await setup();
  const prompts = join(dir, "prompts.log");
  process.env.FAKE_PROMPTS = prompts;
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
  // The restarted run is told it was interrupted and to carry on, not handed the task as if it were new.
  const runs = readFileSync(prompts, "utf8").split("=====\n").filter((p) => p.includes("pottery"));
  expect(runs.at(-1)).toContain("were stopped partway");
  expect(runs.at(-1)).toContain("don't redo what already worked");
  expect(all[0].interrupted).toBeUndefined(); // cleared once it finished
  // The thread shows where it was cut off.
  expect((await store.get<Message>("messages", keep.message.id))!.interrupted).toBe("scout");
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

test("New session → Separate run starts a queued DM as its own run next to the one that's going; it isn't folded in", async () => {
  await setup();
  process.env.FAKE_MS = "1500";
  const first = (await hub.askTeammate("scout", "find a pottery studio")).value!;
  await until(working);
  await Bun.sleep(200);
  process.env.FAKE_MS = "50";
  const q = (await hub.askTeammate("scout", "also book a dentist", { queue: true })).value!;
  const r = (await hub.startQueuedApart(q.message.id, "thread")).value!;
  expect(r.jobId).not.toBe(first.job.id);
  expect((await store.get<Message>("messages", q.message.id))!.queued).toBeUndefined();
  await until(() => settled(2));
  const run = (await store.get<Job>("jobs", r.jobId!))!;
  expect(run.task).toBe("also book a dentist");
  expect(run.teammateId).toBe("scout");
  expect((await store.get<Job>("jobs", first.job.id))!.task).not.toContain("dentist");
  expect((await hub.startQueuedApart(q.message.id, "thread")).error).toBeTruthy(); // already sent
});

/** A ramble with one task whose thread has a follow-up run going, and a reply queued behind it. */
async function queuedInRamble(text: string) {
  process.env.FAKE_PLAN = JSON.stringify({ title: "t", reply: "On it", jobs: [{ task: "find a restaurant", teammate: "Scout" }] });
  const { thread } = (await hub.ramble("dinner")).value!;
  await until(() => settled(1));
  const [root] = await jobs();
  process.env.FAKE_MS = "1500";
  const run = (await hub.replyToJob(root.id, "somewhere quiet")).value!;
  await until(working);
  await Bun.sleep(150);
  process.env.FAKE_MS = "50";
  const q = (await hub.replyToJob(root.id, text, { queue: true })).value!;
  expect(q.message.queued).toBe(true);
  return { thread, root, run: run.job, q: q.message };
}

test("New session → New thread hands a queued reply to Hearth to plan in the ramble, never back into the thread it waited on", async () => {
  await setup();
  const { thread, root, run, q } = await queuedInRamble("also find a florist");
  // Even if the planner tries to fold it into the thread it was queued on, that's refused: it becomes a task of its own.
  // And even if it calls it a new topic: you chose New thread, so it isn't moved to its own ramble.
  process.env.FAKE_PLAN = JSON.stringify({ title: "t", reply: "On it", newTopic: true, jobs: [{ task: "find a florist", teammate: "Scout", addTo: root.id, continue: root.id }] });
  expect((await hub.startQueuedApart(q.id, "thread")).value!.threadId).toBe(thread.id);
  await until(async () => (await jobs()).some((j) => j.task === "find a florist"));
  const fresh = (await jobs()).find((j) => j.task === "find a florist")!;
  expect(fresh.threadId).toBe(thread.id);
  expect(fresh.followsUp).toBeUndefined();
  expect(fresh.messageId).toBe(q.id);
  const m = (await store.get<Message>("messages", q.id))!;
  expect(m.queued).toBeUndefined();
  expect(m.replyTo).toBeUndefined();
  expect(m.threadId).toBe(thread.id);
  expect(m.newTopic).toBeUndefined();
  expect((await msgs()).some((x) => x.movedTo)).toBe(false);
  expect((await store.get<Job>("jobs", run.id))!.task).not.toContain("florist");
});

test("New session → New ramble moves a queued reply to its own ramble the way the new-topic offer does", async () => {
  await setup();
  const { thread, q } = await queuedInRamble("what is the purpose of life?");
  const r = (await hub.startQueuedApart(q.id, "ramble")).value!;
  expect(r.threadId).not.toBe(thread.id);
  const moved = (await store.get<Message>("messages", q.id))!;
  expect(moved.threadId).toBe(r.threadId);
  expect(moved.movedFrom).toBe(thread.id);
  expect(moved.queued).toBeUndefined();
  expect(moved.newTopic).toBeUndefined(); // no countdown: you already chose
  expect((await msgs()).some((m) => m.threadId === thread.id && m.movedTo === r.threadId)).toBe(true);
  await until(async () => (await jobs()).some((j) => j.threadId === r.threadId));
});

test("chats are read on the hub: a reply after you last looked is unread on every device, opening it clears it", async () => {
  await setup();
  const { since } = await hub.chatSeen();
  process.env.FAKE_PLAN = JSON.stringify({ title: "t", reply: "On it", jobs: [{ task: "find a restaurant", teammate: "Scout" }] });
  const { thread } = (await hub.ramble("dinner")).value!;
  await until(() => settled(1));
  const t = (await hub.listThreads()).find((x: any) => x.id === thread.id)!;
  expect(t.lastReplyAt! > since).toBe(true); // something came back: unread
  const at = await hub.markChatSeen(thread.id);
  expect((await hub.chatSeen()).seen[thread.id]).toBe(at);
  expect(at >= t.lastReplyAt!).toBe(true);
  expect(await hub.markChatSeen(thread.id) >= at).toBe(true); // only moves forward
  // DMs are keyed tm-<teammate>, and the roster says when the teammate last wrote.
  await hub.askTeammate("scout", "hi");
  await until(() => settled(2));
  expect((await hub.roster()).find((x) => x.id === "scout")!.lastDmAt).toBeTruthy();
});

test("a job left 'working' by a hub restart goes back in the queue and runs again on startup", async () => {
  await setup();
  process.env.FAKE_PLAN = JSON.stringify({ title: "t", reply: "On it", jobs: [{ task: "find a restaurant", teammate: "Scout" }] });
  await hub.ramble("dinner");
  await until(() => settled(1));
  const [done] = await jobs();
  // What a restart leaves behind: saved as working, no run in this process.
  await store.put<Job>("jobs", { ...done, status: "working", result: undefined, finishedAt: undefined, startedAt: new Date().toISOString() });
  const before = starts();
  await hub.start(60_000);
  await until(() => settled(1));
  const after = (await store.get<Job>("jobs", done.id))!;
  expect(after.status).toBe("done");
  expect(starts()).toBeGreaterThan(before);
});
