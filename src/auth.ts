import { randomBytes, createHash, timingSafeEqual, randomUUID, createPublicKey, verify } from "node:crypto";
import type { Store } from "./store/index.ts";
import type { Device, PairingCode, Passkey } from "./types.ts";

// Pairing: the hub prints a one-time code; a phone trades it for a device token.
// Only the SHA-256 of a token is stored, so a copied database can't log anyone in.
// Like a router: the terminal only hands out codes for the primary device (first setup, or recovery over SSH).
// Every other device gets in through the primary one, by a code it shows or an access request it approves.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const CODE_TTL_MS = 10 * 60 * 1000;

export const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

function safeEqualHex(a: string, b: string) {
  const x = Buffer.from(a, "hex"), y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function newPairingCode(store: Store, role: "owner" | "member" = "member") {
  let code = "";
  for (const b of randomBytes(8)) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  const now = Date.now();
  for (const p of await store.all<PairingCode>("pairing")) if (p.expiresAt < now) await store.remove("pairing", p.id);
  await store.put<PairingCode>("pairing", {
    id: randomUUID(), createdAt: new Date().toISOString(), codeHash: sha256(code), expiresAt: now + CODE_TTL_MS, role,
  });
  return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresInMin: CODE_TTL_MS / 60000 };
}

export async function redeemPairingCode(store: Store, rawCode: unknown, deviceName: unknown) {
  const code = String(rawCode || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 8) return null;
  const hash = sha256(code);
  const now = Date.now();
  const entry = (await store.all<PairingCode>("pairing")).find((p) => p.expiresAt >= now && safeEqualHex(p.codeHash, hash));
  if (!entry) return null;
  await store.remove("pairing", entry.id); // one use only
  const first = (await store.all<Device>("devices")).length === 0;
  return addDevice(store, deviceName, first ? "owner" : entry.role || "member");
}

export async function addDevice(store: Store, deviceName: unknown, role: "owner" | "member") {
  const token = randomBytes(32).toString("base64url");
  const now = new Date().toISOString();
  const device = await store.put<Device>("devices", {
    id: randomUUID(), createdAt: now, lastSeenAt: now,
    name: String(deviceName || "Phone").slice(0, 60), tokenHash: sha256(token), role,
  });
  return { token, device };
}

/** The primary devices. Hubs paired before roles existed treat their oldest device as primary. */
export async function owners(store: Store) {
  const all = (await store.all<Device>("devices")).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const marked = all.filter((d) => d.role === "owner");
  return marked.length ? marked : all.slice(0, 1);
}

export const isOwner = async (store: Store, d: Device) => (await owners(store)).some((o) => o.id === d.id);

export async function deviceForToken(store: Store, header: string | null) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,})$/.exec(header || "");
  if (!m) return null;
  const hash = sha256(m[1]);
  return (await store.all<Device>("devices")).find((d) => safeEqualHex(d.tokenHash, hash)) || null;
}

/** Fixed-window limiter, per key. Used on pairing so codes can't be brute-forced. */
export class RateLimiter {
  private hits = new Map<string, { start: number; n: number }>();
  constructor(private max: number, private windowMs: number) {}
  allow(key: string) {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || now - h.start > this.windowMs) { this.hits.set(key, { start: now, n: 1 }); return true; }
    return ++h.n <= this.max;
  }
  /** Over the limit right now, without counting this as a hit. */
  blocked(key: string) {
    const h = this.hits.get(key);
    return !!h && Date.now() - h.start <= this.windowMs && h.n > this.max;
  }
}

// ---- Passkeys (Face ID, Touch ID, Windows Hello) ----
// The phone keeps the private key in its secure chip; the hub stores only the public key.
// We use attestation "none" and the browser's getPublicKey(), so there's no CBOR to parse: the hub checks
// the challenge, the origin, the site (rpId) hash, that you were verified (face or PIN), and the signature.

const b64u = (s: unknown) => Buffer.from(String(s || ""), "base64url");
const CHALLENGE_TTL_MS = 5 * 60_000;
const challenges = new Map<string, { deviceId: string; exp: number }>();

export function newChallenge(deviceId: string) {
  const c = randomBytes(32).toString("base64url");
  for (const [k, v] of challenges) if (v.exp < Date.now()) challenges.delete(k);
  challenges.set(c, { deviceId, exp: Date.now() + CHALLENGE_TTL_MS });
  return c;
}

function checkClientData(raw: Buffer, type: string, deviceId: string, origin: string) {
  let cd: any;
  try { cd = JSON.parse(raw.toString("utf8")); } catch { return false; }
  const ch = challenges.get(cd?.challenge);
  challenges.delete(cd?.challenge); // one use
  return cd?.type === type && !!ch && ch.exp >= Date.now() && ch.deviceId === deviceId && cd.origin === origin;
}

/** Registration: the browser sends the public key (SPKI) and the client data it signed off on. */
export function verifyPasskeyRegistration(b: any, deviceId: string, origin: string): Passkey | null {
  if (!checkClientData(b64u(b?.clientDataJSON), "webauthn.create", deviceId, origin)) return null;
  const alg = Number(b?.alg);
  if (![-7, -8, -257].includes(alg) || typeof b?.credId !== "string" || !b.credId) return null;
  try { createPublicKey({ key: b64u(b.spki), format: "der", type: "spki" }); } catch { return null; }
  return { credId: b.credId, spki: b.spki, alg };
}

/** Unlock: a fresh signature over this hub's challenge, from this device's passkey, with you verified. */
export function verifyPasskeyAssertion(b: any, device: Device, origin: string) {
  const pk = device.passkey;
  if (!pk || b?.credId !== pk.credId) return false;
  const clientData = b64u(b.clientDataJSON), auth = b64u(b.authenticatorData), sig = b64u(b.signature);
  if (auth.length < 37 || !checkClientData(clientData, "webauthn.get", device.id, origin)) return false;
  const rpIdHash = createHash("sha256").update(new URL(origin).hostname).digest();
  if (!timingSafeEqual(auth.subarray(0, 32), rpIdHash)) return false;
  const flags = auth[32];
  if (!(flags & 0x01) || !(flags & 0x04)) return false; // user present and user verified
  const signed = Buffer.concat([auth, createHash("sha256").update(clientData).digest()]);
  try {
    const key = createPublicKey({ key: b64u(pk.spki), format: "der", type: "spki" });
    return verify(pk.alg === -8 ? null : "sha256", signed, key, sig);
  } catch { return false; }
}

/** After a passkey unlock the device gets a session for a while, so it isn't asking for your face on every tap. */
export class Sessions {
  private s = new Map<string, { deviceId: string; exp: number }>();
  constructor(private ttlMs: number) {}
  create(deviceId: string) {
    const t = randomBytes(32).toString("base64url");
    this.s.set(sha256(t), { deviceId, exp: Date.now() + this.ttlMs });
    return t;
  }
  valid(token: string | null, deviceId: string) {
    if (!token) return false;
    const e = this.s.get(sha256(token));
    if (!e || e.exp < Date.now()) { if (e) this.s.delete(sha256(token)); return false; }
    return e.deviceId === deviceId;
  }
  endDevice(deviceId: string) { for (const [k, v] of this.s) if (v.deviceId === deviceId) this.s.delete(k); }
}

// ---- Access requests: a new device asks, the primary approves (like WPS on a router, but you check a code) ----
export type AccessRequest = { id: string; name: string; code: string; ip: string; createdAt: string; exp: number; status: "pending" | "approved" | "denied"; token?: string; deviceId?: string };
const REQUEST_TTL_MS = 10 * 60_000;

export class AccessRequests {
  private byPoll = new Map<string, AccessRequest>();
  create(name: unknown, ip: string) {
    this.sweep();
    let code = "";
    for (const b of randomBytes(4)) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
    const poll = randomBytes(32).toString("base64url");
    const r: AccessRequest = { id: randomUUID(), name: String(name || "New device").slice(0, 60), code, ip, createdAt: new Date().toISOString(), exp: Date.now() + REQUEST_TTL_MS, status: "pending" };
    this.byPoll.set(sha256(poll), r);
    return { poll, request: r };
  }
  pending() { this.sweep(); return [...this.byPoll.values()].filter((r) => r.status === "pending"); }
  find(id: string) { this.sweep(); return [...this.byPoll.values()].find((r) => r.id === id) || null; }
  /** The requester checks back with its secret. An approved token is handed over once, then forgotten. */
  poll(secret: unknown) {
    this.sweep();
    const key = sha256(String(secret || ""));
    const r = this.byPoll.get(key);
    if (!r) return null;
    if (r.status !== "pending") this.byPoll.delete(key);
    const out = { status: r.status, token: r.token, deviceId: r.deviceId };
    r.token = undefined;
    return out;
  }
  private sweep() { for (const [k, r] of this.byPoll) if (r.exp < Date.now()) this.byPoll.delete(k); }
}
