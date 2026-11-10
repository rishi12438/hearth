import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Mp3Encoder } from "@breezystack/lamejs";
import type { Vault } from "./vault.ts";

// Voice calls. Arca owns the phone line (our Vonage account and the shared number) and dials; this hub owns everything
// on the call. Vonage streams the call's audio straight here (/call-audio/<id>), the hub hands it to a speech-to-speech
// model (OpenAI Realtime or Gemini Live, with the owner's own key) that talks, and the agent that asked for the call
// supervises it in the background with hearth-call. The owner can Listen and Join from the thread (/call-live).
// The wire contract with Arca is docs/calls-arca.md.

export type CallProvider = "openai" | "gemini";
/** How the bot sounds and introduces itself. Saved in Settings; an agent can change voice or language for one call. */
export type VoicePrefs = {
  voice?: string;
  /** OpenAI only: 0.25–1.5. */
  speed?: number;
  language?: string;
  /** The bot's own name ("Sam"). */
  name?: string;
  /** Who it calls for ("Rishi"). */
  owner?: string;
  /** Its first line, if you want a fixed one. */
  intro?: string;
  /** How it should come across ("warm and brief"). */
  style?: string;
  /** false: don't record calls. A hub setting (Settings → Voice calls); an agent can't change it for one call. */
  record?: boolean;
};
export type CallLine = { who: "them" | "bot" | "you" | "note"; text: string; at: string };
export type CallQuestion = { id: string; text: string; at: string; answer?: string; by?: "agent" | "you"; late?: boolean; stage: 0 | 1 | 2 };
export type CallStatus = "dialing" | "ringing" | "live" | "ended" | "failed";
export type Call = {
  id: string; createdAt: string; updatedAt?: string;
  threadId: string; jobId?: string; to: string; brief: string; from?: string; arcaId?: string;
  provider: CallProvider; voice: VoicePrefs;
  status: CallStatus; lines: CallLine[]; questions: CallQuestion[];
  /** The owner's mic is on the call (the bot is quiet). */
  joined?: boolean;
  answeredAt?: string; endedAt?: string; outcome?: string; error?: string;
  /** Who set it going: the agent (teammate) and its task, and when you approved it. */
  startedBy?: { agent?: string; task?: string; approvedAt?: string };
  /** The longest Arca lets this call run (free plan: 120 s); Vonage hangs up there. */
  maxSeconds?: number;
  /** Talk time in seconds (Vonage's count when Arca sends it, else answered → ended). */
  seconds?: number;
  /** Who ended it. "them" also covers the line dropping. */
  endedBy?: "them" | "bot" | "you" | "agent" | "hub" | "limit";
  /** The call's audio as an MP3 on the hub (stereo: left is them, right is the bot and you). */
  recording?: { bytes: number; seconds: number };
  /** Arca keeps its own copy (Vonage's recording, in Arca's bucket). */
  arcaRecording?: { bytes: number };
};

export const OPENAI_VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"];
export const GEMINI_VOICES = ["Puck", "Charon", "Kore", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr", "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba", "Despina",
  "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar", "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi", "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat"];
export const voicesFor = (p: CallProvider) => (p === "openai" ? OPENAI_VOICES : GEMINI_VOICES);

const E164 = /^\+[1-9]\d{6,14}$/;
/** "+1 (415) 555-0199" → "+14155550199"; null if it isn't a full international number. */
export function toE164(raw: string): string | null {
  const s = String(raw || "").trim().replace(/[\s().-]/g, "");
  const n = s.startsWith("00") ? `+${s.slice(2)}` : s;
  return E164.test(n) ? n : null;
}

/** Which provider a pasted key is for. */
export function providerOfKey(key: string): CallProvider | null {
  const k = key.trim();
  if (/^sk-[A-Za-z0-9_-]{20,}$/.test(k)) return "openai";
  if (/^AIza[A-Za-z0-9_-]{30,}$/.test(k)) return "gemini";
  return null;
}

/** Is the key good, and which realtime model does it reach? Asks the provider's model list (costs nothing). */
export async function checkVoiceKey(provider: CallProvider, key: string, fetcher: typeof fetch = fetch): Promise<{ model: string } | { error: string }> {
  const name = provider === "openai" ? "OpenAI" : "Google";
  try {
    if (provider === "openai") {
      const r = await fetcher("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
      if (r.status === 401 || r.status === 403) return { error: "OpenAI didn't accept that key." };
      if (!r.ok) return { error: `OpenAI answered ${r.status}. Try again in a minute.` };
      const ids: string[] = ((await r.json()) as any)?.data?.map((m: any) => String(m.id)) ?? [];
      const model = pickNewest(ids.filter((i) => /^gpt-realtime-\d[\d.]*$/.test(i))) ?? (ids.includes("gpt-realtime") ? "gpt-realtime" : ids.find((i) => /realtime/.test(i) && !/mini|preview/.test(i)) ?? ids.find((i) => /realtime/.test(i)));
      return model ? { model } : { error: "That OpenAI key can't use the Realtime API (no realtime model on it)." };
    }
    const r = await fetcher(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(10_000) });
    if (r.status === 400 || r.status === 401 || r.status === 403) return { error: "Google didn't accept that Gemini key." };
    if (!r.ok) return { error: `Google answered ${r.status}. Try again in a minute.` };
    const live = (((await r.json()) as any)?.models ?? []).filter((m: any) => (m.supportedGenerationMethods ?? []).includes("bidiGenerateContent")).map((m: any) => String(m.name).replace(/^models\//, ""));
    // The newest plain Live model (the extended-thinking ones need async tool calls, which the talker doesn't do).
    const model = pickNewest(live.filter((m: string) => /live/.test(m) && !/thinking|preview/.test(m))) ?? pickNewest(live.filter((m: string) => /live|native-audio/.test(m) && !/thinking/.test(m))) ?? live[0];
    return model ? { model } : { error: "That Gemini key can't use the Live API (no live model on it)." };
  } catch { return { error: `Couldn't reach ${name}.` }; }
}

/** The id with the highest version number in it ("gpt-realtime-2.1" over "gpt-realtime-2"). */
function pickNewest(ids: string[]): string | undefined {
  const ver = (id: string) => (id.match(/\d+(?:\.\d+)*/g) ?? []).map((v) => v.split(".").map(Number));
  const cmp = (a: number[][], b: number[][]) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const x = a[i] ?? [], y = b[i] ?? []; for (let j = 0; j < Math.max(x.length, y.length); j++) { const d = (x[j] ?? -1) - (y[j] ?? -1); if (d) return d; } } return 0; };
  return [...ids].sort((a, b) => cmp(ver(b), ver(a)) || a.length - b.length)[0];
}

// ---------- Arca: the phone line ----------

/** The hub's own Arca account: anonymous (no email) until its owner upgrades it. The phone plan is this account's. */
export type ArcaAccount = { deviceId: string; secret: string; token: string; userId: string };
/** The phone key Arca minted for this hub (under its account), and the shared number. */
export type ArcaLine = { key: string; number: string };
export type ArcaPlan = "free" | "paid";
export interface ArcaApi {
  /** Make (or, with the same device id and secret, get back) the hub's anonymous Arca account. */
  account(a: { deviceId: string; secret: string; name: string }): Promise<{ token: string; userId: string }>;
  register(accountToken: string, hub: { name: string; url: string }): Promise<ArcaLine & { plan: ArcaPlan; maxCallSeconds: number }>;
  /** maxSeconds back is what Arca allows this call (free plan: 2 minutes); Vonage hangs up there. */
  place(key: string, b: { to: string; audioUrl: string; eventUrl: string; maxSeconds: number; record: boolean }): Promise<{ id: string; from: string; maxSeconds: number; plan: ArcaPlan; recorded: boolean }>;
  hangup(key: string, id: string): Promise<void>;
  status(key: string): Promise<{ number: string; plan: ArcaPlan; today: { calls: number; seconds: number }; limits: { calls: number; seconds: number; callSeconds: number };
    /** Free plan: the account's whole allowance (2 minutes, all calls, all hubs) and how much is spent. */
    allowance?: { seconds: number; used: number } }>;
  /** Arca's copy of a call's recording (in its bucket), or null if it has none. */
  recording(key: string, id: string): Promise<Uint8Array | null>;
  deleteRecording(key: string, id: string): Promise<void>;
}

export function arcaApi(base = process.env.HEARTH_ARCA_URL || "https://sync.tryarca.ai", fetcher: typeof fetch = fetch): ArcaApi {
  const req = async (path: string, init: { method?: string; key?: string; body?: unknown } = {}) => {
    let r: Response;
    try {
      r = await fetcher(`${base.replace(/\/$/, "")}${path}`, {
        method: init.method || (init.body ? "POST" : "GET"),
        headers: { "Content-Type": "application/json", ...(init.key ? { Authorization: `Bearer ${init.key}` } : {}) },
        body: init.body ? JSON.stringify(init.body) : undefined, signal: AbortSignal.timeout(20_000),
      });
    } catch { throw new Error("Couldn't reach Arca for the phone line."); }
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error ? `Arca: ${j.error}` : `Arca answered ${r.status}.`);
    return j;
  };
  const plan = (p: unknown): ArcaPlan => (p === "paid" ? "paid" : "free");
  return {
    async account(a) {
      const j = await req("/v1/account/bootstrap", { body: { deviceId: a.deviceId, bootstrapSecret: a.secret, displayName: a.name.slice(0, 120) } });
      if (!j.token) throw new Error("Arca: that hub account already exists and didn't hand back its token.");
      return { token: String(j.token), userId: String(j.userId) };
    },
    async register(token, hub) {
      const j = await req("/v1/phone/register", { key: token, body: { hub } });
      return { key: String(j.key), number: String(j.number), plan: plan(j.plan), maxCallSeconds: Number(j.maxCallSeconds) || 120 };
    },
    async place(key, b) {
      const j = await req("/v1/phone/calls", { key, body: b });
      return { id: String(j.id), from: String(j.from), maxSeconds: Number(j.maxSeconds) || b.maxSeconds, plan: plan(j.plan), recorded: j.recorded !== false };
    },
    async hangup(key, id) { await req(`/v1/phone/calls/${encodeURIComponent(id)}/hangup`, { key, method: "POST", body: {} }); },
    async recording(key, id) {
      const r = await fetcher(`${base.replace(/\/$/, "")}/v1/phone/calls/${encodeURIComponent(id)}/recording`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(60_000) }).catch(() => null);
      return r?.ok ? new Uint8Array(await r.arrayBuffer()) : null;
    },
    async deleteRecording(key, id) { await req(`/v1/phone/calls/${encodeURIComponent(id)}/recording`, { key, method: "DELETE" }).catch(() => {}); },
    async status(key) { return req("/v1/phone/status", { key }); },
  };
}

/** Arca signs each forwarded call event with sha256(the hub's key) as the HMAC key (it keeps only that hash). */
export function arcaSignature(key: string, raw: string) { return createHmac("sha256", createHash("sha256").update(key).digest("hex")).update(raw).digest("hex"); }
export function goodSignature(key: string, raw: string, sig: string | null) {
  const a = Buffer.from(arcaSignature(key, raw)), b = Buffer.from(String(sig || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- audio ----------

/** Linear resample of 16-bit mono PCM. Plenty for a phone line (it's 16 kHz at best). */
/** A streaming resampler for the call's audio (24 kHz model voice ↔ 16 kHz phone). Windowed-sinc, so going down it
 *  filters out what the lower rate can't carry (plain interpolation folds it back as a harsh, robotic buzz), and it
 *  keeps its place and the last few samples between chunks, so chunk edges don't click. One per direction per call. */
export class Resampler {
  private hist = new Float32Array(0);
  /** The next output sample's position, in input samples from the start of hist. */
  private pos = 0;
  private readonly step: number;
  private readonly cutoff: number;
  private readonly half = 16;
  constructor(readonly from: number, readonly to: number) {
    this.step = from / to;
    this.cutoff = Math.min(1, to / from) * 0.92;
  }
  push(pcm: Int16Array): Int16Array {
    if (this.from === this.to || !pcm.length) return pcm;
    const buf = new Float32Array(this.hist.length + pcm.length);
    buf.set(this.hist); for (let i = 0; i < pcm.length; i++) buf[this.hist.length + i] = pcm[i];
    const out: number[] = [];
    const { half, cutoff } = this;
    while (this.pos + half < buf.length) {
      const x = this.pos, c = Math.floor(x);
      let acc = 0, wsum = 0;
      for (let k = c - half + 1; k <= c + half; k++) {
        const t = x - k;
        const a = Math.PI * t * cutoff;
        const sinc = Math.abs(t) < 1e-9 ? 1 : Math.sin(a) / a;
        const win = 0.42 + 0.5 * Math.cos((Math.PI * t) / half) + 0.08 * Math.cos((2 * Math.PI * t) / half);
        const w = sinc * win;
        acc += (k >= 0 ? buf[k] : 0) * w; wsum += w;
      }
      out.push(Math.max(-32768, Math.min(32767, Math.round(acc / wsum))));
      this.pos += this.step;
    }
    const keep = Math.max(0, Math.floor(this.pos) - half);
    this.hist = buf.slice(keep);
    this.pos -= keep;
    return Int16Array.from(out);
  }
}
/** One-off conversion of a whole clip. */
export function resample(pcm: Int16Array, from: number, to: number): Int16Array {
  if (from === to || !pcm.length) return pcm;
  const padded = new Int16Array(pcm.length + 64); padded.set(pcm); // lets the filter run past the end
  return new Resampler(from, to).push(padded).slice(0, Math.max(1, Math.round((pcm.length * to) / from)));
}
const toB64 = (pcm: Int16Array) => Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");
const fromB64 = (b64: string) => { const b = Buffer.from(b64, "base64"); return new Int16Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 2)).slice(); };
const asPcm = (d: ArrayBuffer | Uint8Array | Buffer) => { const u = d instanceof Uint8Array ? d : new Uint8Array(d); return new Int16Array(u.buffer.slice(u.byteOffset, u.byteOffset + (u.byteLength & ~1))); };
/** Vonage's websocket audio: 16 kHz, 20 ms frames of 320 samples. */
const RATE = 16_000, FRAME = 320;

// ---------- the talker: a speech-to-speech model on the line ----------

export interface Talker {
  /** Caller audio, 16 kHz. */
  audio(pcm: Int16Array): void;
  /** Words for the model. respond: it should speak now. */
  inject(text: string, respond: boolean): void;
  /** The result of one of its tool calls. respond: it should speak now. */
  toolResult(callId: string, output: string, respond?: boolean): void;
  /** Start talking (the call connected). */
  greet(): void;
  close(): void;
}
export type TalkerEvents = {
  /** Its voice, 16 kHz. */
  onAudio(pcm: Int16Array): void;
  onLine(who: "them" | "bot", text: string): void;
  /** The person started talking over it: drop what's queued. */
  onInterrupt(): void;
  onTool(name: string, args: any, callId: string): void;
  onError(why: string): void;
};
export type TalkerSpec = { provider: CallProvider; key: string; model: string; instructions: string; voice: VoicePrefs };
export type TalkerFactory = (spec: TalkerSpec, ev: TalkerEvents) => Talker;

const TOOLS = [
  { name: "ask_supervisor", description: "Ask the person you work for something you don't know or can't decide. Say a short filler like \"one moment\" first. The answer comes back as a [Supervisor] message.",
    parameters: { type: "object", properties: { question: { type: "string", description: "A precise question, with what they asked you." } }, required: ["question"] } },
  { name: "end_call", description: "Hang up. Only after you've said goodbye.",
    parameters: { type: "object", properties: { outcome: { type: "string", description: "One line: what happened on the call." } }, required: ["outcome"] } },
];

/** What the talker is told: who it is, what the call is for, and the rules. */
/** "English" → "en-US" (Gemini's speech language). Unknown names: none, and the model goes by its instructions. */
export function languageCode(name?: string): string | undefined {
  const n = (name || "English").trim().toLowerCase();
  const codes: Record<string, string> = {
    english: "en-US", "us english": "en-US", "american english": "en-US", "british english": "en-GB", "uk english": "en-GB", "indian english": "en-IN", "australian english": "en-AU",
    spanish: "es-US", "mexican spanish": "es-US", "castilian spanish": "es-ES", french: "fr-FR", "canadian french": "fr-CA", german: "de-DE", italian: "it-IT",
    portuguese: "pt-BR", "brazilian portuguese": "pt-BR", dutch: "nl-NL", polish: "pl-PL", russian: "ru-RU", turkish: "tr-TR", arabic: "ar-XA",
    hindi: "hi-IN", bengali: "bn-IN", tamil: "ta-IN", telugu: "te-IN", marathi: "mr-IN", gujarati: "gu-IN", kannada: "kn-IN", malayalam: "ml-IN",
    japanese: "ja-JP", korean: "ko-KR", chinese: "cmn-CN", mandarin: "cmn-CN", vietnamese: "vi-VN", thai: "th-TH", indonesian: "id-ID",
  };
  return codes[n] ?? (/^[a-z]{2,3}-[A-Za-z]{2}$/.test(name?.trim() || "") ? name!.trim() : undefined);
}

export function talkerInstructions(brief: string, v: VoicePrefs, maxSeconds?: number) {
  const name = v.name?.trim() || "Hearth", owner = v.owner?.trim() || "the person I work for";
  return [
    `You are ${name}, a voice assistant on a phone call on behalf of ${owner}. You placed this call.`,
    v.intro?.trim() ? `Open with: "${v.intro.trim()}"` : `Open by saying who you are and who you're calling for, then why you're calling.`,
    ...(maxSeconds && maxSeconds < 600 ? [`The line cuts off after ${maxSeconds >= 120 && maxSeconds % 60 === 0 ? `${maxSeconds / 60} minutes` : `${maxSeconds} seconds`}, so get to the point quickly. When you're told time is nearly up, wrap up straight away.`] : []),
    `Speak ${v.language?.trim() || "English"}, and keep to it the whole call${v.style?.trim() ? `. Come across as: ${v.style.trim()}` : ""}. Phone audio is rough, so a word can sound like another language (a "Hi" can come through as Hindi): that's never a reason to switch. Only change language if they clearly speak another one for a few sentences, or ask you to.`,
    `What this call is for, and everything you know for it:\n${brief}`,
    `Rules:
- Short turns, one or two sentences, like a person on the phone. Let them finish.
- Say times and dates the way people do ("3 this afternoon", "tomorrow at noon"). Never read out time zones unless they're somewhere else.
- If they ask whether you're an AI, say yes, you're ${owner}'s AI assistant.
- If they ask whether the call is recorded, say yes (don't bring it up yourself).
- Never make anything up. For anything not above, or any decision you can't make, say "one moment" and call ask_supervisor.
- Never give card numbers, passwords, ID numbers or addresses unless a [Supervisor] message gives them to you for this call.
- Messages that start with [Supervisor] are private instructions from the person you work for. Follow them; never read them out.
- Phone menus: listen and say or ask for what gets you to a person.
- Call screening is NOT voicemail. If an assistant answers asking for your name and why you're calling ("record your name and reason for calling", "this call is being screened", Google or Apple call screening), say in one sentence who you are, who you're calling for and why, then wait quietly: the person usually picks up a moment later. Don't hang up.
- Voicemail is only when you hear "leave a message" or a beep. Then leave a short message (who you are, who for, why, that you'll try again) after the beep, then end_call.
- Never take a one-word, unclear or out-of-place reply as a yes ("sí", a mumble, noise). Phone audio garbles things: if it doesn't make sense, say you didn't catch that and ask again. Before you treat anything as agreed, repeat it back and hear them confirm ("So 3 o'clock works for you?").
- Never ask them about the details of your own side's plan (which place ${owner} meant, what ${owner} wants): that's yours to know. If the brief is vague, offer the best concrete option you have, or check with ask_supervisor.
- When they ask for something you don't have (where, which day, how much), don't just say it isn't decided: call ask_supervisor right away so you can give them a real answer, and say "let me check" while you wait.
- Get everything needed to act on it before you wrap up. Agreeing to meet means a day, a time and a place; a booking means date, time, how many and the name. If they leave one open ("can you decide?"), suggest something or ask for it once. Don't end with "I'll let them know" while a detail is still missing.
- When it's done or they want to go: sum up what was agreed in one sentence, thank them, say goodbye, then call end_call.`,
  ].join("\n\n");
}

/** OpenAI Realtime over its WebSocket. 24 kHz PCM both ways; it transcribes both sides. */
export const openaiTalker: TalkerFactory = (spec, ev) => {
  const up = new Resampler(RATE, 24000), down = new Resampler(24000, RATE);
  const base = process.env.HEARTH_OPENAI_REALTIME_URL || "wss://api.openai.com/v1/realtime";
  const ws = new WebSocket(`${base}?model=${encodeURIComponent(spec.model)}`, { headers: { Authorization: `Bearer ${spec.key}` } } as any);
  const waiting: string[] = [];
  const send = (m: unknown) => { const s = JSON.stringify(m); if (ws.readyState === WebSocket.OPEN) ws.send(s); else if (ws.readyState === WebSocket.CONNECTING) waiting.push(s); };
  const speed = typeof spec.voice.speed === "number" ? Math.min(1.5, Math.max(0.25, spec.voice.speed)) : undefined;
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "session.update", session: {
      type: "realtime", instructions: spec.instructions, output_modalities: ["audio"],
      audio: {
        input: { format: { type: "audio/pcm", rate: 24000 }, transcription: { model: "gpt-4o-mini-transcribe" }, turn_detection: { type: "server_vad", silence_duration_ms: 500, create_response: true, interrupt_response: true } },
        output: { format: { type: "audio/pcm", rate: 24000 }, voice: spec.voice.voice || "marin", ...(speed ? { speed } : {}) },
      },
      tools: TOOLS.map((t) => ({ type: "function", ...t })), tool_choice: "auto",
    } }));
    for (const s of waiting.splice(0)) ws.send(s);
  };
  ws.onmessage = (e) => {
    let m: any; try { m = JSON.parse(String(e.data)); } catch { return; }
    switch (m.type) {
      case "response.output_audio.delta": case "response.audio.delta": if (m.delta) ev.onAudio(down.push(fromB64(m.delta))); return;
      case "response.output_audio_transcript.done": case "response.audio_transcript.done": if (m.transcript?.trim()) ev.onLine("bot", m.transcript.trim()); return;
      case "conversation.item.input_audio_transcription.completed": if (m.transcript?.trim()) ev.onLine("them", m.transcript.trim()); return;
      case "input_audio_buffer.speech_started": ev.onInterrupt(); return;
      case "response.function_call_arguments.done": { let a: any = {}; try { a = JSON.parse(m.arguments || "{}"); } catch {} ev.onTool(m.name, a, m.call_id); return; }
      case "error": ev.onError(String(m.error?.message || "OpenAI Realtime error")); return;
    }
  };
  ws.onerror = () => ev.onError("Lost the connection to OpenAI Realtime.");
  return {
    audio: (pcm) => send({ type: "input_audio_buffer.append", audio: toB64(up.push(pcm)) }),
    inject(text, respond) { send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } }); if (respond) send({ type: "response.create" }); },
    toolResult(callId, output, respond = true) { send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output } }); if (respond) send({ type: "response.create" }); },
    greet: () => send({ type: "response.create" }),
    close: () => { try { ws.close(); } catch {} },
  };
};

/** Gemini Live over its WebSocket. 16 kHz in, 24 kHz out; transcripts of both sides come with it. */
export const geminiTalker: TalkerFactory = (spec, ev) => {
  const down = new Resampler(24000, RATE);
  const base = process.env.HEARTH_GEMINI_LIVE_URL || "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
  const ws = new WebSocket(`${base}?key=${encodeURIComponent(spec.key)}`);
  ws.binaryType = "arraybuffer";
  let ready = false;
  const waiting: string[] = [];
  const names = new Map<string, string>();
  let heard = "", said = "";
  const flushHeard = () => { if (heard.trim()) ev.onLine("them", heard.trim()); heard = ""; };
  const flushSaid = () => { if (said.trim()) ev.onLine("bot", said.trim()); said = ""; };
  const send = (m: unknown) => { const s = JSON.stringify(m); if (ready && ws.readyState === WebSocket.OPEN) ws.send(s); else waiting.push(s); };
  ws.onopen = () => {
    ws.send(JSON.stringify({ setup: {
      model: `models/${spec.model}`,
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: spec.voice.voice || "Puck" } },
        // Pinned, so a word misheard as another language doesn't flip it (it once heard "Hi" as Hindi and stayed there).
        ...(languageCode(spec.voice.language) ? { languageCode: languageCode(spec.voice.language) } : {}) } },
      systemInstruction: { parts: [{ text: spec.instructions }] },
      tools: [{ functionDeclarations: TOOLS }],
      inputAudioTranscription: {}, outputAudioTranscription: {},
      // Wait for a real pause before replying: the most eager setting replied ~0.3 s sooner but cut people off
      // mid-sentence on a phone line ("Where is the…").
      realtimeInputConfig: { automaticActivityDetection: { prefixPaddingMs: 150, silenceDurationMs: 700 } },
    } }));
  };
  ws.onmessage = (e) => {
    let m: any;
    try { m = JSON.parse(typeof e.data === "string" ? e.data : Buffer.from(e.data as ArrayBuffer).toString("utf8")); } catch { return; }
    if (m.setupComplete) { ready = true; for (const s of waiting.splice(0)) ws.send(s); return; }
    const sc = m.serverContent;
    if (sc) {
      if (sc.inputTranscription?.text) heard += sc.inputTranscription.text;
      if (sc.outputTranscription?.text) { flushHeard(); said += sc.outputTranscription.text; }
      for (const p of sc.modelTurn?.parts ?? []) if (p.inlineData?.data) { flushHeard(); ev.onAudio(down.push(fromB64(p.inlineData.data))); }
      if (sc.interrupted) { flushSaid(); ev.onInterrupt(); }
      if (sc.turnComplete) flushSaid();
    }
    for (const f of m.toolCall?.functionCalls ?? []) { names.set(f.id, f.name); flushHeard(); ev.onTool(f.name, f.args ?? {}, f.id); }
  };
  ws.onerror = () => ev.onError("Lost the connection to Gemini Live.");
  ws.onclose = (e) => { if (!ready) ev.onError(`Gemini Live closed: ${String(e.reason || e.code).slice(0, 160)}`); };
  return {
    audio: (pcm) => send({ realtimeInput: { audio: { data: toB64(pcm), mimeType: "audio/pcm;rate=16000" } } }),
    inject: (text, respond) => send({ clientContent: { turns: [{ role: "user", parts: [{ text }] }], turnComplete: respond } }),
    toolResult: (callId, output) => send({ toolResponse: { functionResponses: [{ id: callId, name: names.get(callId) || "ask_supervisor", response: { result: output } }] } }),
    greet: () => send({ clientContent: { turns: [{ role: "user", parts: [{ text: "[Supervisor] The call just connected. Start talking." }] }], turnComplete: true } }),
    close: () => { try { ws.close(); } catch {} },
  };
};

// ---------- settings ----------

export type CallsView = {
  connected: boolean; provider: CallProvider | null; model: string | null; hint: string | null;
  number: string | null; voice: VoicePrefs; voices: string[];
  publicUrl: string | null;
};

/** Saved settings: the voice model key and the Arca line in the vault; how it sounds in calls.json. */
export class CallSettings {
  constructor(private vault: Vault | null, private dataDir: string) {}
  model(): { provider: CallProvider; key: string; model: string } | null {
    try { const j = JSON.parse(this.vault?.get("calls") || "null"); return j?.key ? j : null; } catch { return null; }
  }
  line(): ArcaLine | null {
    try { const j = JSON.parse(this.vault?.get("calls-arca") || "null"); return j?.key ? j : null; } catch { return null; }
  }
  setModel(m: { provider: CallProvider; key: string; model: string }) { this.vault!.set("calls", JSON.stringify(m)); }
  setLine(l: ArcaLine) { this.vault!.set("calls-arca", JSON.stringify({ key: l.key, number: l.number })); }
  account(): ArcaAccount | null {
    try { const j = JSON.parse(this.vault?.get("arca-account") || "null"); return j?.token ? j : null; } catch { return null; }
  }
  setAccount(a: ArcaAccount) { this.vault!.set("arca-account", JSON.stringify(a)); }
  forget() { this.vault?.delete("calls"); }
  private file() { return join(this.dataDir, "calls.json"); }
  voice(): VoicePrefs { try { return existsSync(this.file()) ? JSON.parse(readFileSync(this.file(), "utf8")) : {}; } catch { return {}; } }
  setVoice(v: VoicePrefs) { const clean = cleanVoice(v, this.model()?.provider ?? "openai"); writeFileSync(this.file(), JSON.stringify(clean, null, 1)); return clean; }
}

/** Only the fields we know, trimmed and bounded; a voice that the provider doesn't have is dropped. */
export function cleanVoice(v: any, provider: CallProvider): VoicePrefs {
  const s = (x: unknown, n: number) => (typeof x === "string" && x.trim() ? x.trim().slice(0, n) : undefined);
  const out: VoicePrefs = {};
  const voice = s(v?.voice, 40);
  if (voice) { const hit = voicesFor(provider).find((x) => x.toLowerCase() === voice.toLowerCase()); if (hit) out.voice = hit; }
  const sp = Number(v?.speed);
  if (provider === "openai" && Number.isFinite(sp) && v?.speed !== "" && v?.speed != null) out.speed = Math.min(1.5, Math.max(0.25, Math.round(sp * 100) / 100));
  for (const [k, n] of [["language", 40], ["name", 40], ["owner", 60], ["intro", 300], ["style", 300]] as const) { const x = s(v?.[k], n); if (x) (out as any)[k] = x; }
  // Recording is on unless turned off.
  if (v?.record === false || v?.record === "off") out.record = false;
  return out;
}

// ---------- calls in flight ----------

type Sock = { send(d: string | Uint8Array): void; close(code?: number, why?: string): void };
type Live = {
  call: Call; secret: string; talker: Talker | null; vonage: Sock | null;
  out: Int16Array[]; pump: ReturnType<typeof setInterval> | null;
  listeners: Set<Sock>; joiner: Sock | null; mic: Int16Array[];
  waiters: Set<() => void>; seen: number;
  /** Questions hearth-call wait has already reported. */
  told: Set<string>;
  /** The run supervising this call (one at a time) and when it last checked in. */
  supervisor?: { job: string; at: number };
  /** Private steers from the supervisor the bot hasn't been held to yet (end_call is sent back once if one is fresh). */
  steers: { text: string; at: number }[];
  timers: ReturnType<typeof setTimeout>[]; asked: Map<string, string>;
  ending: boolean; greetTimer?: ReturnType<typeof setTimeout>;
  /** The model's voice that doesn't fill a whole 20 ms frame yet (frames are always whole, so speech has no gaps). */
  carry: Int16Array;
  rec: CallRecorder | null;
};

export type CallsDeps = {
  vault: Vault | null; dataDir: string;
  hubName(): string;
  publicUrl(): string | null;
  save(c: Call): Promise<void>;
  load(id: string): Promise<Call | null>;
  /** The call changed: tell the app. */
  emit(c: Call): void;
  /** Buzz the owner (a question from the call). */
  notify(c: Call, q: CallQuestion): void;
  arca?: ArcaApi;
  talker?: TalkerFactory;
  fetcher?: typeof fetch;
  clock?: () => Date;
  /** Seconds before "let me check" and before giving up and promising a call back (5 and 10). */
  waits?: { check: number; giveUp: number };
  /** hearth-call wait gathers this long after the first new line (5000). */
  gatherMs?: number;
};

const listenerFrame = (tag: number, pcm: Int16Array) => { const b = new Uint8Array(1 + pcm.byteLength); b[0] = tag; b.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 1); return b; };

export class Calls {
  readonly settings: CallSettings;
  private arca: ArcaApi;
  private live = new Map<string, Live>();
  private clock: () => Date;
  private waits: { check: number; giveUp: number };
  /** How long hearth-call wait gathers talk before returning (ms). */
  private gather: number;
  constructor(private d: CallsDeps) {
    this.settings = new CallSettings(d.vault, d.dataDir);
    this.arca = d.arca ?? arcaApi(undefined, d.fetcher);
    this.clock = d.clock ?? (() => new Date());
    this.waits = d.waits ?? { check: 5, giveUp: 10 };
    this.gather = d.gatherMs ?? 5000;
  }

  configured() { return !!this.settings.model() && !!this.settings.line(); }

  view(): CallsView {
    const m = this.settings.model(), l = this.settings.line();
    return { connected: !!m && !!l, provider: m?.provider ?? null, model: m?.model ?? null, hint: m ? `••••${m.key.slice(-4)}` : null,
      number: l?.number ?? null, voice: this.settings.voice(), voices: voicesFor(m?.provider ?? "openai"), publicUrl: this.d.publicUrl() };
  }

  /** Turn voice calls on: check the model key, then get this hub its own Arca key (once). Returns an error or null. */
  async connect(rawKey: string): Promise<string | null> {
    if (!this.d.vault) return "This hub has no key vault.";
    const key = rawKey.trim();
    const provider = providerOfKey(key);
    if (!provider) return "Paste an OpenAI key (sk-…) or a Gemini key (AIza…).";
    const pub = this.d.publicUrl();
    if (!pub || !/^https:\/\//.test(pub)) return "Voice calls need this hub's public https address (HEARTH_PUBLIC_URL), so the call's audio can reach it.";
    const ok = await checkVoiceKey(provider, key, this.d.fetcher);
    if ("error" in ok) return ok.error;
    if (!this.settings.line()) {
      try {
        // The hub's own Arca account (anonymous; the plan lives on it), then a phone key under it.
        let acct = this.settings.account();
        if (!acct) {
          const deviceId = `hearth-${randomBytes(12).toString("base64url")}`, secret = randomBytes(32).toString("base64url");
          acct = { deviceId, secret, ...(await this.arca.account({ deviceId, secret, name: this.d.hubName() })) };
          this.settings.setAccount(acct);
        }
        this.settings.setLine(await this.arca.register(acct.token, { name: this.d.hubName(), url: pub }));
      } catch (e: any) { return `Your key is fine, but the phone line didn't set up: ${e.message}`; }
    }
    const was = this.settings.model()?.provider;
    this.settings.setModel({ provider, key, model: ok.model });
    // A voice picked for the other provider doesn't exist on this one.
    if (was && was !== provider) this.settings.setVoice({ ...this.settings.voice(), voice: undefined, speed: undefined });
    return null;
  }
  /** Turn voice calls off. The Arca line stays, so turning them back on keeps the same key. */
  disconnect() { this.settings.forget(); }
  async lineStatus() { const l = this.settings.line(); return l ? this.arca.status(l.key).catch(() => null) : null; }

  // ---- placing a call (after the owner's Approve) ----

  async start(a: { to: string; brief: string; voice?: VoicePrefs; threadId: string; jobId?: string; startedBy?: Call["startedBy"] }): Promise<Call> {
    const m = this.settings.model(), l = this.settings.line(), pub = this.d.publicUrl();
    if (!m || !l) throw new Error("Voice calls aren't turned on (Settings → Connectors → Voice calls).");
    if (!pub) throw new Error("This hub has no public address (HEARTH_PUBLIC_URL).");
    const to = toE164(a.to);
    if (!to) throw new Error(`${a.to} isn't a full phone number with its country code (+1…).`);
    const now = this.clock().toISOString();
    const call: Call = {
      id: `c_${randomBytes(9).toString("base64url")}`, createdAt: now, threadId: a.threadId, jobId: a.jobId, to, brief: a.brief.slice(0, 6000),
      provider: m.provider, voice: cleanVoice({ ...this.settings.voice(), ...(a.voice || {}), record: this.settings.voice().record }, m.provider),
      status: "dialing", lines: [], questions: [], ...(a.startedBy ? { startedBy: a.startedBy } : {}),
    };
    const lv: Live = { call, secret: randomBytes(24).toString("base64url"), talker: null, vonage: null, out: [], pump: null, listeners: new Set(), joiner: null, mic: [],
      waiters: new Set(), seen: 0, told: new Set(), timers: [], asked: new Map(), ending: false, rec: null, carry: new Int16Array(0), steers: [] };
    this.live.set(call.id, lv);
    await this.save(lv);
    const base = pub.replace(/\/$/, "");
    try {
      const r = await this.arca.place(l.key, { to, audioUrl: `${base.replace(/^http/, "ws")}/call-audio/${call.id}?t=${lv.secret}`, eventUrl: `${base}/api/calls/events/${call.id}`, maxSeconds: 900, record: call.voice.record !== false });
      call.arcaId = r.id; call.from = r.from; call.maxSeconds = r.maxSeconds; call.status = "ringing";
      // Free calls are always recorded (Arca decides): then the hub records too, and the bot says so.
      if (r.recorded) call.voice = { ...call.voice, record: undefined };
      await this.save(lv);
    } catch (e: any) { await this.finish(lv, "failed", e.message, "hub"); throw e; }
    return call;
  }

  private async save(lv: Live) { lv.call.updatedAt = this.clock().toISOString(); await this.d.save(lv.call); this.d.emit(lv.call); for (const w of [...lv.waiters]) w(); }

  /** Arca forwarded a call event. Unsigned or for a call we don't have: false. */
  async event(id: string, raw: string, sig: string | null): Promise<boolean> {
    const lv = this.live.get(id), l = this.settings.line();
    if (!l || !goodSignature(l.key, raw, sig)) return false;
    let e: any; try { e = JSON.parse(raw); } catch { return false; }
    const s = String(e?.status || "");
    // Arca has stored Vonage's recording. It comes after the call ends, often after the hub has let go of it.
    if (s === "recorded") {
      const c = lv?.call ?? (await this.d.load(id));
      if (!c) return false;
      c.arcaRecording = { bytes: Math.max(0, Number(e?.recordingBytes) || 0) };
      if (lv) await this.save(lv); else { c.updatedAt = this.clock().toISOString(); await this.d.save(c); this.d.emit(c); }
      return true;
    }
    if (!lv) return false;
    const dur = Number(e?.duration);
    if (s === "completed" && Number.isFinite(dur) && dur >= 0) lv.call.seconds = Math.round(dur);
    if (s === "completed" && e?.endedBy === "limit") lv.call.endedBy = "limit";
    // Arca runs the call's clock: shortly before it cuts the line, the bot wraps up.
    if (s === "warning") {
      if (lv.call.status === "live" && !lv.ending) {
        lv.talker?.inject(`[Supervisor] About ${Number(e?.secondsLeft) || 20} seconds left before the line cuts off. Wrap up now: sum up what was agreed, say we'll follow up on anything open, say goodbye, then end_call.`, true);
        await this.line(lv, "note", "Near the time limit: the bot is wrapping up");
      }
      return true;
    }
    if (s === "answered" && lv.call.status === "ringing") { lv.call.status = "live"; lv.call.answeredAt = this.clock().toISOString(); await this.save(lv); }
    // "rejected"/"failed" before it rang is usually the phone network (an unknown number screened or blocked, Do Not
    // Disturb), not them: never tell the owner they declined.
    const notThrough = "It didn't go through: it was stopped before their phone rang (usually their phone network or phone screening an unknown number, or Do Not Disturb).";
    const why = typeof e?.detail === "string" && e.detail ? ` (${String(e.detail).slice(0, 60)})` : "";
    const ended: Record<string, string> = { busy: "Their line was busy.", cancelled: "The call was cancelled.", failed: notThrough + why, rejected: notThrough + why, timeout: "It rang, but nobody picked up.", unanswered: "It rang, but nobody picked up.", machine: "" };
    if (s === "completed") await this.finish(lv, "ended", lv.call.outcome || (lv.call.answeredAt ? "The call ended." : "Nobody picked up."), "them");
    else if (s in ended && s !== "machine") await this.finish(lv, lv.call.answeredAt ? "ended" : "failed", ended[s], "them");
    return true;
  }

  /** Vonage's audio socket for a call: the token in its URL has to match. */
  audioAllowed(id: string, token: string) {
    const lv = this.live.get(id);
    if (!lv || lv.vonage || lv.call.status === "ended" || lv.call.status === "failed") return false;
    const a = Buffer.from(lv.secret), b = Buffer.from(String(token || ""));
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** The call's audio is here: start the talker and the 20 ms pump back to Vonage. */
  audioOpen(id: string, sock: Sock) {
    const lv = this.live.get(id), m = this.settings.model();
    if (!lv || !m) { sock.close(1011, "no call"); return; }
    lv.vonage = sock;
    if (lv.call.voice.record !== false && !lv.rec) {
      try { lv.rec = new CallRecorder(recordingPath(this.d.dataDir, lv.call.id)); lv.call.recording = { bytes: 0, seconds: 0 }; }
      catch (e: any) { void this.line(lv, "note", `Not recording: ${e.message}`); }
    }
    if (lv.call.status !== "live") { lv.call.status = "live"; lv.call.answeredAt ??= this.clock().toISOString(); void this.save(lv); }
    const factory = this.d.talker ?? (m.provider === "openai" ? openaiTalker : geminiTalker);
    lv.talker = factory({ provider: m.provider, key: m.key, model: m.model, instructions: talkerInstructions(lv.call.brief, lv.call.voice, lv.call.maxSeconds), voice: lv.call.voice }, {
      onAudio: (pcm) => {
        if (lv.joiner) return;
        const all = lv.carry.length ? (() => { const b = new Int16Array(lv.carry.length + pcm.length); b.set(lv.carry); b.set(pcm, lv.carry.length); return b; })() : pcm;
        let i = 0;
        for (; i + FRAME <= all.length; i += FRAME) lv.out.push(all.slice(i, i + FRAME));
        lv.carry = all.slice(i);
      },
      onLine: (who, text) => { void this.line(lv, lv.joiner && who === "them" ? "them" : who, text); },
      onInterrupt: () => { lv.out.length = 0; lv.carry = new Int16Array(0); },
      onTool: (name, args, callId) => { void this.tool(lv, name, args, callId); },
      onError: (why) => { void this.line(lv, "note", why); },
    });
    // People answer with "Hello?": the model replies to that. If they say nothing, it starts after 2 s.
    let heard = false;
    lv.greetTimer = setTimeout(() => { if (!heard) lv.talker?.greet(); }, 2000);
    const origAudio = lv.talker.audio.bind(lv.talker);
    lv.talker.audio = (pcm) => { heard ||= pcm.some((x) => Math.abs(x) > 1500); origAudio(pcm); };
    // Paced by the clock, not by timer ticks (they fire late, and one frame a late tick falls behind and stutters):
    // every frame that's due goes out, up to 40 ms early so Vonage always has the next one in hand.
    let due = 0;
    const next = (): { frame: Int16Array; mic: boolean } | null => {
      if (lv.joiner) { const m = lv.mic.shift(); return m ? { frame: m, mic: true } : null; }
      const f = lv.out.shift();
      if (f) return { frame: f, mic: false };
      // The last bit of a sentence, once nothing more is coming in.
      if (lv.carry.length) { const p = new Int16Array(FRAME); p.set(lv.carry); lv.carry = new Int16Array(0); return { frame: p, mic: false }; }
      return null;
    };
    lv.pump = setInterval(() => {
      const now = performance.now();
      if (!due || now - due > 200) due = now;
      while (due <= now + 40) {
        const n = next();
        if (!n) { due = 0; return; }
        const frame = n.frame.length === FRAME ? n.frame : (() => { const p = new Int16Array(FRAME); p.set(n.frame.subarray(0, FRAME)); return p; })();
        try { lv.vonage?.send(new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength)); } catch {}
        lv.rec?.ours(frame);
        if (!n.mic) for (const s of lv.listeners) { try { s.send(listenerFrame(2, frame)); } catch {} }
        due += 20;
      }
    }, 10);
  }

  /** One binary frame (or the opening JSON) from Vonage. */
  audioIn(id: string, data: string | ArrayBuffer | Uint8Array) {
    const lv = this.live.get(id);
    if (!lv || typeof data === "string") return;
    const pcm = asPcm(data as ArrayBuffer);
    // While you're on, the model hears you too (mixed in), so it knows what you said when you hand back.
    const mine = lv.joiner ? lv.mic[0] : undefined;
    lv.talker?.audio(mine ? mix(pcm, mine) : pcm);
    try { lv.rec?.theirs(pcm); } catch {}
    for (const s of lv.listeners) { try { s.send(listenerFrame(1, pcm)); } catch {} }
  }

  audioClosed(id: string) {
    const lv = this.live.get(id);
    if (lv && !lv.ending) void this.finish(lv, lv.call.answeredAt ? "ended" : "failed", lv.call.outcome || "The call ended.", "them");
  }

  private async line(lv: Live, who: CallLine["who"], text: string) {
    lv.call.lines.push({ who, text: text.slice(0, 2000), at: this.clock().toISOString() });
    if (lv.call.lines.length > 600) lv.call.lines.splice(0, lv.call.lines.length - 600);
    await this.save(lv);
  }

  /** The talker called a tool. */
  private async tool(lv: Live, name: string, args: any, callId: string) {
    if (name === "end_call") {
      // Hanging up seconds in is nearly always a mistake (a call screener or a greeting taken for voicemail).
      const since = lv.call.answeredAt ? (this.clock().getTime() - Date.parse(lv.call.answeredAt)) / 1000 : 99;
      if (since < 12 && !(lv.call.lines.some((l) => l.who === "them" && /\b(bye|goodbye|not interested|stop calling|wrong number)\b/i.test(l.text)))) {
        lv.talker?.toolResult(callId, "Not yet: the call only just connected. If an assistant is screening the call, say who you are and why you're calling, then wait for the person. Only end the call once you've actually talked or left a voicemail after the beep.", true);
        return;
      }
      // The supervisor's notes come a few seconds behind the conversation: a fresh one gets done before the goodbye.
      const fresh = lv.steers.filter((x) => Date.now() - x.at < 20_000);
      if (fresh.length) {
        lv.steers.length = 0;
        lv.talker?.toolResult(callId, `Not yet. Your supervisor asked: "${fresh.map((x) => x.text).join(" / ")}". Do that first (ask them now), then end the call.`, true);
        return;
      }
      lv.talker?.toolResult(callId, "ok", false);
      lv.call.outcome = String(args?.outcome || "").slice(0, 500) || lv.call.outcome;
      lv.call.endedBy ??= "bot";
      return this.hangupSoon(lv);
    }
    if (name !== "ask_supervisor") { lv.talker?.toolResult(callId, "No such tool."); return; }
    const q: CallQuestion = { id: `q${lv.call.questions.length + 1}`, text: String(args?.question || "").slice(0, 800), at: this.clock().toISOString(), stage: 0 };
    lv.call.questions.push(q);
    lv.asked.set(q.id, callId);
    await this.save(lv);
    this.d.notify(lv.call, q);
    // ~5 s: "let me just check". ~10 s: no answer, so it promises to get back to them and wraps up.
    lv.timers.push(setTimeout(() => {
      if (q.answer || q.stage) return;
      q.stage = 1; lv.asked.delete(q.id);
      lv.talker?.toolResult(callId, "No answer yet. Tell them briefly you're just checking on that, then wait quietly.");
      void this.save(lv);
    }, this.waits.check * 1000));
    lv.timers.push(setTimeout(() => {
      if (q.answer) return;
      q.stage = 2;
      lv.talker?.inject(`[Supervisor] No answer on "${q.text}" right now. Tell them you'll get back to them on that shortly, thank them, say goodbye, then call end_call.`, true);
      void this.save(lv);
    }, this.waits.giveUp * 1000));
  }

  private hangupSoon(lv: Live) {
    if (lv.ending) return;
    // Let the goodbye play out, then hang up (or after 8 s at most).
    const started = Date.now();
    const t = setInterval(() => { if (lv.out.length === 0 || Date.now() - started > 8000) { clearInterval(t); setTimeout(() => void this.hangup(lv.call.id, "bot"), 600); } }, 100);
  }

  // ---- the supervisor (the agent, through hearth-call) and the owner (the app) ----

  /** An answer to the talker's question, from the agent or from you. Late (after the bot gave up) it's kept for the call back. */
  async answer(id: string, text: string, by: "agent" | "you", qid?: string): Promise<string> {
    const lv = this.live.get(id);
    const call = lv?.call ?? (await this.d.load(id));
    if (!call) throw new Error("No such call.");
    const q = (qid ? call.questions.find((x) => x.id === qid) : null) ?? [...call.questions].reverse().find((x) => !x.answer);
    if (!q) throw new Error("There's no question waiting on this call.");
    if (q.answer) throw new Error(`Already answered (by ${q.by === "you" ? "the owner" : "the agent"}): ${q.answer}`);
    q.answer = text.slice(0, 2000); q.by = by;
    if (!lv || lv.call.status !== "live" || q.stage === 2) {
      q.late = true;
      if (lv) await this.save(lv); else await this.d.save(call);
      return "Saved. The call had already moved on (the bot said it would get back to them), so use this when you call or text them back.";
    }
    const callId = lv.asked.get(q.id);
    if (callId && q.stage === 0) { lv.asked.delete(q.id); lv.talker?.toolResult(callId, q.answer); }
    else lv.talker?.inject(`[Supervisor] The answer to "${q.text}": ${q.answer}. Carry on with it.`, true);
    if (by === "you") lv.call.lines.push({ who: "note", text: `You answered: ${q.answer}`, at: this.clock().toISOString() });
    await this.save(lv);
    return "Passed to the bot on the call.";
  }

  /** A private steer for the talker ("they're stalling: ask for a manager"). */
  async say(id: string, text: string) {
    const lv = this.live.get(id);
    if (!lv || lv.call.status !== "live") throw new Error("That call isn't live.");
    lv.talker?.inject(`[Supervisor] ${text.slice(0, 2000)}`, false);
    lv.steers.push({ text: text.slice(0, 600), at: Date.now() });
    await this.line(lv, "note", `Supervisor: ${text.slice(0, 300)}`);
  }

  async hangup(id: string, by: "you" | "agent" | "bot" = "agent") {
    const lv = this.live.get(id);
    if (!lv) return;
    lv.call.endedBy ??= by;
    const l = this.settings.line();
    if (l && lv.call.arcaId) await this.arca.hangup(l.key, lv.call.arcaId).catch(() => {});
    await this.finish(lv, lv.call.answeredAt ? "ended" : "failed", lv.call.outcome || (lv.call.answeredAt ? "Hung up." : "Hung up before they answered."), by);
  }

  private async finish(lv: Live, status: "ended" | "failed", why: string, by?: Call["endedBy"]) {
    if (lv.ending) return;
    lv.ending = true;
    for (const t of lv.timers) clearTimeout(t);
    if (lv.greetTimer) clearTimeout(lv.greetTimer);
    if (lv.pump) clearInterval(lv.pump);
    lv.talker?.close();
    try { lv.vonage?.close(1000, "done"); } catch {}
    for (const s of lv.listeners) { try { s.send(JSON.stringify({ t: "ended" })); s.close(1000, "ended"); } catch {} }
    lv.call.status = status; lv.call.endedAt = this.clock().toISOString(); lv.call.joined = false;
    if (by) lv.call.endedBy ??= by;
    if (lv.call.answeredAt && lv.call.seconds == null) lv.call.seconds = Math.max(0, Math.round((Date.parse(lv.call.endedAt) - Date.parse(lv.call.answeredAt)) / 1000));
    if (lv.rec) { try { lv.call.recording = lv.rec.close(); } catch (e: any) { lv.call.lines.push({ who: "note", text: `The recording didn't save: ${e.message}`, at: lv.call.endedAt }); } lv.rec = null; }
    if (status === "failed") lv.call.error ??= why; else lv.call.outcome ||= why;
    await this.save(lv);
    // Keep it a minute so a last hearth-call wait still sees how it ended.
    setTimeout(() => this.live.delete(lv.call.id), 60_000);
  }

  /** One run supervises a call. Another run that tries gets told to stand down (two used to report the same call twice,
   *  at twice the cost). Null: go ahead. A supervisor that hasn't checked in for 90 s gives way. */
  claim(id: string, job: string | undefined): string | null {
    const lv = this.live.get(id);
    if (!lv || !job) return null;
    const cur = lv.supervisor;
    if (cur && cur.job !== job && Date.now() - cur.at < 90_000) {
      return "Another run is already supervising this call, so don't. End your turn now with one short line saying the call is in progress, and post nothing about its result: that run reports it.";
    }
    lv.supervisor = { job, at: Date.now() };
    return null;
  }

  /** hearth-call wait: blocks until something new happens on the call (or ~45 s), then says what. */
  async wait(id: string, ms = 45_000) {
    const lv = this.live.get(id);
    if (!lv) { const c = await this.d.load(id); if (!c) throw new Error("No such call."); return this.report(c, 0); }
    // Something to say: new lines, a question it hasn't been told about yet, or the end.
    const news = () => lv.call.lines.length > lv.seen || lv.call.status === "ended" || lv.call.status === "failed"
      || lv.call.questions.some((q) => !q.answer && q.stage < 2 && !lv.told.has(q.id));
    const urgent = () => lv.call.status === "ended" || lv.call.status === "failed"
      || lv.call.questions.some((q) => !q.answer && q.stage < 2 && !lv.told.has(q.id));
    const until = (cond: () => boolean, wait: number) => new Promise<void>((res) => {
      if (cond() || wait <= 0) return res();
      const done = () => { if (!cond()) return; clearTimeout(t); lv.waiters.delete(done); res(); };
      const t = setTimeout(() => { lv.waiters.delete(done); res(); }, wait);
      lv.waiters.add(done);
    });
    if (ms > 0) {
      await until(news, ms);
      // Each return is a whole turn for the agent (it re-reads everything), so gather a few seconds of talk per
      // return; a question or the end still comes straight away.
      if (news() && !urgent() && lv.call.lines.length - lv.seen < 4) await until(() => urgent() || lv.call.lines.length - lv.seen >= 4, Math.min(this.gather, ms));
    }
    const r = this.report(lv.call, lv.seen);
    lv.seen = lv.call.lines.length;
    for (const q of lv.call.questions) lv.told.add(q.id);
    return r;
  }

  private report(c: Call, since: number) {
    const open = c.questions.filter((q) => !q.answer && q.stage < 2);
    const unanswered = c.questions.filter((q) => q.stage === 2 && !q.answer || q.late);
    return {
      id: c.id, status: c.status, to: c.to,
      new: c.lines.slice(since).map((l) => `${l.who === "them" ? "Them" : l.who === "bot" ? "Bot" : l.who === "you" ? "Owner" : "Note"}: ${l.text}`),
      ...(open.length ? { question: { id: open[0].id, text: open[0].text, howTo: `hearth-call answer ${c.id} "<answer>" (within ~${this.waits.giveUp}s, or the bot promises to get back to them)` } } : {}),
      ...(c.status === "ended" || c.status === "failed" ? {
        ended: { outcome: c.outcome || null, error: c.error || null, seconds: c.seconds ?? 0, endedBy: c.endedBy || null,
          next: !c.answeredAt
            ? "It never connected, so nobody spoke: don't say they declined or that you talked. Tell the owner plainly in a line what happened (from the error). If it didn't go through, their phone or network likely blocked an unknown number: suggest they save Hearth's number in their contacts, and don't call again more than once."
            : "Now act on it; don't stop at a report. Settled: do the follow-through (calendar, booking, telling whoever needs to know) through the usual tools. Anything open (no clear yes, no time or place, they asked the owner to decide, time ran out): suggest a concrete answer yourself (check calendar and memory), ask the owner to confirm in one line ending with [[answer-needed]], and call back once they answer. The transcript and recording are already in the thread: don't repeat them.",
          recording: c.recording?.bytes ? recordingPath(this.d.dataDir, c.id) : null,
          followUp: unanswered.map((q) => ({ question: q.text, answer: q.answer || null })) },
        transcript: c.lines.filter((l) => l.who !== "note").map((l) => `${l.who === "them" ? "Them" : l.who === "bot" ? "Bot" : "Owner"}: ${l.text}`),
      } : {}),
    };
  }

  // ---- Listen and Join (the owner's browser) ----

  listenOpen(id: string, sock: Sock) {
    const lv = this.live.get(id);
    if (!lv || lv.call.status === "ended" || lv.call.status === "failed") { sock.close(1000, "ended"); return; }
    lv.listeners.add(sock);
  }
  listenMessage(id: string, sock: Sock, data: string | ArrayBuffer | Uint8Array) {
    const lv = this.live.get(id);
    if (!lv) return;
    if (typeof data === "string") {
      if (data === "join" && !lv.joiner) {
        lv.joiner = sock; lv.out.length = 0; lv.call.joined = true;
        lv.talker?.inject("[Supervisor] I've joined the call myself and I'm talking now. Stay completely quiet until I hand back.", false);
        void this.line(lv, "note", "You joined the call");
      } else if (data === "leave" && lv.joiner === sock) this.handBack(lv);
      return;
    }
    if (lv.joiner !== sock) return;
    const pcm = asPcm(data as ArrayBuffer);
    for (let i = 0; i < pcm.length; i += FRAME) lv.mic.push(pcm.subarray(i, i + FRAME));
    if (lv.mic.length > 50) lv.mic.splice(0, lv.mic.length - 50); // never more than 1 s behind
  }
  listenClosed(id: string, sock: Sock) {
    const lv = this.live.get(id);
    if (!lv) return;
    lv.listeners.delete(sock);
    if (lv.joiner === sock) this.handBack(lv);
  }
  private handBack(lv: Live) {
    lv.joiner = null; lv.mic.length = 0; lv.call.joined = false;
    if (lv.call.status !== "live") return;
    lv.talker?.inject("[Supervisor] I've handed the call back to you. Carry on from where I left it, with what I said.", true);
    void this.line(lv, "note", "You handed the call back");
  }

  /** Arca's copy of a call's recording. */
  async arcaRecording(c: Call) { const l = this.settings.line(); return l && c.arcaId ? this.arca.recording(l.key, c.arcaId) : null; }
  /** Remove Arca's copy (best effort: the hub's copy is gone either way). */
  async deleteRecording(c: Call) { const l = this.settings.line(); if (l && c.arcaId && c.arcaRecording?.bytes) await this.arca.deleteRecording(l.key, c.arcaId); }

  isLive(id: string) { const s = this.live.get(id)?.call.status; return s === "ringing" || s === "live" || s === "dialing"; }
  /** A hub restart drops every live call: mark the ones the store still thinks are going as ended. */
  static stale(c: Call, recordedBytes = 0): Call | null {
    if (c.status === "ended" || c.status === "failed") return null;
    const endedAt = new Date().toISOString();
    return { ...c, status: c.answeredAt ? "ended" : "failed", endedAt, endedBy: c.endedBy || "hub", outcome: c.outcome || "The hub restarted, so the call dropped.", error: c.answeredAt ? undefined : "The hub restarted before it connected.",
      // The MP3 is written as the call goes, so what was said before the restart is still there.
      ...(c.recording ? { recording: { bytes: recordedBytes, seconds: Math.round((recordedBytes * 8) / (REC_KBPS * 1000)) } } : {}),
      ...(c.answeredAt && c.seconds == null ? { seconds: Math.max(0, Math.round((Date.parse(c.updatedAt || endedAt) - Date.parse(c.answeredAt)) / 1000)) } : {}) };
  }
}

// ---------- recording ----------

const REC_RATE = 16000, REC_KBPS = 32, MP3_FRAME = 1152;
export const recordingPath = (dataDir: string, id: string) => join(dataDir, "calls", `${id.replace(/[^\w-]/g, "")}.mp3`);

/** Records a call to a stereo MP3 as it happens (so a hub restart still leaves a playable file). Left: them. Right:
 *  what we sent (the bot, or you while you've joined). Vonage's frames from them arrive every 20 ms for the whole call
 *  and set the clock; what we sent since lines up beside each one, silence when we sent nothing. */
export class CallRecorder {
  private enc = new Mp3Encoder(2, REC_RATE, REC_KBPS);
  private us: Int16Array[] = [];
  private usLen = 0;
  private l = new Int16Array(MP3_FRAME);
  private r = new Int16Array(MP3_FRAME);
  private n = 0;
  private pending: Uint8Array[] = [];
  private samples = 0;
  private bytes = 0;
  constructor(readonly path: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, new Uint8Array(0)); }
  /** A frame we sent to the call. */
  ours(pcm: Int16Array) {
    this.us.push(pcm); this.usLen += pcm.length;
    while (this.usLen > REC_RATE && this.us.length) this.usLen -= this.us.shift()!.length; // never more than 1 s ahead
  }
  /** A frame from them: it and the same length of ours go in. */
  theirs(pcm: Int16Array) {
    const ours = this.take(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      this.l[this.n] = pcm[i]; this.r[this.n] = ours[i];
      if (++this.n === MP3_FRAME) { this.add(this.enc.encodeBuffer(this.l, this.r)); this.samples += this.n; this.n = 0; if (this.pending.length >= 40) this.flush(); }
    }
  }
  close(): { bytes: number; seconds: number } {
    if (this.n) { this.add(this.enc.encodeBuffer(this.l.subarray(0, this.n), this.r.subarray(0, this.n))); this.samples += this.n; this.n = 0; }
    this.add(this.enc.flush());
    this.flush();
    return { bytes: this.bytes, seconds: Math.round(this.samples / REC_RATE) };
  }
  private take(k: number) {
    const out = new Int16Array(k);
    let o = 0;
    while (o < k && this.us.length) {
      const f = this.us[0], m = Math.min(k - o, f.length);
      out.set(f.subarray(0, m), o); o += m; this.usLen -= m;
      if (m === f.length) this.us.shift(); else this.us[0] = f.subarray(m);
    }
    return out;
  }
  private add(b: Int8Array | Uint8Array) { if (b.length) this.pending.push(new Uint8Array(b.buffer, b.byteOffset, b.length).slice()); }
  private flush() {
    if (!this.pending.length) return;
    const all = Buffer.concat(this.pending);
    this.pending = [];
    appendFileSync(this.path, all);
    this.bytes += all.length;
  }
}

function mix(a: Int16Array, b: Int16Array) {
  const out = new Int16Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.max(-32768, Math.min(32767, a[i] + (b[i] ?? 0)));
  return out;
}

/** The hearth-call command and its how-to. */
export function callSkill(hubUrl: string, key: string) {
  const script = `#!/usr/bin/env bash
# hearth-call <command> …: phone calls. A voice bot talks; you supervise. Prints JSON.
set -uo pipefail
cmd="\${1:-}"; shift 2>/dev/null || true
job=(); if [ -n "\${HEARTH_JOB:-}" ]; then job=(-H "X-Hearth-Job: \${HEARTH_JOB}"); fi
post() { curl -sS -m 70 -H "X-Hearth-Agent: ${key}" "\${job[@]}" "$@" "${hubUrl}/api/agent/call"; }
case "$cmd" in
  start)
    to="\${1:-}"; shift 2>/dev/null || true
    extra=(); brief=()
    while [ $# -gt 0 ]; do case "$1" in --voice) extra+=(--data-urlencode "voice=\${2:-}"); shift 2 ;; --language) extra+=(--data-urlencode "language=\${2:-}"); shift 2 ;; *) brief+=("$1"); shift ;; esac; done
    post --data-urlencode action=start --data-urlencode "to=$to" --data-urlencode "brief=\${brief[*]:-}" "\${extra[@]}" ;;
  wait|status|hangup) post --data-urlencode "action=$cmd" --data-urlencode "id=\${1:-}" ;;
  answer|say) id="\${1:-}"; shift 2>/dev/null || true; post --data-urlencode "action=$cmd" --data-urlencode "id=$id" --data-urlencode "text=$*" ;;
  *) echo '{"error":"usage: hearth-call start +15551234567 \\"brief\\" [--voice NAME] [--language LANG] | wait ID | answer ID TEXT | say ID TEXT | hangup ID | status ID"}' >&2; exit 1 ;;
esac
`;
  return {
    name: "hearth-call", common: true, commands: ["hearth-call"], reads: [], scripts: { "hearth-call": script },
    description: "Phone calls: a voice bot calls a number and talks for the owner (book, ask, confirm, reschedule); you supervise it live and answer its questions.",
    body: `# Phone calls

\`hearth-call start <+number> "<brief>"\` places a call from Hearth's line. A voice bot does the talking; **you supervise**. The owner approves each call first, and can listen in or join from the thread.

## Before you call: settle your own side
Look things up first so the bot can be specific: the exact place (name and address, via search or maps), the time, the owner's calendar, anything they're likely to ask. "The Starbucks near Redwood Shores" isn't a place: find which one and give its address. Never send the bot to ask *them* what the owner meant.

## The brief is all the bot knows
Write it like notes for a person making the call: who you're calling and why, the goal, **exactly what to come back with** (e.g. "yes or no, and if yes a time and a place"), what's fine to agree to or suggest (times, places, prices, limits; check the owner's calendar first), names and details it may give, and what to do on voicemail. Anything it shouldn't decide alone, say so. Think about what they'll obviously ask (where? which day?) and give the bot an answer or a suggestion for it (from memory and the calendar), instead of "don't invent one": a bot that can only say "that isn't decided" wastes the call. Never put card numbers or passwords in a brief unless the owner gave them for this call. On the free plan a call is cut off after 2 minutes (the bot is warned 20 s before), so keep each call to one clear goal.

## Running a call
1. \`hearth-call start +14155550199 "<brief>"\` (number with its country code; \`--voice NAME\` / \`--language LANG\` only if the owner asked). It waits for the owner's Approve: say so in your reply and stop. When they approve you get a turn with the call id.
2. Then supervise in a loop: \`hearth-call wait <id>\`. Each wait returns what was said since the last one, and returns at once when the bot asks something.
3. A \`question\`: if it's something you can look up (an address, opening hours, a date), look it up and answer with the actual answer; never "the owner isn't sure". Answer fast with \`hearth-call answer <id> "<answer>"\` (the bot is waiting on the line: ~5 s it says it's checking, ~10 s it promises to get back to them and wraps up). Answer from the brief, memory and what you can look up in a second or two. Never invent. If you don't know, don't answer: the owner is asked too and may answer from the thread.
4. Steer when needed: \`hearth-call say <id> "<private note to the bot>"\` (never spoken as is). \`hearth-call hangup <id>\` to end it.
5. Their side of the transcript comes from the voice model's own hearing and phone audio can garble it (a "Do you know where it is?" once showed as "¿Qué? ¿No vales?"); the bot heard the audio itself, so don't steer off a word that makes no sense. Steer early. Your notes reach the bot a few seconds late, so as soon as you see a gap (no time agreed, a name to spell), say it then, not after the goodbye.
6. When \`ended\` comes back, **the call was a means, not the end: act on what it got.** Report it in a line or two (the transcript and recording are already in the thread), then do the next step the owner would want:
   - it's settled: do the follow-through (put it on the calendar, book it, tell whoever else needs to know), through the usual tools and their Approve;
   - something's still open (no time, they asked the owner to decide, \`endedBy: "limit"\`, a \`followUp\` question): suggest the concrete answer yourself when you can ("Kumla's at 1pm? Your calendar's free"), and ask the owner to confirm in one line ending with [[answer-needed]]. When they answer, call back once to settle it.
   Never end on just "no time was agreed".

Don't call anyone the owner didn't ask you to, don't call the same number again and again, and never more than one call at a time.`,
  };
}
