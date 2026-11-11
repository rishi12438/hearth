import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Background, backgroundSkill, endedText, MAX_QUICK_RESTARTS, type BgEnd } from "../src/background.ts";
import { expendable } from "../src/oom.ts";
import { buildPrompt } from "../src/brain.ts";

const who = { by: "Research", jobId: "j1", threadId: "t1" };

function setup(over: Partial<ConstructorParameters<typeof Background>[0]> = {}) {
  const root = mkdtempSync(join(tmpdir(), "hearth-bg-"));
  const ws = join(root, "brain", "workspaces", "sim");
  mkdirSync(ws, { recursive: true });
  const ends: BgEnd[] = [];
  const stateFile = join(root, "background", "tasks.json");
  const make = () => new Background({ roots: [join(root, "brain")], stateFile, machine: () => ({ cores: 2, load: 0.5, availMB: 3000, totalMB: 4000 }), shell: () => ({ prefix: [], env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: root } }), onEnd: (e) => { ends.push(e); }, ...over });
  return { root, ws, ends, stateFile, bg: make(), make };
}

const until = async (f: () => boolean, ms = 5000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("timed out"); await Bun.sleep(25); } };

describe("hearth-bg", () => {
  test("starts in the workspace, writes its log, and tells the conversation when it ends", async () => {
    const { bg, ws, ends } = setup();
    const out = await bg.agent(["start", "--name", "flights", "--", "echo step 1; echo step 2 > result.txt; exit 3"], ws, who);
    expect(out).toContain("Started flights in the background");
    expect(out).toContain("Now reply to the user");
    await until(() => ends.length === 1);
    expect(ends[0].why).toBe("exited");
    expect(ends[0].task.status).toBe("failed");
    expect(ends[0].task.code).toBe(3);
    expect(ends[0].tail).toContain("step 1");
    expect(readFileSync(join(ws, "result.txt"), "utf8").trim()).toBe("step 2");
    expect(readFileSync(join(ws, ".hearth-bg", "flights.log"), "utf8")).toContain("started by Research");
    expect(await bg.agent(["status", "flights"], ws, who)).toContain("failed (exit 3)");
  });

  test("keeps running across calls until stopped; a stop isn't reported as an end", async () => {
    const { bg, ws, ends } = setup();
    await bg.agent(["start", "--name", "loop", "--", "while true; do echo tick; sleep 0.1; done"], ws, who);
    await Bun.sleep(400);
    expect(await bg.agent(["list"], ws, who)).toContain("loop  running");
    expect(await bg.agent(["start", "--name", "loop", "--", "true"], ws, who)).toContain("already running");
    expect(await bg.agent(["log", "loop", "3"], ws, who)).toContain("tick");
    expect(await bg.agent(["stop", "loop"], ws, who)).toContain("Stopping loop");
    await until(() => bg.list()[0].status !== "running");
    expect(bg.list()[0].status).toBe("stopped");
    await Bun.sleep(100);
    expect(ends).toHaveLength(0);
  });

  test("each start says how busy the machine is, and nothing starts when memory is nearly gone", async () => {
    let avail = 3000;
    const { bg, ws } = setup({ machine: () => ({ cores: 2, load: 2.4, availMB: avail, totalMB: 3800 }) });
    const ok = await bg.agent(["start", "--name", "a", "--", "sleep 5"], ws, who);
    expect(ok).toContain("Machine now: 2 CPU cores, load 2.4 (CPU fully busy); 2.9 GB of 3.7 GB memory free; 1 background task running.");
    avail = 400;
    const no = await bg.agent(["start", "--name", "b", "--", "sleep 5"], ws, who);
    expect(no).toContain("not started, the machine is nearly out of memory");
    expect(no).toContain("one after another");
    expect(bg.list().map((t) => t.name)).toEqual(["a"]);
    await bg.agent(["stop", "a"], ws, who);
  });

  test("only runs inside the workspaces", async () => {
    const { bg, root } = setup();
    expect(await bg.agent(["start", "--", "true"], root, who)).toContain("runs in your workspace");
    expect(await bg.agent(["start", "--name", "x"], root, who)).toContain("give the command");
  });

  test("no jail on this hub: no background tasks", async () => {
    const { bg, ws } = setup({ shell: () => null });
    expect(await bg.agent(["start", "--", "true"], ws, who)).toContain("no jail");
  });

  test("a hub restart starts --restart tasks again and reports the others as stopped", async () => {
    const { ws, ends, stateFile, make } = setup();
    const first = make();
    await first.agent(["start", "--name", "keep", "--restart", "--", "sleep 30"], ws, who);
    await first.agent(["start", "--name", "once", "--", "sleep 30"], ws, who);
    expect(existsSync(stateFile)).toBe(true);
    first.closingDown();
    // A new hub reads the saved list (the old processes are left as they are here; on the hub they died with it).
    const second = make();
    await second.restore();
    const keep = second.list().find((t) => t.name === "keep")!, once = second.list().find((t) => t.name === "once")!;
    expect(keep.status).toBe("running");
    expect(keep.restarts).toBe(1);
    expect(once.status).toBe("stopped");
    expect(ends.map((e) => [e.task.name, e.why])).toEqual([["once", "hub-restart"]]);
    expect(readFileSync(join(ws, ".hearth-bg", "keep.log"), "utf8")).toContain("the hub restarted, so this started again");
    await second.agent(["stop", "keep"], ws, who);
    for (const t of first.list()) await first.agent(["stop", t.name], ws, who);
  });

  test("a --restart task the hub keeps going down right after starting isn't started again (out-of-memory loop)", async () => {
    const { ws, ends, make } = setup();
    let hub = make();
    await hub.agent(["start", "--name", "hog", "--restart", "--", "sleep 30"], ws, who);
    const hubs = [hub];
    for (let i = 0; i < MAX_QUICK_RESTARTS; i++) {
      hub.closingDown();
      hub = make();
      hubs.push(hub);
      await hub.restore();
    }
    const hog = hub.list().find((t) => t.name === "hog")!;
    expect(hog.status).toBe("failed");
    expect(hog.restarts).toBe(MAX_QUICK_RESTARTS - 1);
    expect(ends.map((e) => e.why)).toEqual(["restart-loop"]);
    expect(endedText(ends[0])).toContain("won't start again");
    for (const h of hubs) for (const t of h.list()) if (t.status === "running") await h.agent(["stop", t.name], ws, who);
  });

  test("a --restart task that ran a while before the hub restarted starts again every time", async () => {
    let now = 0;
    const { ws, ends, make } = setup({ now: () => now });
    let hub = make();
    await hub.agent(["start", "--name", "long", "--restart", "--", "sleep 30"], ws, who);
    const hubs = [hub];
    for (let i = 0; i < MAX_QUICK_RESTARTS + 2; i++) {
      now += 10 * 60_000;
      hub.closingDown();
      hub = make();
      hubs.push(hub);
      await hub.restore();
    }
    expect(hub.list()[0].status).toBe("running");
    expect(ends).toHaveLength(0);
    for (const h of hubs) for (const t of h.list()) if (t.status === "running") await h.agent(["stop", t.name], ws, who);
  });

  test("the end turn tells the agent to report, with the output as data", () => {
    const text = endedText({ task: { ...who, name: "sim", cmd: "python3 sim.py", cwd: "/w", log: ".hearth-bg/sim.log", restart: false, startedAt: 0, endedAt: 3600_000, status: "done", code: 0 }, why: "exited", tail: "avg 9 m" }, 3600_000);
    expect(text).toContain("finished: exit 0 after 1 h 0 min");
    expect(text).toContain("<untrusted>\navg 9 m\n</untrusted>");
    expect(text).toContain("Tell the user how it went");
  });

  test("the skill says to run long work in the background and keep talking to the user", () => {
    const s = backgroundSkill("http://127.0.0.1:1", "k");
    expect(s.description).toContain("keep talking with the user");
    expect(s.body).toContain("Reply right away");
    expect(s.body).toContain("never\nsleep or poll");
    expect(s.scripts["hearth-bg"]).toContain("/api/agent/bg");
    const prompt = buildPrompt({ mode: "job", input: "x" } as any, "claude");
    expect(prompt).toContain("start it with hearth-bg");
  });
});

describe("out of memory", () => {
  test("on Linux, runs start with a raised OOM score and keep their command (exec, same pid)", () => {
    const cmd = expendable(["claude", "-p", "it's \"quoted\""], "linux");
    expect(cmd.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(cmd[2]).toContain("/proc/self/oom_score_adj");
    expect(cmd.slice(3)).toEqual(["sh", "claude", "-p", "it's \"quoted\""]);
    expect(expendable(["claude"], "darwin")).toEqual(["claude"]);
  });

  test("the wrapped command runs with its arguments intact", async () => {
    const p = Bun.spawn(expendable(["printf", "%s|", "a b", "$HOME", "x;y"], "linux"), { stdout: "pipe" });
    expect(await new Response(p.stdout).text()).toBe("a b|$HOME|x;y|");
  });
});
