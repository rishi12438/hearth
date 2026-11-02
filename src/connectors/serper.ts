import type { Connector } from "./types.ts";
import { hint } from "./types.ts";

// Serper: Google search for teammates, with your own key. Scripts that say `// needs: serper` get it as SERPER_API_KEY
// (see scripts/web-search.ts); nothing else does.

/** Is this a working Serper key? One tiny search (Serper has no free "who am I"). */
export async function checkSerperKey(key: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  if (!/^[A-Za-z0-9]{20,80}$/.test(key)) return "That doesn't look like a Serper API key.";
  try {
    const r = await fetcher("https://google.serper.dev/search?q=hearth&num=1", { headers: { "X-API-KEY": key }, signal: AbortSignal.timeout(10_000) });
    if (r.status === 401 || r.status === 403) return "Serper didn't accept that key.";
    if (r.status === 400) { const t = await r.text().catch(() => ""); return /credit/i.test(t) ? "That Serper key is out of credits." : "Serper didn't accept that key."; }
    if (!r.ok) return `Serper answered ${r.status}. Try again in a minute.`;
    return null;
  } catch { return "Couldn't reach Serper."; }
}

export const serperKey = (vault: { get(n: string): string | null } | null) => vault?.get("serper") ?? process.env.HEARTH_SERPER_API_KEY ?? null;

export const serper: Connector = {
  def: { id: "serper", label: "Serper", kind: "key", how: "key", blurb: "Google search for teammates.", getFrom: "https://serper.dev/api-key" },
  status: ({ vault }) => { const k = serperKey(vault); return { state: k ? "connected" : "off", detail: hint(k) }; },
  async add({ vault }, { key }) {
    if (!vault) return "This hub has no key vault.";
    const k = String(key || "").trim();
    const bad = await checkSerperKey(k);
    if (bad) return bad;
    vault.set("serper", k);
    return null;
  },
  async remove({ vault }) { vault?.delete("serper"); return null; },
};
