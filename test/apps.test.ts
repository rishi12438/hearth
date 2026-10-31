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

test("voice: a Deepgram key set from the app is kept encrypted, is only shown as its last 4, and .env wins", async () => {
  const { VoiceSettings } = await import("../src/voice.ts");
  const { writeFileSync, existsSync, readFileSync } = await import("node:fs");
  const v = new VoiceSettings(dir, {});
  expect(v.status()).toEqual({ provider: null, source: null, hint: null });
  expect((await v.connect("nope")).error).toContain("doesn't look like");
  // A key saved the old way, in plain voice.json, moves into the encrypted vault and the plain file is deleted.
  writeFileSync(join(dir, "voice.json"), JSON.stringify({ deepgramKey: "abcdefghijklmnopqrstuvwxyz1234" }), { mode: 0o600 });
  const again = new VoiceSettings(dir, {});
  expect(again.status()).toEqual({ provider: "deepgram", source: "app", hint: "••••1234" });
  expect(existsSync(join(dir, "voice.json"))).toBe(false);
  expect(readFileSync(join(dir, "keys/vault.db")).includes("abcdefghijklmnopqrstuvwxyz1234")).toBe(false);
  expect(again.disconnect().value!.provider).toBeNull();
  const env = new VoiceSettings(dir, { HEARTH_DEEPGRAM_API_KEY: "envkeyenvkeyenvkeyenvkey9999" });
  expect(env.status().source).toBe("env");
  expect((await env.connect("abcdefghijklmnopqrstuvwxyz1234")).error).toContain(".env");
});

test("live dictation: the hub relays audio to Deepgram with its key and streams words back; tickets are single-use", async () => {
  let auth = "";
  const fake = Bun.serve({
    port: 0,
    fetch(req, srv) { auth = req.headers.get("authorization") || ""; return srv.upgrade(req) ? undefined : new Response("no", { status: 400 }); },
    websocket: {
      message(ws, m) {
        if (typeof m === "string") { if (m.includes("CloseStream")) ws.close(); return; }
        ws.send(JSON.stringify({ type: "Results", is_final: false, channel: { alternatives: [{ transcript: "remind me" }] } }));
        ws.send(JSON.stringify({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: "Remind me at six." }] } }));
      },
    },
  });
  process.env.HEARTH_DEEPGRAM_LIVE_URL = `ws://127.0.0.1:${fake.port}/v1/listen`;
  const { VoiceSettings } = await import("../src/voice.ts");
  const { startServer } = await import("../src/server.ts");
  const { newPairingCode, redeemPairingCode } = await import("../src/auth.ts");
  (hub.config as any).port = 0;
  const { server } = await startServer(hub, new VoiceSettings(dir, { HEARTH_DEEPGRAM_API_KEY: "testkeytestkeytestkey1234" }));
  const { code } = await newPairingCode(store);
  const { token } = (await redeemPairingCode(store, code, "test"))!;
  const { ticket } = await (await fetch(`http://127.0.0.1:${server.port}/api/voice/live`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" })).json();
  const got: any[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/voice-live?ticket=${ticket}&rate=48000`);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => { ws.send(new Int16Array(4800).buffer); setTimeout(() => ws.send("stop"), 150); };
    ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); got.push(m); if (m.t === "end") res(); };
    ws.onerror = () => rej(new Error("socket error"));
    setTimeout(() => rej(new Error("timed out")), 5000);
  });
  expect(auth).toBe("Token testkeytestkeytestkey1234"); // the key stays on the hub
  expect(got.map((m) => m.t)).toEqual(["partial", "final", "end"]);
  expect(got[1].text).toBe("Remind me at six.");
  expect((await fetch(`http://127.0.0.1:${server.port}/voice-live?ticket=${ticket}&rate=48000`)).status).toBe(401); // used up
  ws.close(); server.stop(true); fake.stop(true);
  delete process.env.HEARTH_DEEPGRAM_LIVE_URL;
});

test("dictation clean-up keeps the words when the model output looks wrong", async () => {
  expect(await hub.cleanDictation("hi")).toBe("hi"); // too short to bother
  const out = await hub.cleanDictation("um so uh remind me to call mom at five");
  expect(out).toContain("remind me to call mom at five");
  expect(out).not.toContain("uh");
});

test("artifacts: inline apps show in the answer at their own height, can use hub pictures, and can be kept as apps", async () => {
  const r = await hub.applyActions([{ type: "app.save", name: "japan-days", title: "Japan, day by day", inline: true, html: "<html><head></head><body>days</body></html>", data: { days: 7 } }], "");
  const a = (await hub.apps.byName("japan-days"))!;
  expect(a.inline).toBe(true);
  expect(r.done.some((d: any) => d.kind === "app" && d.id === a.id)).toBe(true);
  const page = (await hub.apps.page(hub.apps.ticket(a.id, "inline"), { origin: "https://hub.example", tileKey: "k1" }))!;
  expect(page).toContain('view: "inline"');
  expect(page).toContain("ResizeObserver"); // reports its content height to the app
  expect(page).toContain('"https://hub.example" + "/emoji/"');
  expect(appCsp("'self'", "https://hub.example")).toContain("img-src data: blob: https://hub.example");
  expect(appCsp("'self'", "https://hub.example")).toContain("connect-src 'none'"); // still no network
  await hub.applyActions([{ type: "app.save", name: "japan-days", html: "<html><head></head><body>days v2</body></html>" }], "");
  const b = (await hub.apps.byName("japan-days"))!;
  expect([b.inline, b.versions.length]).toEqual([true, 1]); // evolves in place
});

test("components: an artifact becomes a reusable component with a description, found in the library and reused with new data", async () => {
  const html = "<html><head></head><body><script>document.body.textContent = hearth.data.days.length + ' days'</script></body></html>";
  await hub.applyActions([{ type: "app.save", name: "japan-days", title: "Japan, day by day", inline: true, component: "day-by-day-itinerary", html, data: { days: [{ title: "Osaka" }] } }], "");
  let c = (await hub.componentByName("day-by-day-itinerary"))!;
  expect([c.title, c.uses, c.shape]).toEqual(["Japan, day by day", 1, '{"days":[{"title":"Osaka"}]}']);
  for (let i = 0; i < 50 && !(c = (await hub.componentByName("day-by-day-itinerary"))!).description; i++) await Bun.sleep(10);
  expect(c.description).toBe("Shows Japan, day by day."); // written by the quick model (demo brain here)
  const found = await hub.searchLibrary("day by day itinerary for my lisbon trip");
  expect(found.some((x: any) => x.kind === "component" && x.name === "day-by-day-itinerary")).toBe(true);
  // Reuse: new data, no code; the new artifact gets the component's code.
  await hub.applyActions([{ type: "app.save", name: "lisbon-days", title: "Lisbon, day by day", inline: true, component: "day-by-day-itinerary", data: { days: [{ title: "Alfama" }, { title: "Belém" }] } }], "");
  const lisbon = (await hub.apps.byName("lisbon-days"))!;
  expect([lisbon.html, lisbon.inline]).toEqual([html, true]);
  expect((await hub.componentByName("day-by-day-itinerary"))!.uses).toBe(2);
  expect((await store.all<any>("components")).length).toBe(1); // reused, not copied
});

test("starter components ship with Hearth: loaded once, found by search, and not overwritten once the team improves one", async () => {
  await hub.ensureStarterComponents();
  const names = (await store.all<any>("components")).map((c) => c.name).sort();
  expect(names).toEqual(["budget-breakdown", "chart", "checklist", "countdown", "day-by-day-itinerary", "option-comparison", "photo-gallery", "recipe", "stats", "table", "timeline", "video-player"]);
  expect((await hub.searchLibrary("chart of my spending this month")).some((x: any) => x.name === "chart")).toBe(true);
  expect((await hub.searchLibrary("compare three hotels in lisbon")).some((x: any) => x.name === "option-comparison")).toBe(true);
  expect((await hub.searchLibrary("packing list for my trip")).some((x: any) => x.name === "checklist")).toBe(true);
  // The team improves the checklist; a later start doesn't put the starter back over it.
  await hub.saveComponent({ name: "checklist", html: "<html><body>improved</body></html>", data: { items: [] } });
  await hub.ensureStarterComponents();
  expect((await hub.componentByName("checklist"))!.html).toContain("improved");
});
