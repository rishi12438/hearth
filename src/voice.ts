// Speech-to-text behind one small interface. The key lives on the hub; the phone only uploads audio.
// Deepgram is the default. To add Whisper, Gemini or a local model, implement SpeechToText and add a case below.

export interface SpeechToText {
  readonly name: string;
  transcribe(audio: Uint8Array, mimeType: string): Promise<string>;
}

import { Vault } from "./vault.ts";

export class Deepgram implements SpeechToText {
  readonly name = "deepgram";
  constructor(private key: string, private model = "nova-3") {}

  async transcribe(audio: Uint8Array, mimeType: string) {
    const url = `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(this.model)}&smart_format=true&punctuate=true&detect_language=true`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Token ${this.key}`, "Content-Type": mimeType || "application/octet-stream" },
      body: audio as unknown as BodyInit,
    });
    if (!res.ok) throw new Error(`Deepgram replied ${res.status}`);
    const data: any = await res.json();
    return String(data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "").trim();
  }
}

/** Is this a working Deepgram key? Asks Deepgram (lists your projects) without spending anything. */
export async function checkDeepgramKey(key: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_\-.]{20,100}$/.test(key)) return "That doesn't look like a Deepgram API key.";
  try {
    const res = await fetch("https://api.deepgram.com/v1/projects", { headers: { Authorization: `Token ${key}` }, signal: AbortSignal.timeout(10_000) });
    if (res.status === 401 || res.status === 403) return "Deepgram didn't accept that key.";
    if (!res.ok) return `Deepgram replied ${res.status}. Try again in a minute.`;
    return null;
  } catch { return "Couldn't reach Deepgram from the hub."; }
}

/**
 * Voice settings the app can change: the Deepgram key lives in the hub's encrypted vault (vault.ts), never in the
 * database, exports or API responses. A key in the environment wins and can't be changed from the app.
 */
export class VoiceSettings {
  private vault: Vault;
  current: SpeechToText | null;
  constructor(dataDir: string, private env: Record<string, string | undefined> = process.env, vault?: Vault) {
    this.vault = vault ?? new Vault(dataDir);
    this.vault.migrate(dataDir);
    this.current = createSpeechToText(env) || this.fromFile();
  }
  get fromEnv() { return !!this.env.HEARTH_DEEPGRAM_API_KEY; }
  private saved(): { deepgramKey?: string } { const k = this.vault.get("deepgram"); return k ? { deepgramKey: k } : {}; }
  private fromFile() { const k = this.saved().deepgramKey; return k ? new Deepgram(k, this.env.HEARTH_DEEPGRAM_MODEL || "nova-3") : null; }
  /** What the app may see: provider, where the key came from, and its last 4 characters. */
  status() {
    const key = this.env.HEARTH_DEEPGRAM_API_KEY || this.saved().deepgramKey;
    return { provider: this.current?.name || null, source: this.fromEnv ? "env" : key ? "app" : null, hint: key ? `••••${key.slice(-4)}` : null };
  }
  async connect(key: string) {
    if (this.fromEnv) return { error: "This hub's voice key is set in its .env, so it can't be changed from the app." };
    const clean = key.trim();
    const bad = await checkDeepgramKey(clean);
    if (bad) return { error: bad };
    this.vault.set("deepgram", clean);
    this.current = this.fromFile();
    return { value: this.status() };
  }
  /** The Deepgram key, for the hub's own live relay (never sent to the app). */
  deepgramKey() { return this.current?.name === "deepgram" ? this.env.HEARTH_DEEPGRAM_API_KEY || this.saved().deepgramKey || null : null; }

  disconnect() {
    if (this.fromEnv) return { error: "This hub's voice key is set in its .env." };
    this.vault.delete("deepgram");
    this.current = null;
    return { value: this.status() };
  }
}

/** HEARTH_STT=deepgram (default when HEARTH_DEEPGRAM_API_KEY is set) | off */
export function createSpeechToText(env: Record<string, string | undefined> = process.env): SpeechToText | null {
  const provider = env.HEARTH_STT || (env.HEARTH_DEEPGRAM_API_KEY ? "deepgram" : "off");
  switch (provider) {
    case "deepgram":
      if (!env.HEARTH_DEEPGRAM_API_KEY) throw new Error("HEARTH_STT=deepgram needs HEARTH_DEEPGRAM_API_KEY");
      return new Deepgram(env.HEARTH_DEEPGRAM_API_KEY, env.HEARTH_DEEPGRAM_MODEL || "nova-3");
    case "off": return null;
    default: throw new Error(`Unknown HEARTH_STT provider: ${provider}`);
  }
}

/**
 * Live dictation: the app streams 16-bit mono PCM to the hub over a WebSocket; the hub relays it to Deepgram's streaming
 * API (the key stays on the hub) and sends words back as they're heard: {t:"partial"|"final", text} then {t:"end"}.
 */
export type LiveClient = { send(data: string): void; close(): void };
export function deepgramLive(key: string, sampleRate: number, client: LiveClient) {
  const base = process.env.HEARTH_DEEPGRAM_LIVE_URL || "wss://api.deepgram.com/v1/listen";
  const qs = new URLSearchParams({ model: process.env.HEARTH_DEEPGRAM_MODEL || "nova-3", encoding: "linear16", sample_rate: String(sampleRate),
    channels: "1", smart_format: "true", punctuate: "true", interim_results: "true", endpointing: "400" });
  const dg = new WebSocket(`${base}?${qs}`, { headers: { Authorization: `Token ${key}` } } as any);
  dg.binaryType = "arraybuffer";
  const waiting: (ArrayBuffer | Uint8Array | string)[] = [];
  let bytes = 0, ended = false;
  const end = () => { if (ended) return; ended = true; try { client.send(JSON.stringify({ t: "end" })); } catch {} client.close(); };
  const keepAlive = setInterval(() => { if (dg.readyState === WebSocket.OPEN) dg.send(JSON.stringify({ type: "KeepAlive" })); }, 8000);
  const limit = setTimeout(() => stop(), 15 * 60_000); // a ramble, not a podcast
  dg.onopen = () => { for (const w of waiting.splice(0)) dg.send(w); };
  dg.onmessage = (e) => {
    try {
      const m = JSON.parse(String(e.data));
      if (m.type !== "Results") return;
      const text = String(m.channel?.alternatives?.[0]?.transcript || "");
      if (text || m.is_final) client.send(JSON.stringify({ t: m.is_final ? "final" : "partial", text }));
    } catch {}
  };
  dg.onerror = () => { try { client.send(JSON.stringify({ t: "error", text: "Couldn't reach Deepgram for live text." })); } catch {} };
  dg.onclose = () => { clearInterval(keepAlive); clearTimeout(limit); end(); };
  const push = (d: ArrayBuffer | Uint8Array | string) => (dg.readyState === WebSocket.OPEN ? dg.send(d) : dg.readyState === WebSocket.CONNECTING ? waiting.push(d) : undefined);
  function audio(chunk: ArrayBuffer | Uint8Array) {
    bytes += chunk.byteLength;
    if (bytes > 120 * 1024 * 1024) return stop();
    push(chunk);
  }
  /** Finish: Deepgram flushes the last words, then closes. */
  function stop() { push(JSON.stringify({ type: "CloseStream" })); setTimeout(() => { try { dg.close(); } catch {} end(); }, 4000); }
  function abort() { clearInterval(keepAlive); clearTimeout(limit); ended = true; try { dg.close(); } catch {} }
  return { audio, stop, abort };
}
