// Speech-to-text behind one small interface. The key lives on the hub; the phone only uploads audio.
// Deepgram is the default. To add Whisper, Gemini or a local model, implement SpeechToText and add a case below.

export interface SpeechToText {
  readonly name: string;
  transcribe(audio: Uint8Array, mimeType: string): Promise<string>;
}

class Deepgram implements SpeechToText {
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
