import type { Doc } from "./store/types.ts";
import type { Repeat } from "./time.ts";

/** The primary device (role "owner") lets other devices in, like the admin of a router. */
export type Passkey = { credId: string; spki: string; alg: number };
/** "computer": a Mac (or any machine) linked to this hub to run work with its own logins. Its key opens only the link. */
export type Device = Doc & { name: string; tokenHash: string; lastSeenAt: string; role?: "owner" | "member" | "computer"; passkey?: Passkey;
  /** For a computer: which of its logins it keeps copied up to this hub, so the cloud can work while it's off. */
  copy?: ("claude" | "codex")[] };
export type PairingCode = Doc & { codeHash: string; expiresAt: number; role?: "owner" | "member" };

export type Done = { kind: string; label: string; id?: string };

export type Message = Doc & {
  role: "user" | "assistant";
  text: string;
  /** Set on messages the assistant sent first. */
  proactive?: { hookId: string; title: string; trigger: string; why: string };
  /** A DM about an archived ramble (e.g. its watch fired): which ramble, so the app can link back. */
  fromThreadId?: string;
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
  /** Set on Hearth's task messages in a group chat: the job this message hands out (its thread lives under it). */
  taskJobId?: string;
  /** Files you attached to this message. */
  fileIds?: string[];
  /** A reply inside a job's thread (Slack-style); the value is the thread's root job id. */
  replyTo?: string;
  error?: boolean;
};

// ---- Hooks: the rules for when the assistant speaks first ----

export type Trigger =
  | { type: "at"; at: string; repeat: Repeat }
  | { type: "schedule"; time: string; days: number[] }
  | { type: "every"; minutes: number }
  | { type: "place"; place: string; event: "arrive" | "leave" }
  | { type: "silence"; hours: number }
  /** Checks a web page every N minutes and fires only when its text changes. */
  | { type: "watch"; url: string; minutes: number }
  /** Fires when something POSTs to the hook's secret URL (/api/webhook/<token>). */
  | { type: "webhook"; token: string }
  /** Runs an approved script every N minutes (no model). Fires when it prints something, or when its output changes. */
  | { type: "check"; script: string; args: string[]; minutes: number; when: "output" | "changed" };

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
  /** Watch and check hooks: what the page or script said last time. */
  seen?: { hash: string; text: string; at: string };
  /** A webhook call that came in during quiet hours, waiting to be handled when they end. */
  held?: { reason: string; extra: string };
};

// ---- Rambles: each chat is a thread; the orchestrator splits what you say into jobs for teammates. ----
/** A ramble is a temporary channel (#ramble-N). It archives itself an hour after everything in it is done. */
export type Thread = Doc & { title: string; updatedAt: string; preview?: string; num?: number; archivedAt?: string;
  /** The channel name ("japan-trip"): from the plan, or set by you. Falls back to ramble-N. */
  channel?: string;
  /** Who named it: you (then it's never renamed for you) or Hearth. */
  channelBy?: "you" | "hearth" };

export type Job = Doc & {
  threadId: string;
  messageId: string;
  task: string;
  /** 2-6 words for the user ("Pottery gift for Priya"); task is the full brief for the agent. */
  label?: string;
  teammateId: string;
  status: "queued" | "working" | "waiting" | "blocked" | "done" | "failed";
  /** Set when the job can't go on without you (a login, your laptop, a permission). It parks until you unblock it. */
  /** needs "computer": parked until a linked computer is online, then it resumes on its own. */
  blocked?: { need: string; why: string; unblock: string; needs?: "computer" };
  /** Where the model ran: a linked computer's name, or "cloud" for this hub. */
  ranOn?: string;
  effort: "quick" | "light" | "heavy";
  /** How it was done: reused a skill/workflow, or worked out fresh by a model. */
  how?: "skill" | "workflow" | "fresh" | "repaired";
  skillId?: string;
  workflowId?: string;
  inputs?: Record<string, string>;
  durationMs?: number;
  /** Model spend for this job, when the harness reports it (Claude does; Codex doesn't). */
  costUsd?: number | null;
  approvalIds?: string[];
  /** A follow-up you asked in a job's thread; the value is the root job id. */
  followsUp?: string;
  /** Files the teammate made for this job. */
  fileIds?: string[];
  /** Jobs this one needs results from; it starts when they're done. */
  dependsOn?: string[];
  /** Results shown as tiles (weather, places, checklist…). */
  tiles?: import("./tiles.ts").Tile[];
  /** Set on sub-jobs a heavy job split off; depth is 1 for those (never deeper). */
  parentId?: string;
  depth?: number;
  startedAt?: string;
  tier?: "quick" | "workhorse" | "heavy";
  /** Hybrid: the heavy model wrote the answer from a cheaper model's legwork. */
  voiced?: boolean;
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
  /** The badge on its avatar: one emoji for its lane (🏋️ Fitness, ✈️ Travel). */
  emoji?: string;
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
  /** "About you": a short profile the assistant keeps (and you can edit). Always in context. */
  about?: string;
  aboutUpdatedAt?: string;
  /** Hybrid: cheaper models do a job's legwork, the heavy model writes what the user reads. On unless turned off. */
  hybrid?: boolean;
};

/** Something the assistant could do for you, suggested on its own ("I can follow up on your airline refund"). */
export type Idea = Doc & {
  title: string;
  body: string;
  emoji?: string;
  /** What runs as a ramble if you say yes. */
  prompt: string;
  teammateId?: string;
  status: "open" | "accepted" | "dismissed";
  decidedAt?: string;
  threadId?: string;
};

/** Someone in the user's life, for the relationship map. Teammates add and update them as people come up. */
export type Person = Doc & {
  name: string;
  /** How they relate to the user: "sister", "landlord", "Priya's partner". */
  relation: string;
  emoji?: string;
  notes: string[];
  /** How they relate to other people on the map. */
  links: { to: string; relation: string }[];
  lastMentionedAt?: string;
};

/** One line per day of what happened, so "what did I say last week" works without loading every chat. id = YYYY-MM-DD. */
export type DayLog = Doc & { summary: string };

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

/** A file on the hub: one you attached, or one a teammate or script made. Bytes live in <data>/files/<id>. */
export type StoredFile = Doc & {
  name: string;
  mime: string;
  size: number;
  sha256: string;
  source: "you" | "teammate" | "script";
  threadId?: string;
  jobId?: string;
  teammateId?: string;
};

/** A mini app a teammate built: one html file plus its data. Runs sandboxed with no network. */
/** How big an app is on Home: small = half-width square (~170px), wide = full width ~170px tall, large = full width ~340px. */
export type AppSize = "small" | "wide" | "large";
export type MiniApp = Doc & {
  name: string;
  title: string;
  description: string;
  html: string;
  sha256: string;
  data: unknown;
  versions: { html: string; sha256: string; at: string; by?: string }[];
  teammateId?: string;
  threadId?: string;
  jobId?: string;
  /** Shown live on Home, in this order and size. */
  pinned: boolean;
  size?: AppSize;
  order?: number;
  /** An artifact: shown inside the answer that made it, not in Mini apps (until you keep it). */
  inline?: boolean;
};
/**
 * A reusable artifact component, like a skill for visuals: general code that draws any data of its shape
 * ("day-by-day-itinerary", "option-comparison"). Teammates find it in the library and reuse it with new data.
 */
export type Component = Doc & {
  name: string;
  title: string;
  description: string;
  /** Example of the data it expects (trimmed JSON), so a teammate knows what to send. */
  shape: string;
  html: string;
  sha256: string;
  uses: number;
  lastUsedAt?: string;
  teammateId?: string;
  versions: { html: string; at: string }[];
  /** Ships with Hearth (components/*.html). Kept up to date with new releases until the team improves it. */
  builtIn?: boolean;
};

/** What an app saved for itself (flashcard progress, ticked boxes). */
export type AppState = Doc & { state: unknown };
