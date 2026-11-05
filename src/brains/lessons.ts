/**
 * Lessons as a library the agent searches, like skills: `hearth-lesson search <words>` asks the hub (Hub.lessonsAgent)
 * for the rules the team learned the hard way that bear on what it's doing. A few lines of curl with the agent key,
 * like hearth-skill-store, so it works the same from the hub's sandbox and from a linked Mac.
 */
export function lessonsSkill(hubUrl: string, key: string) {
  const script = `#!/usr/bin/env bash
# hearth-lesson: the team's lessons. search <words...> | show <id> | list | add <rule> [--why <what happened>] | update <id> <rule> | used <id...>
set -uo pipefail
if [ $# -eq 0 ]; then set -- help; fi
args=()
for a in "$@"; do args+=(--data-urlencode "a=$a"); done
run=()
if [ -n "\${HEARTH_JOB:-}" ]; then run=(-H "X-Hearth-Job: \${HEARTH_JOB}"); fi
exec curl -sS -m 30 -H "X-Hearth-Agent: ${key}" \${run[@]+"\${run[@]}"} "\${args[@]}" "${hubUrl}/api/agent/lessons"
`;
  return {
    name: "learn-from-mistakes", common: true, commands: ["hearth-lesson"], reads: [] as string[], scripts: { "hearth-lesson": script },
    description: "The team's lessons, learned from its own mistakes: search them before you pick a tool or way in, or claim something is true; save one when a way failed and another worked, or the user corrected you.",
    body: LESSONS_BODY,
  };
}

export const LESSONS_BODY = `# Learning from mistakes

The team keeps its lessons in a library: general rules for how to work, each learned the hard way. Your prompt shows
the few that best match this task. There may be more: search, the way you search skills.

## Search before you act
- \`hearth-lesson search <a few words>\`: the lessons that match, best first, each with its id. Search with words for
  what you're about to do, not the subject: "prices availability", "site blocked browser", "send file attachment",
  "webhook duplicate", "answer total figure".
- Search when you start a task, before you pick a tool or a way in, when something fails, and before you tell the user
  something is true, done, cheapest or available.
- \`hearth-lesson show <id>\`: one lesson, what happened when it was learned, and how often it's been used.
- \`hearth-lesson list\`: all of them, most used first.
- A lesson that applies comes before habit and before what seems quicker. When you followed one, say so:
  \`hearth-lesson used <id> [<id>...]\` (that's how the team sees which lessons earn their place).
- No shell in this run? Use the ones in your prompt, and put the ids you followed in memory.used.

## When to save one
- A tool or way failed and another worked: blocked, rate-limited, empty pages, a wrong answer, and something else got
  through. Save which beats which, and for what kind of problem.
- The user corrected you ("that doesn't exist", "you didn't check", "that's wrong"): save the habit that would have
  caught it.
- The user told you a better way, and it worked.
- You wasted real time or money on something a rule would have avoided.
Search first: if a lesson already covers it, sharpen that one instead (\`hearth-lesson update <id> "<rule>"\`). Otherwise
\`hearth-lesson add "<rule>" --why "<what happened, in a line>"\` (or the lesson.add action). Save it the moment you know
it, not at the end: you can be stopped at any time.

## Make it general
A lesson is a rule for every job, not a note about this one. Take out this case's names, places and dates and keep
the pattern. Name a tool only when the lesson is which tool to use for a kind of problem.
- "The table lost a page when I parsed it" -> "After extracting data, check the counts against the source before using them."
- "The same tool failed three times the same way" -> "When a tool fails twice the same way, switch to another instead of retrying."
- "I said done but the file was empty" -> "Check a tool's output before saying something is done."
(These only show the shape. Your lessons come from what actually happened in your own work.)

## Check it before you save it
- Would it change what a job on a completely different task does? If it only matters for one product, tool or kind of
  output, save the general habit underneath it ("anything set off by events must be safe to run twice"), or skip it.
- Is it what the user wanted, not just the fix that happened to work? If they said how they wanted it, the lesson is to
  do what they said.
- One rule, under about 200 characters, with no quoted error text, field names, flags or product names (a tool's name
  only when the lesson is which tool to use for a kind of problem). Two rules are two lessons.

## Not a lesson
- How the user likes things to look, sound or be written: a preference, memory.add {notebook: "preferences"}.
- Facts about the user or their world (their card, their trip, a price you found): that's memory.add.
- How to do this one subject's job step by step: the Playbook in NOTES.md, or a skill.
- One-off bad luck (a site down for a minute) or a guess you haven't tested.

## Keep them true
- Proved wrong or out of date (a tool got fixed, a better one came along)? \`hearth-lesson update <id> "<rule>"\`.
- Say it in a short line in your reply ("Noted for next time: check a tool's output before saying it's done").`;
