import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Vault, loadMasterKey } from "../src/vault.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "hearth-vault-"));
const SECRET = "e2b_live_9f8e7d6c5b4a39281706";

test("keys are encrypted at rest in their own SQLite file, readable only by the hub's user", () => {
  const dir = tmp(), key = randomBytes(32);
  const v = new Vault(dir, { masterKey: key });
  v.set("e2b", SECRET);
  v.set("ssh:abc", "-----BEGIN OPENSSH PRIVATE KEY-----\nxyz\n-----END OPENSSH PRIVATE KEY-----\n");
  expect(v.get("e2b")).toBe(SECRET);
  expect(v.names()).toEqual(["e2b", "ssh:abc"]); // the internal check row isn't listed
  v.close();

  const raw = readFileSync(join(dir, "keys/vault.db"));
  expect(raw.includes(SECRET)).toBe(false);
  expect(raw.includes("PRIVATE KEY")).toBe(false);
  expect(statSync(join(dir, "keys/vault.db")).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir, "keys")).mode & 0o777).toBe(0o700);
  expect(existsSync(join(dir, "keys/vault.db-wal"))).toBe(false);

  // Same master key: still there after a restart. Each write gets a fresh IV.
  const again = new Vault(dir, { masterKey: key });
  expect(again.get("e2b")).toBe(SECRET);
  again.set("e2b", SECRET);
  again.close();
  expect(readFileSync(join(dir, "keys/vault.db")).equals(raw)).toBe(false);
});

test("a copied data folder is useless without the master key", () => {
  const dir = tmp();
  new Vault(dir, { masterKey: randomBytes(32) }).set("e2b", SECRET);
  expect(() => new Vault(dir, { masterKey: randomBytes(32) })).toThrow("master key doesn't match");
});

test("a value moved to another name, or tampered with, doesn't decrypt", () => {
  const dir = tmp(), key = randomBytes(32);
  const v = new Vault(dir, { masterKey: key });
  v.set("e2b", SECRET);
  v.set("deepgram", "dg_key_123456789012345678");
  v.close();
  const db = new Database(join(dir, "keys/vault.db"));
  // Copy e2b's ciphertext onto deepgram's row: bound to its name, it won't open as deepgram.
  db.run("UPDATE secrets SET iv = (SELECT iv FROM secrets WHERE name='e2b'), tag = (SELECT tag FROM secrets WHERE name='e2b'), data = (SELECT data FROM secrets WHERE name='e2b') WHERE name='deepgram'");
  const row = db.query("SELECT data FROM secrets WHERE name='e2b'").get() as { data: Uint8Array };
  const flipped = Buffer.from(row.data); flipped[0] ^= 1;
  db.query("UPDATE secrets SET data = ? WHERE name='e2b'").run(flipped);
  db.close();
  const after = new Vault(dir, { masterKey: key });
  expect(after.get("deepgram")).toBeNull();
  expect(after.get("e2b")).toBeNull();
});

test("the master key file is made private on first use, kept outside the data folder, and refused if others can read it", () => {
  const home = tmp();
  const file = join(home, ".hearth/master.key");
  const env = { HEARTH_MASTER_KEY_FILE: file };
  const k = loadMasterKey(env);
  expect(k.length).toBe(32);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(loadMasterKey(env).equals(k)).toBe(true); // same key next time
  chmodSync(file, 0o644);
  expect(() => loadMasterKey(env)).toThrow("can be read by others");
  expect(() => loadMasterKey({ HEARTH_MASTER_KEY: "too-short" })).toThrow("32 bytes");
  expect(loadMasterKey({ HEARTH_MASTER_KEY: randomBytes(32).toString("hex") }).length).toBe(32);
});

test("keys saved the old way in plain files move into the vault, and the plain files are deleted", () => {
  const dir = tmp();
  mkdirSync(join(dir, "keys"), { recursive: true });
  const id = "6f1c2a8e-1b2c-4d5e-8f90-123456789abc";
  writeFileSync(join(dir, "voice.json"), JSON.stringify({ deepgramKey: "dg_key_123456789012345678" }));
  writeFileSync(join(dir, "keys/secrets.json"), JSON.stringify({ e2bKey: SECRET }));
  writeFileSync(join(dir, "keys", `ssh-${id}`), "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n");
  const v = new Vault(dir, { masterKey: randomBytes(32) });
  expect(v.migrate(dir).length).toBe(3);
  expect([v.get("deepgram"), v.get("e2b"), v.get(`ssh:${id}`)?.includes("PRIVATE KEY")]).toEqual(["dg_key_123456789012345678", SECRET, true]);
  for (const f of ["voice.json", "keys/secrets.json", `keys/ssh-${id}`]) expect(existsSync(join(dir, f))).toBe(false);
  expect(v.migrate(dir)).toEqual([]); // nothing left to move
});
