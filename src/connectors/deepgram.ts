import type { Connector } from "./types.ts";

// Deepgram: speech-to-text, so you can talk instead of type. The key lives in the vault (voice.ts does the work).

export const deepgram: Connector = {
  def: { id: "deepgram", label: "Deepgram", kind: "key", how: "key", blurb: "Talk instead of type.", getFrom: "https://console.deepgram.com/" },
  status: ({ voice }) => { const s = voice?.status(); return { state: s?.provider ? "connected" : "off", detail: s?.hint ?? null }; },
  async add({ voice, hub }, { key }) {
    if (!voice) return "Voice isn't available on this hub.";
    const r = await voice.connect(String(key || ""));
    if (r.error) return r.error;
    hub.emit("voice");
    return null;
  },
  async remove({ voice, hub }) {
    const r = voice?.disconnect();
    if (r?.error) return r.error;
    hub.emit("voice");
    return null;
  },
};
