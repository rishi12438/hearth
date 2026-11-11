import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Background, backgroundSkill, endedText, type BgEnd } from "../src/background.ts";
import { buildPrompt } from "../src/brain.ts";

const who = { by: "Research", jobId: "j1", threadId: "t1" };

function setup(over: Partial<ConstructorParameters<typeof Background>[0]> = {}) {
  const root = mkdtempSync(join(tmpdir(), "hearth-bg-"));
  const ws = join(root, "brain", "workspaces", "sim");
  mkdirSync(ws, { recursive: true });
  const ends: BgEnd[] = [];
  const stateFile = join(root, "background", "tasks.json");
  const make = () => new Background({ roots: [join(root, "brain")], stateFile, shell: () => ({ prefix: [], env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: root } }), onEnd: (e) => { ends.push(e); }, ...over });
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
