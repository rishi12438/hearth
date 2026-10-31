import { createHash } from "node:crypto";
import { tokens } from "./memory.ts";
import type { Component, Script, Skill, Workflow } from "./types.ts";

// The library is everything the team already knows how to do: skills, workflows and approved scripts.
// Before anyone writes something new, the orchestrator and teammates get a shortlist from here.
// Shortlisting uses embeddings when a provider is configured, and keyword overlap otherwise;
// the model makes the final pick either way.

export interface Embeddings {
  readonly name: string;
  embed(texts: string[]): Promise<number[][]>;
}

class Fireworks implements Embeddings {
  readonly name = "fireworks";
  constructor(private key: string, private model: string) {}
  async embed(texts: string[]) {
    const res = await fetch("https://api.fireworks.ai/inference/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) throw new Error(`Fireworks embeddings replied ${res.status}`);
    const data: any = await res.json();
    return (data.data as { embedding: number[] }[]).map((d) => d.embedding);
  }
}

/** HEARTH_EMBEDDINGS=fireworks (default when HEARTH_FIREWORKS_API_KEY is set) | off */
export function createEmbeddings(env: Record<string, string | undefined> = process.env): Embeddings | null {
  const provider = env.HEARTH_EMBEDDINGS || (env.HEARTH_FIREWORKS_API_KEY ? "fireworks" : "off");
  if (provider === "off") return null;
  if (provider === "fireworks") {
    if (!env.HEARTH_FIREWORKS_API_KEY) throw new Error("HEARTH_EMBEDDINGS=fireworks needs HEARTH_FIREWORKS_API_KEY");
    return new Fireworks(env.HEARTH_FIREWORKS_API_KEY, env.HEARTH_EMBEDDINGS_MODEL || "nomic-ai/nomic-embed-text-v1.5");
  }
  throw new Error(`Unknown HEARTH_EMBEDDINGS provider: ${provider}`);
}

export type LibraryItem = { kind: "skill" | "workflow" | "script" | "component" | "trigger" | "trigger-recipe"; name: string; description: string; inputs?: string[]; how?: string; id?: string; score: number };

const cosine = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na * nb) || 1);
};

export class Library {
  private cache = new Map<string, number[]>(); // sha of text -> vector

  constructor(private embeddings: Embeddings | null) {}

  get mode() { return this.embeddings?.name ?? "keywords"; }

  private items(skills: Skill[], workflows: Workflow[], scripts: Script[], components: Component[] = []): Omit<LibraryItem, "score">[] {
    const covered = new Set(skills.map((s) => s.script).filter(Boolean));
    return [
      ...skills.filter((s) => s.status === "active").map((s) => ({ kind: "skill" as const, name: s.name, description: s.description, inputs: s.inputs.map((i) => i.name), how: s.kind })),
      ...workflows.filter((w) => w.status === "active").map((w) => ({ kind: "workflow" as const, name: w.name, description: w.description, inputs: w.inputs.map((i) => i.name), how: w.steps.map((x) => x.skill || "task").join(" → ") })),
      ...scripts.filter((s) => s.status === "approved" && !covered.has(s.name)).map((s) => ({ kind: "script" as const, name: s.name, description: s.description, how: s.effects })),
      // Artifact components: "how" is the data they expect, so a teammate can reuse one with new data and no new code.
      ...components.map((c) => ({ kind: "component" as const, name: c.name, description: c.description || c.title, how: `data like ${c.shape}` })),
    ];
  }

  /** Top matches for a request. Falls back to keywords if the embedding provider fails. */
  async search(query: string, skills: Skill[], workflows: Workflow[], scripts: Script[], k = 6, components: Component[] = [], extra: Omit<LibraryItem, "score">[] = []): Promise<LibraryItem[]> {
    const items = [...this.items(skills, workflows, scripts, components), ...extra];
    if (!items.length || !query.trim()) return [];
    const texts = items.map((i) => `${i.name}: ${i.description}`);
    if (this.embeddings) {
      try {
        const vecs = await this.vectors([query, ...texts]);
        return items.map((it, i) => ({ ...it, score: +cosine(vecs[0], vecs[i + 1]).toFixed(3) }))
          .sort((a, b) => b.score - a.score).slice(0, k);
      } catch (err) {
        console.warn(`embeddings unavailable, using keywords: ${(err as Error).message}`);
      }
    }
    const q = tokens(query);
    return items.map((it, i) => {
      let hits = 0;
      for (const t of tokens(texts[i])) if (q.has(t)) hits++;
      return { ...it, score: hits };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
  }

  private async vectors(texts: string[]) {
    const keys = texts.map((t) => createHash("sha256").update(t).digest("hex"));
    const missing = texts.filter((_, i) => !this.cache.has(keys[i]));
    if (missing.length) {
      const got = await this.embeddings!.embed(missing);
      let j = 0;
      texts.forEach((_, i) => { if (!this.cache.has(keys[i])) this.cache.set(keys[i], got[j++]); });
    }
    return keys.map((k) => this.cache.get(k)!);
  }
}

// ---- validation for what the brain proposes ----

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export function cleanInputs(v: unknown) {
  return (Array.isArray(v) ? v : []).slice(0, 8)
    .map((i: any) => ({ name: String(i?.name || "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 30), description: String(i?.description || "").slice(0, 120) }))
    .filter((i) => i.name);
}

export function validateSkill(a: any) {
  const name = String(a?.name || "").toLowerCase();
  const description = str(a?.description, 240);
  if (!NAME_RE.test(name) || !description) return { error: "A skill needs a lowercase-dash name and a description." };
  const kind = a.kind === "script" ? "script" : "recipe";
  const steps = kind === "recipe" ? (Array.isArray(a.steps) ? a.steps : []).slice(0, 12).map((x: unknown) => String(x).slice(0, 400)).filter(Boolean) : undefined;
  if (kind === "recipe" && !steps?.length) return { error: "A recipe needs steps." };
  const uses: string[] = (Array.isArray(a.uses) ? a.uses : []).map(String).slice(0, 8);
  return { value: { name, description, kind, steps, uses, inputs: cleanInputs(a.inputs), script: kind === "script" ? String(a.script || name) : undefined } as const };
}

export function validateWorkflow(a: any) {
  const name = String(a?.name || "").toLowerCase();
  const description = str(a?.description, 240);
  if (!NAME_RE.test(name) || !description) return { error: "A workflow needs a lowercase-dash name and a description." };
  const steps = (Array.isArray(a.steps) ? a.steps : []).slice(0, 8).map((s: any) => ({
    skill: s?.skill ? String(s.skill).toLowerCase() : undefined,
    task: !s?.skill && typeof s?.task === "string" ? s.task.slice(0, 600) : undefined,
    teammate: typeof s?.teammate === "string" ? s.teammate.slice(0, 24) : undefined,
    inputs: Object.fromEntries(Object.entries(s?.inputs && typeof s.inputs === "object" ? s.inputs : {}).slice(0, 8).map(([k, v]) => [String(k).slice(0, 30), String(v).slice(0, 400)])),
  })).filter((s: any) => (s.skill && NAME_RE.test(s.skill)) || s.task);
  if (steps.length < 2) return { error: "A workflow has at least two steps." };
  return { value: { name, description, steps, inputs: cleanInputs(a.inputs) } };
}

/** A trigger recipe from the brain: a name, inputs and a hook whose strings may hold $input.x blanks. */
export function validateTriggerRecipe(a: any) {
  const name = String(a?.name || "").toLowerCase();
  const description = str(a?.description, 240);
  if (!NAME_RE.test(name) || !description) return { error: "A trigger recipe needs a lowercase-dash name and a description." };
  const h = a?.hook;
  if (!h || typeof h !== "object" || !h.trigger || !h.action || !str(h.title, 80)) return { error: "A trigger recipe needs a hook with title, trigger and action." };
  const hook = { title: str(h.title, 80)!, trigger: h.trigger, action: h.action, why: str(h.why, 300) || "From a saved setup.",
    ...(typeof h.teammate === "string" && h.teammate.trim() ? { teammate: h.teammate.trim().slice(0, 24) } : {}),
    ...(h.cooldownMin ? { cooldownMin: Number(h.cooldownMin) || undefined } : {}) };
  if (JSON.stringify(hook).length > 6000) return { error: "That trigger recipe is too big." };
  return { value: { name, description, inputs: cleanInputs(a.inputs), hook } };
}

/** Fills $input.x blanks in every string inside a value (a recipe's hook). */
export function fillDeep<T>(v: T, inputs: Record<string, string>): T {
  if (typeof v === "string") return fill(v, inputs, "") as T;
  if (Array.isArray(v)) return v.map((x) => fillDeep(x, inputs)) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillDeep(x, inputs)])) as T;
  return v;
}

/** Fills "$input.x" and "$prev" placeholders. */
export function fill(template: string, inputs: Record<string, string>, prev: string) {
  return template.replace(/\$prev\b/g, prev).replace(/\$input\.([a-z0-9_]+)/g, (_, k) => inputs[k] ?? "");
}
