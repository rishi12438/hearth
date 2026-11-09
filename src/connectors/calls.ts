import type { Connector } from "./types.ts";

// Voice calls: paste an OpenAI or Gemini key (the bot's voice and ears). Adding it also gets this hub its own key for
// Arca's phone line, once (calls.ts does the work). How it sounds is set in its sheet (/api/calls/settings).

export const calls: Connector = {
  def: { id: "calls", label: "Voice calls", kind: "key", how: "key", blurb: "Agents call people for you. You can listen in or join.", getFrom: "https://platform.openai.com/api-keys" },
  status: ({ hub }) => {
    const v = hub.calls?.view();
    if (!v?.connected) return { state: "off", detail: null };
    return { state: "connected", detail: `${v.provider === "openai" ? "OpenAI" : "Gemini"} ${v.hint}${v.number ? ` · ${v.number}` : ""}` };
  },
  async add({ hub }, { key }) {
    if (!hub.calls) return "Voice calls aren't available on this hub.";
    const bad = await hub.calls.connect(String(key || ""));
    if (bad) return bad;
    hub.brain.refreshSkills?.();
    return null;
  },
  async remove({ hub }) { hub.calls?.disconnect(); hub.brain.refreshSkills?.(); return null; },
};
