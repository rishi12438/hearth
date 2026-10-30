import { resolve } from "node:path";
import { SqlStore } from "./sql.ts";
import { MongoStore } from "./mongo.ts";
import type { Store } from "./types.ts";

export * from "./types.ts";

/**
 * Pick a backend from HEARTH_DB_URL:
 *   sqlite:./data/hearth.db      (default; one file you own)
 *   sqlite::memory:              (tests)
 *   postgres://user:pass@host/db (your own Postgres, Supabase, Neon, RDS…)
 *   mysql://user:pass@host/db
 *   mongodb://host/db            (needs `bun add mongodb`)
 * To add a backend, implement `Store` in one file and add a branch here.
 */
export async function createStore(url: string | undefined, dataDir: string): Promise<Store> {
  const u = url || `sqlite:${resolve(dataDir, "hearth.db")}`;
  let store: Store;
  if (u.startsWith("sqlite:") || /^(postgres|postgresql|mysql):\/\//.test(u)) store = new SqlStore(u);
  else if (/^mongodb(\+srv)?:\/\//.test(u)) store = new MongoStore(u);
  else throw new Error(`Unsupported HEARTH_DB_URL scheme: ${u.split(":")[0]}`);
  await store.init();
  return store;
}

/** For logs: never print credentials. */
export function redactUrl(url: string | undefined) {
  if (!url) return "sqlite (default)";
  return url.replace(/\/\/[^@/]*@/, "//***@");
}
