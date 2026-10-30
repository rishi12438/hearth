import type { Collection, Doc, Store } from "./types.ts";

// MongoDB adapter. The driver is optional: `bun add mongodb` to use it.
export class MongoStore implements Store {
  readonly kind = "mongodb";
  private client: any;
  private db: any;

  constructor(private url: string) {}

  async init() {
    let mod: any;
    try { mod = await import(/* optional */ "mongodb" as string); }
    catch { throw new Error("HEARTH_DB_URL is a mongodb:// URL but the driver isn't installed. Run: bun add mongodb"); }
    this.client = new mod.MongoClient(this.url);
    await this.client.connect();
    this.db = this.client.db(); // database name comes from the URL path
  }

  private c(col: Collection) { return this.db.collection(`hearth_${col}`); }
  private strip<T>(d: any): T { if (d) delete d._id; return d as T; }

  async all<T extends Doc>(col: Collection) {
    return (await this.c(col).find().sort({ createdAt: 1 }).toArray()).map((d: any) => this.strip<T>(d));
  }

  async recent<T extends Doc>(col: Collection, limit: number, before?: string) {
    const q = before ? { createdAt: { $lt: before } } : {};
    const rows = await this.c(col).find(q).sort({ createdAt: -1 }).limit(limit).toArray();
    return rows.map((d: any) => this.strip<T>(d)).reverse();
  }

  async get<T extends Doc>(col: Collection, id: string) {
    const d = await this.c(col).findOne({ id });
    return d ? this.strip<T>(d) : null;
  }

  async put<T extends Doc>(col: Collection, doc: T) {
    await this.c(col).replaceOne({ id: doc.id }, { ...doc }, { upsert: true });
    return doc;
  }

  async remove(col: Collection, id: string) {
    return (await this.c(col).deleteOne({ id })).deletedCount > 0;
  }

  async clear(col: Collection) { await this.c(col).deleteMany({}); }
  async close() { await this.client?.close(); }
}
