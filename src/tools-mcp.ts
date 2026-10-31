#!/usr/bin/env bun
// The workbench tools, as a tiny MCP server Claude Code starts for one job (stdio, JSON-RPC, one message per line).
// It holds nothing but the hub's address and that job's short-lived key, and forwards each tool call to the hub, which
// runs it on the workbench. Works the same when the agent thinks on your Mac: the key is only good for that job.
import { TOOLS } from "./workbench.ts";

const url = process.env.HEARTH_TOOL_URL || "";
const token = process.env.HEARTH_TOOL_TOKEN || "";
const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + "\n");

async function handle(m: any) {
  const reply = (result: unknown) => m.id !== undefined && send({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize":
      return reply({ protocolVersion: m.params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "hearth", version: "1" } });
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      let text: string, isError = false;
      try {
        const r = await fetch(`${url}/api/tool`, {
          method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ name: m.params?.name, arguments: m.params?.arguments || {} }), signal: AbortSignal.timeout(1_900_000),
        });
        const j: any = await r.json().catch(() => ({}));
        text = String(j.text ?? j.error ?? `The hub answered ${r.status}.`);
        isError = !r.ok || j.ok === false;
      } catch (e: any) { text = `Couldn't reach the hub: ${e?.message || e}`; isError = true; }
      return reply({ content: [{ type: "text", text }], isError });
    }
    case "ping": return reply({});
    default:
      if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `No method ${m.method}` } });
  }
}

let buf = "";
const dec = new TextDecoder();
for await (const chunk of Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>) {
  buf += dec.decode(chunk, { stream: true });
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch {}
  }
}
