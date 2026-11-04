// What a call on a plan (Codex on ChatGPT) would cost at the model's API prices. The plan reports no dollars, so this is
// an estimate: it's shown with "≈" and never counts toward the spending cap.
//
// Per 1M tokens. OpenAI's standard tier as listed in Nov 2026 (third-party pricing sites, checked against each other):
// requests over `longAbove` input tokens are billed at the long-context rates.

type Rate = { input: number; cached: number; cacheWrite: number; output: number };
type Price = Rate & { longAbove?: number; long?: Rate };

const PRICES: Record<string, Price> = {
  "gpt-6.1-sol": { input: 2, cached: 0.1, cacheWrite: 2.5, output: 10, longAbove: 272_000, long: { input: 4, cached: 0.2, cacheWrite: 5, output: 15 } },
};

/** One model call's token use, as Codex's app-server reports it (thread/tokenUsage/updated → tokenUsage.last). */
export type CallTokens = { totalTokens?: number; inputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number; outputTokens?: number };

/** Dollars for one call at the model's API prices, or null for a model we have no prices for. */
export function estimateUsd(model: string, t: CallTokens): number | null {
  const p = PRICES[model];
  if (!p) return null;
  const input = t.inputTokens ?? 0, cached = t.cachedInputTokens ?? 0, write = t.cacheWriteInputTokens ?? 0;
  const r = p.long && p.longAbove && input > p.longAbove ? p.long : p;
  // Input counts every prompt token; the cached and cache-written ones are billed at their own rates.
  const fresh = Math.max(0, input - cached - write);
  return (fresh * r.input + cached * r.cached + write * r.cacheWrite + (t.outputTokens ?? 0) * r.output) / 1_000_000;
}
