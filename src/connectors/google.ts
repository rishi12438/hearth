import type { Connector } from "./types.ts";

// Google (Gmail, Calendar, Drive) signs in with OAuth from the app; google.ts does the work. Its tile lives in the grid too.

export const google: Connector = {
  def: { id: "google", label: "Google", kind: "account", how: "oauth", blurb: "Gmail, Calendar and Drive." },
  // "me@x.com · Gmail, Calendar, Drive": what it can reach, so a sign-in from before Drive shows what's missing.
  status: ({ hub }) => {
    const g = hub.google.status();
    if (!g.connected) return { state: "off", detail: null };
    const who = g.accounts.length > 1 ? `${g.accounts.length} accounts` : g.accounts[0].email;
    const noDrive = g.accounts.filter((a) => !a.canDrive).length;
    return { state: "connected", detail: `${who} · Gmail, Calendar${noDrive < g.accounts.length ? ", Drive" : ""}${noDrive ? ` · reconnect ${noDrive > 1 ? `${noDrive} accounts` : g.accounts.length > 1 ? g.accounts.find((a) => !a.canDrive)!.email : "it"} for Drive` : ""}` };
  },
  async add() { return "Connect Google from Settings → Connectors → Google (it signs in with Google)."; },
  async remove({ hub }) { await hub.google.disconnect(); return null; }, // every account; the sheet removes one at a time
};
