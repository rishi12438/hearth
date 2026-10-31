import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, COLLECTIONS, type Store } from "../src/store/index.ts";
import { Hub } from "../src/hub.ts";
import { Brain } from "../src/brain.ts";
import { Scripts } from "../src/scripts.ts";
import { loadConfig } from "../src/config.ts";
import { parseReply } from "../src/reply.ts";
import { nextOccurrence, nextScheduledRun, inQuietHours, zonedToUtc } from "../src/time.ts";
import { recall } from "../src/memory.ts";
import { newPairingCode, redeemPairingCode, deviceForToken } from "../src/auth.ts";
import type { Fact, Hook, Job, Message, Thread } from "../src/types.ts";

const TZ = "America/Los_Angeles";
let dir: string, store: Store, hub: Hub, now: Date;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hearth-test-"));
  store = await createStore(process.env.TEST_DB || "sqlite::memory:", dir);
  for (const c of COLLECTIONS) await store.clear(c);
  const config = { ...loadConfig({}), dataDir: dir, agent: "echo" };
  hub = new Hub(config, store, new Brain(config), new Scripts(store, dir, join(import.meta.dir, "../scripts")), null);
  now = zonedToUtc(2026, 10, 30, 12, 0, TZ); // Fri noon in LA
  hub.clock = () => now;
  await hub.setPrefs({ tz: TZ });
});

afterEach(async () => { hub.stop(); await hub.idle(20_000); await store.close(); });

const messages = () => store.all<Message>("messages");
const until = async (fn: () => Promise<boolean>) => { for (let i = 0; i < 100 && !(await fn()); i++) await Bun.sleep(10); };

test("time: repeating reminders keep wall-clock time across DST", () => {
  const at = zonedToUtc(2026, 10, 31, 9, 0, TZ).toISOString(); // Sat 9am PDT
  const next = nextOccurrence(at, "daily", TZ, new Date(at))!;
  const after = nextOccurrence(next.toISOString(), "daily", TZ, next)!; // Nov 2, after DST ends
  expect(new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "numeric" }).format(after)).toBe("9 AM");
  const weekday = nextOccurrence(zonedToUtc(2026, 10, 30, 9, 0, TZ).toISOString(), "weekdays", TZ, now)!; // Fri -> Mon
  expect(weekday.toISOString()).toBe(zonedToUtc(2026, 11, 2, 9, 0, TZ).toISOString());
  expect(nextScheduledRun("08:00", [1], TZ, now)!.toISOString()).toBe(zonedToUtc(2026, 11, 2, 8, 0, TZ).toISOString());
  expect(inQuietHours(zonedToUtc(2026, 10, 30, 23, 30, TZ), TZ, "23:00", "07:30")).toBe(true);
  expect(inQuietHours(zonedToUtc(2026, 10, 30, 7, 31, TZ), TZ, "23:00", "07:30")).toBe(false);
});

test("reply parser takes the last hearth block and hides it", () => {
  const r = parseReply('Sure.\n```hearth\n[{"type":"memory.add","fact":"x"}]\n```');
  expect(r.text).toBe("Sure.");
  expect(r.actions).toEqual([{ type: "memory.add", fact: "x" }]);
  expect(parseReply("```hearth\nnot json\n```").actions).toEqual([]);
});

test("a ramble becomes jobs for teammates; a reminder job fires proactively with a why", async () => {
  await hub.ensureTeammates();
  await hub.ramble("remind me in 5 minutes to stretch, and find a cheap dinner spot");
  await until(async () => (await store.all<Job>("jobs")).every((j) => j.status === "done") && (await store.all<Job>("jobs")).length === 2);
  const jobs = await store.all<Job>("jobs");
  expect(jobs.map((j) => j.teammateId).sort()).toEqual(["planner", "scout"]);
  const threads = await store.all<Thread>("threads");
  expect(threads.length).toBe(1);
  const [hook] = (await store.all<Hook>("hooks"));
  expect(hook.title).toBe("stretch");
  expect(hook.source).toBe("you");

  const before = (await messages()).length;
  await hub.tick();
  expect((await messages()).length).toBe(before); // not yet

  now = new Date(now.getTime() + 6 * 60000);
  await hub.tick();
  const last = (await messages()).at(-1)!;
  expect(last.proactive?.why).toContain("You asked me");
  expect(last.threadId).toBe(threads[0].id);
  expect(last.teammateId).toBe("planner");
  expect((await store.get<Hook>("hooks", hook.id))!.status).toBe("done");
});

test("quiet hours hold assistant hooks but not your own reminders", async () => {
  now = zonedToUtc(2026, 10, 30, 23, 30, TZ);
  const mine = await hub.addHook({ title: "Pills", trigger: { type: "at", at: now.toISOString() }, action: { type: "notify", text: "Pills" } }, "you");
  const theirs = await hub.addHook({ title: "Nudge", trigger: { type: "at", at: now.toISOString() }, action: { type: "notify", text: "Nudge" } }, "assistant");
  await hub.tick();
  const texts = (await messages()).map((m) => m.text);
  expect(texts).toContain("Pills");
  expect(texts).not.toContain("Nudge");
  const held = (await store.get<Hook>("hooks", theirs.value!.id))!;
  expect(held.nextAt).toBe(zonedToUtc(2026, 10, 31, 7, 30, TZ).toISOString());
  expect(mine.value).toBeTruthy();
});

test("daily cap limits unprompted messages", async () => {
  await hub.setPrefs({ maxProactivePerDay: 1 });
  for (const t of ["A", "B"]) await hub.addHook({ title: t, trigger: { type: "at", at: now.toISOString() }, action: { type: "notify", text: t } }, "assistant");
  await hub.tick();
  expect((await messages()).filter((m) => m.proactive).length).toBe(1);
});

test("watch hooks can stay quiet", async () => {
  const h = await hub.addHook({ title: "Check", trigger: { type: "every", minutes: 30 }, action: { type: "think", prompt: "[[quiet]]" } }, "assistant");
  now = new Date(now.getTime() + 31 * 60000);
  await hub.tick();
  expect((await messages()).length).toBe(0);
  expect((await store.get<Hook>("hooks", h.value!.id))!.fireCount).toBe(1);
});

test("place hooks fire on arrival, once", async () => {
  await hub.recordLocation(37.0, -122.0, 10, "test");
  await hub.addPlace({ name: "Office", here: true });
  await hub.recordLocation(37.1, -122.0, 10, "test"); // leave
  await hub.addHook({ title: "Charger", trigger: { type: "place", place: "office", event: "arrive" }, action: { type: "notify", text: "Grab the charger" } }, "you");
  await hub.recordLocation(37.0, -122.0, 10, "test");
  await hub.recordLocation(37.0001, -122.0, 10, "test");
  await until(async () => (await messages()).length >= 1);
  expect((await messages()).filter((m) => m.text === "Grab the charger").length).toBe(1);
});

test("silence hook checks in once after N hours", async () => {
  await hub.setPrefs({ lastUserAt: now.toISOString() });
  await hub.addHook({ title: "Check-in", trigger: { type: "silence", hours: 48 }, action: { type: "notify", text: "Anything to track this week?" } }, "assistant");
  now = new Date(now.getTime() + 49 * 3.6e6);
  await hub.tick(); await hub.tick();
  expect((await messages()).length).toBe(1);
});

test("memory: update keeps history, forget removes the chain, recall keeps core", async () => {
  const a = (await hub.addFact({ fact: "Lives in Seattle", notebook: "home", importance: 2 }, "you")).value!;
  const b = (await hub.updateFact(a.id, { fact: "Lives in San Francisco" }))!;
  const all = await store.all<Fact>("memory");
  expect(all.find((f) => f.id === a.id)!.supersededBy).toBe(b.id);
  await hub.addFact({ fact: "Name is Rishi", notebook: "you", importance: 3 }, "you");
  for (let i = 0; i < 50; i++) await hub.addFact({ fact: `Trivia ${i}`, importance: 1 }, "assistant");
  const r = recall(await store.all<Fact>("memory"), "where do I live, san francisco?", 10);
  expect(r.map((f) => f.fact)).toContain("Name is Rishi");
  expect(r[1].fact).toBe("Lives in San Francisco");
  expect(r.some((f) => f.fact === "Lives in Seattle")).toBe(false);
  await hub.forgetFact(b.id);
  expect((await store.all<Fact>("memory")).some((f) => f.fact.startsWith("Lives in"))).toBe(false);
});

test("pairing codes are single use and tokens are stored hashed", async () => {
  const { code } = await newPairingCode(store);
  const r = (await redeemPairingCode(store, code.toLowerCase(), "Phone"))!;
  expect(r.token.length).toBeGreaterThan(40);
  expect(await redeemPairingCode(store, code, "Again")).toBeNull();
  expect(JSON.stringify(await store.all("devices"))).not.toContain(r.token);
  expect((await deviceForToken(store, `Bearer ${r.token}`))!.id).toBe(r.device.id);
  expect(await deviceForToken(store, "Bearer nope-nope-nope-nope-nope")).toBeNull();
});

test("assistant scripts need approval and re-approval after any change", async () => {
  const p = await hub.scripts.propose({ name: "hello", code: 'console.log("hi " + (process.env.HEARTH_DB_URL ?? "no-secrets"))' });
  expect((await hub.scripts.run("hello")).ok).toBe(false);
  const code = hub.scripts.code(p.value!);
  expect((await hub.scripts.approve(p.value!.id, "wrong")).error).toBeTruthy();
  const { sha256 } = await import("../src/auth.ts");
  await hub.scripts.approve(p.value!.id, sha256(code));
  process.env.HEARTH_DB_URL = "postgres://secret";
  const out = await hub.scripts.run("hello");
  delete process.env.HEARTH_DB_URL;
  expect(out.output).toBe("hi no-secrets");
  appendFileSync(join(dir, "scripts", "hello.ts"), "\n// sneaky");
  expect((await hub.scripts.run("hello")).ok).toBe(false);
});

test("brain cannot act outside the action list", async () => {
  const r = await hub.applyActions([{ type: "shell.exec", cmd: "rm -rf /" }, { type: "hook.add", title: "x", trigger: { type: "every", minutes: 1 }, action: { type: "notify", text: "spam" } }], "");
  expect(r.done).toEqual([]);
  expect((await store.all<Hook>("hooks")).length).toBe(0);
});

test("orchestrator creates a new teammate when nobody fits", async () => {
  await hub.ensureTeammates();
  await hub.ramble("I want to go to the gym 3 times a week");
  await until(async () => (await store.all<Job>("jobs")).some((j) => j.status === "done" || j.status === "failed"));
  const team = await store.all<any>("teammates");
  expect(team.some((t) => t.name === "Fitness")).toBe(true);
});

test("light jobs escalate to the heavy model when the workhorse gives up", async () => {
  await hub.ensureTeammates();
  const calls: string[] = [];
  (hub.brain as any).think = async (b: any, p: any) => {
    calls.push(`${b.mode}:${p.model}`);
    if (b.mode === "orchestrate") return JSON.stringify({ reply: "On it", jobs: [{ task: "Plan a trip", teammate: "Planner", effort: "light" }] });
    return p.model === "small" ? "[[escalate]]" : "Here's your plan.";
  };
  await hub.setBrains({ workhorse: { harness: "echo", model: "small" }, heavy: { harness: "echo", model: "big" } });
  await hub.ramble("plan my trip");
  await until(async () => (await store.all<Job>("jobs")).some((j) => j.status === "done"));
  const [job] = await store.all<Job>("jobs");
  expect(job.escalated).toBe(true);
  expect(job.tier).toBe("heavy");
  expect(job.result).toBe("Here's your plan.");
  expect(calls.filter((c) => !c.startsWith("orchestrate"))).toEqual(["legwork:small", "job:big"]); // heavy does it all, no extra voice step
});

test("hybrid: the cheap model does the legwork, the heavy model writes what you read (or redoes it)", async () => {
  await hub.ensureTeammates();
  const calls: string[] = [];
  let redo = false;
  (hub.brain as any).think = async (b: any, p: any) => {
    calls.push(`${b.mode}:${p.model}`);
    if (b.mode === "orchestrate") return JSON.stringify({ reply: "On it", jobs: [{ task: "Find a pottery gift", teammate: "Research", effort: "light" }] });
    if (b.mode === "legwork") return "NOTES: Clayroom Oakland gift card $60 (clayroom.com); Etsy mug set $45.";
    if (b.mode === "voice") return redo ? "[[redo]] notes miss her taste" : "Two good picks: a $60 Clayroom gift card, or a $45 handmade mug set.";
    return "Heavy did it all: a $60 Clayroom gift card.";
  };
  await hub.setBrains({ workhorse: { harness: "echo", model: "small" }, heavy: { harness: "echo", model: "big" } });
  await hub.ramble("gift for priya");
  await until(async () => (await store.all<Job>("jobs")).some((j) => j.status === "done"));
  let [job] = await store.all<Job>("jobs");
  expect([job.voiced, job.tier, job.result]).toEqual([true, "workhorse", "Two good picks: a $60 Clayroom gift card, or a $45 handmade mug set."]);
  expect(calls.slice(1)).toEqual(["legwork:small", "voice:big"]);

  redo = true; calls.length = 0;
  for (const c of COLLECTIONS) if (c === "jobs") await store.clear(c);
  await hub.ramble("gift for priya again");
  await until(async () => (await store.all<Job>("jobs")).some((j) => j.status === "done"));
  [job] = await store.all<Job>("jobs");
  expect([job.voiced, job.tier, job.escalated, job.result]).toEqual([false, "heavy", true, "Heavy did it all: a $60 Clayroom gift card."]);
  expect(calls.slice(1)).toEqual(["legwork:small", "voice:big", "job:big"]);

  await hub.setBrains({ hybrid: false }); calls.length = 0;
  await store.clear("jobs");
  await hub.ramble("one more");
  await until(async () => (await store.all<Job>("jobs")).some((j) => j.status === "done"));
  expect(calls.slice(1)).toEqual(["job:small"]); // switched off: the workhorse answers directly
});

test("the app can only pick harnesses the hub has", async () => {
  expect((await hub.setBrains({ heavy: { harness: "rm", model: "" } })).error).toBeTruthy();
  expect((await hub.setBrains({ heavy: { harness: "echo", model: "x; rm -rf /" } })).error).toBeTruthy();
});

// ---- approve-before-send, skills, search-before-create, self-repair ----

async function approvedScript(name: string, code: string) {
  const { sha256 } = await import("../src/auth.ts");
  const p = await hub.scripts.propose({ name, code });
  await hub.scripts.approve(p.value!.id, sha256(code));
  await hub.scriptApproved(name);
}

test("scripts that send or post can't run without a per-run Approve, even when approved", async () => {
  await approvedScript("email-sam", 'await fetch("https://example.invalid", { method: "POST", body: "hi" }); console.log("sent")');
  const s = (await hub.scripts.list()).find((x) => x.name === "email-sam")!;
  expect(s.effects).toBe("external");
  const out = await hub.scripts.run("email-sam", []);
  expect(out.needsApproval).toBe(true);

  // The brain asking to run it turns into an approval card, not a run.
  await hub.ensureTeammates();
  (hub.brain as any).think = async (b: any) => b.mode === "orchestrate"
    ? JSON.stringify({ reply: "On it", jobs: [{ task: "Email Sam that Tuesday works", teammate: "Hearth", effort: "light" }] })
    : 'Drafted it.\n```hearth\n[{"type":"script.run","name":"email-sam","args":[]}]\n```';
  await hub.ramble("tell sam tuesday works");
  await until(async () => (await store.all<Job>("jobs")).some((j) => j.status === "waiting"));
  const [ap] = await store.all<any>("approvals");
  expect(ap.status).toBe("pending");

  // Reject: nothing runs, job closes.
  await hub.decideApproval(ap.id, false);
  const [job] = await store.all<Job>("jobs");
  expect(job.status).toBe("done");
  expect(job.result).toContain("You said no");
  expect((await hub.decideApproval(ap.id, true)).error).toBeTruthy(); // can't flip a decision
});

test("a job matched to a script skill runs with no model at all", async () => {
  await hub.ensureTeammates();
  await approvedScript("echo-city", 'console.log("weather in " + process.argv[2])');
  const saved = await hub.saveSkill({ name: "city-weather", description: "Weather for a city", kind: "script", script: "echo-city", inputs: [{ name: "city", description: "City" }] });
  expect(saved.value!.status).toBe("active");
  const modes: string[] = [];
  (hub.brain as any).think = async (b: any) => {
    modes.push(b.mode);
    expect(b.context.library.some((l: any) => l.name === "city-weather")).toBe(true); // search before create
    return JSON.stringify({ reply: "Checking", jobs: [{ task: "weather in Paris", teammate: "Scout", effort: "light", use: { skill: "city-weather", inputs: { city: "Paris" } } }] });
  };
  await hub.ramble("what's the weather in paris");
  await until(async () => (await store.all<Job>("jobs")).some((j) => j.status === "done"));
  const [job] = await store.all<Job>("jobs");
  expect(job.how).toBe("skill");
  expect(job.result).toBe("weather in Paris");
  expect(job.costUsd).toBe(0);
  expect(modes).toEqual(["orchestrate"]); // only the plan used a model
  expect((await store.all<any>("memory")).some((f) => f.fact.includes("city-weather"))).toBe(true);
});

test("a failing skill falls back to solving fresh and gets repaired", async () => {
  await hub.ensureTeammates();
  await approvedScript("flaky", 'process.exit(1)');
  await approvedScript("solid", 'console.log("ok")');
  await hub.saveSkill({ name: "get-thing", description: "Gets the thing", kind: "recipe", steps: ["Run flaky"], uses: ["flaky"] });
  (hub.brain as any).think = async (b: any) => {
    if (b.mode === "orchestrate") return JSON.stringify({ reply: "On it", jobs: [{ task: "get the thing", teammate: "Hearth", effort: "light", use: { skill: "get-thing", inputs: {} } }] });
    if (b.input.startsWith("Follow this saved recipe")) return "";
    // Fresh solve, then tries to "fix" the recipe with a new script (not allowed) and with the old one (allowed).
    return 'Got it.\n```hearth\n[{"type":"skill.save","name":"get-thing","description":"Gets the thing","kind":"recipe","steps":["Run solid"],"uses":["solid"]},{"type":"skill.save","name":"get-thing","description":"Gets the thing, v2","kind":"recipe","steps":["Run flaky twice"],"uses":["flaky"]}]\n```';
  };
  await hub.ramble("get the thing");
  await until(async () => (await store.all<Job>("jobs")).some((j) => j.status === "done"));
  const [job] = await store.all<Job>("jobs");
  expect(job.how).toBe("repaired");
  expect(job.did!.map((d) => d.label)).toEqual(["Couldn't save skill: A fixed recipe can't use scripts the old one didn't.", "Fixed skill: get-thing"]);
  const sk = (await hub.skillByName("get-thing"))!;
  expect(sk.failures).toBe(1);
  expect(sk.version).toBe(2);
  expect(sk.lastFixedAt).toBeTruthy();
});

test("recipes can't use unapproved scripts, and workflows chain skills", async () => {
  expect((await hub.saveSkill({ name: "sneaky", description: "x", kind: "recipe", steps: ["do"], uses: ["not-approved"] })).error).toBeTruthy();
  await approvedScript("upper", 'console.log(process.argv[2].toUpperCase())');
  await approvedScript("exclaim", 'console.log(process.argv[2] + "!")');
  await hub.saveSkill({ name: "shout", description: "Uppercase", kind: "script", script: "upper", inputs: [{ name: "text", description: "" }] });
  await hub.saveSkill({ name: "bang", description: "Add !", kind: "script", script: "exclaim", inputs: [{ name: "text", description: "" }] });
  const wf = (await hub.proposeWorkflow({ name: "yell", description: "Shout and bang", inputs: [{ name: "words" }], steps: [{ skill: "shout", inputs: { text: "$input.words" } }, { skill: "bang", inputs: { text: "$prev" } }] })).value!;
  await expect(hub.runWorkflow(wf.id, { words: "hi" }, {})).rejects.toThrow(); // proposals don't run
  await store.put("workflows", { ...wf, status: "active" });
  const r = await hub.runWorkflow(wf.id, { words: "hi" }, {});
  expect(r.output).toContain("HI!");
});

test("a job that can't go on says it's blocked, parks, and resumes when you unblock it", async () => {
  await hub.ensureTeammates();
  let laptopOnline = false;
  (hub.brain as any).think = async (b: any) => {
    if (b.mode === "orchestrate") return JSON.stringify({ reply: "On it", jobs: [{ task: "Download my Chase statement", teammate: "Money", effort: "light" }] });
    return laptopOnline ? "Downloaded October's statement." :
      'I need your laptop for the bank login.\n```hearth\n[{"type":"blocked","need":"Your laptop online","why":"The bank login lives in your laptop browser","unblock":"Open your laptop, then tap Try again"}]\n```';
  };
  await hub.ramble("get my chase statement");
  await until(async () => (await store.all<Job>("jobs")).some((j) => j.status === "blocked"));
  let [job] = await store.all<Job>("jobs");
  expect(job.blocked!.unblock).toContain("Open your laptop");
  expect(job.result).not.toContain("Downloaded"); // never pretends
  await Bun.sleep(30);
  expect((await store.all<Job>("jobs"))[0].status).toBe("blocked"); // no retry loop

  laptopOnline = true;
  await hub.retryJob(job.id);
  await until(async () => (await store.all<Job>("jobs"))[0].status === "done");
  [job] = await store.all<Job>("jobs");
  expect(job.result).toBe("Downloaded October's statement.");
  expect(job.blocked).toBeUndefined();
});

test("teammates wear an emoji badge the orchestrator or the user can set; only real emoji are accepted", async () => {
  await hub.ensureTeammates();
  expect((await hub.teammate("scout"))!.emoji).toBe("🔍");
  const t = (await hub.addTeammate({ name: "Volleyball", description: "Games, practice and your knees.", emoji: "🏐" })).value!;
  expect(t.emoji).toBe("🏐");
  expect((await hub.updateTeammate("Volleyball", { emoji: "<img src=x>" })).error).toBeTruthy();
  expect((await hub.updateTeammate("Volleyball", { emoji: "ab" })).error).toBeTruthy();
  expect((await hub.updateTeammate("volleyball", { emoji: "🏋️‍♀️" })).value!.emoji).toBe("🏋️‍♀️"); // ZWJ sequence is one emoji
  const r = await hub.applyActions([{ type: "teammate.update", name: "Volleyball", emoji: "🇵🇹" }], "give it a flag");
  expect(r.done.some((d: any) => d.label.includes("Volleyball updated"))).toBe(true);
  expect((await hub.teammate(t.id))!.emoji).toBe("🇵🇹");
});

test("ideas: suggested, accepted into a ramble or dismissed for good; near-duplicates and too many are refused", async () => {
  await hub.ensureTeammates();
  const a = (await hub.addIdea({ title: "I can follow up on your airline refund", body: "No refund since Oct 14.", emoji: "🛂", prompt: "Draft a follow-up to the airline about my refund" })).value!;
  expect((await hub.addIdea({ title: "I can follow up on the airline refund", prompt: "x" })).error).toBeTruthy(); // too close
  const b = (await hub.addIdea({ title: "I can plan your half marathon training", prompt: "Plan my half marathon training" })).value!;
  expect((await hub.listIdeas()).length).toBe(2);
  expect(await hub.dismissIdea(b.id)).toBe(true);
  expect((await hub.addIdea({ title: "I can plan your half marathon training", prompt: "again" })).error).toBeTruthy(); // learned from no
  const r = await hub.acceptIdea(a.id);
  expect(r.value!.thread).toBeTruthy();
  expect((await hub.listIdeas()).length).toBe(0);
  expect((await hub.ideaTitlesForTest()).dismissed).toEqual(["I can plan your half marathon training"]);
});

test("about you is always in context; past conversations are searchable by the brain", async () => {
  await hub.ensureTeammates();
  await hub.setAbout("Sister Priya, turns 30 on Dec 12.\nTraining for a half marathon.", true);
  expect(((await hub.context("hi", "chat")) as any).aboutYou).toContain("Priya");
  await hub.ramble("email the landlord about the leak in the bathroom");
  const found = await hub.searchHistory("what did I say about the landlord leak");
  expect(found).toContain("landlord");
  expect(await hub.searchHistory("zebra unicorn")).toBe("(no matches)");
});

test("people: the relationship map grows as people come up, merging by name", async () => {
  await hub.applyActions([{ type: "person.upsert", name: "Priya", relation: "sister", note: "Turns 30 on Dec 12", emoji: "🎂" }], "");
  await hub.applyActions([{ type: "person.upsert", name: "Sam", relation: "Priya's partner", links: [{ to: "Priya", relation: "partner" }] }], "");
  await hub.applyActions([{ type: "person.upsert", name: "priya", note: "Loves pottery" }], "");
  const people = await store.all<any>("people");
  expect(people.length).toBe(2);
  const priya = people.find((p) => p.name === "Priya");
  expect([priya.relation, priya.notes, priya.emoji]).toEqual(["sister", ["Turns 30 on Dec 12", "Loves pottery"], "🎂"]);
  expect(people.find((p) => p.name === "Sam").links).toEqual([{ to: "Priya", relation: "partner" }]);
  expect((await hub.upsertPerson({ name: "me" })).error).toBeTruthy();
  expect(((await hub.context("hi", "chat")) as any).people.length).toBe(2);
});

test("rambles get a channel name from the plan and can be renamed; names stay unique", async () => {
  await hub.ensureTeammates();
  const a = (await hub.ramble("plan my japan trip")).value!.thread;
  await until(async () => !hub.thinking);
  const r1 = await hub.renameThread(a.id, "Japan Trip!");
  expect(r1.value!.channel).toBe("japan-trip");
  const b = (await hub.ramble("another")).value!.thread;
  await until(async () => !hub.thinking);
  expect((await hub.renameThread(b.id, "japan-trip")).value!.channel).toBe("japan-trip-2");
  expect((await hub.listThreads()).find((t: any) => t.id === a.id)!.name).toBe("japan-trip");
});

test("map tiles keep real coordinates in order and drop stops without them", async () => {
  const { cleanTile } = await import("../src/tiles.ts");
  const t = cleanTile({ type: "map", data: { stops: [{ name: "Osaka", lat: 34.6687, lon: 135.5013, when: "Day 1" }, { name: "Nowhere" }, { name: "Tokyo", lat: 35.68, lon: 139.76 }] } })!;
  expect(t.data.stops.map((s: any) => s.name)).toEqual(["Osaka", "Tokyo"]);
  expect(t.data.route).toBe(true);
  expect(cleanTile({ type: "map", data: { stops: [{ name: "x", lat: 200, lon: 0 }] } })).toBeNull();
});

test("Hearth names rambles from the plan and renames them when the topic changes, but never over your own name", async () => {
  await hub.ensureTeammates();
  let channel = "japan-trip";
  const real = (hub.brain as any).think.bind(hub.brain);
  (hub.brain as any).think = async (b: any, p: any) => b.mode === "orchestrate" ? JSON.stringify({ title: "Trip", channel, reply: "On it", jobs: [] }) : real(b, p);
  const t = (await hub.ramble("plan japan")).value!.thread;
  await until(async () => !hub.thinking);
  expect((await store.get<any>("threads", t.id)).channel).toBe("japan-trip");
  channel = "kyoto-ryokan";
  await hub.ramble("actually just kyoto, find a ryokan", t.id);
  await until(async () => !hub.thinking);
  expect((await store.get<any>("threads", t.id)).channel).toBe("kyoto-ryokan");
  await hub.renameThread(t.id, "honeymoon");
  channel = "something-else";
  await hub.ramble("and a restaurant", t.id);
  await until(async () => !hub.thinking);
  expect((await store.get<any>("threads", t.id)).channel).toBe("honeymoon"); // yours sticks
});
