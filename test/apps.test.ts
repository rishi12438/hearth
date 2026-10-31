import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, COLLECTIONS, type Store } from "../src/store/index.ts";
import { Hub } from "../src/hub.ts";
import { Brain } from "../src/brain.ts";
import { Scripts } from "../src/scripts.ts";
import { loadConfig } from "../src/config.ts";
import { parseReply } from "../src/reply.ts";
import { appCsp } from "../src/apps.ts";
import type { Job } from "../src/types.ts";

let dir: string, store: Store, hub: Hub;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hearth-apps-"));
  store = await createStore(process.env.TEST_DB || "sqlite::memory:", dir);
  for (const c of COLLECTIONS) await store.clear(c);
  const config = { ...loadConfig({}), dataDir: dir, agent: "echo" };
  hub = new Hub(config, store, new Brain(config), new Scripts(store, dir, join(import.meta.dir, "../scripts")), null);
  await hub.ensureTeammates();
});

afterEach(async () => { hub.stop(); await hub.idle(20_000); await store.close(); });

const until = async (fn: () => Promise<boolean>) => { for (let i = 0; i < 200 && !(await fn()); i++) await Bun.sleep(10); };

test("reply parser attaches an app's code block to its app.save action and hides it", () => {
  const r = parseReply('Built it.\n```hearth\n[{"type":"app.save","name":"cards","title":"Cards"}]\n```\n```app cards\n<p>hi `x`</p>\n```');
  expect(r.text).toBe("Built it.");
  expect(r.actions[0].html).toBe("<p>hi `x`</p>");
});

test("apps keep code and data apart, keep old versions, and undo", async () => {
  const a = (await hub.apps.save({ name: "cards", title: "Cards", html: "<p>v1</p>", data: { cards: [1] } }, { teammateId: "hearth" })).value!;
  const b = (await hub.apps.save({ name: "cards", data: { cards: [1, 2] } }, {})).value!;
  expect(b.id).toBe(a.id);
  expect(b.html).toBe("<p>v1</p>");
  expect(b.versions.length).toBe(0); // data changes don't make versions
  const c = (await hub.apps.save({ name: "cards", html: "<p>v2</p>" }, {})).value!;
  expect(c.versions.length).toBe(1);
  expect((c.data as any).cards).toEqual([1, 2]);
  const d = (await hub.apps.undo(a.id))!;
  expect(d.html).toBe("<p>v1</p>");
  expect((await hub.apps.save({ name: "Bad Name", html: "x" }, {})).error).toBeTruthy();
  expect((await hub.apps.save({ name: "missing", data: {} }, {})).error).toBeTruthy();
});

test("an app page gets the bridge with its data and state, escaped, only with a live ticket", async () => {
  const a = (await hub.apps.save({ name: "cards", html: "<html><head></head><body>x</body></html>", data: { evil: "</script><script>alert(1)</script>" } }, {})).value!;
  await hub.apps.setState(a.id, { known: { a: true } });
  expect((await hub.apps.setState(a.id, { big: "x".repeat(60_000) })).error).toBeTruthy();
  const page = (await hub.apps.page(hub.apps.ticket(a.id)))!;
  expect(page).toContain("window.hearth");
  expect(page).toContain('"known":{"a":true}');
  expect(page).not.toContain("</script><script>alert(1)");
  expect(await hub.apps.page("nope")).toBeNull();
  const csp = appCsp("'self'");
  expect(csp).toContain("sandbox allow-scripts");
  expect(csp).toContain("connect-src 'none'");
  expect(csp).not.toContain("allow-same-origin");
});

test("asking for flashcards in a ramble builds an app the job points to", async () => {
  const { thread } = (await hub.ramble("make me flashcards for my Portuguese words")).value!;
  await until(async () => (await store.all<Job>("jobs")).some((j) => j.status === "done"));
  const job = (await store.all<Job>("jobs")).find((j) => j.threadId === thread.id)!;
  const app = (await hub.apps.list())[0];
  expect(app.title).toBe("Flashcards");
  expect(job.did?.some((d) => d.kind === "app" && d.id === app.id)).toBe(true);
  expect(((await hub.context("flashcards", "job")) as any).apps[0].name).toBe("demo-flashcards");
});

test("teammates can pin apps to Home and take them off; apps can message their teammate, rate-limited", async () => {
  const a = (await hub.apps.save({ name: "cards", title: "Cards", html: "<p>x</p>" }, { teammateId: "scout" })).value!;
  const r = await hub.applyActions([{ type: "app.pin", name: "cards", size: "tall" }], "pin my cards");
  expect(r.done.some((d: any) => d.label.startsWith("Pinned to Home"))).toBe(true);
  let now = (await hub.apps.byName("cards"))!;
  expect([now.pinned, now.size]).toEqual([true, "large"]); // "tall" is the old name
  await hub.applyActions([{ type: "app.unpin", name: "cards" }], "");
  expect((await hub.apps.byName("cards"))!.pinned).toBe(false);
  expect((await hub.askFromApp(a.id, "quiz me")).error).toBeUndefined();
  expect((await hub.askFromApp(a.id, "again")).error).toBeTruthy(); // too soon
  await until(async () => (await store.all<Job>("jobs")).some((j) => j.status === "done"));
  const job = (await store.all<Job>("jobs"))[0];
  expect(job.teammateId).toBe("scout");
  expect(job.task).toContain('mini app "Cards"');
});

test("streamed tool calls become one-line progress the app can show", async () => {
  const { describeStep } = await import("../src/brain.ts");
  expect(describeStep("WebSearch", { query: "pottery gifts under $80" })).toBe("Searching: pottery gifts under $80");
  expect(describeStep("WebFetch", { url: "https://www.etsy.com/x" })).toBe("Reading etsy.com");
  expect(describeStep("ToolSearch", {})).toBeNull();
});
