import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";

// The `hearth` CLI drives a running hub with the owner's rights through this key: a 0600 file in the hub's own data
// folder, so only someone logged in to the hub's machine (you, over SSH, or an agent you run there) can use it. It's
// only accepted on a direct localhost request: never through Caddy (which adds X-Forwarded-For), never from outside.

export const adminTokenFile = (dataDir: string) => join(dataDir, "keys", "admin.token");

/** The hub's admin key, made on first start. */
export function adminToken(dataDir: string): string {
  const path = adminTokenFile(dataDir);
  if (!existsSync(path)) {
    mkdirSync(join(dataDir, "keys"), { recursive: true, mode: 0o700 });
    writeFileSync(path, randomBytes(32).toString("base64url") + "\n", { mode: 0o600, flag: "wx" });
  }
  chmodSync(path, 0o600);
  return readFileSync(path, "utf8").trim();
}

/** Is this request the CLI on this machine? */
export function isAdminRequest(req: Request, ip: string, token: string): boolean {
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Admin ")) return false;
  if (req.headers.get("x-forwarded-for") || req.headers.get("x-forwarded-host")) return false;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip)) return false;
  const a = Buffer.from(auth.slice(6).trim()), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Call the hub running on this machine as its owner. Null if no hub is running here. */
export async function adminFetch(config: Config, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; data: any } | null> {
  const file = adminTokenFile(config.dataDir);
  if (!existsSync(file)) return null;
  const token = readFileSync(file, "utf8").trim();
  const host = ["0.0.0.0", "::", "localhost"].includes(config.host) ? "127.0.0.1" : config.host;
  try {
    const r = await fetch(`http://${host.includes(":") ? `[${host}]` : host}:${config.port}${path}`, {
      method: init.method || "GET",
      headers: { Authorization: `Admin ${token}`, ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  } catch { return null; }
}
