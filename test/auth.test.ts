import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createStore, COLLECTIONS, type Store } from "../src/store/index.ts";
import {
  newPairingCode, redeemPairingCode, owners, isOwner, newChallenge, verifyPasskeyRegistration, verifyPasskeyAssertion,
  Sessions, AccessRequests, RateLimiter, addDevice,
} from "../src/auth.ts";
import type { Device } from "../src/types.ts";

const ORIGIN = "https://example.com";
let store: Store;

beforeEach(async () => {
  store = await createStore(process.env.TEST_DB || "sqlite::memory:", mkdtempSync(join(tmpdir(), "hearth-auth-")));
  for (const c of COLLECTIONS) await store.clear(c);
});
afterEach(async () => { await store.close(); });

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** A pretend authenticator: an ES256 key, signing the way a phone's secure chip does. */
function authenticator(rpId = "example.com") {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const credId = b64u("cred-1");
  const clientData = (type: string, challenge: string, origin = ORIGIN) => Buffer.from(JSON.stringify({ type, challenge, origin }));
  return {
    register: (challenge: string, origin = ORIGIN) => ({
      credId, alg: -7, spki: b64u(publicKey.export({ format: "der", type: "spki" }) as Buffer), clientDataJSON: b64u(clientData("webauthn.create", challenge, origin)),
    }),
    assert: (challenge: string, opts: { flags?: number; origin?: string; rp?: string } = {}) => {
      const auth = Buffer.concat([createHash("sha256").update(opts.rp || rpId).digest(), Buffer.from([opts.flags ?? 0x05]), Buffer.alloc(4)]);
      const cd = clientData("webauthn.get", challenge, opts.origin);
      const sig = sign("sha256", Buffer.concat([auth, createHash("sha256").update(cd).digest()]), privateKey);
      return { credId, authenticatorData: b64u(auth), clientDataJSON: b64u(cd), signature: b64u(sig) };
    },
  };
}

test("roles: the first device is primary; codes from the app make members; terminal codes make owners", async () => {
  const setup = await newPairingCode(store, "owner");
  const first = await redeemPairingCode(store, setup.code, "iPhone");
  expect(first!.device.role).toBe("owner");
  const member = await redeemPairingCode(store, (await newPairingCode(store)).code, "Laptop");
  expect(member!.device.role).toBe("member");
  expect(await isOwner(store, member!.device)).toBe(false);
  const recovered = await redeemPairingCode(store, (await newPairingCode(store, "owner")).code, "New phone");
  expect(recovered!.device.role).toBe("owner");
});

test("roles: hubs paired before roles existed treat the oldest device as primary", async () => {
  const now = Date.now();
  await store.put<Device>("devices", { id: "a", createdAt: new Date(now - 1000).toISOString(), lastSeenAt: "", name: "Old", tokenHash: "00" });
  await store.put<Device>("devices", { id: "b", createdAt: new Date(now).toISOString(), lastSeenAt: "", name: "New", tokenHash: "01" });
  expect((await owners(store)).map((d) => d.id)).toEqual(["a"]);
});

test("passkey: a real signature unlocks; replay, wrong origin, wrong site and no Face ID don't", async () => {
  const { device } = await addDevice(store, "iPhone", "owner");
  const a = authenticator();
  const pk = verifyPasskeyRegistration(a.register(newChallenge(device.id)), device.id, ORIGIN);
  expect(pk).not.toBeNull();
  const d = { ...device, passkey: pk! };

  const c1 = newChallenge(d.id);
  const proof = a.assert(c1);
  expect(verifyPasskeyAssertion(proof, d, ORIGIN)).toBe(true);
  expect(verifyPasskeyAssertion(proof, d, ORIGIN)).toBe(false); // challenge already used
  expect(verifyPasskeyAssertion(a.assert(newChallenge(d.id), { origin: "https://evil.example" }), d, ORIGIN)).toBe(false);
  expect(verifyPasskeyAssertion(a.assert(newChallenge(d.id), { rp: "evil.example" }), d, ORIGIN)).toBe(false);
  expect(verifyPasskeyAssertion(a.assert(newChallenge(d.id), { flags: 0x01 }), d, ORIGIN)).toBe(false); // present but not verified
  expect(verifyPasskeyAssertion(a.assert(newChallenge("someone-else")), d, ORIGIN)).toBe(false); // another device's challenge
  expect(verifyPasskeyAssertion(authenticator().assert(newChallenge(d.id)), d, ORIGIN)).toBe(false); // a different key
});

test("passkey: registration must answer this hub's challenge from this origin", async () => {
  const a = authenticator();
  expect(verifyPasskeyRegistration(a.register("made-up"), "dev", ORIGIN)).toBeNull();
  expect(verifyPasskeyRegistration(a.register(newChallenge("dev"), "https://evil.example"), "dev", ORIGIN)).toBeNull();
});

test("sessions: valid for their device only, and ended when the device is signed out", () => {
  const s = new Sessions(60_000);
  const t = s.create("phone");
  expect(s.valid(t, "phone")).toBe(true);
  expect(s.valid(t, "laptop")).toBe(false);
  expect(s.valid("nope", "phone")).toBe(false);
  s.endDevice("phone");
  expect(s.valid(t, "phone")).toBe(false);
});

test("access requests: pending until decided; the token is handed over once", () => {
  const ar = new AccessRequests();
  const { poll, request } = ar.create("MacBook", "1.2.3.4");
  expect(request.code).toMatch(/^[A-Z2-9]{4}$/);
  expect(ar.poll(poll)!.status).toBe("pending");
  expect(ar.poll("wrong")).toBeNull();
  const r = ar.find(request.id)!;
  r.status = "approved"; r.token = "secret"; r.deviceId = "d1";
  expect(ar.poll(poll)).toEqual({ status: "approved", token: "secret", deviceId: "d1" });
  expect(ar.poll(poll)).toBeNull();
  expect(ar.pending()).toHaveLength(0);
});

test("rate limiter: blocked() reports a ban without counting a hit", () => {
  const rl = new RateLimiter(2, 60_000);
  expect(rl.blocked("ip")).toBe(false);
  rl.allow("ip"); rl.allow("ip");
  expect(rl.blocked("ip")).toBe(false);
  rl.allow("ip");
  expect(rl.blocked("ip")).toBe(true);
});
