import type { Doc } from "./store/types.ts";
import type { Repeat } from "./time.ts";

export type Device = Doc & { name: string; tokenHash: string; lastSeenAt: string };
export type PairingCode = Doc & { codeHash: string; expiresAt: number };

export type Done = { kind: string; label: string; id?: string };

export type Message = Doc & {
  role: "user" | "assistant";
  text: string;
  /** Set on messages the assistant sent first. */
  proactive?: { hookId: string; title: string; trigger: string; why: string };
  /** What the brain changed while answering. */
  did?: Done[];
  /** Memory ids the brain says it relied on. */
  used?: string[];
  /** Which teammate said it (assistant) or was addressed (user). */
  teammateId?: string;
  /** The chat it belongs to. */
  threadId?: string;
  /** Jobs the orchestrator handed out for this ramble. */
  jobIds?: string[];
  error?: boolean;
};

// ---- Hooks: the rules for when the assistant speaks first ----

export type Trigger =
  | { type: "at"; at: string; repeat: Repeat }
  | { type: "schedule"; time: string; days: number[] }
  | { type: "every"; minutes: number }
  | { type: "place"; place: string; event: "arrive" | "leave" }
  | { type: "silence"; hours: number };

export type HookAction =
  | { type: "notify"; text: string }
  | { type: "think"; prompt: string }
  | { type: "script"; script: string; args: string[]; then: "notify" | "think" };

export type Hook = Doc & {
  title: string;
  trigger: Trigger;
  action: HookAction;
  why: string;
  status: "active" | "paused" | "done";
  nextAt: string | null;
  lastFiredAt?: string;
  fireCount: number;
  source: "you" | "assistant" | "system";
  /** Minimum minutes between two firings. */
  cooldownMin?: number;
  /** The teammate who set it up and speaks when it fires. */
  teammateId?: string;
  /** The chat it was created in; it reports back there. */
  threadId?: string;
};

// ---- Rambles: each chat is a thread; the orchestrator splits what you say into jobs for teammates. ----
export type Thread = Doc & { title: string; updatedAt: string; preview?: string };

export type Job = Doc & {
  threadId: string;
  messageId: string;
  task: string;
  teammateId: string;
  status: "queued" | "working" | "done" | "failed";
  effort: "light" | "heavy";
  tier?: "workhorse" | "heavy";
  escalated?: boolean;
  result?: string;
  did?: Done[];
  finishedAt?: string;
};

// ---- Teammates: personas you can talk to. Each is a role prompt and a colour dot. ----
export type Teammate = Doc & {
  name: string;
  color: string;
  description: string;
  prompt: string;
  builtIn: boolean;
};

// ---- Memory ----

export type Importance = 1 | 2 | 3; // 1 = nice to know, 2 = useful, 3 = core (always in context)

export type Fact = Doc & {
  fact: string;
  notebook: string;
  importance: Importance;
  source: "you" | "assistant";
  /** The words it came from, so you can see why it believes this. */
  evidence?: string;
  /** Facts that stop being true (a trip, a temporary preference) expire. */
  expiresAt?: string;
  /** When a fact is replaced, the old one is kept as history and points forward. */
  supersededBy?: string;
  supersedes?: string;
  useCount: number;
  lastUsedAt?: string;
};

export type Notebook = Doc & { name: string; summary: string };

export type Place = Doc & { name: string; lat: number; lon: number; radiusM: number };
export type LocationFix = Doc & { lat: number; lon: number; accuracy?: number; source: string };

export type Script = Doc & {
  name: string;
  description: string;
  origin: "repo" | "assistant";
  status: "proposed" | "approved" | "rejected";
  sha256: string;
  lastRunAt?: string;
  lastResult?: string;
};

export type Activity = Doc & { kind: string; text: string };

export type Prefs = {
  userName: string;
  tz: string;
  quietStart: string;
  quietEnd: string;
  maxProactivePerDay: number;
  proactiveToday: { date: string; n: number };
  lastUserAt?: string;
  placeState: Record<string, boolean>;
  brains?: import("./brain.ts").Brains;
};
