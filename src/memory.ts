import type { Fact, Importance } from "./types.ts";

// Memory model (borrowing from Enkidu notebooks, Letta core memory, Zep temporal facts, mem0 consolidation):
// - Each fact is one sentence in a notebook (people, health, work, places, preferences…).
// - Importance 3 is "core": always in the brain's context, like a profile.
// - Others are recalled by relevance to the current message, then importance, then recent use.
// - Changing a fact supersedes it; the old version stays as history. Facts can expire.
// - A nightly review hook merges duplicates and refreshes each notebook's summary.

const STOP = new Set(("the and for are but not you your with this that have from was were will what when where who " +
  "how why can could would should about into just like some than then them they there these those its it's i'm " +
  "me my mine our out get got all any too very also has had did does doing been being").split(" "));

export function tokens(text: string) {
  return new Set(
    text.toLowerCase().split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w))
      .map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w)),
  );
}

export function isActive(f: Fact, now = new Date()) {
  return !f.supersededBy && (!f.expiresAt || new Date(f.expiresAt) > now);
}

/** Facts worth putting in front of the brain for this message. */
export function recall(facts: Fact[], query: string, budget = 40, now = new Date()) {
  const active = facts.filter((f) => isActive(f, now));
  const core = active.filter((f) => f.importance === 3);
  const q = tokens(query);
  const scored = active
    .filter((f) => f.importance !== 3)
    .map((f) => {
      let overlap = 0;
      for (const t of tokens(`${f.fact} ${f.notebook}`)) if (q.has(t)) overlap++;
      const recentUse = f.lastUsedAt && now.getTime() - new Date(f.lastUsedAt).getTime() < 30 * 864e5 ? 0.5 : 0;
      return { f, score: overlap * 3 + f.importance + recentUse };
    })
    .sort((a, b) => b.score - a.score || b.f.createdAt.localeCompare(a.f.createdAt));
  return [...core, ...scored.slice(0, Math.max(0, budget - core.length)).map((s) => s.f)];
}

export function search(facts: Fact[], query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return facts;
  return facts.filter((f) => `${f.fact} ${f.notebook} ${f.evidence || ""}`.toLowerCase().includes(q));
}

const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export function validateFact(input: any): { value?: Pick<Fact, "fact" | "notebook" | "importance" | "evidence" | "expiresAt">; error?: string } {
  const fact = str(input?.fact, 500);
  if (!fact) return { error: "Memory needs a fact." };
  const importance = ([1, 2, 3].includes(Number(input.importance)) ? Number(input.importance) : 2) as Importance;
  const notebook = (str(input.notebook, 40) || "general").toLowerCase().replace(/[^a-z0-9 -]/g, "");
  let expiresAt: string | undefined;
  if (input.expiresAt) {
    const d = new Date(input.expiresAt);
    if (!Number.isNaN(d.getTime())) expiresAt = d.toISOString();
  }
  return { value: { fact, notebook: notebook || "general", importance, evidence: str(input.evidence, 300) || undefined, expiresAt } };
}
