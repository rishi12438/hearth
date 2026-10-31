// Storage is a set of document collections. Every backend implements this one interface,
// so the hub never knows (or cares) whether it is talking to SQLite, Postgres, MySQL or Mongo.

export const COLLECTIONS = [
  "devices", "pairing", "messages", "hooks", "memory", "places",
  "locations", "activity", "pushSubs", "settings", "notebooks", "scripts", "teammates", "threads", "jobs", "skills", "workflows", "approvals", "files", "apps", "appState", "ideas", "days", "people", "components",
  "shares", "shareEvents", "shareApplies",
] as const;
export type Collection = (typeof COLLECTIONS)[number];

export type Doc = { id: string; createdAt: string; updatedAt?: string };

export interface Store {
  readonly kind: string;
  init(): Promise<void>;
  /** Every document, oldest first. Collections are small; filter in code. */
  all<T extends Doc>(col: Collection): Promise<T[]>;
  /** The newest `limit` documents created before `before`, returned oldest first. */
  recent<T extends Doc>(col: Collection, limit: number, before?: string): Promise<T[]>;
  get<T extends Doc>(col: Collection, id: string): Promise<T | null>;
  /** Insert or replace a whole document. */
  put<T extends Doc>(col: Collection, doc: T): Promise<T>;
  remove(col: Collection, id: string): Promise<boolean>;
  /** Delete everything in a collection. */
  clear(col: Collection): Promise<void>;
  close(): Promise<void>;
}
