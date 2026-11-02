import type { Connector } from "./types.ts";

// Google (Gmail, Calendar) signs in with OAuth from the app; google.ts does the work. Its tile lives in the grid too.

export const google: Connector = {
  def: { id: "google", label: "Google", kind: "account", how: "oauth", blurb: "Gmail and Calendar." },
  status: ({ hub }) => { const g = hub.google.status(); return { state: g.connected ? "connected" : "off", detail: g.email ?? null }; },
  async add() { return "Connect Google from Settings → Connectors → Google (it signs in with Google)."; },
  async remove({ hub }) { await hub.google.disconnect(); return null; },
};
