import { test, expect, beforeEach, afterEach } from "bun:test";
import { parse, check, variablesOf, normalize } from "../src/events/formula.ts";
import { EventPipeline, fillTemplate, type EventTrigger, type PipelineEvent } from "../src/events/pipeline.ts";
import { zonedToUtc } from "../src/time.ts";

// The event pipeline: sources push events, every event is saved, formulas (plain code) pick the triggers.

const TZ = "America/Los_Angeles";

// ---------- formulas ----------

test("formulas compare an event's variables with plain code", () => {
  const msg = { source: "whatsapp", from: "Mom", text: "Call me when you're free!", group: false, count: "3" };
  expect(check('from == "Mom" && text contains "call"', msg).ok).toBe(true);
  expect(check('from == "mom"', msg).ok).toBe(false);                      // == is exact
  expect(check('lower(from) == "mom"', msg).ok).toBe(true);
  expect(check('from in ["Dad", "Mom"] and not group', msg).ok).toBe(true);
  expect(check('from not in ["Dad", "Mom"]', msg).ok).toBe(false);
  expect(check('text matches "free|busy"', msg).ok).toBe(true);
  expect(check("count > 2 && count <= 3", msg).ok).toBe(true);            // numeric strings compare as numbers
  expect(check('text startsWith "call" || text endsWith "?"', msg).ok).toBe(true);
  expect(check("missing == null && !exists(missing)", msg).ok).toBe(true); // absent variables are null, never an error
  expect(check('nope.deep.path == "x"', msg).ok).toBe(false);
});

test("formulas read nested payloads, prices and lists", () => {
  const ev = { payload: { type: "payment_failed", customer: { email: "a@b.co" }, tags: ["vip", "eu"] }, added: "Now $1,299.99 (was $1,499)" };
  expect(check('payload.type == "payment_failed" && payload.customer.email endsWith "b.co"', ev).ok).toBe(true);
  expect(check('payload.tags contains "VIP"', ev).ok).toBe(true);
  expect(check("price(added) < 1300", ev).ok).toBe(true);
  expect(check("len(payload.tags) == 2", ev).ok).toBe(true);
  expect(check('hour >= 9 && weekday in ["Mon","Tue"]', { hour: 10, weekday: "Tue" }).ok).toBe(true);
  expect(check('date >= "2026-11-01"', { date: "2026-11-07" }).ok).toBe(true); // ISO strings order correctly
});

test("bad formulas say what's wrong instead of running", () => {
  expect(check('from = "Mom"', {}).error).toMatch(/Use ==/);
  expect(check('from == "Mom', {}).error).toMatch(/never closed/);
  expect(check("eval(x)", {}).error).toMatch(/no function called eval/);
  expect(check("from ==", {}).error).toMatch(/ends too early/);
  expect(check("(a == 1", {}).error).toMatch(/Expected "\)"/);
  expect(check("", {}).error).toMatch(/empty/);
  // Nothing in the language can reach the outside world.
  expect(check('constructor.constructor("return process")() == 1', {}).error).toBeTruthy();
  expect(check("__proto__.polluted == null", {}).ok).toBe(true);
  // A pattern that could hang the hub is refused (false), not run.
  expect(check('text matches "(a+)+$"', { text: "a".repeat(40) + "!" }).ok).toBe(false);
});

test("formulas list what they read, and the same rule written two ways is the same", () => {
  expect(variablesOf(parse('from == "Mom" && lower(payload.type) in ["a"]')).sort()).toEqual(["from", "payload.type"]);
  expect(normalize(parse('a == 1 && "Mom" == from'))).toBe(normalize(parse('from == "Mom" and 1 == a')));
  expect(normalize(parse("a > 1"))).not.toBe(normalize(parse("a < 1")));
});

test("action text fills {{variables}} from the event", () => {
  expect(fillTemplate("New PR {{title}} by {{author.login}}{{none}}", { title: "Fix", author: { login: "rishi" } })).toBe("New PR Fix by rishi");
});

// ---------- the pipeline ----------

let now: Date, p: EventPipeline, ran: { t: EventTrigger; e: PipelineEvent }[];

beforeEach(() => {
  now = zonedToUtc(2026, 11, 4, 7, 59, TZ); // a Wednesday
  p = new EventPipeline(":memory:", () => now, async () => TZ);
  ran = [];
  p.run = async (t, e) => { ran.push({ t, e }); return { text: `ran ${t.name}` }; };
});
afterEach(() => p.close());

const makeWhatsApp = () => p.createSource({ name: "whatsapp", service: "whatsapp", scope: "me", variables: ["from", "text", { name: "group" }] }).value!;

test("a push source gets a secret URL; pushes are saved, mapped to its variables, and matched", async () => {
  const { source, secret } = p.createSource({ name: "github-prs", service: "github", scope: "rishi/hearth",
    variables: [{ name: "title" }, { name: "author" }, { name: "kind" }],
    mapping: { title: "pull_request.title", author: "sender.login", kind: "headers.x-github-event" } }).value!;
  expect(source.kind).toBe("push");
  await p.addTrigger({ name: "my-prs", source: "github-prs", formula: 'kind == "pull_request" && author == "rishi"', action: { type: "notify", text: "PR: {{title}}" } });

  expect(p.push("github-prs", "wrong-secret", "{}")).toBeNull();
  expect(p.push("nope", secret, "{}")).toBeNull();
  const ev = p.push("github-prs", secret, JSON.stringify({ pull_request: { title: "Add events" }, sender: { login: "rishi" } }), { "X-GitHub-Event": "pull_request" })!.value!;
  expect(ev.variables).toEqual({ title: "Add events", author: "rishi", kind: "pull_request" });
  await p.drain();

  expect(ran.map((r) => r.t.name)).toEqual(["my-prs"]);
  const saved = p.getEvent(ev.id)!;
  expect(saved.status).toBe("matched");
  expect(saved.payload).toEqual({ pull_request: { title: "Add events" }, sender: { login: "rishi" } });
  expect(saved.log!.map((l) => l.step)).toEqual(["received", "matched", "ran"]);

  // Someone else's PR: saved, but nothing ran.
  const other = p.push("github-prs", secret, JSON.stringify({ sender: { login: "bob" } }), { "x-github-event": "pull_request" })!.value!;
  await p.drain();
  expect(p.getEvent(other.id)!.status).toBe("unmatched");
  expect(ran).toHaveLength(1);
  expect(p.findSource("github-prs")!.eventCount).toBe(2);

  // Rotating the secret kills the old URL.
  const fresh = p.rotateSecret("github-prs").value!.secret;
  expect(p.push("github-prs", secret, "{}")).toBeNull();
  expect(p.push("github-prs", fresh, "{}")!.value).toBeTruthy();
});

test("every matching trigger runs, in order; failures and cooldowns are logged, not lost", async () => {
  makeWhatsApp();
  p.run = async (t) => { if (t.name === "broken") throw new Error("workflow blew up"); ran.push({ t } as any); return { text: "ok" }; };
  await p.addTrigger({ name: "mom", source: "whatsapp", formula: 'from == "Mom"', action: { type: "notify", text: "Mom wrote" } });
  await p.addTrigger({ name: "urgent", source: "whatsapp", formula: 'text contains "urgent"', action: { type: "think", prompt: "Handle it" }, cooldownMin: 60 });
  await p.addTrigger({ name: "broken", source: "whatsapp", formula: "true", action: { type: "workflow", name: "x", inputs: {} } });

  const a = p.publish("whatsapp", { from: "Mom", text: "urgent: call" }).value!;
  const b = p.publish("whatsapp", { from: "Bob", text: "also urgent" }).value!;
  await p.drain();
  expect(ran.map((r) => r.t.name)).toEqual(["mom", "urgent"]);   // b's "urgent" hit the cooldown
  const la = p.getEvent(a.id)!, lb = p.getEvent(b.id)!;
  expect(la.status).toBe("matched");
  expect(la.log!.find((l) => l.step === "failed")!.detail).toContain("workflow blew up");
  expect(lb.status).toBe("failed");                               // only the broken one ran
  expect(lb.log!.some((l) => l.step === "cooldown")).toBe(true);
});

test("conflicts: same name, same service twice, unknown variables, and a rule you already have", async () => {
  makeWhatsApp();
  expect(p.createSource({ name: "whatsapp", variables: ["x"] }).conflict!.kind).toBe("name");
  const dup = p.createSource({ name: "wa-2", service: "WhatsApp", scope: "me", variables: ["x"] });
  expect(dup.conflict).toMatchObject({ kind: "duplicate", existing: { name: "whatsapp" } });
  expect(dup.error).toContain("Options:");

  const typo = await p.addTrigger({ name: "t1", source: "whatsapp", formula: 'sender == "Mom"', action: { type: "notify", text: "hi" } });
  expect(typo.conflict!.kind).toBe("variables");
  expect(typo.error).toContain("doesn't send sender");

  await p.addTrigger({ name: "mom", source: "whatsapp", formula: 'from == "Mom" && !group', action: { type: "notify", text: "Mom wrote" } });
  // The same rule, written the other way round, doing the same thing.
  const same = await p.addTrigger({ name: "mom-2", source: "whatsapp", formula: 'not group and "Mom" == from', action: { type: "notify", text: "Mom wrote" } });
  expect(same.conflict).toMatchObject({ kind: "overlap", existing: { name: "mom" } });
  // A narrower rule that "mom" already covers, judged from real past events.
  p.publish("whatsapp", { from: "Mom", text: "hi", group: false });
  p.publish("whatsapp", { from: "Mom", text: "dinner?", group: false });
  await p.drain();
  const narrower = await p.addTrigger({ name: "mom-dinner", source: "whatsapp", formula: 'from == "Mom" && text contains "dinner"', action: { type: "notify", text: "Mom wrote" } });
  expect(narrower.conflict!.kind).toBe("overlap");
  // Doing something different is fine, and force keeps both.
  expect((await p.addTrigger({ name: "mom-dinner", source: "whatsapp", formula: 'from == "Mom" && text contains "dinner"', action: { type: "notify", text: "Dinner plans" } })).value).toBeTruthy();
  expect((await p.addTrigger({ name: "mom-3", source: "whatsapp", formula: 'from == "Mom"', action: { type: "notify", text: "Mom wrote" }, force: true })).value).toBeTruthy();
  expect((await p.addTrigger({ name: "mom", source: "whatsapp", formula: "true", action: { type: "notify", text: "x" } })).conflict!.kind).toBe("name");

  // Dropping a variable a trigger reads is refused.
  expect(p.updateSource("whatsapp", { variables: ["text"] }).conflict!.kind).toBe("variables");
  // The built-in time source can't be deleted or pushed to.
  expect(p.removeSource("time").conflict!.kind).toBe("protected");
  expect(p.publish("time", {}).conflict!.kind).toBe("protected");
});

test("dry-run shows what a rule would have caught, and who else catches it", async () => {
  makeWhatsApp();
  await p.addTrigger({ name: "mom", source: "whatsapp", formula: 'from == "Mom"', action: { type: "notify", text: "x" } });
  for (const [from, text] of [["Mom", "hi"], ["Bob", "dinner?"], ["Mom", "dinner at 7"]]) p.publish("whatsapp", { from, text });
  await p.drain();
  const r = p.dryrun("whatsapp", 'text contains "dinner"').value!;
  expect(r).toMatchObject({ checked: 3, matched: 2, alsoMatchedBy: [{ name: "mom", count: 1 }] });
  expect(p.dryrun("whatsapp", "nope == 1").error).toContain("doesn't send nope");
});

test("the time minter pushes one event per due timer, with variables formulas can compare", async () => {
  await p.addTimer({ name: "standup", schedule: { time: "08:00", days: [1, 2, 3, 4, 5] }, data: { team: "core" } });
  await p.addTimer({ name: "follow-up-acme", schedule: { at: zonedToUtc(2026, 11, 4, 9, 30, TZ).toISOString() }, data: { who: "Acme" } });
  await p.addTrigger({ name: "standup-summary", source: "time", formula: 'time_to_run == "standup" && late_by_min < 30 && weekday != "Sat"', action: { type: "think", prompt: "Summarize {{data.team}}" } });
  await p.addTrigger({ name: "acme", source: "time", formula: 'time_to_run == "follow-up-acme" && data.who == "Acme"', action: { type: "notify", text: "How did {{data.who}} go?" } });
  expect(p.timers().map((t) => t.name)).toEqual(["standup", "follow-up-acme"]); // soonest first

  await p.tick();
  expect(ran).toHaveLength(0); // 7:59, nothing due

  now = zonedToUtc(2026, 11, 4, 8, 0, TZ);
  await p.tick(); await p.tick(); // a second tick doesn't mint it again
  expect(ran.map((r) => r.t.name)).toEqual(["standup-summary"]);
  expect(ran[0].e.variables).toMatchObject({ time_to_run: "standup", hour: 8, minute: 0, weekday: "Wed", date: "2026-11-04", late_by_min: 0, data: { team: "core" } });
  expect(p.findTimer("standup")!.nextAt).toBe(zonedToUtc(2026, 11, 5, 8, 0, TZ).toISOString());

  // The hub was off from 9:00 to 11:00: the one-off runs once, late, and the formula can see how late.
  now = zonedToUtc(2026, 11, 4, 11, 0, TZ);
  await p.tick();
  expect(ran.map((r) => r.t.name)).toEqual(["standup-summary", "acme"]);
  expect(ran[1].e.variables.late_by_min).toBe(90);
  expect(p.findTimer("follow-up-acme")!.status).toBe("done");

  // Thursday 8:45 after a long outage: standup is minted once, 45 min late, and its rule skips it.
  now = zonedToUtc(2026, 11, 5, 8, 45, TZ);
  await p.tick();
  expect(ran).toHaveLength(2);
  expect(p.events({ source: "time", limit: 1 })[0]).toMatchObject({ status: "unmatched", variables: { late_by_min: 45 } });

  expect((await p.addTimer({ name: "standup", schedule: { everyMin: 30 } })).conflict!.kind).toBe("name");
  expect((await p.addTimer({ name: "past", schedule: { at: "2020-01-01T00:00:00Z" } })).error).toContain("already passed");
  expect(p.removeTimer("standup")).toBe(true);
  expect(p.timers().map((t) => t.name)).toEqual(["follow-up-acme"]);
});

test("an event a trigger publishes is one level deeper; past 3 levels it stops", async () => {
  makeWhatsApp();
  await p.addTrigger({ name: "echo", source: "whatsapp", formula: "true", action: { type: "notify", text: "x" } });
  let refused = "";
  p.run = async () => { const r = p.publish("whatsapp", { from: "loop", text: "again" }); if (r.error) refused = r.error; return { text: "ok" }; };
  p.publish("whatsapp", { from: "a", text: "start" });
  await p.drain();
  expect(p.events({ source: "whatsapp", limit: 10 }).map((e) => e.depth).sort()).toEqual([0, 1, 2, 3]);
  expect(refused).toContain("so it can't loop forever");
});

test("deleting: a source takes its triggers; events can be kept or purged; events can be cleared", async () => {
  makeWhatsApp();
  await p.addTrigger({ name: "mom", source: "whatsapp", formula: 'from == "Mom"', action: { type: "notify", text: "x" } });
  p.publish("whatsapp", { from: "Mom" }); p.publish("whatsapp", { from: "Bob" });
  await p.drain();
  expect(p.clearEvents({ status: "unmatched" })).toBe(1);
  expect(p.removeSource("whatsapp").value).toEqual({ triggers: 1, events: 0 });
  expect(p.triggers()).toHaveLength(0);
  expect(p.events()).toHaveLength(1);            // history kept
  makeWhatsApp();
  p.publish("whatsapp", { from: "x" });
  await p.drain();
  expect(p.removeSource("whatsapp", true).value!.events).toBe(1);
  const left = p.events()[0];
  expect(p.removeEvent(left.id)).toBe(true);
  expect(p.events()).toHaveLength(0);
});

test("everything is in real SQLite columns: the formula is a column, event details are JSON", async () => {
  makeWhatsApp();
  await p.addTrigger({ name: "mom", source: "whatsapp", formula: 'from == "Mom"', action: { type: "notify", text: "x" } });
  p.publish("whatsapp", { from: "Mom", text: "hi" });
  await p.drain();
  expect(p.db.query("SELECT formula FROM triggers WHERE name = 'mom'").get()).toEqual({ formula: 'from == "Mom"' });
  expect(p.db.query("SELECT json_extract(variables, '$.from') AS f, status FROM events").get()).toEqual({ f: "Mom", status: "matched" });
  expect((p.db.query("SELECT count(*) AS n FROM event_log").get() as any).n).toBe(3);
});

// ---------- in the hub: the brain's tools, and triggers that speak ----------

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, COLLECTIONS, type Store } from "../src/store/index.ts";
import { Hub } from "../src/hub.ts";
import { Brain } from "../src/brain.ts";
import { Scripts } from "../src/scripts.ts";
import { loadConfig } from "../src/config.ts";
import type { Message } from "../src/types.ts";

async function makeHub() {
  const dir = mkdtempSync(join(tmpdir(), "hearth-events-"));
  const store: Store = await createStore("sqlite::memory:", dir);
  for (const c of COLLECTIONS) await store.clear(c);
  const config = { ...loadConfig({}), dataDir: dir, agent: "echo" };
  const hub = new Hub(config, store, new Brain(config), new Scripts(store, dir, join(dir, "none")), null);
  let at = zonedToUtc(2026, 11, 4, 12, 0, TZ);
  hub.clock = () => at;
  await hub.setPrefs({ tz: TZ, quietStart: "23:00", quietEnd: "07:00" });
  return { hub, store, dir, setNow: (d: Date) => { at = d; } };
}

test("the brain's tools make sources, triggers and timers; matches post a message; conflicts go back to the brain", async () => {
  const { hub, store, setNow } = await makeHub();
  const seen: any[] = [];
  hub.on((e) => { if (e.type === "pipeline") seen.push(e.data); });

  const r = await hub.applyActions([
    { type: "source.create", name: "stripe", service: "stripe", scope: "acct_1", variables: [{ name: "kind" }, { name: "email" }], mapping: { kind: "type", email: "data.object.customer_email" } },
    { type: "trigger.add", name: "failed-payment", source: "stripe", formula: 'kind == "invoice.payment_failed"', action: { type: "notify", text: "Payment failed for {{email}}" }, why: "You asked on Nov 4" },
    { type: "time.schedule", name: "check-acme", schedule: { at: zonedToUtc(2026, 11, 4, 14, 0, TZ).toISOString() }, data: { who: "Acme" } },
    { type: "trigger.add", name: "acme", source: "time", formula: 'time_to_run == "check-acme"', action: { type: "notify", text: "Did {{data.who}} reply?" } },
  ], "set it up");
  expect(r.done.map((d) => d.label)).toEqual(["Source: stripe", "Trigger: failed-payment", "Timer: check-acme", "Trigger: acme"]);
  expect(r.runs[0].args[0]).toContain("source.create stripe: done"); // told where the URL is, not the secret
  expect(r.runs[0].args[0]).not.toContain(hub.pipeline.secretOf("stripe")!);
  // Made by a teammate: the app is told, so it can fly the new trigger in.
  expect(seen.find((x) => x.what === "triggers" && x.created)).toMatchObject({ by: "Hearth" });

  // A Stripe webhook arrives on the secret URL.
  hub.pipeline.push("stripe", hub.pipeline.secretOf("stripe")!, JSON.stringify({ type: "invoice.payment_failed", data: { object: { customer_email: "a@b.co" } } }));
  await hub.pipeline.drain();
  let msgs = (await store.all<Message>("messages")).filter((m) => m.proactive);
  expect(msgs.map((m) => m.text)).toEqual(["Payment failed for a@b.co"]);
  expect(msgs[0].proactive).toMatchObject({ title: "failed-payment", trigger: "event from stripe", why: "You asked on Nov 4" });

  // The hub's own tick mints the timer when it's due.
  setNow(zonedToUtc(2026, 11, 4, 14, 1, TZ));
  await hub.tick();
  msgs = (await store.all<Message>("messages")).filter((m) => m.proactive);
  expect(msgs.map((m) => m.text)).toEqual(["Payment failed for a@b.co", "Did Acme reply?"]);

  // A second Stripe source, and a typo'd trigger: nothing is made, and the brain is told why and what to do instead.
  const c = await hub.applyActions([
    { type: "source.create", name: "stripe-2", service: "stripe", scope: "acct_1", variables: ["kind"] },
    { type: "trigger.add", name: "typo", source: "stripe", formula: 'amount > 10', action: { type: "notify", text: "x" } },
    { type: "trigger.dryrun", source: "stripe", formula: 'kind contains "payment"' },
  ], "again");
  expect(c.done).toHaveLength(0);
  expect(c.runs.map((x) => x.name)).toEqual(["@pipeline", "@pipeline", "@pipeline"]);
  expect(c.runs[0].args[0]).toMatch(/not done[\s\S]*"stripe" already receives stripe[\s\S]*Options: use "stripe"/);
  expect(c.runs[1].args[0]).toContain(`"stripe" doesn't send amount`);
  expect(c.runs[2].args[0]).toContain("checked 1 recent events, 1 matched. Already caught by: failed-payment (1)");

  // The brain sees the pipeline in its context.
  const ctx: any = await hub.context("stripe", "chat");
  expect(ctx.eventPipeline.triggers.map((t: any) => t.name)).toEqual(["failed-payment", "acme"]);
  expect(ctx.eventPipeline.sources.find((s: any) => s.name === "stripe").variables).toEqual(["kind", "email"]);

  // And can delete what it made.
  const d = await hub.applyActions([{ type: "trigger.remove", name: "acme" }, { type: "time.cancel", name: "check-acme" }, { type: "source.remove", name: "stripe" }], "clean up");
  expect(d.done.map((x) => x.label)).toEqual(["Removed trigger: acme", "Cancelled timer: check-acme", "Removed source: stripe and 1 trigger(s)"]);
  expect(hub.pipeline.triggers()).toHaveLength(0);
  hub.stop(); await hub.idle(5000); await store.close();
});

test("a workflow action must name a switched-on workflow", async () => {
  const { hub, store } = await makeHub();
  await hub.applyActions([{ type: "source.create", name: "gh", variables: ["title"] }], "x");
  const r = await hub.applyActions([{ type: "trigger.add", name: "w", source: "gh", formula: "true", action: { type: "workflow", name: "nope", inputs: {} } }], "x");
  expect(r.runs[0].args[0]).toContain('No switched-on workflow called "nope"');
  hub.stop(); await hub.idle(5000); await store.close();
});
