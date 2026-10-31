import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// The hub's API keys and sign-ins (E2B, Deepgram, Google, your VMs' SSH keys) in their own SQLite file, <data>/keys/vault.db, each value
// encrypted at rest with AES-256-GCM. The master key lives outside the data folder (~/.hearth/master.key, or
// HEARTH_MASTER_KEY), so a copy or backup of the data folder alone doesn't give anyone your keys. Each value is bound to
// its name, so a row moved to another name won't decrypt. This is separate from the main store on purpose: secrets stay
// local and encrypted even when your data lives in Postgres or MySQL.

const ALG = "aes-256-gcm";
const CHECK = "__vault_check__";

/** Where the master key is: HEARTH_MASTER_KEY (base64 or hex, 32 bytes), else a 0600 file outside the data folder. */
export function masterKeyPath(env: Record<string, string | undefined> = process.env) {
  return env.HEARTH_MASTER_KEY_FILE || join(homedir(), ".hearth", "master.key");
}

function parseKey(raw: string): Buffer | null {
  const s = raw.trim();
  const b = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, "hex") : Buffer.from(s, "base64");
  return b.length === 32 ? b : null;
}

/** The master key, made on first use if there's none. Refuses a key file anyone but its owner can read. */
export function loadMasterKey(env: Record<string, string | undefined> = process.env): Buffer {
  if (env.HEARTH_MASTER_KEY) {
    const k = parseKey(env.HEARTH_MASTER_KEY);
    if (!k) throw new Error("HEARTH_MASTER_KEY must be 32 bytes, base64 or hex (make one with: openssl rand -base64 32).");
    return k;
  }
  const path = masterKeyPath(env);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, randomBytes(32).toString("base64") + "\n", { mode: 0o600, flag: "wx" });
  }
  if (statSync(path).mode & 0o077) throw new Error(`${path} can be read by others. Run: chmod 600 ${path}`);
  const k = parseKey(readFileSync(path, "utf8"));
  if (!k) throw new Error(`${path} isn't a valid master key.`);
  return k;
}

export class Vault {
  private db: Database;
  private key: Buffer;
  readonly path: string;

  constructor(dataDir: string, opts: { masterKey?: Buffer; env?: Record<string, string | undefined> } = {}) {
    const dir = join(dataDir, "keys");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.path = join(dir, "vault.db");
    this.key = opts.masterKey ?? loadMasterKey(opts.env);
    if (this.key.length !== 32) throw new Error("The master key must be 32 bytes.");
    const fresh = !existsSync(this.path);
    this.db = new Database(this.path, { create: true });
    chmodSync(this.path, 0o600);
    this.db.run("PRAGMA journal_mode = DELETE"); // no -wal/-shm side files with copies of pages
    this.db.run("CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, iv BLOB NOT NULL, tag BLOB NOT NULL, data BLOB NOT NULL, updated_at TEXT NOT NULL)");
    // A known value proves the master key is the one this vault was made with, instead of failing later, one key at a time.
    if (fresh || !this.row(CHECK)) this.write(CHECK, "ok");
    else if (this.read(CHECK) !== "ok") throw new Error("The master key doesn't match this vault. Restore the master key you had, or delete keys/vault.db and add your API keys again.");
  }

  private row(name: string) {
    return this.db.query("SELECT iv, tag, data FROM secrets WHERE name = ?").get(name) as { iv: Uint8Array; tag: Uint8Array; data: Uint8Array } | null;
  }
  private write(name: string, value: string) {
    const iv = randomBytes(12);
    const c = createCipheriv(ALG, this.key, iv);
    c.setAAD(Buffer.from(name));
    const data = Buffer.concat([c.update(value, "utf8"), c.final()]);
    this.db.query("INSERT INTO secrets (name, iv, tag, data, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET iv = excluded.iv, tag = excluded.tag, data = excluded.data, updated_at = excluded.updated_at")
      .run(name, iv, c.getAuthTag(), data, new Date().toISOString());
  }
  private read(name: string): string | null {
    const r = this.row(name);
    if (!r) return null;
    try {
      const d = createDecipheriv(ALG, this.key, Buffer.from(r.iv));
      d.setAAD(Buffer.from(name));
      d.setAuthTag(Buffer.from(r.tag));
      return Buffer.concat([d.update(Buffer.from(r.data)), d.final()]).toString("utf8");
    } catch { return null; } // tampered, moved, or a different master key
  }

  get(name: string) { return name === CHECK ? null : this.read(name); }
  has(name: string) { return name !== CHECK && !!this.row(name); }
  set(name: string, value: string) {
    if (name === CHECK || !name) throw new Error("Bad secret name.");
    this.write(name, value);
  }
  delete(name: string) { this.db.query("DELETE FROM secrets WHERE name = ?").run(name); }
  names() { return (this.db.query("SELECT name FROM secrets WHERE name != ? ORDER BY name").all(CHECK) as { name: string }[]).map((r) => r.name); }
  close() { this.db.close(); }

  /**
   * Keys that used to sit in plain files move in here, and the plain copies are deleted: the Deepgram key in voice.json,
   * the E2B key in keys/secrets.json, the Google sign-in in google.json, and each VM's keys/ssh-<id>.
   */
  migrate(dataDir: string) {
    const moved: string[] = [];
    const take = (path: string, fn: (text: string) => void) => {
      if (!existsSync(path)) return;
      try { fn(readFileSync(path, "utf8")); rmSync(path, { force: true }); moved.push(path); } catch {}
    };
    take(join(dataDir, "voice.json"), (t) => { const k = JSON.parse(t).deepgramKey; if (k) this.set("deepgram", k); });
    take(join(dataDir, "keys", "secrets.json"), (t) => { const k = JSON.parse(t).e2bKey; if (k) this.set("e2b", k); });
    take(join(dataDir, "google.json"), (t) => { JSON.parse(t); this.set("google", t); });
    const keys = join(dataDir, "keys");
    for (const f of existsSync(keys) ? readdirSync(keys) : []) {
      const m = /^ssh-([0-9a-f-]{36})$/.exec(f);
      if (m) take(join(keys, f), (t) => this.set(`ssh:${m[1]}`, t));
    }
    return moved;
  }
}
