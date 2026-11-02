import type { Connector } from "./types.ts";
import { RISK } from "./types.ts";

// Sites read through your own login cookies (Instagram, LinkedIn): pasted, or brought from your Mac. Unofficial, so the
// owner accepts the ban risk once. connections.ts keeps the cookies in the vault; sources/ reads them.

export function cookieSite(id: string, label: string, blurb: string): Connector {
  return {
    def: { id, label, kind: "account", how: "cookies", blurb, risk: RISK(label) },
    status: ({ hub }) => {
      const row: any = hub.connections.status().find((x: any) => x.id === id);
      return { state: row?.problem ? "needs-you" : row?.connected ? "connected" : "off", detail: row?.problem ?? row?.detail ?? null };
    },
    async add({ hub }, { cookies }) {
      if (!cookies) return `Paste your ${label} cookies, or bring them from your Mac.`;
      return hub.connections.saveCookies(id, cookies).error ?? null;
    },
    async remove({ hub }) { hub.connections.remove(id); return null; },
  };
}

export const instagram = cookieSite("instagram", "Instagram", "Your DMs, through your own login.");
export const linkedin = cookieSite("linkedin", "LinkedIn", "Messages, invitations and notifications.");
