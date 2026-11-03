import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainHealth, signInProblem } from "../src/brains/health.ts";
import { Brain, SignedOut } from "../src/brain.ts";
import { loadConfig } from "../src/config.ts";

test("sign-in errors from Claude Code and Codex are told apart from other failures", () => {
  expect(signInProblem("Failed to authenticate. API Error: 401 OAuth access token is invalid.")).toContain("OAuth access token is invalid");
  expect(signInProblem("Invalid API key · Please run /login")).toBeTruthy();
  expect(signInProblem("ERROR: unexpected status 401 Unauthorized: token expired")).toBeTruthy();
  expect(signInProblem("Your refresh token has already been used to generate a new access token")).toBeTruthy();
  expect(signInProblem("You've hit your usage limit. Resets at 5pm")).toBeNull();
  expect(signInProblem("Overloaded")).toBeNull();
});

test("health tells you only when a brain goes from fine to signed out, or back", () => {
  const h = new BrainHealth(() => 1);
  const seen: string[] = [];
  h.onChange = (s) => seen.push(`${s.harness}:${s.ok}`);
  h.fine("claude");                 // fine from the start: nothing to say
  h.signedOut("claude", "401");
  h.signedOut("claude", "401");     // still out: not again
  expect(h.problem("claude")).toBe("401");
  h.fine("claude");
  expect(h.problem("claude")).toBeNull();
  expect(seen).toEqual(["claude:false", "claude:true"]);
});

/** Fake claude (turned away, like a bad token) and codex (answers) on PATH. */
function fakes() {
  const dir = mkdtempSync(join(tmpdir(), "hearth-bh-"));
  writeFileSync(join(dir, "claude"), `#!/bin/sh
cat >/dev/null
echo '{"type":"result","is_error":true,"result":"Failed to authenticate. API Error: 401 OAuth access token is invalid."}'
exit 1
`);
  writeFileSync(join(dir, "codex"), `#!/bin/sh
cat >/dev/null
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done
echo "codex here" > "$out"
`);
  chmodSync(join(dir, "claude"), 0o755); chmodSync(join(dir, "codex"), 0o755);
  return dir;
}

test("a signed-out brain says so (never as the answer), and the other brain takes the work", async () => {
  const bin = fakes();
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const config = loadConfig({ HEARTH_DATA: mkdtempSync(join(tmpdir(), "hearth-bh-data-")), HEARTH_AGENT: "claude", HEARTH_SKILLS: "off" });
    const brain = new Brain(config);
    const changes: string[] = [];
    brain.health.onChange = (s) => changes.push(`${s.harness}:${s.ok}`);
    // Just Claude: a clear SignedOut error, not "Failed to authenticate" handed back as a reply.
    const err = await brain.think({ mode: "clean", context: {}, input: "hi" }, { harness: "claude", model: "" }).catch((e) => e);
    expect(err).toBeInstanceOf(SignedOut);
    expect(String(err.message)).toContain("Reconnect it in Connectors");
    expect(brain.health.problem("claude")).toContain("OAuth access token is invalid");
    // Both picked: Claude sits out while it's signed out, so Codex answers.
    brain.pool = async () => ["claude", "codex"];
    expect(await brain.think({ mode: "clean", context: {}, input: "hi" }, { harness: "claude", model: "" })).toBe("codex here");
    expect((await brain.check("codex")).ok).toBe(true);
    expect((await brain.check("claude")).ok).toBe(false);
    expect(changes).toEqual(["claude:false"]);
  } finally { process.env.PATH = oldPath; }
});

test("Codex's streamed events show as progress while it works, and the answer still comes from its output file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-cx-"));
  writeFileSync(join(dir, "codex"), `#!/bin/sh
cat >/dev/null
while [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done
echo '{"type":"item.completed","item":{"type":"agent_message","text":"I will check fares from SFO to PHX first."}}'
echo '{"type":"item.started","item":{"type":"web_search","query":"SFO to PHX flights Friday"}}'
echo '{"type":"item.started","item":{"type":"command_execution","command":"/bin/sh -lc python3 fares.py"}}'
echo "Cheapest is \\$89 on Frontier." > "$out"
`);
  chmodSync(join(dir, "codex"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  try {
    const config = loadConfig({ HEARTH_DATA: mkdtempSync(join(tmpdir(), "hearth-cx-data-")), HEARTH_AGENT: "codex", HEARTH_SKILLS: "off" });
    const brain = new Brain(config);
    const steps: string[] = [];
    const out = await brain.think({ mode: "clean", context: {}, input: "hi" }, { harness: "codex", model: "" }, { costUsd: 0, unknown: false, onProgress: (s) => steps.push(s) });
    expect(out).toBe("Cheapest is $89 on Frontier.");
    expect(steps).toEqual(["I will check fares from SFO to PHX first", "Searching: SFO to PHX flights Friday", "Working it out"]);
  } finally { process.env.PATH = oldPath; }
});
