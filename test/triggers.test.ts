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
import { validateHook, describeTrigger } from "../src/hooks.ts";
import { pageText, lineDiff, look } from "../src/watch.ts";
import type { Hook, Message } from "../src/types.ts";

// Event triggers: a page watch, a webhook's secret URL, and a check script that runs with no model.

const TZ = "America/Los_Angeles";
let dir: string, store: Store, hub: Hub;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hearth-trig-"));
  const repo = join(dir, "repo-scripts");
  mkdirSync(repo);
  // Prints only the drops it hasn't printed before: the pattern check hooks are meant for.
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
  const now = zonedToUtc(2026, 10, 30, 12, 0, TZ);
  hub.clock = () => now;
  await hub.setPrefs({ tz: TZ });
});

afterEach(async () => { hub.stop(); await hub.idle(20_000); await store.close(); });

const sent = async () => (await store.all<Message>("messages")).filter((m) => m.proactive);
const get = (id: string) => store.get<Hook>("hooks", id) as Promise<Hook>;

test("trigger rules: webhook tokens come from the hub, watches need a web address, checks need a script", () => {
  const a = validateHook({ title: "x", trigger: { type: "webhook", token: "mine" }, action: { type: "notify", text: "hi" } }).value!;
  const b = validateHook({ title: "x", trigger: { type: "webhook" }, action: { type: "notify", text: "hi" } }).value!;
  expect(a.trigger.type === "webhook" && a.trigger.token).not.toBe("mine");
  expect(a.trigger.type === "webhook" && a.trigger.token.length).toBeGreaterThanOrEqual(32);
  expect(a.trigger).not.toEqual(b.trigger);
  expect(validateHook({ title: "x", trigger: { type: "watch", url: "file:///etc/passwd" }, action: { type: "notify", text: "hi" } }).error).toContain("http");
  expect(validateHook({ title: "x", trigger: { type: "watch", url: "https://example.com", minutes: 5 }, action: { type: "notify", text: "hi" } }).error).toContain("15");
  expect(validateHook({ title: "x", trigger: { type: "check", script: "../evil" }, action: { type: "notify", text: "hi" } }).error).toContain("script");
  const w = validateHook({ title: "x", trigger: { type: "watch", url: "https://www.example.com/tickets" }, action: { type: "notify", text: "hi" } }).value!;
  expect(describeTrigger(w.trigger, TZ)).toBe("when example.com changes (checked every 1h)");
});

test("page text drops markup; the diff shows only lines that came and went", () => {
  const html = "<html><head><style>x{}</style><script>alert(1)</script></head><body><h1>Tickets</h1><p>Sold &amp; out</p></body></html>";
  expect(pageText(html, "text/html")).toBe("Tickets\nSold & out");
  const d = lineDiff("Tickets\nSold out\nFooter", "Tickets\nOn sale Friday\nFooter");
  expect(d).toMatchObject({ added: 1, removed: 1 });
  expect(d.text).toBe("+ On sale Friday\n- Sold out");
});

test("a watch won't read the hub's own network", async () => {
  expect((await look("http://127.0.0.1:1/")).error).toContain("public");
  expect((await look("http://localhost:1/")).error).toContain("public");
});

test("a webhook call wakes its hook with what was sent; a wrong token wakes nothing", async () => {
  const r = await hub.addHook({ title: "Door camera", trigger: { type: "webhook" }, action: { type: "notify", text: "Someone's at the door" } }, "assistant");
  const token = (r.value!.trigger as { token: string }).token;
  expect(r.value!.nextAt).toBeNull();
  expect(await hub.webhook("not-the-token", "{}")).toBe(false);
  expect(await hub.webhook(token, '{"motion":true}')).toBe(true);
  for (let i = 0; i < 100 && !(await sent()).length; i++) await Bun.sleep(10);
  const msgs = await sent();
  expect(msgs.length).toBe(1);
  expect(msgs[0].text).toBe("Someone's at the door");
  expect(msgs[0].proactive!.trigger).toBe("its webhook was called");
  await hub.updateHook(r.value!.id, { action: { type: "notify", text: "Door!" } });
  expect(((await get(r.value!.id)).trigger as { token: string }).token).toBe(token); // editing keeps the URL
  await hub.updateHook(r.value!.id, { status: "paused" });
  expect(await hub.webhook(token, "{}")).toBe(false);
});

test("a check hook runs its script with no model and speaks only when there's something new", async () => {
  const r = await hub.addHook({ title: "New drops", trigger: { type: "check", script: "drops", args: ["a,b"], minutes: 10 }, action: { type: "notify", text: "New drops:" } }, "assistant");
  const id = r.value!.id;
  await hub.fire(await get(id), "check");
  expect((await sent()).length).toBe(0); // first run only remembers what it saw
  expect((await get(id)).seen?.text).toBe("a\nb");
  await hub.fire(await get(id), "check");
  expect((await sent()).length).toBe(0); // nothing new: the script prints nothing
  await hub.updateHook(id, { trigger: { type: "check", script: "drops", args: ["a,b,c"], minutes: 10 } });
  await hub.store.put<Hook>("hooks", { ...(await get(id)), seen: { hash: "old", text: "a\nb", at: "" } });
  await hub.fire(await get(id), "check");
  const msgs = await sent();
  expect(msgs.length).toBe(1);
  expect(msgs[0].text).toBe("New drops:\na\nb\nc");
});

test("a webhook call in quiet hours is held and handled when they end", async () => {
  let now = zonedToUtc(2026, 10, 31, 2, 0, TZ); // 2am
  hub.clock = () => now;
  const r = await hub.addHook({ title: "School email", trigger: { type: "webhook" }, action: { type: "notify", text: "Email from school" } }, "assistant");
  const token = (r.value!.trigger as { token: string }).token;
  await hub.webhook(token, '{"subject":"Uniforms due"}');
  for (let i = 0; i < 100 && !(await get(r.value!.id)).held; i++) await Bun.sleep(10);
  const held = await get(r.value!.id);
  expect(held.held?.extra).toContain("Uniforms due");
  expect(held.nextAt).not.toBeNull();
  expect((await sent()).length).toBe(0);
  now = new Date(new Date(held.nextAt!).getTime() + 60_000);
  await hub.tick();
  expect((await sent()).map((m) => m.text)).toEqual(["Email from school"]);
  const after = await get(r.value!.id);
  expect(after.held).toBeUndefined();
  expect(after.nextAt).toBeNull();
});

test("webhook calls that land while the hook is busy are queued, not dropped", async () => {
  const r = await hub.addHook({ title: "Door", trigger: { type: "webhook" }, action: { type: "notify", text: "Door" } }, "assistant");
  const token = (r.value!.trigger as { token: string }).token;
  await Promise.all([hub.webhook(token, "1"), hub.webhook(token, "2"), hub.webhook(token, "3")]);
  await hub.idle(5000);
  expect((await sent()).length).toBe(2); // the first call, then the two that waited, together
});
