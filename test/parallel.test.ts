import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, COLLECTIONS, type Store } from "../src/store/index.ts";
import { Hub } from "../src/hub.ts";
import { Brain } from "../src/brain.ts";
import { Scripts } from "../src/scripts.ts";
import { loadConfig } from "../src/config.ts";
import { extractTiles } from "../src/tiles.ts";
import type { Job, Thread, Workflow } from "../src/types.ts";

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

test("an agent hands over files from its workspace with @file lines; nothing outside it leaves", async () => {
  await setup();
  const { mkdirSync, writeFileSync, symlinkSync } = await import("node:fs");
  const thread = "job-thread-1";
  const folder = hub.brain.sessions.folder(thread, { workspace: "parley-launch" })!;
  mkdirSync(join(folder, "out"), { recursive: true });
  writeFileSync(join(folder, "out/preview.mp4"), "fake video bytes");
  writeFileSync(join(dir, "secret.txt"), "hub secret");
  symlinkSync(join(dir, "secret.txt"), join(folder, "out/link.txt"));
  const meter: any = { costUsd: 0, unknown: false, thread, ranOn: "cloud" };
  const text = "Made a first preview.\n@file out/preview.mp4\n@file ../../secret.txt\n@file out/link.txt\n@file out/missing.png";
  const r = await hub.handOver(text, { threadId: "t1", jobId: "j1", meter });
  expect(r.fileIds.length).toBe(1);
  const f = (await store.get<any>("files", r.fileIds[0]))!;
  expect(f).toMatchObject({ name: "preview.mp4", mime: "video/mp4", threadId: "t1", jobId: "j1", source: "teammate" });
  expect(new TextDecoder().decode(hub.files.bytes(f.id)!)).toBe("fake video bytes");
  expect(existsSync(join(folder, "out/preview.mp4"))).toBe(true); // the workspace keeps its copy
  expect(r.done).toEqual([{ kind: "file", label: "Made preview.mp4", id: f.id }]);
  expect(r.text).toStartWith("Made a first preview.");
  expect(r.text).not.toContain("@file");
  expect(r.text).toContain("../../secret.txt (couldn't attach");
  expect(r.text).toContain("out/link.txt (couldn't attach");
  expect(r.text).toContain("out/missing.png (couldn't attach");
  // No @file lines: the text is left exactly as it was.
  expect((await hub.handOver("just text", { meter })).text).toBe("just text");
  // A run on a linked Mac made its files there: say so instead of attaching.
  const mac = await hub.handOver("Done.\n@file out/preview.mp4", { threadId: "t1", meter: { ...meter, ranOn: "Rishi's Mac" } });
  expect(mac.fileIds).toEqual([]);
  expect(mac.text).toContain("on Rishi's Mac");
});

test("media and documents an agent makes or edits are shown by themselves; _scratchpad and workspace folders aren't", async () => {
  await setup();
  const { mkdirSync, writeFileSync, utimesSync } = await import("node:fs");
  const thread = "job-thread-2";
  const folder = hub.brain.sessions.folder(thread, { workspace: "launch-video" })!;
  for (const d of ["out", "_scratchpad", "data", "scripts"]) mkdirSync(join(folder, d), { recursive: true });
  writeFileSync(join(folder, "out/old.mp4"), "from yesterday");
  const yesterday = new Date(Date.now() - 86_400_000);
  utimesSync(join(folder, "out/old.mp4"), yesterday, yesterday);
  const meter: any = { costUsd: 0, unknown: false, thread, ranOn: "cloud" };
  const since = Date.now() - 5;
  writeFileSync(join(folder, "out/cut.mp4"), "v1");
  writeFileSync(join(folder, "out/deck.pdf"), "pdf");
  writeFileSync(join(folder, "out/notes.md"), "not media: needs @file");
  writeFileSync(join(folder, "_scratchpad/frame.png"), "test frame");
  writeFileSync(join(folder, "data/raw.csv"), "raw");
  writeFileSync(join(folder, "scripts/render.py"), "code");
  const r = await hub.handOver("Here's the first cut.", { threadId: "t2", jobId: "j1", meter }, undefined, since);
  expect(r.text).toBe("Here's the first cut.");
  expect(r.done.map((d) => d.label).sort()).toEqual(["Made cut.mp4", "Made deck.pdf"]);

  // The next run edits the cut and leaves the deck alone: only the cut comes back, as an update.
  const since2 = Date.now() + 10;
  await Bun.sleep(20);
  writeFileSync(join(folder, "out/cut.mp4"), "v2");
  utimesSync(join(folder, "out/deck.pdf"), new Date(), new Date()); // touched, same bytes
  const r2 = await hub.handOver("Tightened the ending.\n@file out/notes.md", { threadId: "t2", jobId: "j2", meter }, undefined, since2);
  expect(r2.done.map((d) => d.label)).toEqual(["Made notes.md", "Updated cut.mp4"]);
  const cut = (await store.get<any>("files", r2.done[1].id!))!;
  expect(new TextDecoder().decode(hub.files.bytes(cut.id)!)).toBe("v2");
  expect(r2.text).toBe("Tightened the ending.");
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
  expect(list.map((t: any) => t.name).sort()).toEqual(["t", "t-2"]); // named by Hearth from the plan, kept unique
  expect(list.map((t: any) => t.num).sort()).toEqual([1, 2]);
  await hub.archiveQuietRambles();
  expect((await hub.listThreads()).every((t: any) => !t.archived)).toBe(true); // not quiet long enough
  const later = Date.now() + 61 * 60_000;
  hub.clock = () => new Date(later);
  await hub.archiveQuietRambles();
  expect((await hub.listThreads()).every((t: any) => t.archived)).toBe(true);
  // A background watch made in an archived ramble talks in the DM instead of pulling the ramble back.
  await hub.pipeline.remind({ title: "Tickets", schedule: { at: new Date(later).toISOString() }, text: "On sale", threadId: b.value!.thread.id }, "you");
  await hub.pipeline.tick();
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

test("the model deck: quick jobs run on the quick model and move up step by step when it can't do them", async () => {
  await setup();
  process.env.FAKE_MS = "20";
  plan([{ task: "set a reminder", teammate: "Hearth", effort: "quick" }, { task: "FAIL this one", teammate: "Hearth", effort: "quick" }]);
  await hub.ramble("two small things");
  await until(() => allDone(2));
  const all = await jobs();
  const ok = all.find((j) => j.task === "set a reminder")!;
  const bad = all.find((j) => j.task.startsWith("FAIL"))!;
  expect([ok.effort, ok.tier, ok.escalated]).toEqual(["quick", "quick", false]);
  expect([bad.tier, bad.escalated, bad.status]).toEqual(["heavy", true, "failed"]); // quick -> workhorse -> heavy
});

test("messages sent while a ramble is being planned wait and are planned together, so nothing is duplicated", async () => {
  await setup();
  process.env.FAKE_MS = "50";
  plan([{ label: "Gift for Priya", task: "find a gift", teammate: "Research" }]);
  const r = await hub.ramble("find priya a gift");
  const tid = r.value!.thread.id;
  await hub.ramble("pottery, she loves pottery", tid);  // planning #1 still running
  await hub.ramble("under $80 please", tid);
  await until(async () => !hub.thinking && (await jobs()).every((j) => j.status === "done"));
  const orchestrations = readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("start") && l.includes("?")).length;
  expect((await jobs()).length).toBe(2); // one plan for the first message, one for the two that arrived during it
  expect(orchestrations).toBeLessThanOrEqual(2);
});

test("a DM sent while the teammate is still working goes into its current task", async () => {
  await setup();
  process.env.FAKE_MS = "1500";
  const first = (await hub.askTeammate("scout", "find a pottery studio")).value!;
  await until(async () => (await jobs()).some((j) => j.status === "working"));
  await Bun.sleep(200);
  process.env.FAKE_MS = "50";
  const second = (await hub.askTeammate("scout", "in Oakland please")).value!;
  expect(second.job.id).toBe(first.job.id);
  await until(() => allDone(1));
  const [j] = await jobs();
  expect(j.task).toContain("The user added: in Oakland please");
});

test("boards: each teammate's work in Up next / Working / Needs you / Done, or everyone's", async () => {
  await setup();
  process.env.FAKE_MS = "1200";
  plan([{ label: "Gift for Priya", task: "find a gift", teammate: "Research" }, { label: "Friday reminder", task: "set a reminder", teammate: "Reminders" }]);
  await hub.ramble("gift and a reminder");
  await until(async () => (await jobs()).filter((j) => j.status === "working").length === 2);
  const all = await hub.board();
  expect(all.working.map((c: any) => c.title).sort()).toEqual(["Friday reminder", "Gift for Priya"]);
  const scout = await hub.board("scout");
  expect(scout.working.map((c: any) => c.title)).toEqual(["Gift for Priya"]);
  await until(() => allDone(2));
  expect((await hub.board("scout")).done[0].where).toBe("#t");
});

test("asking more about a finished task goes straight to its thread, with no planning call", async () => {
  await setup();
  process.env.FAKE_MS = "20";
  plan([{ label: "Your Robinhood balance", task: "check my Robinhood balance", teammate: "Hearth" }]);
  const r = await hub.ramble("what's my robinhood balance");
  const thread = r.value!.thread.id;
  await until(() => allDone(1));
  const root = (await jobs())[0];
  process.env.FAKE_PLAN = "not json: the planner must not be asked"; // a planning call would make a new task
  await hub.ramble("how is it allocated and how has it grown?", thread);
  await until(() => allDone(2));
  const next = (await jobs()).find((j) => j.id !== root.id)!;
  expect([next.followsUp, next.teammateId, next.status]).toEqual([root.id, root.teammateId, "done"]); // same thread, same teammate
  const msgs = await store.all<any>("messages");
  expect(msgs.filter((m) => m.taskJobId).length).toBe(1); // no second task post
  expect(msgs.find((m) => m.text.startsWith("how is it"))?.continues).toEqual([root.id]); // your message links to the thread
  expect(msgs.filter((m) => m.role === "assistant" && m.teammateId === "hearth" && !m.taskJobId).length).toBe(1); // no planner reply
});

test("asking a stuck task where it's stuck goes on in its thread and settles the stuck card", async () => {
  await setup();
  process.env.FAKE_MS = "20";
  plan([{ label: "AliExpress orders", task: "check my AliExpress orders", teammate: "Research" }]);
  const r = await hub.ramble("check my aliexpress orders");
  const thread = r.value!.thread.id;
  await until(() => allDone(1));
  const root = (await jobs())[0];
  await store.put<Job>("jobs", { ...root, status: "blocked", blocked: { need: "Order details", why: "Not logged in", unblock: "Try again" } } as any);
  process.env.FAKE_PLAN = "not json: the planner must not be asked";
  await hub.ramble("did u get the login from the mac? where r u stuck?", thread);
  await until(() => allDone(2));
  const all = await jobs();
  const next = all.find((j) => j.id !== root.id)!;
  expect([next.followsUp, next.teammateId]).toEqual([root.id, root.teammateId]);
  const settled = all.find((j) => j.id === root.id)!;
  expect([settled.status, settled.blocked]).toEqual(["done", undefined]);
  expect((await store.all<any>("messages")).filter((m) => m.taskJobId).length).toBe(1); // no second task post
});

test("a new subject sent to the latest thread is handed back and planned as a new task", async () => {
  await setup();
  process.env.FAKE_MS = "20";
  plan([{ label: "Your Robinhood balance", task: "check my Robinhood balance", teammate: "Hearth" }]);
  const r = await hub.ramble("what's my robinhood balance");
  const thread = r.value!.thread.id;
  await until(() => allDone(1));
  const root = (await jobs())[0];
  // The planner may still try to continue the thread that handed it back; it's not offered, and an unknown id makes a new task.
  plan([{ continue: root.id, label: "Dinner spot", task: "find a dinner spot", teammate: "Hearth" }]);
  await hub.ramble("NEW: find me a dinner spot tonight", thread);
  await until(async () => (await jobs()).filter((j) => !j.followsUp).length === 2 && (await allDone(2)));
  const all = await jobs();
  expect(all.some((j) => j.followsUp)).toBe(false); // the handed-back follow-up is gone
  const dinner = all.find((j) => j.id !== root.id)!;
  expect(dinner.label).toBe("Dinner spot");
  const msg = (await store.all<any>("messages")).find((m) => m.text.startsWith("NEW"));
  expect(msg.continues).toBeUndefined();
  // Nobody said keep it: after 5s it moved to its own ramble, with the task, and the old ramble says where it went.
  expect([msg.threadId !== thread, msg.movedFrom, dinner.threadId, msg.newTopic]).toEqual([true, thread, msg.threadId, undefined]);
  expect((await store.all<any>("messages")).some((m) => m.threadId === thread && m.movedTo === msg.threadId)).toBe(true);
}, 20_000);

test("tapping Keep here on a new topic keeps it in the ramble", async () => {
  await setup();
  process.env.FAKE_MS = "20";
  plan([{ label: "Your Robinhood balance", task: "check my Robinhood balance", teammate: "Hearth" }]);
  const thread = (await hub.ramble("what's my robinhood balance")).value!.thread.id;
  await until(() => allDone(1));
  plan([{ label: "Dinner spot", task: "find a dinner spot", teammate: "Hearth" }]);
  const m = (await hub.ramble("NEW: find me a dinner spot tonight", thread)).value!.message;
  await until(async () => !!(await store.get<any>("messages", m.id))?.newTopic);
  expect(await hub.decideMove(thread, m.id, "keep")).toBe(true);
  await until(async () => (await jobs()).length === 2 && (await allDone(2)));
  const dinner = (await jobs()).find((j) => j.label === "Dinner spot")!;
  expect(dinner.threadId).toBe(thread);
  expect((await store.get<any>("messages", m.id)).newTopic).toBeUndefined();
});

test("when the planner says it's a new topic, it's offered and moved too", async () => {
  await setup();
  process.env.FAKE_MS = "20";
  plan([{ label: "Card subscriptions", task: "list my card subscriptions", teammate: "Hearth" }]);
  const thread = (await hub.ramble("what subscriptions are on my card")).value!.thread.id;
  await until(() => allDone(1));
  process.env.FAKE_MS = "3000"; // the thread's still busy, so this goes to the planner, not the teammate
  plan([{ label: "Card subscriptions 2", task: "more", teammate: "Hearth" }]);
  await hub.ramble("also the annual ones", thread);
  await until(async () => (await jobs()).some((j) => j.status === "working"));
  process.env.FAKE_PLAN = JSON.stringify({ title: "Phoenix flights", reply: "On it", newTopic: true, jobs: [{ label: "Phoenix flights", task: "cheapest flights to Phoenix", teammate: "Hearth" }] });
  await hub.ramble("cheapest flights sf to phoenix friday", thread);
  await until(async () => (await jobs()).some((j) => j.label === "Phoenix flights"), 12_000);
  const fl = (await jobs()).find((j) => j.label === "Phoenix flights")!;
  expect(fl.threadId).not.toBe(thread);
}, 25_000);

test("a new ramble that's about an earlier one (even a closed one) is matched to it, without a model call", async () => {
  await setup();
  process.env.FAKE_MS = "20";
  plan([{ label: "Your Robinhood balance", task: "check my Robinhood balance and holdings", teammate: "Hearth" }]);
  const money = (await hub.ramble("what's my robinhood balance")).value!.thread.id;
  plan([{ label: "Ramen near me", task: "find a good ramen place nearby", teammate: "Hearth" }]);
  await hub.ramble("find me a good ramen place");
  await until(() => allDone(2));
  await hub.renameThread(money, "robinhood-money");
  expect((await hub.similarRamble("how is my robinhood doing this month?"))?.threadId).toBe(money);
  expect((await hub.similarRamble("can you plan my week please"))).toBeNull(); // only common words: no match
  expect((await hub.similarRamble("weather in tokyo"))).toBeNull();
});

test("a new ramble on an earlier one's subject is its own ramble, started in that one's workspace", async () => {
  await setup();
  process.env.FAKE_MS = "20";
  plan([{ label: "Your Robinhood balance", task: "check my Robinhood balance and holdings", teammate: "Hearth", workspace: "robinhood-account" }]);
  const money = (await hub.ramble("what's my robinhood balance")).value!.thread.id;
  await until(() => allDone(1));
  plan([{ label: "Robinhood this month", task: "how Robinhood did this month", teammate: "Hearth" }]); // the planner gives no workspace
  const next = (await hub.ramble("how is my robinhood doing this month?")).value!.thread;
  expect(next.id).not.toBe(money);
  expect(next.workspace).toBe("robinhood-account");
  expect(next.workspaceFrom).toBe(money);
  await until(() => allDone(2));
  const job = (await jobs()).find((j) => j.threadId === next.id)!;
  expect((await (hub as any).placeFor(job))?.workspace).toBe("robinhood-account");
  // Nothing alike: no workspace carried over.
  plan([{ label: "Ramen near me", task: "find a good ramen place nearby", teammate: "Hearth" }]);
  expect((await hub.ramble("find me a good ramen place")).value!.thread.workspace).toBeUndefined();
});

test("in the background, rambles on the same subject go in one project: a new one named after it, with the folder", async () => {
  await setup();
  process.env.FAKE_MS = "20";
  plan([{ label: "Your Robinhood balance", task: "check my Robinhood balance and holdings", teammate: "Hearth", workspace: "robinhood-account" }]);
  const money = (await hub.ramble("what's my robinhood balance")).value!.thread.id;
  await until(() => allDone(1));
  const job = (await jobs())[0];
  const before = hub.brain.sessions.placeOf(job.id);
  process.env.FAKE_MS = "1500";
  plan([{ label: "Robinhood this month", task: "how Robinhood did this month", teammate: "Hearth" }]);
  const next = (await hub.ramble("how is my robinhood doing this month?")).value!.thread;
  expect(next.projectId).toBeUndefined(); // nothing to wait for when you send: grouping happens in the background
  await until(async () => (await jobs()).some((j) => j.threadId === next.id && j.status === "working"));
  expect(await hub.groupRambles()).toBe(0); // its job is still going, so its folder isn't moved under it
  await until(() => allDone(2), 10_000);
  process.env.FAKE_MS = "20";
  plan([{ label: "Ramen near me", task: "find a good ramen place nearby", teammate: "Hearth" }]);
  const ramen = (await hub.ramble("find me a good ramen place")).value!.thread.id;
  await until(() => allDone(3));
  expect(await hub.groupRambles()).toBe(1);
  const p = (await hub.listProjects()).find((x) => x.name === "Robinhood account")!;
  expect(p.rambles).toBe(2);
  expect((await store.get<Thread>("threads", next.id))?.projectId).toBe(p.id);
  expect((await store.get<Thread>("threads", money))?.projectId).toBe(p.id);
  expect((await store.get<Thread>("threads", ramen))?.projectId).toBeUndefined();
  if (before) expect(hub.brain.sessions.placeOf(job.id)).toEqual({ project: "robinhood-account", workspace: "robinhood-account" });
  const j2 = (await jobs()).find((j) => j.threadId === next.id)!;
  expect(await (hub as any).placeFor(j2)).toEqual({ project: "robinhood-account", workspace: "robinhood-account" });
  // Once there's a project for it, a new one is filed right away, and so is one that names an existing project.
  plan([{ label: "Robinhood taxes", task: "robinhood tax forms", teammate: "Hearth" }]);
  expect((await hub.ramble("robinhood tax forms please")).value!.thread.projectId).toBe(p.id);
  const wed = (await hub.createProject("Wedding")).value!;
  plan([{ label: "Cake", task: "cake", teammate: "Hearth" }]);
  expect((await hub.ramble("wedding cake ideas")).value!.thread.projectId).toBe(wed.id);
  await until(() => allDone(5));
});

test("old loose rambles about the same thing are grouped too, into the project one of them is in", async () => {
  await setup();
  const at = new Date().toISOString();
  const p = (await hub.createProject("Home")).value!;
  await store.put<Thread>("threads", { id: "old-a", createdAt: at, updatedAt: at, title: "Kitchen renovation quotes", channel: "kitchen-renovation", projectId: p.id } as Thread);
  await store.put<Thread>("threads", { id: "old-b", createdAt: at, updatedAt: at, title: "Kitchen tiles", channel: "kitchen-tiles" } as Thread);
  await store.put<Thread>("threads", { id: "old-c", createdAt: at, updatedAt: at, title: "Tokyo flights", channel: "tokyo-flights" } as Thread);
  await store.put<Thread>("threads", { id: "old-d", createdAt: at, updatedAt: at, title: "Hotels in Tokyo", channel: "tokyo-hotels" } as Thread);
  expect(await hub.groupRambles()).toBe(2);
  expect((await store.get<Thread>("threads", "old-b"))?.projectId).toBe(p.id);
  const tokyo = (await hub.listProjects()).find((x) => x.name === "Tokyo flights" || x.name === "Tokyo hotels")!;
  expect(tokyo?.rambles).toBe(2);
  expect(await hub.groupRambles()).toBe(0); // nothing left to group
});

test("a project dragged onto another joins it: rambles, memory and files", async () => {
  await setup();
  const a = (await hub.createProject("Stocks")).value!, b = (await hub.createProject("Money", "💰")).value!;
  const t = (await hub.ramble("loose", undefined, [], a.id)).value!.thread.id;
  await hub.addFact({ fact: "Uses Robinhood.", notebook: a.notebook, importance: 2 }, "assistant");
  const dir = hub.brain.sessions.folder("thread-merge-1", { project: "stocks", workspace: "general" })!;
  writeFileSync(join(dir, "x.txt"), "hi");
  expect((await hub.mergeProject(a.id, a.id)).error).toBeTruthy();
  expect((await hub.mergeProject(a.id, b.id)).value?.name).toBe("Money");
  expect(await store.get("projects", a.id)).toBeNull();
  expect((await store.get<Thread>("threads", t))?.projectId).toBe(b.id);
  expect((await hub.projectDetail(b.id))!.memory.map((f) => f.fact)).toEqual(["Uses Robinhood."]);
  expect(hub.brain.sessions.placeOf("thread-merge-1")).toEqual({ project: "money", workspace: "general" });
  await until(async () => !hub.thinking);
});

test("moving a ramble into the earlier one it was started like takes everything along, even a task still running", async () => {
  await setup();
  process.env.FAKE_MS = "20";
  plan([{ label: "Your Robinhood balance", task: "check my Robinhood balance and holdings", teammate: "Hearth", workspace: "robinhood-account" }]);
  const money = (await hub.ramble("what's my robinhood balance")).value!.thread.id;
  await until(() => allDone(1));
  process.env.FAKE_MS = "1500";
  plan([{ label: "Robinhood this month", task: "how Robinhood did this month", teammate: "Hearth" }]);
  const next = (await hub.ramble("how is my robinhood doing this month?")).value!.thread.id;
  await until(async () => (await jobs()).some((j) => j.label === "Robinhood this month" && j.status === "working"), 10_000);
  expect((await hub.joinRamble(next, "move")).value?.threadId).toBe(money);
  await until(() => allDone(2), 10_000);
  expect(await store.get("threads", next)).toBeNull(); // not brought back by the job finishing
  expect((await jobs()).every((j) => j.threadId === money)).toBe(true);
  const said = (await store.all<any>("messages")).filter((m) => m.threadId === money).map((m) => m.text);
  expect(said).toContain("how is my robinhood doing this month?");
  expect((await store.all<any>("messages")).some((m) => m.threadId === next)).toBe(false);
  // Keep separate: it stays, and isn't offered again.
  process.env.FAKE_MS = "20";
  plan([{ label: "Robinhood taxes", task: "robinhood tax forms", teammate: "Hearth" }]);
  const third = (await hub.ramble("robinhood tax forms")).value!.thread.id;
  await hub.joinRamble(third, "keep");
  expect((await store.get<any>("threads", third))?.workspaceKept).toBe(true);
}, 30_000);
