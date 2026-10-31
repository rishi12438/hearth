import type { BoxModel, TurnRequest, TurnResult } from "../src/public/model.ts";

/** A model we script. `turns` answers each teammate call; `verdict` answers the guard. */
export class FakeModel implements BoxModel {
  guardCalls = 0;
  turnCalls = 0;
  seen: string[] = []; // everything any call was shown
  verdict: (input: string) => any = () => ({ fit: "in", injection: false, abuse: "none", reason: "" });
  turns: ((req: TurnRequest, n: number) => TurnResult)[] = [];
  costPerTurn = 0.001;
  async guard(_m: string, system: string, input: string) {
    this.guardCalls++;
    this.seen.push(system, input);
    return { json: this.verdict(input), costUsd: 0.0001, refused: false };
  }
  async turn(req: TurnRequest): Promise<TurnResult> {
    this.seen.push(req.system, JSON.stringify(req.messages));
    const fn = this.turns[this.turnCalls] || this.turns[this.turns.length - 1] || (() => text("ok"));
    return { ...fn(req, this.turnCalls++), costUsd: this.costPerTurn };
  }
}
export const text = (t: string): TurnResult => ({ content: [{ type: "text", text: t, citations: null } as any], stopReason: "end_turn", costUsd: 0 });
export const tool = (name: string, input: Record<string, unknown>, id = `t${Math.random()}`): TurnResult =>
  ({ content: [{ type: "tool_use", id, name, input, caller: { type: "direct" } } as any], stopReason: "tool_use", costUsd: 0 });
