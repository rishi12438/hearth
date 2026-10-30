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

afterEach(async () => { hub.stop(); await Bun.sleep(20); await store.close(); });

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
  expect(team.some((t) => t.name === "Coach")).toBe(true);
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
  expect(calls.filter((c) => c.startsWith("job"))).toEqual(["job:small", "job:big"]);
});

test("the app can only pick harnesses the hub has", async () => {
  expect((await hub.setBrains({ heavy: { harness: "rm", model: "" } })).error).toBeTruthy();
  expect((await hub.setBrains({ heavy: { harness: "echo", model: "x; rm -rf /" } })).error).toBeTruthy();
});
