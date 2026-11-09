import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/vault.ts";
import { createStore, COLLECTIONS, type Store } from "../src/store/index.ts";
import { Hub } from "../src/hub.ts";
import { Brain } from "../src/brain.ts";
import { Scripts } from "../src/scripts.ts";
import { loadConfig } from "../src/config.ts";
import {
  Calls, CallRecorder, recordingPath, arcaSignature, cleanVoice, providerOfKey, resample, talkerInstructions, toE164, checkVoiceKey, arcaApi,
  type ArcaApi, type Call, type Talker, type TalkerEvents, type TalkerSpec,
} from "../src/calls.ts";
import type { Approval } from "../src/types.ts";

// Voice calls (src/calls.ts): Arca dials, the hub runs the call. Here Arca, Vonage's audio socket, the voice model and
// the owner's browser are all stand-ins, so the whole call runs in memory.

const OPENAI_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123";
const ARCA_KEY = "arcaph_testkeytestkeytestkeytestkeytestkey1";
const arcaBucket = new Map<string, Uint8Array>();
let paid = false;
let dir: string, vault: Vault, saved: Map<string, Call>, buzzed: string[], placed: any[], hungUp: string[], accounts: any[], maxSeconds: number;
let talker: { spec: TalkerSpec; ev: TalkerEvents; heard: number; injected: { text: string; respond: boolean }[]; results: { id: string; out: string }[]; greeted: number; closed: boolean } | null;

const fakeArca = (): ArcaApi => ({
  async account(a) { accounts.push(a); return { token: "tok-hub-account", userId: "user-1" }; },
  async register(token, h) { expect(token).toBe("tok-hub-account"); expect(h.url).toBe("https://hub.example.com"); return { key: ARCA_KEY, number: "+14155550123", plan: "free", maxCallSeconds: 120 }; },
  async place(key, b) { expect(key).toBe(ARCA_KEY); placed.push(b); return { id: `arca-${placed.length}`, from: "+14155550123", maxSeconds: Math.min(b.maxSeconds, maxSeconds), plan: paid ? "paid" : "free", recorded: !paid || b.record }; },
  async hangup(_k, id) { hungUp.push(id); },
  async recording(_k, id) { return arcaBucket.get(id) ?? null; },
  async deleteRecording(_k, id) { arcaBucket.delete(id); },
  async status() { return { number: "+14155550123", plan: "free", today: { calls: 1, seconds: 30 }, limits: { calls: 20, seconds: 1800, callSeconds: 120 } }; },
});
const fakeTalker = (spec: TalkerSpec, ev: TalkerEvents): Talker => {
  talker = { spec, ev, heard: 0, injected: [], results: [], greeted: 0, closed: false };
  const t = talker;
  return { audio: () => { t.heard++; }, inject: (text, respond) => { t.injected.push({ text, respond }); }, toolResult: (id, out) => { t.results.push({ id, out }); }, greet: () => { t.greeted++; }, close: () => { t.closed = true; } };
};
// The provider's model list, for checking a key.
const models: typeof fetch = (async (url: any) => {
  if (String(url).includes("api.openai.com/v1/models")) return new Response(JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "gpt-realtime" }, { id: "gpt-realtime-2.1" }, { id: "gpt-realtime-2" }, { id: "gpt-realtime-mini" }] }));
  if (String(url).includes("generativelanguage")) return new Response(JSON.stringify({ models: [
    { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-2.5-flash-native-audio-preview-12-2025", supportedGenerationMethods: ["bidiGenerateContent"] },
    { name: "models/gemini-3.8-live-extended-thinking", supportedGenerationMethods: ["bidiGenerateContent"] },
    { name: "models/gemini-3.8-live", supportedGenerationMethods: ["bidiGenerateContent"] },
    { name: "models/gemini-3.1-flash-live-preview", supportedGenerationMethods: ["bidiGenerateContent"] }] }));
  return new Response("{}", { status: 404 });
}) as any;

function make(waits = { check: 0.05, giveUp: 0.1 }) {
  return new Calls({
    vault, dataDir: dir, hubName: () => "Test hub", publicUrl: () => "https://hub.example.com",
    save: async (c) => { saved.set(c.id, structuredClone(c)); }, load: async (id) => saved.get(id) ?? null,
    emit: () => {}, notify: (_c, q) => buzzed.push(q.text),
    arca: fakeArca(), talker: fakeTalker, fetcher: models, waits,
  });
}
type Sent = (string | Uint8Array)[];
const sock = (sent: Sent = []) => ({ sent, closed: false as boolean, send(d: string | Uint8Array) { sent.push(d); }, close() { this.closed = true; } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const signed = (calls: Calls, id: string, body: object) => { const raw = JSON.stringify(body); return calls.event(id, raw, arcaSignature(ARCA_KEY, raw)); };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hearth-calls-"));
  vault = new Vault(dir);
  arcaBucket.clear(); paid = false; saved = new Map(); buzzed = []; placed = []; hungUp = []; accounts = []; maxSeconds = 900; talker = null;
});
afterEach(() => { vault.close(); rmSync(dir, { recursive: true, force: true }); });

test("numbers, keys and voice settings are checked and cleaned", async () => {
  expect(toE164("+1 (415) 555-0199")).toBe("+14155550199");
  expect(toE164("0044 20 7946 0958")).toBe("+442079460958");
  expect(toE164("415-555-0199")).toBeNull();
  expect(providerOfKey(OPENAI_KEY)).toBe("openai");
  expect(providerOfKey("AIzaSyA1234567890abcdefghijklmnopqrstu")).toBe("gemini");
  expect(providerOfKey("hello")).toBeNull();
  expect(await checkVoiceKey("openai", OPENAI_KEY, models)).toEqual({ model: "gpt-realtime-2.1" });
  expect(await checkVoiceKey("gemini", "AIzaSyA1234567890abcdefghijklmnopqrstu", models)).toEqual({ model: "gemini-3.8-live" });
  expect(await checkVoiceKey("openai", OPENAI_KEY, (async () => new Response("", { status: 401 })) as any)).toEqual({ error: "OpenAI didn't accept that key." });
  // A voice the provider doesn't have is dropped; speed is OpenAI only, and bounded.
  expect(cleanVoice({ voice: "MARIN", speed: 9, name: " Sam ", junk: 1 }, "openai")).toEqual({ voice: "marin", speed: 1.5, name: "Sam" });
  expect(cleanVoice({ voice: "marin", speed: 1.2 }, "gemini")).toEqual({});
  expect(cleanVoice({ voice: "kore" }, "gemini")).toEqual({ voice: "Kore" });
  const r = resample(new Int16Array([0, 100, 200, 300]), 16000, 24000);
  expect(r.length).toBe(6);
  expect(talkerInstructions("Book a table for 4 at 7pm.", { name: "Sam", owner: "Rishi", language: "Spanish" })).toContain("You are Sam, a voice assistant on a phone call on behalf of Rishi");
});

test("turning calls on checks the key, gets the hub its own Arca key once, and keeps both in the vault", async () => {
  const calls = make();
  expect(await calls.connect("nope")).toContain("OpenAI key");
  expect(await calls.connect(OPENAI_KEY)).toBeNull();
  expect(calls.configured()).toBe(true);
  expect(calls.view()).toMatchObject({ connected: true, provider: "openai", model: "gpt-realtime-2.1", number: "+14155550123", hint: "••••0123" });
  expect(JSON.parse(vault.get("calls-arca")!).key).toBe(ARCA_KEY);
  // The hub made itself an anonymous Arca account first; the phone key is under it (the plan is the account's).
  expect(accounts.length).toBe(1);
  expect(accounts[0].deviceId).toMatch(/^hearth-/);
  expect(JSON.parse(vault.get("arca-account")!)).toMatchObject({ token: "tok-hub-account", userId: "user-1", deviceId: accounts[0].deviceId });
  // Off and on again keeps the same line (no second registration).
  calls.disconnect();
  expect(calls.configured()).toBe(false);
  const again = new Calls({ ...(calls as any).d, arca: { ...fakeArca(), account: async () => { throw new Error("made twice"); }, register: async () => { throw new Error("registered twice"); } } });
  expect(await again.connect(OPENAI_KEY)).toBeNull();
  // No public https address: the call's audio couldn't reach the hub.
  const local = new Calls({ ...(calls as any).d, publicUrl: () => "http://localhost:7777" });
  expect(await local.connect(OPENAI_KEY)).toContain("HEARTH_PUBLIC_URL");
});

test("a call: Arca dials, Vonage's audio reaches the talker, its voice goes back paced, and the transcript fills in", async () => {
  const calls = make();
  await calls.connect(OPENAI_KEY);
  calls.settings.setVoice({ voice: "cedar", name: "Sam", owner: "Rishi" });
  const c = await calls.start({ to: "+1 415 555 0199", brief: "Book a table for 4 at 7pm.", voice: { language: "Spanish" }, threadId: "t1", jobId: "j1" });
  expect(c.status).toBe("ringing");
  expect(placed[0]).toMatchObject({ to: "+14155550199", eventUrl: `https://hub.example.com/api/calls/events/${c.id}`, maxSeconds: 900 });
  const token = new URL(placed[0].audioUrl).searchParams.get("t")!;
  expect(placed[0].audioUrl.startsWith(`wss://hub.example.com/call-audio/${c.id}?t=`)).toBe(true);
  expect(calls.audioAllowed(c.id, "wrong")).toBe(false);
  expect(calls.audioAllowed(c.id, token)).toBe(true);

  // Events need Arca's signature with this hub's key.
  expect(await calls.event(c.id, JSON.stringify({ status: "answered" }), "bad")).toBe(false);
  expect(await signed(calls, c.id, { id: "arca-1", status: "answered" })).toBe(true);
  expect(saved.get(c.id)!.status).toBe("live");

  const vonage = sock();
  calls.audioOpen(c.id, vonage);
  expect(talker!.spec).toMatchObject({ provider: "openai", model: "gpt-realtime-2.1", voice: { voice: "cedar", name: "Sam", owner: "Rishi", language: "Spanish" } });
  expect(talker!.spec.instructions).toContain("Book a table for 4 at 7pm.");
  calls.audioIn(c.id, JSON.stringify({ event: "websocket:connected" }));
  calls.audioIn(c.id, new Uint8Array(640));
  expect(talker!.heard).toBe(1);

  // A listener hears both sides: tag 1 = them, tag 2 = the bot.
  const ear = sock();
  calls.listenOpen(c.id, ear);
  calls.audioIn(c.id, new Uint8Array(640));
  talker!.ev.onAudio(new Int16Array(960)); // 60 ms of its voice
  await sleep(120);
  const toVonage = vonage.sent.filter((x) => x instanceof Uint8Array) as Uint8Array[];
  expect(toVonage.length).toBe(3);
  expect(toVonage.every((f) => f.byteLength === 640)).toBe(true);
  expect((ear.sent as Uint8Array[]).map((f) => f[0]).sort()).toEqual([1, 2, 2, 2]);

  // Barge-in drops what's still queued.
  talker!.ev.onAudio(new Int16Array(16000));
  talker!.ev.onInterrupt();
  await sleep(50);
  expect((vonage.sent.filter((x) => x instanceof Uint8Array)).length).toBeLessThan(6);

  talker!.ev.onLine("them", "Hola, restaurante.");
  talker!.ev.onLine("bot", "Hola, soy Sam.");
  await sleep(5);
  expect(saved.get(c.id)!.lines.map((l) => `${l.who}: ${l.text}`)).toEqual(["them: Hola, restaurante.", "bot: Hola, soy Sam."]);
  const w = await calls.wait(c.id, 0);
  expect(w.new).toEqual(["Them: Hola, restaurante.", "Bot: Hola, soy Sam."]);

  // The bot ends the call: once its goodbye has played, the hub hangs up through Arca.
  talker!.ev.onTool("end_call", { outcome: "Booked for 7pm, name Rishi." }, "t-end");
  await sleep(900);
  expect(hungUp).toEqual(["arca-1"]);
  const done = saved.get(c.id)!;
  expect(done).toMatchObject({ status: "ended", outcome: "Booked for 7pm, name Rishi." });
  expect(talker!.closed).toBe(true);
  expect(ear.closed).toBe(true);
  const end: any = await calls.wait(c.id, 0);
  expect(end.ended.outcome).toBe("Booked for 7pm, name Rishi.");
  expect(end.transcript).toEqual(["Them: Hola, restaurante.", "Bot: Hola, soy Sam."]);
});

test("a question: answered in time it goes straight back; unanswered, the bot checks at 5 s and promises a call back at 10 s", async () => {
  const calls = make();
  await calls.connect(OPENAI_KEY);
  const c = await calls.start({ to: "+14155550199", brief: "Book a table.", threadId: "t1" });
  calls.audioOpen(c.id, sock());

  // Answered at once (by the agent supervising): the bot's tool call gets the answer.
  talker!.ev.onTool("ask_supervisor", { question: "Is 8pm ok instead?" }, "tc1");
  await sleep(5);
  expect(buzzed).toEqual(["Is 8pm ok instead?"]);
  const w: any = await calls.wait(c.id, 0);
  expect(w.question.text).toBe("Is 8pm ok instead?");
  // A second wait doesn't return at once for the same question (no busy loop).
  const t0 = Date.now(); await calls.wait(c.id, 25); expect(Date.now() - t0).toBeGreaterThanOrEqual(20);
  expect(await calls.answer(c.id, "Yes, 8pm is fine.", "agent")).toBe("Passed to the bot on the call.");
  expect(talker!.results).toEqual([{ id: "tc1", out: "Yes, 8pm is fine." }]);
  await sleep(150);
  expect(talker!.injected.length).toBe(0); // no "let me check", no giving up

  // Nobody answers: "let me check" at the first wait, then wrap up and promise to get back.
  talker!.ev.onTool("ask_supervisor", { question: "Card number to hold it?" }, "tc2");
  await sleep(70);
  expect(talker!.results[1]).toEqual({ id: "tc2", out: "No answer yet. Tell them briefly you're just checking on that, then wait quietly." });
  await sleep(60);
  expect(talker!.injected.at(-1)).toMatchObject({ respond: true });
  expect(talker!.injected.at(-1)!.text).toContain("you'll get back to them on that shortly");
  // The owner answers after that: kept for the call back, not spoken.
  expect(await calls.answer(c.id, "Use the Amex", "you")).toContain("call or text them back");
  talker!.ev.onTool("end_call", { outcome: "Asked to hold; will call back with card." }, "t-end");
  await sleep(900);
  const end: any = await calls.wait(c.id, 0);
  expect(end.ended.followUp).toEqual([{ question: "Card number to hold it?", answer: "Use the Amex" }]);
});

test("an answer between 5 and 10 s is passed on as a supervisor message", async () => {
  const calls = make({ check: 0.03, giveUp: 0.3 });
  await calls.connect(OPENAI_KEY);
  const c = await calls.start({ to: "+14155550199", brief: "Ask the hours.", threadId: "t1" });
  calls.audioOpen(c.id, sock());
  talker!.ev.onTool("ask_supervisor", { question: "Weekend too?" }, "tc1");
  await sleep(60);
  expect(talker!.results[0].out).toContain("just checking");
  await calls.answer(c.id, "Yes, weekends too.", "you");
  expect(talker!.injected.at(-1)).toEqual({ text: `[Supervisor] The answer to "Weekend too?": Yes, weekends too.. Carry on with it.`, respond: true });
  await sleep(300);
  expect(talker!.injected.some((i) => i.text.includes("get back to them"))).toBe(false);
  await calls.hangup(c.id);
});

test("Join: your mic goes on the call and the bot goes quiet; hand back and it carries on", async () => {
  const calls = make();
  await calls.connect(OPENAI_KEY);
  const c = await calls.start({ to: "+14155550199", brief: "Say hi.", threadId: "t1" });
  const vonage = sock();
  calls.audioOpen(c.id, vonage);
  const me = sock();
  calls.listenOpen(c.id, me);
  calls.listenMessage(c.id, me, "join");
  expect(talker!.injected.at(-1)!.text).toContain("Stay completely quiet");
  talker!.ev.onAudio(new Int16Array(3200)); // the bot tries to talk: dropped
  const mic = new Int16Array(640).fill(1234);
  calls.listenMessage(c.id, me, new Uint8Array(mic.buffer));
  await sleep(100);
  const frames = vonage.sent.filter((x) => x instanceof Uint8Array) as Uint8Array[];
  expect(frames.length).toBe(2);
  expect(new Int16Array(frames[0].buffer.slice(frames[0].byteOffset, frames[0].byteOffset + 640))[0]).toBe(1234);
  expect(saved.get(c.id)!.joined).toBe(true);
  calls.listenMessage(c.id, me, "leave");
  expect(talker!.injected.at(-1)).toMatchObject({ respond: true });
  expect(saved.get(c.id)!.joined).toBe(false);
  await calls.hangup(c.id);
  expect(saved.get(c.id)!.lines.filter((l) => l.who === "note").map((l) => l.text)).toEqual(["You joined the call", "You handed the call back"]);
});

// An MP3 frame header: 11 sync bits, then MPEG-2 (16 kHz) layer III.
const isMp3 = (b: Uint8Array) => b.length > 4 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0;

test("tracking: who started it, how long, who ended it, and the whole call as a stereo MP3", async () => {
  const calls = make();
  await calls.connect(OPENAI_KEY);
  const c = await calls.start({ to: "+14155550199", brief: "Ask if they're open Sunday.", threadId: "t1", jobId: "j1",
    startedBy: { agent: "Sam", task: "Sunday opening", approvedAt: "2026-11-09T10:00:00.000Z" } });
  await signed(calls, c.id, { id: "arca-1", status: "answered" });
  calls.audioOpen(c.id, sock());
  // The bot is told to say the call is recorded.
  expect(talker!.spec.instructions).toContain("This call is recorded");
  // 2 s of them (Vonage sends a frame every 20 ms, silence included) while the bot talks for a bit.
  talker!.ev.onAudio(new Int16Array(8000).map((_, i) => Math.round(Math.sin(i / 5) * 6000)));
  for (let i = 0; i < 100; i++) {
    calls.audioIn(c.id, new Uint8Array(new Int16Array(320).map((_, j) => Math.round(Math.sin((i * 320 + j) / 9) * 6000)).buffer));
    if (i % 5 === 0) await sleep(20);
  }
  await sleep(60);
  // Vonage's count of the talk time wins; they hung up.
  await signed(calls, c.id, { id: "arca-1", status: "completed", duration: 42 });
  const done = saved.get(c.id)!;
  expect(done).toMatchObject({ status: "ended", seconds: 42, endedBy: "them", startedBy: { agent: "Sam", task: "Sunday opening" } });
  const f = recordingPath(dir, c.id);
  const mp3 = readFileSync(f);
  expect(isMp3(mp3)).toBe(true);
  expect(done.recording!.bytes).toBe(mp3.length);
  expect(done.recording!.seconds).toBe(2);
  const end: any = await calls.wait(c.id, 0);
  expect(end.ended).toMatchObject({ seconds: 42, endedBy: "them", recording: f });

  // Free plan: the owner's "off" doesn't apply; Arca records, so the hub does too and the bot says so.
  calls.settings.setVoice({ record: false });
  const c1 = await calls.start({ to: "+14155550199", brief: "Hi.", threadId: "t1" });
  expect(placed.at(-1).record).toBe(false);
  calls.audioOpen(c1.id, sock());
  expect(talker!.spec.instructions).toContain("This call is recorded");
  calls.audioIn(c1.id, new Uint8Array(640));
  await calls.hangup(c1.id, "you");
  expect(saved.get(c1.id)!.recording!.bytes).toBeGreaterThan(0);

  // Paid, recording off: nothing saved, and the bot doesn't say it is.
  paid = true;
  expect(calls.settings.voice().record).toBe(false);
  const c2 = await calls.start({ to: "+14155550199", brief: "Hi.", threadId: "t1", voice: { record: true } as any });
  expect(placed.at(-1).record).toBe(false); // Arca doesn't record it either
  calls.audioOpen(c2.id, sock());
  expect(talker!.spec.instructions).not.toContain("recorded");
  calls.audioIn(c2.id, new Uint8Array(640));
  await calls.hangup(c2.id, "you");
  expect(saved.get(c2.id)).toMatchObject({ endedBy: "you" });
  expect(saved.get(c2.id)!.recording).toBeUndefined();
  expect(existsSync(recordingPath(dir, c2.id))).toBe(false);
});

test("free plan: Arca caps the call at 2 minutes; the bot knows, is told to wrap up 20 s before, and the cut shows as the limit", async () => {
  maxSeconds = 120;
  const calls = make();
  await calls.connect(OPENAI_KEY);
  const c = await calls.start({ to: "+14155550199", brief: "Ask if they're open Sunday.", threadId: "t1" });
  expect(c.maxSeconds).toBe(120);
  await signed(calls, c.id, { id: "arca-1", status: "answered" });
  calls.audioOpen(c.id, sock());
  expect(talker!.spec.instructions).toContain("The line cuts off after 2 minutes");
  expect(placed[0].record).toBe(true);
  // Arca runs the clock: its warning, 20 s before it cuts the line, makes the bot wrap up.
  expect(talker!.injected.some((i) => i.text.includes("seconds left"))).toBe(false);
  await signed(calls, c.id, { id: "arca-1", status: "warning", secondsLeft: 20 });
  expect(talker!.injected.some((i) => i.text.includes("About 20 seconds left") && i.respond)).toBe(true);
  await signed(calls, c.id, { id: "arca-1", status: "completed", duration: 120, endedBy: "limit" });
  expect(saved.get(c.id)).toMatchObject({ status: "ended", seconds: 120, endedBy: "limit", maxSeconds: 120 });
  expect(saved.get(c.id)!.lines.map((l) => l.text)).toContain("Near the time limit: the bot is wrapping up");
  // Arca's copy of the recording lands later, after the hub has let go of the call.
  (calls as any).live.delete(c.id);
  expect(await signed(calls, c.id, { id: "arca-1", status: "recorded", recordingBytes: 4321 })).toBe(true);
  expect(saved.get(c.id)!.arcaRecording).toEqual({ bytes: 4321 });
  expect(await calls.event(c.id, JSON.stringify({ status: "recorded" }), "forged")).toBe(false);
});

test("the recorder lines our side up with theirs, and a hub restart keeps what was recorded", async () => {
  const f = join(dir, "calls", "x.mp3");
  const r = new CallRecorder(f);
  // We sent nothing for a while: silence on our side, never a pile-up when we send in a burst.
  for (let i = 0; i < 25; i++) r.theirs(new Int16Array(320).fill(1000));
  for (let i = 0; i < 200; i++) r.ours(new Int16Array(320).fill(2000)); // 4 s at once: only the last 1 s is kept
  for (let i = 0; i < 100; i++) r.theirs(new Int16Array(320));
  const out = r.close();
  expect(out.seconds).toBe(3); // (25 + 100) frames × 20 ms = 2.5 s, rounded
  expect(statSync(f).size).toBe(out.bytes);
  // A call the store still thinks is live when the hub starts: ended, by the restart, with its partial recording.
  const live: Call = { id: "c_x", createdAt: "2026-11-09T10:00:00.000Z", updatedAt: "2026-11-09T10:01:30.000Z", answeredAt: "2026-11-09T10:00:10.000Z",
    threadId: "t", to: "+1", brief: "", provider: "openai", voice: {}, status: "live", lines: [], questions: [], recording: { bytes: 0, seconds: 0 } };
  const s = Calls.stale(live, 40_000)!;
  expect(s).toMatchObject({ status: "ended", endedBy: "hub", seconds: 80, recording: { bytes: 40_000, seconds: 10 } });
});

test("nobody picks up: Arca's event ends it as not answered", async () => {
  const calls = make();
  await calls.connect(OPENAI_KEY);
  const c = await calls.start({ to: "+14155550199", brief: "Say hi.", threadId: "t1" });
  await signed(calls, c.id, { id: "arca-1", status: "timeout" });
  expect(saved.get(c.id)).toMatchObject({ status: "failed", error: "Nobody picked up." });
  expect(calls.audioAllowed(c.id, new URL(placed[0].audioUrl).searchParams.get("t")!)).toBe(false);
});

test("the Arca client speaks the contract (docs/calls-arca.md)", async () => {
  const seen: any[] = [];
  const f = (async (url: any, init: any) => { seen.push({ url: String(url), method: init.method, auth: init.headers.Authorization, body: init.body && JSON.parse(init.body) });
    if (String(url).endsWith("/bootstrap")) return new Response(JSON.stringify({ token: "tok-1", userId: "u-1", anonymous: true }));
    if (String(url).endsWith("/register")) return new Response(JSON.stringify({ key: ARCA_KEY, number: "+1415", plan: "free", maxCallSeconds: 120 }), { status: 201 });
    if (String(url).endsWith("/calls")) return new Response(JSON.stringify({ error: "Over today's limit." }), { status: 429 });
    return new Response(JSON.stringify({ ok: true })); }) as any;
  const a = arcaApi("https://arca.example/", f);
  expect(await a.account({ deviceId: "hearth-abc", secret: "s".repeat(40), name: "h" })).toEqual({ token: "tok-1", userId: "u-1" });
  expect(seen[0].body).toEqual({ deviceId: "hearth-abc", bootstrapSecret: "s".repeat(40), displayName: "h" });
  expect(await a.register("tok-1", { name: "h", url: "https://x" })).toEqual({ key: ARCA_KEY, number: "+1415", plan: "free", maxCallSeconds: 120 });
  await expect(a.place(ARCA_KEY, { to: "+1", audioUrl: "wss://x", eventUrl: "https://x", maxSeconds: 900, record: true })).rejects.toThrow("Arca: Over today's limit.");
  await a.hangup(ARCA_KEY, "abc");
  expect(seen.map((s) => `${s.method} ${s.url} ${s.auth ?? "-"}`)).toEqual([
    "POST https://arca.example/v1/account/bootstrap -",
    "POST https://arca.example/v1/phone/register Bearer tok-1",
    `POST https://arca.example/v1/phone/calls Bearer ${ARCA_KEY}`,
    `POST https://arca.example/v1/phone/calls/abc/hangup Bearer ${ARCA_KEY}`,
  ]);
});

test("the hub: hearth-call start makes an Approve card; Approve places exactly that call", async () => {
  const store: Store = await createStore("sqlite::memory:", dir);
  for (const c of COLLECTIONS) await store.clear(c);
  const config = { ...loadConfig({}), dataDir: dir, agent: "echo" };
  const hub = new Hub(config, store, new Brain(config), new Scripts(store, dir, join(dir, "none")), null);
  expect(await hub.requestCall({ to: "+14155550199", brief: "Hi" })).toContain("aren't turned on");
  const calls = make();
  hub.calls = calls;
  await calls.connect(OPENAI_KEY);
  expect(await hub.requestCall({ to: "555-0199", brief: "Hi" })).toContain("country code");
  const told = await hub.requestCall({ to: "+1 415 555 0199", brief: "Ask if they're open Sunday." });
  expect(told).toContain("waits for the user's Approve");
  await hub.requestCall({ to: "+1 415 555 0199", brief: "Ask if they're open Sunday." }); // same ask: same card
  const aps = (await store.all<Approval>("approvals")).filter((a) => a.action.type === "call");
  expect(aps.length).toBe(1);
  expect(aps[0]).toMatchObject({ summary: "Call +14155550199", status: "pending", action: { type: "call", to: "+14155550199", brief: "Ask if they're open Sunday." } });
  expect(placed.length).toBe(0);
  const r: any = await hub.decideApproval(aps[0].id, true);
  expect(r.value.status).toBe("done");
  expect(r.value.result).toContain("hearth-call wait c_");
  expect(placed.length).toBe(1);
  await store.close();
});

test("through the server: hearth-call asks, Approve dials, Vonage's socket carries the call both ways, Arca's events land", async () => {
  const { startServer } = await import("../src/server.ts");
  const { hubSkills } = await import("../src/brains/skills.ts");
  const store: Store = await createStore("sqlite::memory:", dir);
  for (const c of COLLECTIONS) await store.clear(c);
  const config = { ...loadConfig({ HEARTH_PORT: "0" }), dataDir: dir, agent: "echo" };
  const hub = new Hub(config, store, new Brain(config), new Scripts(store, dir, join(dir, "none")), null);
  process.env.HEARTH_PUBLIC_URL = "https://hub.example.com";
  const { server } = await startServer(hub, null, { vault, calls: { arca: fakeArca(), talker: fakeTalker, fetcher: models, waits: { check: 5, giveUp: 10 } } });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    expect(await hub.calls!.connect(OPENAI_KEY)).toBeNull();
    hub.brain.refreshSkills?.();
    const skill = hubSkills(dir).find((s) => s.name === "hearth-call");
    expect(skill).toBeTruthy();
    const key = skill!.scripts!["hearth-call"].match(/X-Hearth-Agent: (\w+)/)![1];
    const agent = (fields: Record<string, string>, k = key) => { const f = new FormData(); for (const [a, b] of Object.entries(fields)) f.append(a, b); return fetch(`${base}/api/agent/call`, { method: "POST", body: f, headers: { "X-Hearth-Agent": k } }); };
    expect((await agent({ action: "start" }, "wrong")).status).toBe(401);
    expect((await (await agent({ action: "start", to: "+14155550199", brief: "Ask if they're open Sunday." })).json()).result).toContain("Approve");
    const ap = (await store.all<Approval>("approvals")).find((a) => a.action.type === "call")!;
    await hub.decideApproval(ap.id, true);
    const c = (await store.all<Call>("calls"))[0];
    expect(c).toMatchObject({ status: "ringing", to: "+14155550199" });

    // Arca's event: signed with the hub's Arca key, or refused.
    const ev = (body: object, sig?: string) => { const raw = JSON.stringify(body); return fetch(`${base}/api/calls/events/${c.id}`, { method: "POST", body: raw, headers: { "X-Arca-Signature": sig ?? arcaSignature(ARCA_KEY, raw) } }); };
    expect((await ev({ status: "answered" }, "nope")).status).toBe(401);
    expect((await ev({ id: "arca-1", status: "answered" })).status).toBe(200);

    // Vonage's audio socket: the wrong secret is refused; the right one carries the call both ways.
    const url = new URL(placed[0].audioUrl);
    expect((await fetch(`${base}/call-audio/${c.id}?t=wrong`)).status).toBe(401);
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}${url.pathname}${url.search}`);
    ws.binaryType = "arraybuffer";
    const got: ArrayBuffer[] = [];
    ws.onmessage = (e) => { if (typeof e.data !== "string") got.push(e.data as ArrayBuffer); };
    await new Promise((r) => { ws.onopen = r; });
    ws.send(JSON.stringify({ event: "websocket:connected", "content-type": "audio/l16;rate=16000" }));
    ws.send(new Uint8Array(640));
    await sleep(50);
    expect(talker!.heard).toBe(1);
    talker!.ev.onAudio(new Int16Array(640));
    await sleep(100);
    expect(got.map((g) => g.byteLength)).toEqual([640, 640]);

    // The agent supervises: wait reports the transcript; hang up ends it through Arca.
    talker!.ev.onLine("them", "Hello?");
    const w = await (await agent({ action: "wait", id: c.id })).json();
    expect(w.new).toEqual(["Them: Hello?"]);
    expect((await (await agent({ action: "hangup", id: c.id })).json()).result).toBe("Hung up.");
    expect(hungUp).toEqual(["arca-1"]);
    const ended = (await store.get<Call>("calls", c.id))!;
    expect(ended).toMatchObject({ status: "ended", endedBy: "agent", startedBy: { approvedAt: expect.any(String) } });
    expect(ended.recording!.bytes).toBeGreaterThan(0);
    ws.close();

    // The owner's call log and the MP3 (device token only).
    const { addDevice } = await import("../src/auth.ts");
    const { token } = await addDevice(store, "Phone", "owner");
    const dev = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${token}` } });
    expect((await fetch(`${base}/api/calls/${c.id}/recording`)).status).toBe(401);
    const log = await (await dev("/api/calls")).json();
    expect(log.calls[0]).toMatchObject({ id: c.id, to: "+14155550199", lines: 1, endedBy: "agent" });
    const rec = await dev(`/api/calls/${c.id}/recording?download=1`);
    expect(rec.headers.get("content-type")).toBe("audio/mpeg");
    expect(rec.headers.get("content-disposition")).toContain("call-14155550199-");
    expect(isMp3(new Uint8Array(await rec.arrayBuffer()))).toBe(true);
    // Not on the hub any more: it plays Arca's copy.
    rmSync(recordingPath(dir, c.id));
    arcaBucket.set("arca-1", new Uint8Array([0xff, 0xf3, 1, 2, 3]));
    await store.put<Call>("calls", { ...(await store.get<Call>("calls", c.id))!, arcaRecording: { bytes: 5 } });
    expect(new Uint8Array(await (await dev(`/api/calls/${c.id}/recording`)).arrayBuffer())).toEqual(new Uint8Array([0xff, 0xf3, 1, 2, 3]));
    expect((await dev(`/api/calls/${c.id}/recording`, { method: "DELETE" })).status).toBe(200);
    expect(arcaBucket.has("arca-1")).toBe(false); // deleted on Arca too
    expect((await dev(`/api/calls/${c.id}/recording`)).status).toBe(404);
    expect((await store.get<Call>("calls", c.id))!.recording).toBeUndefined();
  } finally { delete process.env.HEARTH_PUBLIC_URL; server.stop(true); await store.close(); }
});
