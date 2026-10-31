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

test("voice: a Deepgram key set from the app stays in a private file, is only shown as its last 4, and .env wins", async () => {
  const { VoiceSettings } = await import("../src/voice.ts");
  const { writeFileSync, statSync } = await import("node:fs");
  const v = new VoiceSettings(dir, {});
  expect(v.status()).toEqual({ provider: null, source: null, hint: null });
  expect((await v.connect("nope")).error).toContain("doesn't look like");
  writeFileSync(join(dir, "voice.json"), JSON.stringify({ deepgramKey: "abcdefghijklmnopqrstuvwxyz1234" }), { mode: 0o600 });
  const again = new VoiceSettings(dir, {});
  expect(again.status()).toEqual({ provider: "deepgram", source: "app", hint: "••••1234" });
  expect(statSync(join(dir, "voice.json")).mode & 0o777).toBe(0o600);
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
