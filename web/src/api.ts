// The phone keeps a list of hubs it's paired with (your Lightsail box, your laptop…) and talks to
// each one directly with its own device token. There is no account and no server of ours in between.

export type HubRef = { id: string; url: string; name: string; token: string };

const HUBS_KEY = "hearth.hubs";
const ACTIVE_KEY = "hearth.active";

export function hubs(): HubRef[] {
  try { return JSON.parse(localStorage.getItem(HUBS_KEY) || "[]"); } catch { return []; }
}

export function saveHubs(list: HubRef[]) { localStorage.setItem(HUBS_KEY, JSON.stringify(list)); }

export function activeHub(): HubRef | null {
  const list = hubs();
  return list.find((h) => h.id === localStorage.getItem(ACTIVE_KEY)) || list[0] || null;
}

export function setActive(id: string) { localStorage.setItem(ACTIVE_KEY, id); }

export function removeHub(id: string) {
  saveHubs(hubs().filter((h) => h.id !== id));
  if (localStorage.getItem(ACTIVE_KEY) === id) localStorage.removeItem(ACTIVE_KEY);
}

export function normalizeUrl(raw: string) {
  const s = raw.trim().replace(/\/+$/, "");
  const url = new URL(/^https?:\/\//.test(s) ? s : `https://${s}`);
  const local = ["localhost", "127.0.0.1"].includes(url.hostname) || url.hostname.endsWith(".local");
  if (url.protocol !== "https:" && !local) throw new Error("Use https:// for hubs on the internet, so your token stays private.");
  return url.origin;
}

export class ApiError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export async function call<T = any>(path: string, opts: { method?: string; body?: unknown; hub?: HubRef } = {}): Promise<T> {
  const hub = opts.hub || activeHub();
  if (!hub) throw new ApiError(401, "Not paired.");
  const res = await fetch(hub.url + path, {
    method: opts.method || (opts.body ? "POST" : "GET"),
    headers: { Authorization: `Bearer ${hub.token}`, ...(opts.body ? { "Content-Type": "application/json" } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, data?.error || `Hub replied ${res.status}`);
  return data as T;
}

export async function pair(url: string, code: string, deviceName: string): Promise<HubRef> {
  const origin = normalizeUrl(url);
  const res = await fetch(origin + "/api/pair", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, deviceName, tz: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Pairing failed (${res.status})`);
  const ref: HubRef = { id: data.deviceId, url: origin, name: data.hub?.name || "Hub", token: data.token };
  saveHubs([...hubs().filter((h) => h.url !== origin), ref]);
  setActive(ref.id);
  return ref;
}

/** Live events over a streamed fetch (so the token rides in a header, never in a URL). */
export function stream(onEvent: (e: { type: string; data?: any }) => void, onState: (s: "live" | "connecting" | "offline") => void) {
  let stopped = false;
  let ctrl: AbortController | null = null;
  let failures = 0;

  async function loop() {
    while (!stopped) {
      const hub = activeHub();
      if (!hub) return;
      ctrl = new AbortController();
      onState("connecting");
      try {
        const res = await fetch(hub.url + "/api/stream", { headers: { Authorization: `Bearer ${hub.token}` }, signal: ctrl.signal, cache: "no-store" });
        if (res.status === 401) { onEvent({ type: "unpaired" }); return; }
        if (!res.ok || !res.body) throw new Error(String(res.status));
        onState("live");
        failures = 0;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            const line = chunk.split("\n").find((l) => l.startsWith("data: "));
            if (line) { try { onEvent(JSON.parse(line.slice(6))); } catch {} }
          }
        }
      } catch {
        if (stopped) return;
      }
      failures++;
      onState(failures > 2 ? "offline" : "connecting");
      await new Promise((r) => setTimeout(r, Math.min(15000, 1000 * 2 ** failures)));
    }
  }
  loop();
  return { stop() { stopped = true; ctrl?.abort(); }, restart() { ctrl?.abort(); failures = 0; } };
}
