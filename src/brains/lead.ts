// The lead (the team's heavy model) helps while a cheaper model does a job, two ways:
//   - before it starts: a short brief of tips (the hub asks for it, mode "coach"; see hub.runJob)
//   - while it works: it can ask. `hearth-lead "question"` (any brain) asks the hub, which asks the heavy model (mode
//     "advise") and prints the answer. A Claude run also has the lead as a sub-agent that can read its files (brain.ts).
// The lead advises; it doesn't take the job over.

/** The command, for skills.ts: a few lines of curl to the hub with its agent key (like hearth-plaid). */
export function leadSkill(hubUrl: string, key: string) {
  const script = `#!/usr/bin/env bash
# hearth-lead "question": ask the lead (the team's stronger model) for advice mid-job. The question can also come on stdin.
set -uo pipefail
q="$*"; if [ -z "$q" ] && [ ! -t 0 ]; then q="$(cat)"; fi
if [ -z "$q" ]; then echo 'usage: hearth-lead "what you tried, what happened, what you want to know"' >&2; exit 2; fi
exec curl -sS -m 600 -H "X-Hearth-Agent: ${key}" --data-urlencode "q=$q" "${hubUrl}/api/agent/lead"
`;
  return {
    name: "hearth-lead", common: true, commands: ["hearth-lead"], reads: [], scripts: { "hearth-lead": script },
    description: "Ask the lead (a stronger model on your team) for advice mid-job: when you're stuck after two tries, before an approach that's big, tricky or hard to undo, or when results look off.",
    body: `# Ask the lead

Run \`hearth-lead "<your question>"\` (or pipe it in: \`cat notes.txt | hearth-lead\`). It prints the lead's advice. It takes
a minute or two: the lead is a stronger, slower model.

When:
- you're stuck after two honest tries (say what you tried and what happened, word for word)
- before an approach for something big, tricky or hard to undo (say the plan in a few lines)
- when results look off (paste the counts, a few sample rows, what you expected)

The lead can't see your files or this conversation: put in what it needs (the task in a line, the relevant output, the
paths and a short excerpt). Then follow its advice, or say why you didn't. Don't ask it to do the whole job.`,
  };
}

/** What the lead is told when asked mid-job. */
export const ADVISE = `You are the lead on a team: a stronger model. A teammate doing a job for the user stopped to ask you something.
Answer with a concrete recommendation: what to do next and why, the trap they're about to fall into, and what to check
before trusting a result. Be brief and specific (a few short bullets or lines). Don't do the whole job, and say plainly
if their question is missing something you'd need.`;
