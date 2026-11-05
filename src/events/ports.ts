import type { EventPipeline, EventSource } from "./pipeline.ts";

// Trigger ports: an agent asks the hub for a callback URL on the fly (`hearth-trigger-port claim`), puts it into
// whatever service has webhooks, and every call becomes an event on the port's source. Each claim says why and what
// will call it, and the hub writes down who took it (teammate, job, thread) and when, so every live URL is accounted
// for. The publisher is only whatever POSTs, so it can be swapped for another service without touching the triggers.

export type PortWho = { by: string; jobId: string | null; threadId: string | null; teammateId: string | null };

/** `--reason "…" --source plaid` → { reason: "…", source: "plaid" }; bare words come back in `rest`. */
export function parseFlags(argv: string[]): { flags: Record<string, string[]>; rest: string[] } {
  const flags: Record<string, string[]> = {}, rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--([a-z][\w-]*)(?:=(.*))?$/i.exec(a);
    if (!m) { rest.push(a); continue; }
    const v = m[2] ?? (i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[++i] : "");
    (flags[m[1].toLowerCase()] ||= []).push(v);
  }
  return { flags, rest };
}

/** `--var amount=data.amount --var merchant` → variables and a mapping. */
function varsFrom(specs: string[] = []): { variables?: { name: string }[]; mapping?: Record<string, string> } {
  if (!specs.length) return {};
  const variables: { name: string }[] = [], mapping: Record<string, string> = {};
  for (const s of specs) {
    const [name, path] = s.split("=", 2).map((x) => x.trim());
    if (!name) continue;
    variables.push({ name });
    if (path) mapping[name] = path;
  }
  return { variables, ...(Object.keys(mapping).length ? { mapping } : {}) };
}

const line = (s: EventSource, base: string, secret?: string | null) => {
  const c = s.claim;
  const state = c?.releasedAt ? `released ${c.releasedAt} by ${c.releasedBy}${c.releaseReason ? ` (${c.releaseReason})` : ""}` : s.status;
  return [
    `${s.name}  [${state}]  ${s.eventCount} event${s.eventCount === 1 ? "" : "s"}${s.lastEventAt ? `, last ${s.lastEventAt}` : ""}`,
    `  for: ${c?.reason || s.description || "(no reason recorded: made before ports)"}`,
    `  called by: ${c?.publisher || s.service || "?"} · claimed by ${c?.by || s.createdBy}${c?.jobId ? ` in job ${c.jobId}` : ""} at ${c?.at || s.createdAt}`,
    `  variables: ${s.variables.map((v) => v.name).join(", ")} (plus payload.*)`,
    ...(secret ? [`  url: ${base}/api/events/${s.name}/${secret}`] : []),
  ].join("\n");
};

/** What `hearth-trigger-port <argv>` does, for the hub's /api/agent/ports. Text back for the agent to read. */
export function portsAgent(p: EventPipeline, argv: string[], who: PortWho, base: string): string {
  const [cmd = "list", ...more] = argv;
  const { flags, rest } = parseFlags(more);
  const one = (k: string) => flags[k]?.[flags[k].length - 1]?.trim() || "";
  switch (cmd) {
    case "claim": {
      const r = p.claimPort({ name: one("name") || rest[0], reason: one("reason"), publisher: one("source") || one("publisher"), description: one("description"), ...varsFrom(flags.var) }, who);
      if (!r.value) return `Not claimed: ${r.error}${r.conflict ? `\nOptions: ${r.conflict.options.join(" · ")}` : ""}`;
      const { source: s, secret, others } = r.value;
      return [
        `Claimed port ${s.name}. Give this URL to ${s.claim!.publisher} as its webhook / callback (POST, JSON):`,
        `${base}/api/events/${s.name}/${secret}`,
        ``,
        `Every call is saved as an event on source "${s.name}". Next, add a trigger on it (trigger.add {source:"${s.name}", formula, action}),`,
        `e.g. a script action that gets the event on stdin and publishes clean events: {"type":"script","script":"<name>","then":"publish","into":"<source>"}.`,
        `Keep the URL secret (it's the only key). Release it when it's no longer needed: hearth-trigger-port release ${s.name} --reason "…"`,
        ...(others.length ? [``, `Already live for ${s.claim!.publisher}: ${others.map((o) => `${o.name} (${o.claim?.reason})`).join("; ")}. Release one if this replaces it.`] : []),
      ].join("\n");
    }
    case "list": case "ls": {
      const all = p.ports().filter((s) => flags.all || !s.claim?.releasedAt);
      return all.length ? all.map((s) => line(s, base)).join("\n\n") : "No ports yet. Claim one: hearth-trigger-port claim --reason \"what it's for\" --source <service>";
    }
    case "show": {
      const s = p.findSource(rest[0] || "");
      if (!s || s.kind !== "push") return `No port called ${rest[0] || "?"}. Run: hearth-trigger-port list`;
      const evs = p.events({ source: s.id, limit: 5, log: false });
      return `${line(s, base, s.claim?.releasedAt ? null : p.secretOf(s.id))}\n  triggers: ${p.triggers(s.id).map((t) => `${t.name} (${t.formula})`).join("; ") || "none yet"}\n  recent events:${evs.length ? "\n" + evs.map((e) => `   - ${e.receivedAt} [${e.status}] ${JSON.stringify(e.payload).slice(0, 300)}`).join("\n") : " none"}`;
    }
    case "map": {
      // Name the fields that matter, from what the sender really sends (see `show`): they become variables formulas test.
      const s = p.findSource(rest[0] || "");
      if (!s || s.kind !== "push") return `No port called ${rest[0] || "?"}.`;
      const v = varsFrom(flags.var);
      if (!v.variables?.length) return 'Say which fields: hearth-trigger-port map <name> --var status=data.object.status --var email=data.object.email';
      const names = new Set(v.variables.map((x) => x.name));
      const r = p.updateSource(s.id, { variables: [...s.variables.filter((x) => !names.has(x.name)), ...v.variables], mapping: { ...(s.mapping || {}), ...(v.mapping || {}) } });
      return r.value ? `${s.name} now has: ${r.value.variables.map((x) => `${x.name}${r.value!.mapping?.[x.name] ? ` (${r.value!.mapping[x.name]})` : ""}`).join(", ")}. Decide with code: a formula on these, or a check script (see the make-triggers skill).`
        : `Not changed: ${r.error}${r.conflict ? `\nOptions: ${r.conflict.options.join(" · ")}` : ""}`;
    }
    case "release": {
      const r = p.releasePort(rest[0] || "", who.by, one("reason"));
      return r.value ? `Released ${r.value.name}: its URL no longer works. Its record, triggers and events stay (delete them in Triggers if you want).` : `Not released: ${r.error}`;
    }
    case "test": {
      const s = p.findSource(rest[0] || "");
      if (!s || s.kind !== "push") return `No port called ${rest[0] || "?"}.`;
      let payload: unknown = {};
      try { payload = rest[1] ? JSON.parse(rest[1]) : {}; } catch { return "The test payload must be JSON."; }
      const r = p.publish(s, payload, {}, true);
      return r.value ? `Sent a test event (${r.value.id}) through ${s.name}'s triggers. See it with: hearth-trigger-port show ${s.name}` : `Not sent: ${r.error}`;
    }
    default:
      return USAGE;
  }
}

const USAGE = `usage:
  hearth-trigger-port claim --reason "<what it's for>" --source <who will call it> [--name <name>] [--var name[=path.in.body]]...
  hearth-trigger-port list [--all]
  hearth-trigger-port show <name>
  hearth-trigger-port test <name> '<json>'
  hearth-trigger-port map <name> --var name=path.in.body ...
  hearth-trigger-port release <name> --reason "<why>"`;

/** The agent's hearth-trigger-port command: a few lines of curl to the hub with its agent key (like hearth-mcp). */
export function portsSkill(hubUrl: string, key: string) {
  const script = `#!/usr/bin/env bash
# hearth-trigger-port: claim a callback URL (a trigger port) for a webhook, list them, release one.
set -uo pipefail
if [ $# -eq 0 ]; then set -- list; fi
args=()
for a in "$@"; do args+=(--data-urlencode "a=$a"); done
# The job this run is for: the claim records it, so every URL can be traced back to the task that took it.
job=()
if [ -n "\${HEARTH_JOB:-}" ]; then job=(-H "X-Hearth-Job: \${HEARTH_JOB}"); fi
exec curl -sS -m 60 -H "X-Hearth-Agent: ${key}" \${job[@]+"\${job[@]}"} "\${args[@]}" "${hubUrl}/api/agent/ports"
`;
  return {
    name: "hearth-trigger-port", common: true, commands: ["hearth-trigger-port"], reads: [], scripts: { "hearth-trigger-port": script },
    description: "Get a webhook / callback URL from the hub (a trigger port) so an outside service can push events into Hearth's triggers; list and release them.",
    body: `# Trigger ports

When a service can call a webhook (Plaid, Stripe, GitHub, Zapier, an iOS Shortcut, your own script), claim a port and
give the service its URL. Every call becomes an event on the port's source, where triggers act on it.

- \`hearth-trigger-port claim --reason "<what it's for>" --source <service> [--name <name>] [--var name[=path]]\`
  prints the URL once. --reason and --source are required: the hub records who claimed it, in which job, and why,
  and the user sees that in Triggers. Variables are optional; formulas can always read payload.* (what was sent).
- \`hearth-trigger-port list [--all]\` · \`show <name>\` (its URL, triggers, last events) · \`test <name> '<json>'\`
- \`hearth-trigger-port map <name> --var status=data.object.status --var email=data.object.email\`: make the sender's
  real fields variables. Do this as soon as you know the shape (the service's docs, or \`show\` after the first event).

The trigger on a port decides with CODE: a formula for facts on the event, a check script (Python is fine) for
facts that are awkward as a formula, a judge only for meaning. Never formula "true" plus a prompt that filters. The
make-triggers skill has the whole method: read it before you add the trigger.
- \`hearth-trigger-port release <name> --reason "<why>"\`: the URL stops working. Release ports you no longer need.

Push before polling: when a service can call a webhook, use a port, not a watcher that checks every few minutes.
Check \`list\` first: if a live port already covers this service and purpose, use it instead of claiming another.
Some ports are fed by the hub itself and have no URL: \`plaid\` gets every verified Plaid webhook while a bank is
connected (variables type, code, bank, item_id), so for bank events put a trigger on it rather than claiming one.

Many webhooks only say "something changed" (Plaid: item X has updates). Then add a trigger on the port whose action is
a script (script.propose; .ts, .py or .sh) that gets the whole event as JSON on stdin and in $HEARTH_EVENT, fetches the
details, and prints one JSON object per line. With {"type":"script","script":"<name>","then":"publish","into":"<source>"}
each line becomes an event on <source>, where formulas can test the real fields (amount > 200, merchant contains "uber").
Never print the URL in your reply; tell the user it's in Triggers.`,
  };
}
