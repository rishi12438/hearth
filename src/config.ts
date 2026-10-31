import { resolve } from "node:path";

// Bun loads .env on its own. Every setting has a safe default; nothing secret lives here.
/**
 * Where this hub runs. "lightsail": an always-on server with a public domain (computers link to it, and it can take
 * copies of their logins). "mac": a computer that links to such a hub. "local": a hub on your own machine, just for you.
 */
export type Target = "local" | "lightsail" | "mac";

export type Config = {
  name: string;
  target: Target;
  dataDir: string;
  dbUrl: string | undefined;
  host: string;
  port: number;
  agent: string;
  agentCmd: string[] | null;
  agentTimeoutMs: number;
  allowedOrigins: string[];
  contact: string;
  behindProxy: boolean;
  /** Every device must unlock with a passkey (Face ID…) before it can read anything. */
  requirePasskey: boolean;
  unlockHours: number;
  /** How many brain processes may run at once, overall and per harness. The orchestrator never waits. */
  maxParallel: number;
  maxParallelPerHarness: Record<string, number>;
  /** Spend caps in USD (only harnesses that report cost count). */
  costCapRambleUsd: number;
  costCapDayUsd: number;
  /** Shared teammates: "docker" (sealed, for servers), "local" (a subprocess, for trying it out) or "" (off). */
  boxRunner: "docker" | "local" | "";
  /** Where hearth-boxctl keeps each box's data and socket (docker runner). */
  boxesRoot: string;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const list = (v?: string) => (v || "").split(",").map((s) => s.trim()).filter(Boolean);
  let agentCmd: string[] | null = null;
  if (env.HEARTH_AGENT_CMD) {
    const parsed = JSON.parse(env.HEARTH_AGENT_CMD);
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) {
      throw new Error("HEARTH_AGENT_CMD must be a JSON array of strings");
    }
    agentCmd = parsed;
  }
  return {
    name: env.HEARTH_NAME || "Hearth",
    target: (["lightsail", "mac"] as const).find((t) => t === env.HEARTH_TARGET) ?? "local",
    dataDir: resolve(env.HEARTH_DATA || "./data"),
    dbUrl: env.HEARTH_DB_URL || undefined,
    host: env.HEARTH_HOST || "127.0.0.1",
    port: Number(env.HEARTH_PORT || 8790),
    agent: env.HEARTH_AGENT || "claude",
    agentCmd,
    agentTimeoutMs: Number(env.HEARTH_AGENT_TIMEOUT_SEC || 180) * 1000,
    allowedOrigins: list(env.HEARTH_ALLOWED_ORIGINS),
    contact: env.HEARTH_CONTACT || "mailto:hearth@example.com",
    behindProxy: env.HEARTH_BEHIND_PROXY === "1",
    requirePasskey: env.HEARTH_REQUIRE_PASSKEY === "1",
    unlockHours: Math.max(1, Number(env.HEARTH_UNLOCK_HOURS || 12)),
    maxParallel: Math.max(1, Number(env.HEARTH_MAX_PARALLEL || 4)),
    maxParallelPerHarness: Object.fromEntries(Object.entries(env)
      .filter(([k, v]) => /^HEARTH_MAX_PARALLEL_[A-Z]+$/.test(k) && v)
      .map(([k, v]) => [k.slice("HEARTH_MAX_PARALLEL_".length).toLowerCase(), Math.max(1, Number(v))])),
    costCapRambleUsd: Number(env.HEARTH_COST_CAP_RAMBLE_USD || 2),
    costCapDayUsd: Number(env.HEARTH_COST_CAP_DAY_USD || 10),
    boxRunner: env.HEARTH_BOX_RUNNER === "docker" || env.HEARTH_BOX_RUNNER === "local" ? env.HEARTH_BOX_RUNNER : "",
    boxesRoot: resolve(env.HEARTH_BOXES_ROOT || "/var/lib/hearth-boxes"),
  };
}
