import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeCodex } from "./fixtures/codex.ts";
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
  chmodSync(join(dir, "claude"), 0o755);
  fakeCodex(dir, { answer: "codex here" });
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

test("a Claude run cut off mid-way isn't called signed out because a tool's output mentions 401 or login", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-bh-cut-"));
  // Killed before its "result" line (like a hub restart): stdout is only events, one of them a note about a 401.
  writeFileSync(join(dir, "claude"), `#!/bin/sh
cat >/dev/null
echo '{"type":"system","subtype":"init"}'
echo '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"notes: Glama gave 401 Unauthorized token, not logged in there"}]}}'
exit 143
`);
  chmodSync(join(dir, "claude"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  try {
    const config = loadConfig({ HEARTH_DATA: mkdtempSync(join(tmpdir(), "hearth-bh-data-")), HEARTH_AGENT: "claude", HEARTH_SKILLS: "off" });
    const brain = new Brain(config);
    const err = await brain.think({ mode: "clean", context: {}, input: "hi" }, { harness: "claude", model: "" }).catch((e) => e);
    expect(err).not.toBeInstanceOf(SignedOut);
    expect(brain.health.problem("claude")).toBeNull();
  } finally { process.env.PATH = oldPath; }
});

test("Codex's events (through its app-server) show as progress while it works, and its last message is the answer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-cx-"));
  const item = (kind: "started" | "completed", item: object) => ({ method: `item/${kind}`, params: { item } });
  fakeCodex(dir, {
    answer: "Cheapest is $89 on Frontier.",
    events: [
      item("completed", { type: "agentMessage", id: "m0", text: "I will check fares from SFO to PHX first." }),
      item("started", { type: "webSearch", id: "w1", query: "", action: { type: "other" } }),
      item("completed", { type: "webSearch", id: "w1", query: "SFO to PHX flights Friday", action: { type: "search", query: "SFO to PHX flights Friday" } }),
      item("started", { type: "commandExecution", id: "c1", command: "/bin/zsh -lc 'curl -sL https://www.frontier.com/fares | head -3'", status: "inProgress" }),
      item("started", { type: "commandExecution", id: "c2", command: "/bin/zsh -lc 'python3 fares.py'", status: "inProgress" }),
      item("started", { type: "commandExecution", id: "c3", command: "/bin/zsh -lc 'mkdir -p out'", status: "inProgress" }),
      // One it retries by itself isn't a failure.
      { method: "error", params: { error: { message: "stream dropped" }, willRetry: true } },
    ],
  });
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  try {
    const config = loadConfig({ HEARTH_DATA: mkdtempSync(join(tmpdir(), "hearth-cx-data-")), HEARTH_AGENT: "codex", HEARTH_SKILLS: "off" });
    const brain = new Brain(config);
    const steps: string[] = [];
    const out = await brain.think({ mode: "clean", context: {}, input: "hi" }, { harness: "codex", model: "" }, { costUsd: 0, unknown: false, onProgress: (s) => steps.push(s) });
    expect(out).toBe("Cheapest is $89 on Frontier.");
    expect(steps).toEqual(["I will check fares from SFO to PHX first", "Searching the web", "Searching: SFO to PHX flights Friday",
      "Reading frontier.com", "Running code", "Working it out", "Cheapest is $89 on Frontier"]);
  } finally { process.env.PATH = oldPath; }
});
