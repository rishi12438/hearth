import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, COLLECTIONS, type Store } from "../src/store/index.ts";
import { Hub } from "../src/hub.ts";
import { Brain } from "../src/brain.ts";
import { Scripts } from "../src/scripts.ts";
import { loadConfig } from "../src/config.ts";
import { extractTiles } from "../src/tiles.ts";
import type { Job, Workflow } from "../src/types.ts";

const FIXTURE = join(import.meta.dir, "fixtures/fake-agent.ts");
let dir: string, store: Store, hub: Hub, log: string;

async function setup(env: Record<string, string> = {}) {
  dir = mkdtempSync(join(tmpdir(), "hearth-par-"));
  log = join(dir, "calls.log");
  store = await createStore(process.env.TEST_DB || "sqlite::memory:", dir);
  for (const c of COLLECTIONS) await store.clear(c);
  const config = { ...loadConfig({ HEARTH_AGENT: "custom", HEARTH_AGENT_CMD: JSON.stringify([process.execPath, FIXTURE]), ...env }), dataDir: dir };
  hub = new Hub(config, store, new Brain(config), new Scripts(store, dir, join(import.meta.dir, "../scripts")), null);
  await hub.setPrefs({ tz: "UTC" });
  await hub.ensureTeammates();
  process.env.FAKE_LOG = log;
  process.env.FAKE_MS = "400";
}
const plan = (jobs: any[]) => { process.env.FAKE_PLAN = JSON.stringify({ title: "t", reply: "On it", jobs }); };
const jobs = () => store.all<Job>("jobs");
const until = async (fn: () => Promise<boolean>, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end && !(await fn())) await Bun.sleep(25); };
const allDone = async (n: number) => { const j = await jobs(); return j.length === n && j.every((x) => x.status === "done" || x.status === "failed"); };

/** Max number of fake-agent processes that overlapped, from the start/end log. */
function maxOverlap() {
  const events = readFileSync(log, "utf8").trim().split("\n").map((l) => { const [k, t] = l.split(" "); return { k, t: Number(t) }; })
    .sort((a, b) => a.t - b.t || (a.k === "end" ? -1 : 1));
  let cur = 0, max = 0;
  for (const e of events) { cur += e.k === "start" ? 1 : -1; max = Math.max(max, cur); }
  return max;
}

afterEach(async () => { hub.stop(); await hub.idle(20_000); await store.close(); });

test("independent jobs run at the same time, and the ramble returns right away", async () => {
  await setup();
  plan([{ task: "check weather", teammate: "Scout" }, { task: "find a gift", teammate: "Scout" }, { task: "plan the week", teammate: "Planner" }]);
  const t0 = Date.now();
  const r = await hub.ramble("three things");
  expect(Date.now() - t0).toBeLessThan(300); // didn't wait for the jobs
  expect(r.value).toBeTruthy();
  await until(() => allDone(3));
  const elapsed = Date.now() - t0;
  expect(maxOverlap()).toBe(3);
  expect(elapsed).toBeLessThan(3 * 400 + 600); // well under sequential
});

test("a dependent job waits for its input and gets the result passed in", async () => {
  await setup();
  plan([{ id: "a", task: "find a restaurant", teammate: "Scout" }, { id: "b", task: "invite Sam to it", teammate: "Hearth", dependsOn: ["a"] }, { id: "c", task: "check weather", teammate: "Scout" }]);
  await hub.ramble("dinner with sam");
  await until(() => allDone(3));
  const [a, b] = [(await jobs()).find((j) => j.task.startsWith("find"))!, (await jobs()).find((j) => j.task.startsWith("invite"))!];
  expect(new Date(b.startedAt!).getTime()).toBeGreaterThanOrEqual(new Date(a.finishedAt!).getTime());
  expect(b.result).toContain("used earlier result");
});

test("the concurrency cap is respected; the rest queue", async () => {
  await setup({ HEARTH_MAX_PARALLEL: "2" });
  plan([1, 2, 3, 4, 5].map((i) => ({ task: `job ${i}`, teammate: "Hearth" })));
  await hub.ramble("five things");
  await until(() => allDone(5));
  expect(maxOverlap()).toBe(2);
});

test("a per-harness cap applies on top of the global one", async () => {
  await setup({ HEARTH_MAX_PARALLEL: "4", HEARTH_MAX_PARALLEL_CUSTOM: "1" });
  plan([{ task: "one", teammate: "Hearth" }, { task: "two", teammate: "Hearth" }]);
  await hub.ramble("two");
  await until(() => allDone(2));
  expect(maxOverlap()).toBe(1);
});

test("a failing job doesn't block its siblings, and skips only its dependents", async () => {
  await setup();
  plan([{ id: "x", task: "FAIL this one", teammate: "Hearth" }, { task: "fine one", teammate: "Scout" }, { id: "z", task: "needs x", teammate: "Hearth", dependsOn: ["x"] }]);
  await hub.ramble("mixed");
  await until(() => allDone(3), 12000);
  const all = await jobs();
  expect(all.find((j) => j.task === "fine one")!.status).toBe("done");
  expect(all.find((j) => j.task.startsWith("FAIL"))!.status).toBe("failed");
  expect(all.find((j) => j.task === "needs x")!.result).toContain("Skipped");
});

test("a second ramble mid-run is handled immediately", async () => {
  await setup({ HEARTH_MAX_PARALLEL: "1" });
  process.env.FAKE_MS = "800";
  plan([{ task: "slow one", teammate: "Hearth" }, { task: "slow two", teammate: "Hearth" }]);
  await hub.ramble("first");
  await Bun.sleep(100);
  const t0 = Date.now();
  plan([{ task: "quick", teammate: "Hearth" }]);
  const second = await hub.ramble("second");
  await until(async () => (await store.all<any>("messages")).some((m) => m.role === "assistant" && m.threadId === second.value!.thread.id), 3000);
  expect(Date.now() - t0).toBeLessThan(700); // the orchestrator didn't queue behind running jobs
});

test("spending cap parks model jobs instead of running them", async () => {
  await setup({ HEARTH_COST_CAP_DAY_USD: "0" });
  plan([{ task: "anything", teammate: "Hearth" }]);
  await hub.ramble("x");
  await until(async () => (await jobs()).some((j) => j.status === "blocked"));
  expect((await jobs())[0].blocked!.need).toContain("spending cap");
  expect(existsSync(log) ? readFileSync(log, "utf8") : "").toBe(""); // no model ran
});

test("tiles come out of script output; junk is dropped", () => {
  const r = extractTiles('@tile {"type":"weather","data":{"place":"Paris","temp":11,"hours":[{"t":"12:00","temp":12}]}}\nParis: 11°\n@tile {"type":"evil","data":{}}\n@tile not json');
  expect(r.text).toBe("Paris: 11°");
  expect(r.tiles.length).toBe(1);
  expect(r.tiles[0].data.place).toBe("Paris");
});

test("a finished ramble saves as a workflow in one tap, and the purger cleans the library", async () => {
  await setup();
  plan([{ id: "a", task: "find a restaurant", teammate: "Scout" }, { id: "b", task: "invite Sam to it", teammate: "Hearth", dependsOn: ["a"] }]);
  const r = await hub.ramble("dinner with sam");
  await until(() => allDone(2));
  const wf = (await hub.saveRambleAsWorkflow(r.value!.message.id, "dinner with sam")).value!;
  expect(wf.status).toBe("active");
  expect(wf.steps.map((s) => s.task)).toEqual(["find a restaurant", "invite Sam to it"]);

  // Pinned stays; unused and never-approved go.
  await hub.saveSkill({ name: "old-thing", description: "Old", kind: "recipe", steps: ["x"], uses: [] });
  await hub.saveSkill({ name: "keeper", description: "Keep", kind: "recipe", steps: ["x"], uses: [] });
  const keeper = (await hub.skillByName("keeper"))!;
  await store.put("skills", { ...keeper, pinned: true });
  await store.put("workflows", { ...wf, pinned: true });
  hub.clock = () => new Date(Date.now() + 60 * 864e5);
  const removed = await hub.purgeLibrary();
  expect(removed.some((x) => x.startsWith("skill old-thing"))).toBe(true);
  expect(await hub.skillByName("keeper")).toBeTruthy();
  expect((await store.all<Workflow>("workflows")).length).toBe(1);
});

test("the brain's tile action becomes a tile on the job", async () => {
  await setup();
  const r = await hub.applyActions([{ type: "tile", tile: "places", title: "Studios", data: { items: [{ name: "Mudlark", detail: "Sat" }] } }, { type: "tile", tile: "nope", data: {} }], "");
  expect(r.tiles.length).toBe(1);
  expect(r.tiles[0].type).toBe("places");
});

test("replying in a job's thread goes to the same teammate with the thread as context", async () => {
  await setup();
  process.env.FAKE_MS = "50";
  plan([{ task: "find a restaurant", teammate: "Scout" }]);
  const r = await hub.ramble("dinner");
  await until(() => allDone(1));
  const [root] = await jobs();
  const rep = await hub.replyToJob(root.id, "anything vegetarian?");
  expect(rep.value!.job.teammateId).toBe(root.teammateId);
  expect(rep.value!.message.replyTo).toBe(root.id);
  await until(() => allDone(2));
  const follow = (await jobs()).find((j) => j.followsUp === root.id)!;
  expect(follow.status).toBe("done");
  expect(follow.result).toContain("used earlier result"); // the fixture sees "done: find a restaurant" in its context
  // Each ramble is its own group chat, with Hearth's reply and one task message per job.
  const msgs = (await store.all<any>("messages")).filter((m) => m.threadId === r.value!.thread.id);
  expect(msgs.filter((m) => m.taskJobId === root.id).length).toBe(1);
  const r2 = await hub.ramble("something else");
  expect(r2.value!.thread.id).not.toBe(r.value!.thread.id);
});

test("teammates make files, scripts hand files over, and downloads are sandboxed", async () => {
  await setup();
  // A teammate's file.create action
  const r = await hub.applyActions([{ type: "file.create", name: "trip.ics", content: "BEGIN:VCALENDAR\nEND:VCALENDAR" }, { type: "file.create", name: "../../etc/passwd", content: "x" }], "", { threadId: "t1" });
  expect(r.fileIds.length).toBe(2);
  const files = await store.all<any>("files");
  expect(files.map((f) => f.name).sort()).toEqual(["passwd", "trip.ics"]); // path parts stripped
  expect(files.find((f) => f.name === "trip.ics").mime).toBe("text/calendar");

  // A script that writes a file and prints @file
  const { sha256 } = await import("../src/auth.ts");
  const code = 'await Bun.write("report.csv", "a,b\\n1,2"); console.log("@file report.csv"); console.log("wrote it")';
  const p = await hub.scripts.propose({ name: "make-report", code });
  await hub.scripts.approve(p.value!.id, sha256(code));
  await hub.saveSkill({ name: "report", description: "Make a report", kind: "script", script: "make-report" });
  const sk = (await hub.skillByName("report"))!;
  const out = await hub.runSkill(sk.id, {}, {});
  expect(out.output).toBe("wrote it");
  const csv = (await store.all<any>("files")).find((f) => f.name === "report.csv");
  expect(new TextDecoder().decode(hub.files.bytes(csv.id)!)).toBe("a,b\n1,2");

  // Downloads over HTTP: auth required, html never inline, sandbox CSP
  const { startServer } = await import("../src/server.ts");
  const { newPairingCode, redeemPairingCode } = await import("../src/auth.ts");
  (hub.config as any).port = 0;
  const { server } = await startServer(hub);
  const { code: pc } = await newPairingCode(store);
  const { token } = (await redeemPairingCode(store, pc, "test"))!;
  const html = (await hub.files.save(new TextEncoder().encode("<script>alert(1)</script>"), { name: "evil.html", source: "teammate" })).value!;
  const base = `http://127.0.0.1:${server.port}`;
  expect((await fetch(`${base}/api/files/${html.id}`)).status).toBe(401);
  const res = await fetch(`${base}/api/files/${html.id}?inline=1`, { headers: { Authorization: `Bearer ${token}` } });
  expect(res.headers.get("content-disposition")).toStartWith("attachment");
  expect(res.headers.get("content-type")).toBe("application/octet-stream");
  expect(res.headers.get("content-security-policy")).toStartWith("sandbox");
  const up = await fetch(`${base}/api/files`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "X-File-Name": encodeURIComponent("notes.txt") }, body: "remember the milk" });
  const upFile = await up.json();
  expect(hub.files.textOf(upFile)).toBe("remember the milk");
  server.stop(true);
});

test("rambles are numbered temporary channels that archive an hour after they're done", async () => {
  await setup();
  process.env.FAKE_MS = "30";
  plan([{ task: "quick thing", teammate: "Hearth" }]);
  const a = await hub.ramble("one");
  const b = await hub.ramble("two");
  await until(() => allDone(2));
  const list = await hub.listThreads();
  expect(list.map((t: any) => t.name).sort()).toEqual(["ramble-1", "ramble-2"]);
  await hub.archiveQuietRambles();
  expect((await hub.listThreads()).every((t: any) => !t.archived)).toBe(true); // not quiet long enough
  const later = Date.now() + 61 * 60_000;
  hub.clock = () => new Date(later);
  await hub.archiveQuietRambles();
  expect((await hub.listThreads()).every((t: any) => t.archived)).toBe(true);
  // A background watch made in an archived ramble talks in the DM instead of pulling the ramble back.
  const watch = (await hub.addHook({ title: "Tickets", trigger: { type: "at", at: new Date(later).toISOString() }, action: { type: "notify", text: "On sale" } }, "you", { threadId: b.value!.thread.id })).value!;
  await hub.fire(watch, "test");
  expect((await hub.listThreads()).find((t: any) => t.id === b.value!.thread.id)!.archived).toBe(true);
  const dm = (await store.all<any>("messages")).find((m) => m.text === "On sale")!;
  expect([dm.threadId.startsWith("tm-"), dm.fromThreadId]).toEqual([true, b.value!.thread.id]); // links back to the ramble
  expect((await hub.roster()).some((t: any) => t.lastDmAt === dm.createdAt)).toBe(true); // for the unread dot
  // Posting in an archived ramble brings it back.
  await hub.ramble("one more thing", a.value!.thread.id);
  const back = (await hub.listThreads()).find((t: any) => t.id === a.value!.thread.id);
  expect(back!.archived).toBe(false);
  expect(b.value).toBeTruthy();
});

test("saying more about a task that's still running restarts it with the whole brief instead of adding another", async () => {
  await setup();
  process.env.FAKE_MS = "1500";
  plan([{ label: "Knee before volleyball", task: "help with left knee pain before volleyball", teammate: "Hearth" }]);
  const r = await hub.ramble("my left knee hurts and I play volleyball saturday");
  const thread = r.value!.thread.id;
  await until(async () => (await jobs()).some((j) => j.status === "working"));
  const first = (await jobs())[0];
  await Bun.sleep(300); // the model process is running
  process.env.FAKE_MS = "50";
  plan([{ addTo: first.id, label: "Knee, volleyball and lower body", task: "also a lower-body plan so it doesn't happen again" }]);
  await hub.ramble("I also want to strengthen my lower body to prevent this", thread);
  await until(() => allDone(1));
  const all = await jobs();
  expect(all.length).toBe(1); // still one task, one answer
  expect(all[0].status).toBe("done");
  expect(all[0].task).toContain("The user added: also a lower-body plan");
  expect(all[0].label).toBe("Knee, volleyball and lower body");
  expect(readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("end")).length).toBe(1); // the first run was stopped
});
