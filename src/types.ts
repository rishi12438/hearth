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
  status: "queued" | "working" | "waiting" | "blocked" | "done" | "failed";
  /** Set when the job can't go on without you (a login, your laptop, a permission). It parks until you unblock it. */
  blocked?: { need: string; why: string; unblock: string };
  effort: "light" | "heavy";
  /** How it was done: reused a skill/workflow, or worked out fresh by a model. */
  how?: "skill" | "workflow" | "fresh" | "repaired";
  skillId?: string;
  workflowId?: string;
  inputs?: Record<string, string>;
  durationMs?: number;
  /** Model spend for this job, when the harness reports it (Claude does; Codex doesn't). */
  costUsd?: number | null;
  approvalIds?: string[];
  /** Jobs this one needs results from; it starts when they're done. */
  dependsOn?: string[];
  /** Results shown as tiles (weather, places, checklist…). */
  tiles?: import("./tiles.ts").Tile[];
  /** Set on sub-jobs a heavy job split off; depth is 1 for those (never deeper). */
  parentId?: string;
  depth?: number;
  startedAt?: string;
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
  /** "external" scripts can send, post, pay or change things outside the hub; every run needs your Approve. */
  effects: "read" | "external";
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
  spend?: { date: string; usd: number };
  costCaps?: { rambleUsd: number; dayUsd: number };
};

// ---- Skills: things the team already knows how to do, so it doesn't work them out again. ----

export type SkillInput = { name: string; description: string };

export type Skill = Doc & {
  name: string;
  description: string;
  inputs: SkillInput[];
  /** script: run an approved script directly, no model. recipe: a light model follows the steps. */
  kind: "script" | "recipe";
  script?: string;
  steps?: string[];
  /** Approved scripts a recipe may use. A recipe can never reach beyond these. */
  uses?: string[];
  status: "active" | "proposed";
  teammateId?: string;
  runs: number;
  failures: number;
  lastUsedAt?: string;
  lastFixedAt?: string;
  avgMs?: number;
  version: number;
  /** How this skill's tiles look ("hourly": true, "units": "F"). Changed by just asking. */
  view?: import("./tiles.ts").TileOptions;
  pinned?: boolean;
};

/** A step either reuses a skill, or is a plain task a teammate works out (light model). */
export type WorkflowStep = { skill?: string; task?: string; teammate?: string; inputs: Record<string, string> };

/** A saved chain of skills. "$input.x" is a workflow input, "$prev" the previous step's output. */
export type Workflow = Doc & {
  name: string;
  description: string;
  inputs: SkillInput[];
  steps: WorkflowStep[];
  status: "active" | "proposed";
  runs: number;
  lastUsedAt?: string;
  /** Pinned items are never purged. */
  pinned?: boolean;
};

/** Anything that would send, post, pay or change something outside the hub waits here for your tap. */
export type Approval = Doc & {
  threadId?: string;
  jobId?: string;
  summary: string;
  details?: string;
  action: { type: "script"; script: string; args: string[] };
  status: "pending" | "approved" | "rejected" | "done" | "failed";
  result?: string;
  decidedAt?: string;
};
