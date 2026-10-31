import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { BetaContentBlock, BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { BoxModel, TurnRequest, TurnResult } from "./model.ts";

// "Use my subscription": instead of calling the Claude API with its own key, the box asks the hub to run the model with
// your Claude login. It still has no network path to the hub. Requests go out the way the outbox does (a file in the
// box's own data folder, which the hub reads); answers come back the way the bundle does (a file the hub writes into the
// read-only bundle). The hub runs each one as a plain `claude -p` with no tools, no MCP and no settings.
// Your login never enters the box. The trade-off: the box can now spend your subscription, so the hub caps it per day.

const TIMEOUT_MS = 180_000;

/** The first JSON object in a reply, tolerating code fences or stray text around it. */
export function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try { return JSON.parse(t); } catch {}
  const start = t.indexOf("{"), end = t.lastIndexOf("}");
  if (start >= 0 && end > start) { try { return JSON.parse(t.slice(start, end + 1)); } catch {} }
  return null;
}

/** The conversation as text, with each turn JSON-quoted so a visitor can't fake a tool result or a turn. */
export function renderTurn(req: TurnRequest) {
  const out: string[] = [];
  if (req.tools.length) {
    out.push("TOOLS you can use:");
    for (const t of req.tools) out.push(`- ${t.name}: ${t.description} Input fields: ${JSON.stringify((t.input_schema as any).properties || {})}`);
    out.push("");
  }
  out.push("CONVERSATION (each turn is a JSON string):");
  const line = (who: string, v: unknown) => out.push(`${who}: ${JSON.stringify(v)}`);
  for (const m of req.messages as BetaMessageParam[]) {
    const who = m.role === "user" ? "VISITOR" : "YOU";
    if (typeof m.content === "string") { line(who, m.content); continue; }
    for (const b of m.content as any[]) {
      if (b.type === "text") line(who, b.text);
      else if (b.type === "tool_use") line("YOU CALLED", { name: b.name, input: b.input });
      else if (b.type === "tool_result") line("TOOL RESULT", typeof b.content === "string" ? b.content : JSON.stringify(b.content));
    }
  }
  out.push("", `Reply with ONLY one JSON object and nothing else: {"say": "what the visitor sees", "tools": []}.`,
    `To use tools, put them in "tools" as {"name": "...", "input": {...}} and leave "say" empty; you'll get the results and can answer after.`);
  return out.join("\n");
}

export class HubModel implements BoxModel {
  constructor(private dataDir: string, private bundleDir: string, private timeoutMs = TIMEOUT_MS) {}

  private async ask(kind: "guard" | "turn", model: string, system: string, prompt: string): Promise<string> {
    const id = randomUUID();
    const dir = join(this.dataDir, "rpc");
    mkdirSync(dir, { recursive: true });
    const req = join(dir, `${id}.json`);
    writeFileSync(`${req}.tmp`, JSON.stringify({ kind, model, system, prompt }), { mode: 0o640 });
    renameSync(`${req}.tmp`, req);
    const res = join(this.bundleDir, "rpc", `${id}.json`);
    try {
      for (const t0 = Date.now(); Date.now() - t0 < this.timeoutMs; await Bun.sleep(150)) {
        if (!existsSync(res)) continue;
        const r = JSON.parse(readFileSync(res, "utf8"));
        if (typeof r.error === "string") throw new Error(r.error);
        return String(r.text ?? "");
      }
      throw new Error("The hub didn't answer in time.");
    } finally { rmSync(req, { force: true }); }
  }

  async guard(model: string, system: string, input: string, schema: Record<string, unknown>) {
    const text = await this.ask("guard", model, system, `${input}\n\nReply with only a JSON object that matches this JSON schema, nothing else:\n${JSON.stringify(schema)}`);
    return { json: extractJson(text), costUsd: 0, refused: false };
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
    const text = await this.ask("turn", req.model, req.system, renderTurn(req));
    const j = extractJson(text) as any;
    const calls = j && Array.isArray(j.tools) ? j.tools.filter((t: any) => typeof t?.name === "string").slice(0, 8) : [];
    if (calls.length) {
      const content = calls.map((t: any) => ({ type: "tool_use", id: `hub_${randomUUID()}`, name: t.name, input: t.input && typeof t.input === "object" ? t.input : {} })) as BetaContentBlock[];
      return { content, stopReason: "tool_use", costUsd: 0 };
    }
    const say = j && typeof j.say === "string" ? j.say : text;
    return { content: [{ type: "text", text: say, citations: null }] as BetaContentBlock[], stopReason: "end_turn", costUsd: 0 };
  }
}

/** Picks the API or the hub per call, so changing the setting doesn't need a restart. */
export class PickModel implements BoxModel {
  constructor(private which: () => "api" | "hub", private api: BoxModel | null, private hub: BoxModel) {}
  private get m() {
    if (this.which() === "hub") return this.hub;
    if (!this.api) throw new Error("This box has no API key. Add one, or switch the link to use your subscription.");
    return this.api;
  }
  guard(model: string, system: string, input: string, schema: Record<string, unknown>) { return this.m.guard(model, system, input, schema); }
  turn(req: TurnRequest) { return this.m.turn(req); }
}
