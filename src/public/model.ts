import Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlock, BetaMessageParam, BetaTool } from "@anthropic-ai/sdk/resources/beta/messages/messages";

// The box's only way out: the Claude API, with its own key, through the egress proxy when one is set.
// It has no Claude Code, no MCP servers, no web tools, no shell: just messages and the tools the box defines.

export type TurnRequest = {
  model: string;
  effort: "low" | "medium" | "high";
  system: string;
  messages: BetaMessageParam[];
  tools: BetaTool[];
  maxTokens: number;
};
export type TurnResult = { content: BetaContentBlock[]; stopReason: string | null; costUsd: number };
export type GuardResult = { json: unknown; costUsd: number; refused: boolean };

export interface BoxModel {
  guard(model: string, system: string, input: string, schema: Record<string, unknown>): Promise<GuardResult>;
  turn(req: TurnRequest): Promise<TurnResult>;
}

/** USD per million tokens (input, output). Unknown models are priced high so the daily cap stays safe. */
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20], "claude-sonnet-5-5": [2, 10], "claude-haiku-5-5": [0.1, 0.5],
  "claude-opus-5": [5, 25], "claude-sonnet-5": [2, 10], "claude-opus-4-8": [5, 25],
};
export function costOf(model: string, usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }) {
  const [i, o] = PRICES[model] || [10, 50];
  const input = usage.input_tokens + (usage.cache_creation_input_tokens || 0) * 1.25 + (usage.cache_read_input_tokens || 0) * 0.1;
  return (input * i + usage.output_tokens * o) / 1e6;
}

export const isOauthToken = (key: string) => key.startsWith("sk-ant-oat");

const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"]);

export class AnthropicModel implements BoxModel {
  private client: Anthropic;

  /** key: an API key (sk-ant-api…) or a subscription token from `claude setup-token` (sk-ant-oat…). */
  constructor(key: string, proxy?: string) {
    // Bun's fetch takes a proxy per request; the SDK lets us hand it our own fetch.
    const viaProxy: typeof fetch = ((url: any, init?: any) => fetch(url, { ...init, proxy })) as typeof fetch;
    const auth = isOauthToken(key) ? { apiKey: null, authToken: key, defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" } } : { apiKey: key };
    this.client = new Anthropic({ ...auth, maxRetries: 2, timeout: 120_000, ...(proxy ? { fetch: viaProxy } : {}) });
  }

  async guard(model: string, system: string, input: string, schema: Record<string, unknown>): Promise<GuardResult> {
    const r = await this.client.messages.create({
      model, max_tokens: 1024, system,
      output_config: { effort: "low", format: { type: "json_schema", schema } },
      messages: [{ role: "user", content: input }],
    });
    const text = r.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    let json: unknown = null;
    try { json = JSON.parse(text); } catch {}
    return { json, costUsd: costOf(r.model, r.usage), refused: r.stop_reason === "refusal" };
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
    const r = await this.client.beta.messages.create({
      model: req.model, max_tokens: req.maxTokens, system: req.system, messages: req.messages,
      output_config: { effort: req.effort },
      ...(req.tools.length ? { tools: req.tools } : {}),
      // On a policy decline the API retries on a model it picks, inside the same call.
      ...(FALLBACK_MODELS.has(req.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });
    return { content: r.content, stopReason: r.stop_reason, costUsd: costOf(r.model, r.usage) };
  }
}
