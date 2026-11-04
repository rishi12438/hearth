import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Brain, inFolder, type Meter } from "../src/brain.ts";
import { Sessions } from "../src/brains/sessions.ts";
import { loadConfig } from "../src/config.ts";
import { fakeCodex } from "./fixtures/codex.ts";

const JOB = { mode: "job" as const, context: { tz: "UTC", nowIso: new Date().toISOString() }, input: "check my orders" };
const meter = (thread?: string): Meter => ({ costUsd: 0, unknown: false, thread });

async function withPath<T>(dir: string, f: () => Promise<T>): Promise<T> {
  const old = process.env.PATH;
  process.env.PATH = `${dir}:${old}`;
  try { return await f(); } finally { process.env.PATH = old; }
}

test("a thread's session ids are kept per brain, privately, and its folder stays and sees the skills", () => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-ss-"));
  const s = new Sessions(join(dir, "brain-sessions.json"), join(dir, "brain"));
  expect(s.get("thread-1", "claude")).toBeUndefined();
  s.set("thread-1", "claude", "sess-aaaa");
  s.set("thread-1", "codex", "thr-bbbb");
  expect(s.get("thread-1", "claude")).toBe("sess-aaaa");
  expect(s.get("thread-1", "codex")).toBe("thr-bbbb");
  expect(statSync(join(dir, "brain-sessions.json")).mode & 0o777).toBe(0o600);
  s.forget("thread-1", "claude");
  expect(s.get("thread-1", "claude")).toBeUndefined();
  expect(s.get("thread-1", "codex")).toBe("thr-bbbb");
  // Nothing with a path in it becomes a folder or a key.
  expect(s.folder("../etc")).toBeNull();
  s.set("../x", "claude", "sess-cccc");
  expect(s.get("../x", "claude")).toBeUndefined();
  const f = s.folder("thread-1")!;
  expect(f).toBe(join(dir, "brain", "threads", "thread-1"));
  expect(lstatSync(join(f, ".claude")).isSymbolicLink()).toBe(true);
  expect(s.folder("thread-1")).toBe(f); // again: same folder, no error
});

test("the jail starts a thread's run in the thread's folder", () => {
  expect(inFolder(["bwrap", "--bind", "/", "/", "--chdir", "/data/brain"], "/data/brain/threads/t1")).toEqual(["bwrap", "--bind", "/", "/", "--chdir", "/data/brain/threads/t1"]);
});

/** A fake claude that logs its args and cwd, answers with a session id, and doesn't know session "sess-gone". */
function fakeClaude(dir: string) {
  const log = join(dir, "claude.log");
  writeFileSync(join(dir, "claude"), `#!/bin/sh
cat >/dev/null
printf '%s | %s\\n' "$(pwd)" "$(echo "$*" | tr '\\n' ' ')" >> "${log}"
case "$*" in *"--resume sess-gone"*) echo "No conversation found with session ID: sess-gone" >&2; exit 1;; esac
sid=sess-new1; case "$*" in *"--resume "*) sid=$(echo "$*" | sed 's/.*--resume \\([^ ]*\\).*/\\1/');; esac
echo '{"type":"result","is_error":false,"result":"done","session_id":"'$sid'","total_cost_usd":0.01}'
`);
  chmodSync(join(dir, "claude"), 0o755);
  return () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
}

test("Claude: a thread's first job starts a session in its folder, follow-ups resume it, and a lost one starts over", async () => {
  const bin = mkdtempSync(join(tmpdir(), "hearth-cl-"));
  const calls = fakeClaude(bin);
  const data = mkdtempSync(join(tmpdir(), "hearth-cl-data-"));
  const brain = new Brain(loadConfig({ HEARTH_DATA: data, HEARTH_AGENT: "claude", HEARTH_SKILLS: "off", HEARTH_BRAIN_JAIL: "off" }));
  const folder = realpathSync(data) + "/brain/threads/thread-orders";
  await withPath(bin, async () => {
    const m1 = meter("thread-orders");
    expect(await brain.think(JOB, { harness: "claude", model: "" }, m1)).toBe("done");
    expect(m1.resumed).toBeUndefined();
    let [cwd, args] = calls().at(-1)!.split(" | ");
    expect(realpathSync(cwd)).toBe(folder);
    expect(args).not.toContain("--no-session-persistence");
    expect(args).not.toContain("--resume");
    expect(brain.sessions.get("thread-orders", "claude")).toBe("sess-new1");

    // "can you try again?": the same session.
    const m2 = meter("thread-orders");
    await brain.think(JOB, { harness: "claude", model: "" }, m2);
    [cwd, args] = calls().at(-1)!.split(" | ");
    expect(args).toContain("--resume sess-new1");
    expect(realpathSync(cwd)).toBe(folder);
    expect(m2.resumed).toBe(true);

    // Its session files were cleared: one fresh start, and the new id is kept.
    brain.sessions.set("thread-orders", "claude", "sess-gone");
    const n = calls().length;
    expect(await brain.think(JOB, { harness: "claude", model: "" }, meter("thread-orders"))).toBe("done");
    expect(calls().slice(n).map((l) => l.includes("--resume sess-gone"))).toEqual([true, false]);
    expect(brain.sessions.get("thread-orders", "claude")).toBe("sess-new1");

    // A quick call (no tools) and a job with no thread stay throwaways in the brain's folder.
    await brain.think({ mode: "clean", context: {}, input: "hi" }, { harness: "claude", model: "" }, meter("thread-orders"));
    expect(calls().at(-1)).toContain("--no-session-persistence");
    await brain.think(JOB, { harness: "claude", model: "" }, meter());
    [cwd, args] = calls().at(-1)!.split(" | ");
    expect(args).toContain("--no-session-persistence");
    expect(realpathSync(cwd)).toBe(realpathSync(data) + "/brain");
  });
});

test("Codex: a thread's first job starts an app-server thread, follow-ups resume it, and a lost one starts over", async () => {
  const bin = mkdtempSync(join(tmpdir(), "hearth-cxs-"));
  const log = join(bin, "requests.log"), state = join(bin, "threads.json");
  fakeCodex(bin, { answer: "orders checked", log, state });
  const reqs = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const data = mkdtempSync(join(tmpdir(), "hearth-cxs-data-"));
  const brain = new Brain(loadConfig({ HEARTH_DATA: data, HEARTH_AGENT: "codex", HEARTH_SKILLS: "off", HEARTH_BRAIN_JAIL: "off" }));
  await withPath(bin, async () => {
    expect(await brain.think(JOB, { harness: "codex", model: "" }, meter("thread-orders"))).toBe("orders checked");
    const start = reqs().find((r) => r.method === "thread/start");
    expect(start.params).toMatchObject({ approvalPolicy: "never", sandbox: "danger-full-access", config: { web_search: "live" } });
    expect(realpathSync(start.params.cwd)).toBe(realpathSync(data) + "/brain/threads/thread-orders");
    expect(start.params.ephemeral).toBeUndefined();
    const id = brain.sessions.get("thread-orders", "codex")!;
    expect(id).toMatch(/^thr-/);
    expect(reqs().find((r) => r.method === "turn/start").params).toMatchObject({ threadId: id, input: [{ type: "text" }] });

    const m2 = meter("thread-orders");
    writeFileSync(log, "");
    expect(await brain.think(JOB, { harness: "codex", model: "" }, m2)).toBe("orders checked");
    expect(reqs().map((r) => r.method)).toEqual(["initialize", "initialized", "thread/resume", "turn/start"]);
    expect(reqs()[2].params.threadId).toBe(id);
    expect(m2.resumed).toBe(true);

    // A thread it no longer has: it starts a new one instead of failing the job.
    brain.sessions.set("thread-orders", "codex", "thr-gone0000");
    writeFileSync(log, "");
    const m3 = meter("thread-orders");
    expect(await brain.think(JOB, { harness: "codex", model: "" }, m3)).toBe("orders checked");
    expect(reqs().map((r) => r.method)).toEqual(["initialize", "initialized", "thread/resume", "thread/start", "turn/start"]);
    expect(m3.resumed).toBeUndefined();
    expect(brain.sessions.get("thread-orders", "codex")).not.toBe("thr-gone0000");

    // A quick call: an ephemeral thread, nothing kept.
    writeFileSync(log, "");
    await brain.think({ mode: "clean", context: {}, input: "hi" }, { harness: "codex", model: "" });
    expect(reqs().find((r) => r.method === "thread/start").params).toMatchObject({ ephemeral: true, sandbox: "danger-full-access" });
  });
});
