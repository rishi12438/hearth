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

export class ApiError extends Error { constructor(public status: number, msg: string, public data: any = null) { super(msg); } }

// Face ID unlock: a session the hub hands out after a passkey check. Kept for this app session only,
// so closing the app means Face ID again next time.
const unlockKey = (hub: HubRef) => `hearth.unlock.${hub.id}`;
const unlockFor = (hub: HubRef) => sessionStorage.getItem(unlockKey(hub)) || "";
const setUnlock = (hub: HubRef, t: string) => sessionStorage.setItem(unlockKey(hub), t);
export const authHeaders = (hub: HubRef): Record<string, string> => ({ Authorization: `Bearer ${hub.token}`, ...(unlockFor(hub) ? { "X-Hearth-Unlock": unlockFor(hub) } : {}) });

const b64u = (b: ArrayBuffer | null) => b ? btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : "";
const fromB64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export const passkeysWork = () => !!window.PublicKeyCredential && activeHub()?.url === location.origin;

/** Turn on Face ID lock for this device. The private key never leaves the phone. */
export async function registerPasskey() {
  const hub = activeHub()!;
  const o = await call("/api/passkey/options", { body: {} });
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: fromB64u(o.challenge), rp: o.rp, user: { id: fromB64u(o.user.id), name: o.user.name, displayName: o.user.name },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -8 }, { type: "public-key", alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "preferred" },
    attestation: "none", timeout: 60_000,
  } }) as PublicKeyCredential | null;
  const r = cred?.response as AuthenticatorAttestationResponse | undefined;
  if (!cred || !r?.getPublicKey?.()) throw new Error("This browser can't make a passkey here.");
  const out = await call("/api/passkey/register", { body: { credId: b64u(cred.rawId), spki: b64u(r.getPublicKey()), alg: r.getPublicKeyAlgorithm(), clientDataJSON: b64u(r.clientDataJSON) } });
  setUnlock(hub, out.unlock);
}

/** A fresh Face ID signature over a hub challenge: used to unlock, and to confirm letting a device in. */
export async function passkeyProof() {
  const o = await call("/api/unlock/options", { body: {} });
  const cred = await navigator.credentials.get({ publicKey: {
    challenge: fromB64u(o.challenge), rpId: o.rpId, allowCredentials: [{ type: "public-key", id: fromB64u(o.credId) }], userVerification: "required", timeout: 60_000,
  } }) as PublicKeyCredential | null;
  const r = cred?.response as AuthenticatorAssertionResponse | undefined;
  if (!cred || !r) throw new Error("Face ID was cancelled.");
  return { credId: b64u(cred.rawId), authenticatorData: b64u(r.authenticatorData), clientDataJSON: b64u(r.clientDataJSON), signature: b64u(r.signature) };
}

export async function unlock() {
  const out = await call("/api/unlock/verify", { body: await passkeyProof() });
  setUnlock(activeHub()!, out.unlock);
}

/** A new device asks the hub to join. Returns the code to compare with the one on your primary phone. */
export async function requestAccess(url: string, deviceName: string) {
  const origin = normalizeUrl(url);
  const res = await fetch(origin + "/api/access/request", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deviceName }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return { origin, poll: data.poll as string, code: data.code as string };
}

/** Wait for the primary phone to approve. Resolves with the new hub entry, or throws if denied or expired. */
export async function waitForApproval(origin: string, poll: string, signal: AbortSignal): Promise<HubRef> {
  while (!signal.aborted) {
    await new Promise((r) => setTimeout(r, 2500));
    const res = await fetch(origin + "/api/access/poll", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ poll }), signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "That request expired.");
    if (data.status === "denied") throw new Error("Your primary device said no.");
    if (data.status === "approved" && data.token) {
      const ref: HubRef = { id: data.deviceId, url: origin, name: data.hub?.name || "Hub", token: data.token };
      saveHubs([...hubs().filter((h) => h.url !== origin), ref]);
      setActive(ref.id);
      return ref;
    }
  }
  throw new Error("Stopped.");
}

export async function call<T = any>(path: string, opts: { method?: string; body?: unknown; hub?: HubRef } = {}): Promise<T> {
  const hub = opts.hub || activeHub();
  if (!hub) throw new ApiError(401, "Not paired.");
  const res = await fetch(hub.url + path, {
    method: opts.method || (opts.body ? "POST" : "GET"),
    headers: { ...authHeaders(hub), ...(opts.body ? { "Content-Type": "application/json" } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, data?.error || `Hub replied ${res.status}`, data);
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
        const res = await fetch(hub.url + "/api/stream", { headers: authHeaders(hub), signal: ctrl.signal, cache: "no-store" });
        if (res.status === 401) { onEvent({ type: "unpaired" }); return; }
        if (res.status === 423) { onEvent({ type: "locked" }); return; }
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
