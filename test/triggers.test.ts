import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, COLLECTIONS, type Store } from "../src/store/index.ts";
import { Hub } from "../src/hub.ts";
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

test("a webhook in quiet hours is held and handled once when they end", async () => {
  now = zonedToUtc(2026, 10, 31, 2, 0, TZ); // 2am
  const p = hub.pipeline;
  const src = p.createSource({ name: "school-mail", variables: [{ name: "subject" }] }, "Hearth").value!;
  await p.addTrigger({ name: "school-mail", source: "school-mail", formula: "true", action: { type: "notify", text: "Email from school: {{subject}}" } }, "Hearth");
  p.push("school-mail", src.secret, '{"subject":"Uniforms due"}');
  await p.drain();
  expect((await sent()).length).toBe(0);
  expect(p.heldCount()).toBe(1);
  expect(p.events({ limit: 1 })[0].status).toBe("held");
  now = zonedToUtc(2026, 10, 31, 7, 31, TZ);
  await hub.tick();
  expect((await sent()).map((m) => m.text)).toEqual(["Email from school: Uniforms due"]);
  expect(p.events({ limit: 1 })[0].status).toBe("matched");
  await hub.tick();
  expect((await sent()).length).toBe(1);
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
  expect(p.findTrigger("morning-brief")).toMatchObject({ teammateId: "planner", action: { type: "think", prompt: "Brief me" }, timer: { schedule: { time: "08:00", days: [1, 2, 3, 4, 5] } } });
  expect(p.findWatcher("tickets")).toMatchObject({ kind: "page", looked: true, everyMin: 60 });
  expect(p.findTrigger("tickets")!.action).toEqual({ type: "notify", text: "Tickets changed\n{{url}}" });
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
