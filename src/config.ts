import { resolve } from "node:path";

// Bun loads .env on its own. Every setting has a safe default; nothing secret lives here.
export type Config = {
  name: string;
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
    name: env.HEARTH_NAME || "Home",
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
  };
}
