import { test, expect } from "bun:test";
import { CodexAppTurn } from "../src/brains/codex-app.ts";
import { usageText } from "../src/hub.ts";
import { estimateUsd } from "../src/brains/prices.ts";

// Plays the app-server: answers our requests the way codex 0.166 does, then sends a turn's notifications.
function play(o: { model?: string } = {}) {
  const sent: any[] = [];
  const models: string[] = [];
  const tokens: [number, string][] = [];
  let turn!: CodexAppTurn;
  turn = new CodexAppTurn((l) => {
    const m = JSON.parse(l);
    sent.push(m);
    const reply = (result: unknown) => queueMicrotask(() => turn.line(JSON.stringify({ id: m.id, result })));
    if (m.method === "initialize") reply({ userAgent: "codex" });
    if (m.method === "thread/start") reply({ thread: { id: "t1", model: "gpt-6.1-sol" }, model: "gpt-6.1-sol", modelProvider: "openai" });
    if (m.method === "turn/start") reply({});
  }, { cwd: "/tmp", prompt: "hi", web: false, ephemeral: true, model: o.model, onModel: (x) => models.push(x), onTokens: (t, m) => tokens.push([Number(t.totalTokens), m]) });
  return { turn, sent, models, tokens };
}

test("Codex says which model the thread really runs on, and what each call used", async () => {
  const { turn, sent, models, tokens } = play();
  turn.start();
  await Bun.sleep(5);
  expect(sent.find((m) => m.method === "thread/start").params.model).toBeUndefined(); // we named none: Codex's default
  expect(models).toEqual(["gpt-6.1-sol"]);
  for (const n of [14150, 2000]) turn.line(JSON.stringify({ method: "thread/tokenUsage/updated", params: { tokenUsage: { total: { totalTokens: 99999 }, last: { totalTokens: n } } } }));
  expect(tokens).toEqual([[14150, "gpt-6.1-sol"], [2000, "gpt-6.1-sol"]]); // each call's own use, not the thread's running total
  turn.line(JSON.stringify({ method: "turn/completed", params: { turn: { status: "completed" } } }));
  await turn.done;
});

test("what a job has cost so far, in words", () => {
  expect(usageText(0, 0)).toBe("");
  expect(usageText(0.4231)).toBe("$0.42");
  expect(usageText(0, 340_889)).toBe("341k tokens");
  expect(usageText(1.5, 2_400_000)).toBe("$1.50 + 2.4M tokens");
  expect(usageText(0, 399_000, 0.312)).toBe("399k tokens (≈$0.31)");
});

test("a Codex call is priced at its model's API rates: cached input is cheap, long prompts cost more", () => {
  // The probe call on the hub: 14,145 in (12,288 cached), 5 out.
  expect(estimateUsd("gpt-6.1-sol", { inputTokens: 14145, cachedInputTokens: 12288, outputTokens: 5 })).toBeCloseTo((1857 * 2 + 12288 * 0.1 + 5 * 10) / 1e6, 9);
  expect(estimateUsd("gpt-6.1-sol", { inputTokens: 300_000, outputTokens: 0 })).toBeCloseTo(1.2, 9); // over 272k: $4/M
  expect(estimateUsd("some-new-model", { inputTokens: 1000 })).toBeNull(); // no prices: tokens only
});
