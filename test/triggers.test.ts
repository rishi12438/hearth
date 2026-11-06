import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, COLLECTIONS, type Store } from "../src/store/index.ts";
import { Hub, eventHeadline, sourceWords, shortName } from "../src/hub.ts";
import { Brain } from "../src/brain.ts";
import { Scripts } from "../src/scripts.ts";
import { loadConfig } from "../src/config.ts";
import { zonedToUtc } from "../src/time.ts";
import { cleanWatch, describeWatch } from "../src/events/watchers.ts";
import { pageText, lineDiff, look } from "../src/watch.ts";
import type { Message } from "../src/types.ts";

// Everything that makes the team speak first is in the event pipeline: reminders (a timer and its trigger),
// watchers (a page, a script, an app, a silence) that push what's new into their own source, push sources with a
// secret URL, and the place source. Hooks are gone; old ones are moved over at start.

const TZ = "America/Los_Angeles";
let dir: string, store: Store, hub: Hub, now: Date;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hearth-trig-"));
  const repo = join(dir, "repo-scripts");
  mkdirSync(repo);
  // Prints only the drops it hasn't printed before: the pattern script watchers are meant for.
  writeFileSync(join(repo, "drops.ts"), [
    "// description: new drops since last time",
    "const all = (process.argv[2] || '').split(',').filter(Boolean);",
    "const seen = new Set((process.env.HEARTH_LAST || '').split('\\n'));",
    "const fresh = all.filter((x) => !seen.has(x));",
    "if (fresh.length) console.log(all.join('\\n'));",
  ].join("\n"));
  store = await createStore(process.env.TEST_DB || "sqlite::memory:", dir);
  for (const c of COLLECTIONS) await store.clear(c);
  const config = { ...loadConfig({}), dataDir: dir, agent: "echo" };
  const scripts = new Scripts(store, dir, repo);
  await scripts.syncRepo();
  hub = new Hub(config, store, new Brain(config), scripts, null);
  now = zonedToUtc(2026, 10, 30, 12, 0, TZ);
  hub.clock = () => now;
  await hub.setPrefs({ tz: TZ });
});

afterEach(async () => { hub.stop(); await hub.idle(20_000); await store.close(); });

async function until(ok: () => Promise<boolean>, ms = 5000) { const end = Date.now() + ms; while (!(await ok()) && Date.now() < end) await Bun.sleep(20); }
const sent = async () => (await store.all<Message>("messages")).filter((m) => m.proactive);

test("watcher rules: pages need a web address and 15 min, scripts need a real name", () => {
  expect(cleanWatch("page", { url: "file:///etc/passwd" })).toContain("http");
  expect(cleanWatch("page", { url: "https://example.com", everyMin: 5 })).toContain("15");
  expect(cleanWatch("script", { script: "../evil" })).toContain("script");
  expect(cleanWatch("silence", { hours: 2 })).toContain("6");
  expect(cleanWatch("nope", {})).toContain("kind");
  const w = cleanWatch("page", { url: "https://www.example.com/tickets" }) as any;
  expect(w.everyMin).toBe(60);
  expect(describeWatch("page", w.config, w.everyMin)).toBe("example.com changes (checked every 1h)");
});

test("page text drops markup; the diff shows only lines that came and went", () => {
  const html = "<html><head><style>x{}</style><script>alert(1)</script></head><body><h1>Tickets</h1><p>Sold &amp; out</p></body></html>";
  expect(pageText(html, "text/html")).toBe("Tickets\nSold & out");
  const d = lineDiff("Tickets\nSold out\nFooter", "Tickets\nOn sale Friday\nFooter");
  expect(d).toMatchObject({ added: 1, removed: 1, addedLines: ["On sale Friday"], removedLines: ["Sold out"] });
  expect(d.text).toBe("+ On sale Friday\n- Sold out");
});

test("a page watcher won't read the hub's own network", async () => {
  expect((await look("http://127.0.0.1:1/")).error).toContain("public");
  expect((await look("http://localhost:1/")).error).toContain("public");
});

test("a script watcher runs with no model and pushes an event only when there's something new", async () => {
  const p = hub.pipeline;
  const w = (await p.addWatcher({ name: "drops", kind: "script", script: "drops", args: ["a,b"], everyMin: 10 }, "Research")).value!;
  await p.addTrigger({ name: "drops", source: "drops", formula: "true", action: { type: "notify", text: "New drops:\n{{output}}" } }, "Research");
  await hub.tick();
  expect((await sent()).length).toBe(0); // the first look only remembers what it saw
  expect(p.findWatcher("drops")!.looked).toBe(true);
  now = new Date(now.getTime() + 11 * 60000);
  await hub.tick();
  expect((await sent()).length).toBe(0); // nothing new: the script prints nothing
  await p.updateWatcher("drops", { args: ["a,b,c"] }); // watching something else: a fresh first look…
  await hub.tick();
  expect((await sent()).length).toBe(0);
  // …so pretend it had seen a and b, and look again.
  p.db.query("UPDATE watchers SET seen = ?, next_at = ? WHERE id = ?").run(JSON.stringify({ hash: "old", text: "a\nb", at: "" }), now.toISOString(), w.id);
  await hub.tick();
  const msgs = await sent();
  expect(msgs.map((m) => m.text)).toEqual(["New drops:\na\nb\nc"]);
  expect(msgs[0].proactive!.trigger).toBe("event from drops");
});

test("a watcher with a duplicate target is refused with what to do instead", async () => {
  const p = hub.pipeline;
  await p.addWatcher({ name: "tickets", kind: "page", url: "https://example.com/tickets" });
  const again = await p.addWatcher({ name: "tickets-2", kind: "page", url: "https://example.com/tickets" });
  expect(again.conflict?.kind).toBe("duplicate");
  expect(again.error).toContain("trigger.add");
  // Its source is the watcher's: its variables come from the kind and can't be edited.
  expect(p.findSource("tickets")!.variables.map((v) => v.name)).toContain("added");
  expect(p.updateSource("tickets", { variables: [{ name: "x" }] }).conflict?.kind).toBe("protected");
  expect(p.removeWatcher("tickets")).toBe(true);
  expect(p.findSource("tickets")).toBeNull();
});

test("an app watcher pushes one event per new item; triggers pick which ones matter", async () => {
  const p = hub.pipeline;
  let inbox = [{ id: "1", title: "Field trip form", text: "Due Friday" }];
  (hub as any).connections.connected = () => true;
  const { registerSource } = await import("../src/sources/index.ts");
  registerSource({ id: "fake", label: "Fake mail", needs: "fake", doc: "", validate: () => ({}), minutes: () => ({ min: 5, default: 15 }), describe: () => "Fake mail", items: async () => inbox });
  await p.addWatcher({ name: "school", kind: "app", app: "fake", config: {} }, "Hearth");
  await p.addTrigger({ name: "school-forms", source: "school", formula: 'title contains "form"', action: { type: "notify", text: "School: {{title}}" } }, "Hearth");
  await hub.tick();
  expect((await sent()).length).toBe(0); // first look: what's there already isn't news
  inbox = [{ id: "3", title: "Picture day", text: "" }, { id: "2", title: "Permission form", text: "Sign it" }, ...inbox];
  await hub.pollNow("fake", "test");
  expect((await sent()).map((m) => m.text)).toEqual(["School: Permission form"]);
  expect(p.events({ source: "school" }).length).toBe(2); // both saved; only one matched
});

test("a push source's URL (and the old webhook URL) wakes its trigger; a wrong secret wakes nothing", async () => {
  const p = hub.pipeline;
  const src = p.createSource({ name: "door", variables: [{ name: "motion" }] }, "Hearth").value!;
  await p.addTrigger({ name: "door", source: "door", formula: "motion == true", action: { type: "notify", text: "Someone's at the door" } }, "Hearth");
  expect(p.pushBySecret("not-the-secret", "{}")).toBeNull();
  expect(p.pushBySecret(src.secret, '{"motion":true}')!.value).toBeTruthy();
  await p.drain();
  expect((await sent()).map((m) => m.text)).toEqual(["Someone's at the door"]);
  p.updateSource("door", { status: "paused" });
  expect(p.pushBySecret(src.secret, "{}")!.error).toContain("paused");
});

test("a webhook at 2am is handled right away", async () => {
  now = zonedToUtc(2026, 10, 31, 2, 0, TZ); // 2am
  const p = hub.pipeline;
  const src = p.createSource({ name: "school-mail", variables: [{ name: "subject" }] }, "Hearth").value!;
  await p.addTrigger({ name: "school-mail", source: "school-mail", formula: "true", action: { type: "notify", text: "Email from school: {{subject}}" } }, "Hearth");
  p.push("school-mail", src.secret, '{"subject":"Uniforms due"}');
  await p.drain();
  expect((await sent()).map((m) => m.text)).toEqual(["Email from school: Uniforms due"]);
  expect(p.events({ limit: 1 })[0].status).toBe("matched");
});

test("remind makes a timer and its trigger in one step; moving or deleting one moves or deletes both", async () => {
  await hub.ensureTeammates();
  const at = new Date(now.getTime() + 3.6e6).toISOString();
  const r = await hub.applyActions([{ type: "remind", title: "Call mom", schedule: { at }, text: "Call mom", why: "You asked", requestedByUser: true, teammate: "Reminders" }], "test");
  expect(r.done.map((d) => d.label)).toEqual(["Reminder: Call mom"]);
  const p = hub.pipeline;
  const t = p.findTrigger("call-mom")!;
  expect(t).toMatchObject({ title: "Call mom", createdBy: "you", teammateId: "planner", formula: 'time_to_run == "call-mom"' });
  expect(t.timer!.nextAt).toBe(at);
  // A second one with the same title gets its own name.
  await hub.applyActions([{ type: "remind", title: "Call mom", schedule: { time: "18:00", days: [5] }, text: "Call mom (Friday)" }], "test");
  expect(p.findTrigger("call-mom-2")!.timer!.schedule).toEqual({ time: "18:00", days: [5] });
  // Snooze by the trigger's name.
  await hub.applyActions([{ type: "time.update", name: "call-mom", snoozeMin: 30 }], "test");
  expect(p.findTrigger("call-mom")!.timer!.nextAt).toBe(new Date(now.getTime() + 30 * 60000).toISOString());
  expect(p.removeTrigger("call-mom")).toBe(true);
  expect(p.findTimer("call-mom")).toBeNull();
  expect(p.removeTimer("call-mom-2")).toBe(true);
  expect(p.findTrigger("call-mom-2")).toBeNull();
  expect(hub.upcomingPlans(TZ)).toEqual([]);
});

test("triggers are searchable, so a new request finds the one that already covers it", async () => {
  await hub.ensureTeammates();
  const p = hub.pipeline;
  await p.addWatcher({ name: "school-mail", kind: "silence", hours: 24 }, "Hearth");
  await p.addTrigger({ name: "school-deadlines", title: "School email deadlines", source: "school-mail", formula: "true", action: { type: "think", prompt: "Tell me if a school email has a deadline" }, why: "You asked on Friday" }, "Hearth");
  await p.remind({ title: "Morning weather", schedule: { time: "08:00", days: [1, 2, 3, 4, 5] }, text: "Weather" }, "Hearth");
  const hits = await hub.searchLibrary("tell me when the school emails about a deadline");
  expect(hits[0]).toMatchObject({ kind: "trigger", id: "school-deadlines", name: "School email deadlines" });
  // trigger.update changes it in place and can hand it to another teammate.
  await hub.applyActions([{ type: "trigger.update", name: "school-deadlines", why: "Widened to the soccer club too", teammate: "Research" }], "test");
  expect(p.findTrigger("school-deadlines")).toMatchObject({ why: "Widened to the soccer club too", teammateId: "scout" });
});

test("old hooks are moved into the pipeline once at start, and the old webhook URL still works", async () => {
  const doc = (x: any) => ({ id: crypto.randomUUID(), createdAt: now.toISOString(), status: "active", fireCount: 0, why: "old", ...x });
  const at = new Date(now.getTime() + 3.6e6).toISOString();
  for (const h of [
    doc({ title: "Call mom", source: "you", trigger: { type: "at", at, repeat: "none" }, action: { type: "notify", text: "Call mom" }, nextAt: at }),
    doc({ title: "Morning brief", source: "assistant", teammateId: "planner", trigger: { type: "schedule", time: "08:00", days: [1, 2, 3, 4, 5] }, action: { type: "think", prompt: "Brief me" } }),
    doc({ title: "Tickets", source: "assistant", trigger: { type: "watch", url: "https://example.com/t", minutes: 60 }, action: { type: "notify", text: "Tickets changed" }, seen: { hash: "h", text: "old", at: "" } }),
    doc({ title: "Door", source: "assistant", trigger: { type: "webhook", token: "old-secret-token-abcdefghijklmnop" }, action: { type: "notify", text: "Door" } }),
    doc({ title: "Charger", source: "you", trigger: { type: "place", place: "office", event: "arrive" }, action: { type: "notify", text: "Charger" } }),
    doc({ title: "Rang already", source: "you", status: "done", trigger: { type: "at", at, repeat: "none" }, action: { type: "notify", text: "x" } }),
    doc({ title: "Nightly memory review", source: "system", trigger: { type: "schedule", time: "03:30", days: [] }, action: { type: "think", prompt: "[[memory-review]]" } }),
  ]) await store.put("hooks", h);
  await hub.start(60_000);
  hub.stop();
  expect((await store.all("hooks")).length).toBe(0);
  const p = hub.pipeline;
  expect(p.findTrigger("call-mom")).toMatchObject({ createdBy: "you", timer: { nextAt: at } });
  expect(p.findTrigger("morning-brief")).toMatchObject({ teammateId: "planner", action: { type: "message", message: "Brief me", agent: true }, timer: { schedule: { time: "08:00", days: [1, 2, 3, 4, 5] } } });
  expect(p.findWatcher("tickets")).toMatchObject({ kind: "page", looked: true, everyMin: 60 });
  expect(p.findTrigger("tickets")!.action).toEqual({ type: "message", message: "Tickets changed\n{{url}}", agent: false });
  expect(p.findTrigger("charger")!.formula).toBe('place == "office" and event == "arrive"');
  expect(p.findTrigger("rang-already")).toBeNull();
  // The hub's own jobs are built in: there, protected, and not the user's to delete.
  const review = p.findTrigger("memory-review")!;
  expect(review).toMatchObject({ createdBy: "system", action: { type: "system", job: "review" } });
  expect(p.removeTrigger("memory-review")).toBe(false);
  expect((await p.updateTrigger("memory-review", { formula: "true" })).conflict?.kind).toBe("protected");
  expect((await p.updateTrigger("memory-review", { status: "paused" })).value!.status).toBe("paused");
  expect(hub.upcomingPlans(TZ).map((u) => u.title)).not.toContain("Nightly memory review");
  // The webhook's old URL is its source's secret now.
  expect(p.pushBySecret("old-secret-token-abcdefghijklmnop", "{}")!.value).toBeTruthy();
  await p.drain();
  expect((await sent()).map((m) => m.text)).toContain("Door");
  expect((await store.all<any>("activity")).some((a) => a.text.includes("Moved 5 plans"))).toBe(true);
});

test("a reminder isn't made twice when the brain looks something up and repeats itself", async () => {
  const at = new Date(now.getTime() + 3.6e6).toISOString();
  const remind = { type: "remind", title: "9:40 AM notification", schedule: { at }, text: "It's 9:40", requestedByUser: true };
  const seen: string[] = [];
  // First reply: the reminder plus a look at the pipeline; second reply (with what it found): the same reminder again.
  (hub.brain as any).think = async (b: any) => {
    seen.push(String(b.toolResults || ""));
    return seen.length === 1 ? "On it.\n```hearth\n" + JSON.stringify([remind, { type: "source.list" }]) + "\n```"
      : "Done.\n```hearth\n" + JSON.stringify([remind, { ...remind, why: "You asked just now" }]) + "\n```";
  };
  const r = await hub.turn("chat", "notify me at 9:40", "test");
  expect(r.text).toBe("Done.");
  expect(seen[1]).toContain("Already done this turn");
  expect(seen[1]).toContain("Reminder: 9:40 AM notification");
  // The repeats are refused where they land (a copy of a live reminder): one reminder.
  expect(hub.pipeline.triggers().map((t) => t.title)).toEqual(["9:40 AM notification"]);
  // Asked again for the very same one: refused, with what to do instead (force when they really want two).
  const again = await hub.pipeline.remind({ title: "9:40 AM notification", schedule: { at }, text: "It's 9:40" }, "you");
  expect(again.conflict?.kind).toBe("duplicate");
  expect((await hub.pipeline.remind({ title: "x", schedule: { at }, text: "It's 9:40", force: true }, "you")).value).toBeTruthy();
});

test("who handles a trigger: Hearth picks the teammate, or a named teammate, and it posts where you said", async () => {
  await hub.ensureTeammates();
  const p = hub.pipeline;
  const soon = new Date(now.getTime() + 60_000).toISOString();
  // Hearth picks: it fires as a message from the trigger in a new ramble, and Hearth plans it like one.
  const a = await hub.applyActions([{ type: "remind", title: "Dinner ideas", schedule: { at: soon }, prompt: "find a cheap dinner spot", to: "hearth", post: "new" },
    { type: "remind", title: "Bill check", schedule: { at: soon }, prompt: "Look over this week's bills", to: "Bills", post: "dm" },
    { type: "remind", title: "x", schedule: { at: soon }, text: "x", to: "Nobody" }], "test");
  expect(a.runs.map((r) => r.args[0]).join("\n")).toContain('No teammate called "Nobody"');
  expect(p.findTrigger("dinner-ideas")!.route).toEqual({ who: "hearth", where: "ramble" });
  expect(p.findTrigger("bill-check")).toMatchObject({ teammateId: "money", route: { who: "self", where: "dm" } });
  const before = (await hub.prefs()).lastUserAt;
  now = new Date(now.getTime() + 2 * 60_000);
  await hub.tick();
  for (let i = 0; i < 200 && (await store.all<any>("jobs")).filter((j) => j.status === "done").length < 2; i++) await Bun.sleep(10);
  const msgs = await store.all<any>("messages");
  const handoff = msgs.find((m) => m.fromTrigger)!;
  expect(handoff).toMatchObject({ role: "user", fromTrigger: { title: "Dinner ideas" } });
  expect(handoff.text).toContain("find a cheap dinner spot");
  expect((await store.get<any>("threads", handoff.threadId)).title).toBe("Dinner ideas"); // its own new ramble
  const jobs = await store.all<any>("jobs");
  expect(jobs.find((j) => j.threadId === handoff.threadId)!.teammateId).toBe("scout"); // Hearth handed it to Research
  expect((await hub.prefs()).lastUserAt).toBe(before); // a trigger talking isn't you talking
  // A named teammate in their DM.
  expect(jobs.some((j) => j.threadId === "tm-money") || msgs.some((m) => m.threadId === "tm-money" && m.proactive)).toBe(true);
});

test('to: "this" wakes the same task thread when it fires: same teammate, same conversation', async () => {
  await hub.ensureTeammates();
  const r = await hub.ramble("find a cheap dinner spot");
  for (let i = 0; i < 200 && !(await store.all<any>("jobs")).some((j) => j.status === "done"); i++) await Bun.sleep(10);
  const root = (await store.all<any>("jobs")).find((j) => !j.followsUp)!;
  // The teammate, inside that task, says "check back in an hour".
  const soon = new Date(now.getTime() + 60_000).toISOString();
  await hub.applyActions([{ type: "remind", title: "Check the booking", schedule: { at: soon }, prompt: "Did the booking go through?", to: "this" }], "test", { teammateId: root.teammateId, threadId: r.value!.thread.id, jobId: root.id });
  const t = hub.pipeline.findTrigger("check-the-booking")!;
  expect(t).toMatchObject({ teammateId: "scout", route: { who: "self", where: "this", session: root.id } });
  // Outside a task there's no "this".
  const bad = await hub.applyActions([{ type: "remind", title: "x", schedule: { at: soon }, text: "x", to: "this" }], "test");
  expect(bad.runs[0].args[0]).toContain("no task thread");
  now = new Date(now.getTime() + 2 * 60_000);
  await hub.tick();
  for (let i = 0; i < 200 && (await store.all<any>("jobs")).filter((j) => j.followsUp === root.id && j.status === "done").length < 1; i++) await Bun.sleep(10);
  const next = (await store.all<any>("jobs")).find((j) => j.followsUp === root.id)!;
  expect(next).toMatchObject({ threadId: root.threadId, teammateId: "scout" });
  expect(next.task).toContain("Did the booking go through?");
  const m = (await store.all<any>("messages")).find((x) => x.fromTrigger)!;
  expect(m).toMatchObject({ threadId: root.threadId, continues: [root.id], fromTrigger: { title: "Check the booking" } });
});

test("an agent action: the message goes to the teammate out of sight, as a real task in the workflow's workspace; its post shows with the ⚡ once it has something", async () => {
  await hub.ensureTeammates();
  const r = await hub.ramble("find a cheap dinner spot");
  for (let i = 0; i < 200 && !(await store.all<any>("jobs")).some((j) => j.status === "done"); i++) await Bun.sleep(10);
  const root = (await store.all<any>("jobs")).find((j) => !j.followsUp)!;
  await store.put("jobs", { ...root, workspace: "dinner-spots" });
  const p = hub.pipeline;
  p.createSource({ name: "texts", variables: [{ name: "from" }, { name: "text" }] }, "Hearth");
  // Made inside the task, for another teammate, posting in this ramble: a new task each time (not that conversation).
  const a = await hub.applyActions([{ type: "trigger.add", name: "sam-texts", title: "Sam texts", source: "texts", formula: 'from == "sam"', why: "Reply to Sam",
    action: { message: "Write a quirky reply to {{text}} and send it to the same chat", agent: true, who: "Research", where: "this" } }], "test", { teammateId: root.teammateId, threadId: r.value!.thread.id, jobId: root.id });
  expect(a.runs.map((x) => x.args[0]).join("")).toBe("");
  const t = p.findTrigger("sam-texts")!;
  expect(t).toMatchObject({ teammateId: "scout", action: { type: "message", agent: true }, route: { who: "self", where: "this", job: root.id, workspace: "dinner-spots" } });
  expect(t.route.session).toBeUndefined(); // a named teammate starts fresh tasks; only "self" carries on the conversation
  p.publish("texts", { from: "sam", text: "pizza tonight?" });
  await p.drain();
  const handoff = (await store.all<any>("messages")).find((m) => m.fromTrigger && m.role === "user")!;
  expect(handoff).toMatchObject({ hidden: true, threadId: r.value!.thread.id, fromTrigger: { title: "Sam texts" } });
  expect(handoff.text).toContain("Write a quirky reply to pizza tonight? and send it to the same chat");
  expect(handoff.text).toContain("About this workflow");
  expect(handoff.text).toContain("Reply to Sam");
  const job = (await store.all<any>("jobs")).find((j) => j.messageId === handoff.id)!;
  // Each run is named for what happened, so three runs aren't three "Sam texts".
  expect(job).toMatchObject({ teammateId: "scout", workspace: "dinner-spots", label: "sam: pizza tonight?" });
  expect((await store.all<any>("messages")).find((m) => m.taskJobId === job.id)).toMatchObject({ fromTrigger: { title: "Sam texts" } });
  // Activity's Workflows shows the run: matched on its source, then how the agent's task ended.
  for (let i = 0; i < 300 && (await store.get<any>("jobs", job.id))?.status !== "done"; i++) await Bun.sleep(10);
  await until(async () => (await hub.inbox()).some((it: any) => it.kind === "workflow" && it.state === "done"));
  const inbox = await hub.inbox();
  const wf = inbox.find((it: any) => it.kind === "workflow")!;
  expect(wf).toMatchObject({ title: "Sam texts", source: "texts", state: "done", jobId: job.id, threadId: r.value!.thread.id });
  expect(inbox.some((it: any) => it.kind === "done" && it.id === job.id)).toBe(false); // shown once, as the workflow
  expect(p.events({ limit: 1 })[0].log!.map((l) => l.step)).toEqual(["received", "matched", "ran", "done"]);
});

test("a trigger's message can use the payload: {{payload.data.id}} fills in", async () => {
  const p = hub.pipeline;
  p.createSource({ name: "pings", variables: [{ name: "kind" }] }, "Hearth");
  await p.addTrigger({ name: "ping", source: "pings", formula: "true", action: { type: "notify", text: "Got {{payload.data.id}} ({{kind}})" } }, "Hearth");
  p.publish("pings", { kind: "hello", data: { id: "m-42" } });
  await p.drain();
  expect((await sent()).map((m) => m.text)).toEqual(["Got m-42 (hello)"]);
  // A message that just says something shows under Workflows as done.
  expect((await hub.inbox()).find((it: any) => it.kind === "workflow")).toMatchObject({ title: "ping", state: "done" });
});

test("the hub's own housekeeping runs stay out of Activity's Workflows", async () => {
  await hub.start(60_000);
  hub.stop();
  const p = hub.pipeline;
  p.createSource({ name: "pings", variables: [{ name: "kind" }] }, "Hearth");
  await p.addTrigger({ name: "ping", source: "pings", formula: "true", action: { type: "notify", text: "pong" } }, "Hearth");
  now = zonedToUtc(2026, 10, 31, 4, 5, TZ); // past the nightly cleanup, memory review and an Ideas round
  await p.tick();
  p.publish("pings", { kind: "hello" });
  await p.drain();
  const housekeeping = ["library-cleanup", "memory-review", "ideas"].map((n) => p.findTrigger(n)!.id);
  expect(p.events({ limit: 10 }).some((e: any) => e.log?.some((l: any) => l.step === "matched" && housekeeping.includes(l.triggerId)))).toBe(true);
  expect((await hub.inbox()).filter((it: any) => it.kind === "workflow").map((it: any) => it.title)).toEqual(["ping"]);
});

test("where: ramble:<name> posts in that ramble, made the first time; a plain message needs no agent", async () => {
  const p = hub.pipeline;
  p.createSource({ name: "door", variables: [{ name: "motion" }] }, "Hearth");
  const a = await hub.applyActions([{ type: "trigger.add", name: "door-open", source: "door", formula: "motion == true", why: "door",
    action: { message: "The door opened", agent: false, where: "ramble:front-door" } }], "test");
  expect(a.runs.map((x) => x.args[0]).join("")).toBe("");
  expect(p.findTrigger("door-open")!.route).toMatchObject({ where: "ramble", ramble: "front-door" });
  p.publish("door", { motion: true });
  await p.drain();
  p.publish("door", { motion: true, at: 2 });
  await p.drain();
  const said = (await store.all<any>("messages")).filter((m) => m.text === "The door opened");
  expect(said).toHaveLength(2);
  expect(new Set(said.map((m) => m.threadId)).size).toBe(1);
  expect((await store.get<any>("threads", said[0].threadId)).channel).toBe("front-door");
  const bad = await hub.applyActions([{ type: "trigger.add", name: "x", source: "door", formula: "true", why: "x", action: { message: "x", where: "somewhere" } }], "test");
  expect(bad.runs[0].args[0]).toContain("where must be");
});

test("the same delivery twice is one event: the hub drops the copy, so nothing downstream keeps a seen list", async () => {
  const p = hub.pipeline;
  p.createSource({ name: "hook", variables: [{ name: "id" }] }, "Hearth");
  const first = p.publish("hook", { data: { message: { id: "m1" } } });
  const again = p.publish("hook", { data: { message: { id: "m1" } } });
  expect(again.duplicate).toBe(true);
  expect(again.value!.id).toBe(first.value!.id);
  expect(p.publish("hook", { data: { message: { id: "m2" } } }).duplicate).toBeUndefined();
  // A sender's own delivery id counts even when the body differs (a retry with a new timestamp).
  p.publish("hook", { at: 1 }, { "Webhook-Id": "d-9" });
  expect(p.publish("hook", { at: 2 }, { "Webhook-Id": "d-9" }).duplicate).toBe(true);
  expect(p.events({ source: "hook", limit: 10 })).toHaveLength(3);
});

test("a routine's run is named for its event, never a bare id; sources read as words", () => {
  expect(eventHeadline({ variables: { title: "Jason Hanks", text: "Hey, catching up next week?" }, payload: null })).toBe("Jason Hanks");
  expect(eventHeadline({ variables: {}, payload: { type: "message.received", data: { chat: { id: "14084203023@s.whatsapp.net" },
    message: { from: "14084203023@s.whatsapp.net", push_name: "Harbor Table", text: "We can do Saturday" } } } })).toBe("Harbor Table: We can do Saturday");
  expect(eventHeadline({ variables: { from: "14084203023@s.whatsapp.net" }, payload: null })).toBe("");
  expect(eventHeadline({ variables: { subject: "x".repeat(80) }, payload: null }).length).toBeLessThanOrEqual(48);
  expect(sourceWords("parley-whatsapp-incoming")).toBe("Parley WhatsApp incoming");
});

test("a routine's run closes itself when it only tells you something; one that needs your answer stays open until you close it", async () => {
  const now = new Date().toISOString();
  const run = async (id: string, result: string, status = "done") => {
    await store.put<any>("messages", { id: `m-${id}`, createdAt: now, role: "user", text: "brief", threadId: "th-r", hidden: true, fromTrigger: { id: "t1", title: "Inbox watch", eventId: `e-${id}` } });
    const job = await store.put<any>("jobs", { id, createdAt: now, threadId: "th-r", messageId: `m-${id}`, task: "brief", label: `Run ${id}`, teammateId: "hearth", status, result, answerNeeded: result.includes("[[answer-needed]]") });
    await (hub as any).settleRoutineRun(job);
  };
  await run("fyi", "Checked in reminder set.");
  await run("ask", "Jason asked to meet. Tuesday or Wednesday? [[answer-needed]]");
  await run("ok", "Drafted a reply.", "waiting");
  let r = await hub.routineRuns();
  expect(r.open.map((x) => x.id).sort()).toEqual(["ask", "ok"]);
  expect(r.open.every((x) => x.needsYou && x.routine === "Inbox watch")).toBe(true);
  expect(r.past).toMatchObject([{ id: "fyi", closedBy: "auto", label: "Run fyi" }]);
  expect((await hub.closeRoutineRun("ask")).value!.routine).toMatchObject({ closedBy: "you" });
  r = await hub.routineRuns();
  expect(r.open.map((x) => x.id)).toEqual(["ok"]);
  expect(r.past.map((x) => x.id).sort()).toEqual(["ask", "fyi"]);
});

test("run names are cut at a word, never mid-word", () => {
  expect(shortName("Frontier Airlines — It's time to check in to your flight tomorrow")).toBe("Frontier Airlines — It's time to check…");
  expect(shortName("Jason wants to meet")).toBe("Jason wants to meet");
});

test("a routine's run names itself with [[name: …]], which doesn't show in its reply", async () => {
  const now = new Date().toISOString();
  await store.put<any>("messages", { id: "m-n", createdAt: now, role: "user", text: "brief", threadId: "th-n", hidden: true, fromTrigger: { id: "t1", title: "Inbox watch", eventId: "e-n" } });
  const { RUN_NAME } = await import("../src/brain.ts");
  const reply = "[[name: Frontier check-in tomorrow]]\nCheck-in is open.";
  expect(reply.match(RUN_NAME)![1]).toBe("Frontier check-in tomorrow");
  expect(reply.replace(RUN_NAME, "")).toBe("Check-in is open.");
});
