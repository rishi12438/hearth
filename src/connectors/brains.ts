import type { Connector } from "./types.ts";
import { BRAIN_LABELS, detectBrains, saveClaudeToken, saveCodexAuth, type BrainId } from "../brains/logins.ts";
import { availableHarnesses } from "../brain.ts";

// Claude Code and Codex as tiles: picked or not, signed in on the hub or not, and each one's live plan usage.
// Adding one picks it (and takes a long-lived login copied up from your Mac, if one comes with it).

/** A long-lived login copied up to this hub: a Claude setup-token, or Codex's auth.json. Returns an error or null. */
export function takeLogin(id: BrainId, input: { token?: string; auth?: unknown }): string | null {
  try {
    if (id === "claude") { if (input.token) saveClaudeToken(String(input.token)); }
    else if (input.auth) saveCodexAuth(typeof input.auth === "string" ? input.auth : JSON.stringify(input.auth));
    return null;
  } catch (e: any) { return e.message; }
}

function brain(id: BrainId, blurb: string): Connector {
  return {
    def: { id, label: BRAIN_LABELS[id], kind: "brain", how: "login", blurb },
    async status({ hub }) {
      const d = detectBrains().find((x) => x.id === id)!;
      const pool = await hub.brainPool();
      const on = pool.includes(id) && availableHarnesses(hub.config).includes(id);
      if (on) await hub.brain.usage.refresh(id).catch(() => {}); // cached for a few minutes; a fresh read only when stale
      return {
        state: !d.installed ? "not-installed" : !d.loggedIn ? "needs-you" : on ? "connected" : "off",
        detail: !d.installed ? "Not installed on the hub" : !d.loggedIn ? "Not signed in on the hub" : on ? (d.how ?? "Signed in") : "Signed in, not picked",
        usage: hub.brain.usage.view([id])[0] ?? null,
      };
    },
    async add({ hub }, input) {
      const bad = takeLogin(id, input);
      if (bad) return bad;
      const pool = await hub.brainPool();
      if (pool.includes(id)) return null;
      const r = await hub.setBrainPool([...pool.filter((h) => availableHarnesses(hub.config).includes(h)), id]);
      return r.error ?? null;
    },
    async remove({ hub }) {
      const pool = (await hub.brainPool()).filter((h) => h !== id);
      if (!pool.length) return "That's your only brain. Pick another one first.";
      return (await hub.setBrainPool(pool)).error ?? null;
    },
  };
}

export const claude = brain("claude", "Your Claude subscription thinks for the team.");
export const codex = brain("codex", "Your ChatGPT subscription thinks for the team.");
