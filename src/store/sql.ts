import { SQL } from "bun";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { COLLECTIONS, type Collection, type Doc, type Store } from "./types.ts";

// One adapter for SQLite, Postgres and MySQL via Bun's built-in SQL client.
// Each collection is a table of (id, created_at, body JSON): portable and easy to inspect.
export class SqlStore implements Store {
  readonly kind: string;
  private db: SQL;

  constructor(url: string) {
    if (url.startsWith("sqlite:")) {
      const file = url.replace(/^sqlite:(\/\/)?/, "");
      if (file !== ":memory:") {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        try { chmodSync(dirname(file), 0o700); } catch {}
      }
      this.db = new SQL(`sqlite://${file}`);
      this.kind = "sqlite";
    } else {
      this.db = new SQL(url);
      this.kind = url.startsWith("mysql") ? "mysql" : "postgres";
    }
  }

  private static name(col: Collection) { return `hearth_${col.toLowerCase()}`; } // lowercase: Postgres folds unquoted names
  private table(col: Collection) { return this.db(SqlStore.name(col)); }

  async init() {
    const idType = this.kind === "mysql" ? "VARCHAR(64)" : "TEXT";
    const tsType = this.kind === "mysql" ? "VARCHAR(40)" : "TEXT";
    const bodyType = this.kind === "mysql" ? "LONGTEXT" : "TEXT";
    for (const col of COLLECTIONS) {
      await this.db.unsafe(
        `CREATE TABLE IF NOT EXISTS ${SqlStore.name(col)} (id ${idType} PRIMARY KEY, created_at ${tsType} NOT NULL, body ${bodyType} NOT NULL)`,
      );
      if (this.kind !== "mysql") {
        await this.db.unsafe(`CREATE INDEX IF NOT EXISTS ${SqlStore.name(col)}_created ON ${SqlStore.name(col)} (created_at)`);
      }
    }
    if (this.kind === "sqlite") await this.db.unsafe("PRAGMA journal_mode = WAL");
  }

  private parse<T>(rows: { body: string }[]): T[] {
    return rows.map((r) => JSON.parse(r.body) as T);
  }

  async all<T extends Doc>(col: Collection) {
    return this.parse<T>(await this.db`SELECT body FROM ${this.table(col)} ORDER BY created_at`);
  }

  async recent<T extends Doc>(col: Collection, limit: number, before?: string) {
    const rows = before
      ? await this.db`SELECT body FROM ${this.table(col)} WHERE created_at < ${before} ORDER BY created_at DESC LIMIT ${limit}`
      : await this.db`SELECT body FROM ${this.table(col)} ORDER BY created_at DESC LIMIT ${limit}`;
    return this.parse<T>(rows).reverse();
  }

  async get<T extends Doc>(col: Collection, id: string) {
    const rows = await this.db`SELECT body FROM ${this.table(col)} WHERE id = ${id}`;
    return rows.length ? (JSON.parse(rows[0].body) as T) : null;
  }

  async put<T extends Doc>(col: Collection, doc: T) {
    // One atomic upsert statement: safe under concurrent writes, no transaction needed.
    const body = JSON.stringify(doc);
    const t = SqlStore.name(col);
    if (this.kind === "mysql") {
      await this.db.unsafe(`INSERT INTO ${t} (id, created_at, body) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE created_at = VALUES(created_at), body = VALUES(body)`, [doc.id, doc.createdAt, body]);
    } else {
      await this.db.unsafe(`INSERT INTO ${t} (id, created_at, body) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET created_at = excluded.created_at, body = excluded.body`, [doc.id, doc.createdAt, body]);
    }
    return doc;
  }

  async remove(col: Collection, id: string) {
    const existed = await this.get(col, id);
    await this.db`DELETE FROM ${this.table(col)} WHERE id = ${id}`;
    return !!existed;
  }

  async clear(col: Collection) {
    await this.db`DELETE FROM ${this.table(col)}`;
  }

  async close() { await this.db.close(); }
}
