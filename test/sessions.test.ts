import { expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Brain, inFolder, type Meter } from "../src/brain.ts";
import { Sessions, channelWorkspace, workspaceName } from "../src/brains/sessions.ts";
import { createStore, COLLECTIONS } from "../src/store/index.ts";
import { Hub } from "../src/hub.ts";
import { Scripts } from "../src/scripts.ts";
import type { Job, Project, Thread } from "../src/types.ts";
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

test("any brain you picked that works on the hub runs there before a call goes to your Mac", async () => {
  const bin = mkdtempSync(join(tmpdir(), "hearth-any-"));
  const calls = fakeClaude(bin);
  fakeCodex(bin, { answer: "codex on the hub" });
  const brain = new Brain(loadConfig({ HEARTH_DATA: mkdtempSync(join(tmpdir(), "hearth-any-data-")), HEARTH_AGENT: "claude", HEARTH_SKILLS: "off", HEARTH_BRAIN_JAIL: "off" }));
  const mac: string[] = [];
  brain.remote = { linked: () => true, pick: (p) => ({ name: "Mac", run: async (_b, q) => { mac.push(q.harness); return "from the mac"; } }) };
  await withPath(bin, async () => {
    // Codex is signed out on the hub, Claude isn't: Claude does it here, at the same tier.
    brain.pool = async () => ["claude", "codex"];
    brain.health.signedOut("codex", "401");
    const m1 = meter("thread-any");
    expect(await brain.think(JOB, { harness: "codex", model: "", role: "workhorse" }, m1)).toBe("done");
    expect(m1.ranOn).toBe("cloud");
    expect(calls().at(-1)).toContain("--model claude-sonnet-5-5");
    expect(mac).toEqual([]);

    // Both signed out here: now the Mac gets it.
    brain.health.signedOut("claude", "401");
    const m2 = meter("thread-any");
    expect(await brain.think(JOB, { harness: "codex", model: "" }, m2)).toBe("from the mac");
    expect(m2.ranOn).toBe("Mac");

    // Only Codex picked: Claude isn't used even though it's on the hub.
    brain.health.fine("claude");
    brain.pool = async () => ["codex"];
    expect(await brain.think(JOB, { harness: "codex", model: "" }, meter("thread-any"))).toBe("from the mac");
    expect(mac).toEqual(["codex", "codex"]);
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

    // A quick call: an ephemeral thread, nothing kept, and no shell (like Claude's --tools "").
    writeFileSync(log, "");
    await brain.think({ mode: "clean", context: {}, input: "hi" }, { harness: "codex", model: "" });
    expect(reqs().find((r) => r.method === "thread/start").params).toMatchObject({ ephemeral: true, sandbox: "read-only",
      config: { "features.shell_tool": false, "features.unified_exec": false } });

    // The lead writing up the legwork: no shell either, so it can't go back through the files and redo the job.
    writeFileSync(log, "");
    await brain.think({ mode: "voice", context: {}, input: "NOTES FROM THE LEGWORK: done" }, { harness: "codex", model: "" }, meter("thread-orders"));
    expect(reqs().find((r) => r.method.startsWith("thread/")).params).toMatchObject({ sandbox: "read-only", config: { "features.shell_tool": false } });
  });
});

test("a thread's working runs are told their folder is kept, to look before redoing, to save data and scripts, and to parse with code", async () => {
  const { buildPrompt } = await import("../src/brain.ts");
  const job = { mode: "job" as const, context: {}, input: "check my orders" };
  const kept = buildPrompt(job, "claude", true);
  for (const s of ["YOUR WORKSPACE", "is KEPT", "read NOTES.md", "scripts/", "PARSE WITH CODE, NOT BY EYE", "test it on a"]) expect(kept).toContain(s);
  expect(kept).not.toContain("nothing there is kept");
  expect(buildPrompt({ ...job, mode: "legwork" }, "codex", true)).toContain("YOUR WORKSPACE");
  // No thread: scratch space, as before. No shell (no jail): nothing about folders or code at all.
  expect(buildPrompt(job, "claude", false)).toContain("nothing there is kept");
  expect(buildPrompt(job, "claude", false)).not.toContain("YOUR WORKSPACE");
  expect(buildPrompt(job, null, true)).not.toContain("YOUR WORKSPACE");
  // In a project's workspace: told which, and that its other workspaces are next door.
  const inProject = buildPrompt(job, "claude", { project: "lego-zero", workspace: "aliexpress-orders" });
  expect(inProject).toContain(`"aliexpress-orders" workspace of the user's "lego-zero" project`);
  expect(inProject).toContain("The folder above it (..) is the project");
  expect(buildPrompt(job, "claude", { workspace: "portfolio" })).not.toContain("The folder above it");
});

test("threads on one subject share a workspace, a project holds its workspaces, and a thread stays where it started", () => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-ws-"));
  const brain = join(dir, "brain");
  const s = new Sessions(join(dir, "brain-sessions.json"), brain);
  const orders = { project: "lego-zero", workspace: "aliexpress-orders" };
  expect(s.folder("thread-aaa", orders)).toBe(join(brain, "projects/lego-zero/aliexpress-orders"));
  expect(s.folder("thread-bbb", orders)).toBe(join(brain, "projects/lego-zero/aliexpress-orders")); // a later thread, same subject
  expect(s.folder("thread-ccc", { workspace: "portfolio" })).toBe(join(brain, "workspaces/portfolio"));
  expect(s.placeOf("thread-aaa")).toEqual(orders);
  // Pinned: asked for somewhere else later (the ramble was moved), it stays, so its sessions still resume.
  expect(s.folder("thread-aaa", { workspace: "elsewhere" })).toBe(join(brain, "projects/lego-zero/aliexpress-orders"));
  // A thread that already has its own folder (from before workspaces) keeps it.
  mkdirSync(join(brain, "threads/thread-old"), { recursive: true });
  expect(s.folder("thread-old", orders)).toBe(join(brain, "threads/thread-old"));
  expect(s.placeOf("thread-old")).toBeUndefined();
  // No name: a folder of its own. A bad name is ignored.
  expect(s.folder("thread-ddd")).toBe(join(brain, "threads/thread-ddd"));
  expect(s.folder("thread-eee", { project: "../x", workspace: "y" })).toBe(join(brain, "threads/thread-eee"));
  // What the planner sees: the project's workspaces with their notes, or the ones outside any project.
  writeFileSync(join(brain, "projects/lego-zero/aliexpress-orders/NOTES.md"), "# Orders\n85 items, 5 shipments; tracking via scripts/track.py");
  mkdirSync(join(brain, "projects/lego-zero/customs"), { recursive: true });
  expect(s.workspaces("lego-zero").map((w) => w.name).sort()).toEqual(["aliexpress-orders", "customs"]);
  expect(s.workspaces("lego-zero").find((w) => w.name === "aliexpress-orders")!.notes).toContain("85 items, 5 shipments");
  expect(s.workspaces().map((w) => w.name)).toEqual(["portfolio"]);
  expect(s.workspaces("nope")).toEqual([]);
  expect(workspaceName("Lego Zero!")).toBe("lego-zero");
  expect(workspaceName("🔥")).toBeUndefined();
  expect(channelWorkspace("aliexpress-orders-3")).toBe("aliexpress-orders");
});

test("the hub puts a job in its ramble's project, in the planner's workspace, else the channel's; follow-ups go where their thread is", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-wsh-"));
  const store = await createStore("sqlite::memory:", dir);
  for (const c of COLLECTIONS) await store.clear(c);
  const config = { ...loadConfig({ HEARTH_AGENT: "echo" }), dataDir: dir };
  const hub = new Hub(config, store, new Brain(config), new Scripts(store, dir, join(import.meta.dir, "../scripts")), null);
  const now = new Date().toISOString();
  const doc = (id: string) => ({ id, createdAt: now });
  await store.put<Project>("projects", { ...doc("p1"), name: "lego zero", notebook: "lego" } as Project);
  await store.put<Thread>("threads", { ...doc("t-proj"), title: "x", updatedAt: now, channel: "ramble-15", projectId: "p1" } as Thread);
  await store.put<Thread>("threads", { ...doc("t-free"), title: "x", updatedAt: now, channel: "aliexpress-orders-3" } as Thread);
  await store.put<Thread>("threads", { ...doc("t-anon"), title: "x", updatedAt: now, channel: "ramble-2" } as Thread);
  const job = (id: string, threadId: string, extra: Partial<Job> = {}) => ({ ...doc(id), threadId, messageId: "m", task: "t", teammateId: "hearth", status: "queued", ...extra } as Job);
  const place = (j: Job) => (hub as any).placeFor(j);
  const root = await store.put<Job>("jobs", job("j-root", "t-proj", { workspace: "aliexpress-orders" }));
  expect(await place(root)).toEqual({ project: "lego-zero", workspace: "aliexpress-orders" });
  expect(await place(job("j-follow", "t-proj", { followsUp: root.id }))).toEqual({ project: "lego-zero", workspace: "aliexpress-orders" });
  expect(await place(job("j-plain", "t-proj"))).toEqual({ project: "lego-zero", workspace: "general" });
  expect(await place(job("j-free", "t-free"))).toEqual({ workspace: "aliexpress-orders" });
  expect(await place(job("j-anon", "t-anon"))).toBeUndefined();
  await store.close();
});

test("every command a thread's run executes is kept in its workspace's history/, for Claude and Codex", async () => {
  const bin = mkdtempSync(join(tmpdir(), "hearth-hist-"));
  const script = "python3 - <<'PY'\nimport re\nprint(len(re.findall(r'github\\.com', open('data/hn.html').read())))\nPY";
  writeFileSync(join(bin, "claude"), `#!/bin/sh
cat >/dev/null
printf '%s\\n' '${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: script } }, { type: "tool_use", name: "Write", input: { file_path: "scripts/count.py" } }] } }).replace(/'/g, "'\\''")}'
echo '{"type":"result","is_error":false,"result":"done","session_id":"sess-hist1"}'
`);
  chmodSync(join(bin, "claude"), 0o755);
  fakeCodex(bin, { answer: "ok", events: [{ method: "item/started", params: { item: { type: "commandExecution", id: "c1", command: "/bin/bash -lc 'jq .orders data/o.json'", status: "inProgress" } } }] });
  const data = mkdtempSync(join(tmpdir(), "hearth-hist-data-"));
  const brain = new Brain(loadConfig({ HEARTH_DATA: data, HEARTH_AGENT: "claude", HEARTH_SKILLS: "off", HEARTH_BRAIN_JAIL: "off" }));
  const place = { workspace: "hn-research" };
  await withPath(bin, async () => {
    await brain.think(JOB, { harness: "claude", model: "" }, { ...meter("thread-hist-1"), workspace: place });
    await brain.think(JOB, { harness: "codex", model: "" }, { ...meter("thread-hist-2"), workspace: place });
    await brain.think(JOB, { harness: "claude", model: "" }, meter()); // no thread: nothing kept
  });
  const dir = join(data, "brain/workspaces/hn-research/history");
  const files = (await import("node:fs")).readdirSync(dir).sort();
  expect(files.length).toBe(2);
  const all = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
  expect(all).toContain("re.findall(r'github\\.com'");
  expect(all).toContain("wrote scripts/count.py");
  expect(all).toContain("jq .orders data/o.json");
  expect(existsSync(join(data, "brain/history"))).toBe(false);
});

test("a cheaper model doing a job is told the lead is on hand, and how to ask it", async () => {
  const { buildPrompt } = await import("../src/brain.ts");
  const { leadSkill } = await import("../src/brains/lead.ts");
  const job = { mode: "legwork" as const, context: {}, input: "check 85 orders" };
  const claude = buildPrompt(job, "claude", true, true);
  expect(claude).toContain("THE LEAD (a stronger model on your team) is on hand");
  expect(claude).toContain("use the lead agent (it can read your files)");
  expect(claude).toContain('hearth-lead "<question>"');
  const codex = buildPrompt(job, "codex", true, true);
  expect(codex).toContain('hearth-lead "<question>"');
  expect(codex).not.toContain("lead agent");
  expect(buildPrompt(job, "claude", true, false)).not.toContain("is on hand");
  // The command: the question to the hub's lead endpoint with the agent key, from args or stdin.
  const sk = leadSkill("http://127.0.0.1:8790", "k123");
  expect(sk.common).toBe(true);
  expect(sk.scripts["hearth-lead"]).toContain('-H "X-Hearth-Agent: k123"');
  expect(sk.scripts["hearth-lead"]).toContain("http://127.0.0.1:8790/api/agent/lead");
  // The coach and advise prompts are the lead's, with what they're given.
  expect(buildPrompt({ mode: "coach", context: {}, input: "JOB: x" })).toContain("A cheaper teammate is about to do the job below");
  expect(buildPrompt({ mode: "advise", context: {}, input: "stuck on pagination" })).toContain("<untrusted>\nstuck on pagination\n</untrusted>");
});

test("the hub's lead answers a mid-job question on the heavy brain", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-lead-"));
  const store = await createStore("sqlite::memory:", dir);
  for (const c of COLLECTIONS) await store.clear(c);
  const config = { ...loadConfig({ HEARTH_AGENT: "echo" }), dataDir: dir };
  const hub = new Hub(config, store, new Brain(config), new Scripts(store, dir, join(import.meta.dir, "../scripts")), null);
  expect(await hub.askLead("orders page only shows 20 at a time")).toContain("count rows before and after");
  await store.close();
});

test("a follow-up in a thread with a session is that session answering: no lead tips before it, no write-up after", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-direct-"));
  const store = await createStore("sqlite::memory:", dir);
  for (const c of COLLECTIONS) await store.clear(c);
  const config = { ...loadConfig({ HEARTH_AGENT: "echo" }), dataDir: dir };
  const brain = new Brain(config);
  const hub = new Hub(config, store, brain, new Scripts(store, dir, join(import.meta.dir, "../scripts")), null);
  const h = hub as any;
  const base = await h.brains();
  // The live hub's setup: every role on Claude, Claude and Codex picked, and the thread's session on Codex.
  h.brains = async () => ({ ...base, workhorse: { harness: "claude", model: "claude-sonnet-5-5" }, heavy: { harness: "claude", model: "claude-opus-5-5" } });
  brain.pool = async () => ["claude", "codex"];
  const modes: string[] = [];
  let tips = 0;
  h.turn = async (mode: string) => { modes.push(mode); return { text: "nope, about $871B", did: [], used: [], tiles: [], fileIds: [] }; };
  h.leadTips = async () => { tips++; return "tip"; };
  const now = new Date().toISOString();
  const job = (id: string, extra: Partial<Job> = {}) => store.put<Job>("jobs", { id, createdAt: now, threadId: "t1", messageId: "m1", task: "Musk's net worth", teammateId: "hearth", status: "queued", effort: "light", ...extra } as Job);

  // The thread's first job: the lead briefs it, the cheaper model does the legwork, the lead writes it up.
  await h.runJob(await job("j-root"), "musk net worth");
  expect(modes).toEqual(["legwork", "voice"]);
  expect(tips).toBe(1);

  // "so he isn't a trillionaire anymore?": its session is there, so it just answers.
  brain.sessions.set("j-root", "codex", "thr-abc123");
  modes.length = 0; tips = 0;
  await h.runJob(await job("j-f1", { followsUp: "j-root" }), "so he isn't a trillionaire anymore?");
  expect(modes).toEqual(["job"]);
  expect(tips).toBe(0);
  expect((await store.get<Job>("jobs", "j-f1"))!.result).toBe("nope, about $871B");

  // No session to resume (gone, or it ran on your Mac): the full pipeline, as before.
  brain.sessions.forget("j-root", "codex");
  modes.length = 0;
  await h.runJob(await job("j-f2", { followsUp: "j-root" }), "and now?");
  expect(modes).toEqual(["legwork", "voice"]);
  await store.close();
});

test("a thread's follow-up goes back to the brain holding its session, even when the role or the pool says another", async () => {
  const bin = mkdtempSync(join(tmpdir(), "hearth-held-"));
  const calls = fakeClaude(bin);
  fakeCodex(bin, { answer: "from the codex session", log: join(bin, "req.log"), state: join(bin, "threads.json") });
  const brain = new Brain(loadConfig({ HEARTH_DATA: mkdtempSync(join(tmpdir(), "hearth-held-data-")), HEARTH_AGENT: "claude", HEARTH_SKILLS: "off", HEARTH_BRAIN_JAIL: "off" }));
  brain.pool = async () => ["claude", "codex"];
  const sonnet = { harness: "claude", model: "claude-sonnet-5-5", role: "workhorse" as const };
  await withPath(bin, async () => {
    // The thread's first run landed on Codex (the pool had more room there).
    await brain.think(JOB, { harness: "codex", model: "" }, meter("thread-held"));
    expect(await brain.sessionBrain("thread-held", sonnet)).toBe("codex");
    const m = meter("thread-held");
    expect(await brain.think(JOB, sonnet, m)).toBe("from the codex session");
    expect(m.resumed).toBe(true);
    expect(calls()).toEqual([]);
    // Codex signed out: it doesn't count as holding the thread, and the role's brain does it.
    brain.health.signedOut("codex", "401");
    expect(await brain.sessionBrain("thread-held", sonnet)).toBeUndefined();
    // Not a brain you picked: the session there isn't used.
    brain.health.fine("codex");
    brain.pool = async () => ["claude"];
    expect(await brain.sessionBrain("thread-held", sonnet)).toBeUndefined();
    // Planning and other no-tool calls never follow a session.
    brain.pool = async () => ["claude", "codex"];
    expect(await brain.think({ mode: "clean", context: {}, input: "hi" }, sonnet, meter("thread-held"))).toBe("done");
  });
});
