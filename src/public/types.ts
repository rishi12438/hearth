import type { Access, PathRules } from "./rules.ts";

// What the hub hands a box (the bundle, read-only inside the box) and what the box hands back (the outbox).
// The bundle is the box's whole world: nothing else about you exists in there.

export type Scope = {
  /** What this teammate does, in one or two sentences. */
  does: string;
  examples: string[];
  /** What it won't do, even if asked. */
  not: string[];
  allowCode: boolean;
  allowLongForm: boolean;
};

export type BoxLimits = {
  /** Spend cap per day in USD; the link pauses when it's hit. */
  costCapDayUsd: number;
  perVisitorPer10Min: number;
  perVisitorPerDay: number;
  perIpPer10Min: number;
  perLinkPerHour: number;
  maxMessageChars: number;
};

export const DEFAULT_LIMITS: BoxLimits = {
  costCapDayUsd: 2, perVisitorPer10Min: 12, perVisitorPerDay: 60, perIpPer10Min: 30, perLinkPerHour: 300, maxMessageChars: 2000,
};

export type BoxModels = { teammate: string; guard: string; effort: "low" | "medium" | "high" };

export type Manifest = {
  version: number;
  kind: "public" | "guest";
  /** Who it's for, on guest links ("Sam"). */
  label?: string;
  /** How the teammate refers to you; only what you typed when sharing. */
  ownerName: string;
  teammate: { name: string; role: string; emoji?: string };
  scope: Scope;
  /** The facts you chose to share, as plain sentences. */
  knowledge: string[];
  limits: BoxLimits;
  models: BoxModels;
  folder?: {
    name: string;
    rules: PathRules;
    files: Record<string, { sha256: string; size: number; access: Exclude<Access, "hidden"> }>;
  };
};

/** Answers you gave to "ask me" requests. Written by the hub, outside the versioned bundle. */
export type Answers = {
  always: { question: string; answer: string }[];
  once: Record<string, { question: string; answer: string }[]>; // by visitor session
};

export type EditFile = { path: string; before: string | null; after: string | null; added: number; removed: number };

export type OutboxEvent =
  | { kind: "chat"; at: string; session: string; visitor: string; fit: "in" | "unsure"; costUsd: number }
  | { kind: "refused"; at: string; session: string; visitor: string; reason: "out" | "injection" | "abuse" | "limit" | "check"; text: string; note: string }
  | { kind: "ask"; at: string; session: string; visitor: string; id: string; question: string; why: string }
  | { kind: "edit"; at: string; session: string; visitor: string; id: string; bundleVersion: number; asked: string; note: string; files: EditFile[] }
  | { kind: "paused"; at: string; reason: string };
