import { randomBytes, createHash, timingSafeEqual, randomUUID } from "node:crypto";
import type { Store } from "./store/index.ts";
import type { Device, PairingCode } from "./types.ts";

// Pairing: the hub prints a one-time code; a phone trades it for a device token.
// Only the SHA-256 of a token is stored, so a copied database can't log anyone in.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const CODE_TTL_MS = 10 * 60 * 1000;

export const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");

function safeEqualHex(a: string, b: string) {
  const x = Buffer.from(a, "hex"), y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function newPairingCode(store: Store) {
  let code = "";
  for (const b of randomBytes(8)) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  const now = Date.now();
  for (const p of await store.all<PairingCode>("pairing")) if (p.expiresAt < now) await store.remove("pairing", p.id);
  await store.put<PairingCode>("pairing", {
    id: randomUUID(), createdAt: new Date().toISOString(), codeHash: sha256(code), expiresAt: now + CODE_TTL_MS,
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
  const token = randomBytes(32).toString("base64url");
  const now2 = new Date().toISOString();
  const device = await store.put<Device>("devices", {
    id: randomUUID(), createdAt: now2, lastSeenAt: now2,
    name: String(deviceName || "Phone").slice(0, 60), tokenHash: sha256(token),
  });
  return { token, device };
}

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
}
