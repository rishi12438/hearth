import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Background, backgroundSkill, bgView, codingAgent, commandLine, endedText, MAX_QUICK_RESTARTS, treeMemoryMB, type BgEnd } from "../src/background.ts";
import { describeSkillStep } from "../src/brains/skills.ts";
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

  test("each start says how busy the machine is, and warns when memory is nearly gone", async () => {
    let avail = 3000;
    const { bg, ws } = setup({ machine: () => ({ cores: 2, load: 2.4, availMB: avail, totalMB: 3800 }) });
    const ok = await bg.agent(["start", "--name", "a", "--", "sleep 5"], ws, who);
    expect(ok).toContain("Machine now: 2 CPU cores, load 2.4 (CPU fully busy); 2.9 GB of 3.7 GB memory free; 1 background task running.");
    avail = 400;
    const tight = await bg.agent(["start", "--name", "b", "--", "sleep 5"], ws, who);
    expect(tight).toContain("Started b");
    expect(tight).toContain("nearly out of memory when this started");
    expect(tight).toContain("one after another");
    await bg.agent(["stop", "b"], ws, who);
    await bg.agent(["stop", "a"], ws, who);
  });

  test("memory running low while tasks run: the biggest is stopped and its conversation told why", async () => {
    let avail = 3000, now = 1_000_000;
    let sizes: Record<string, number> = {};
    const { bg, ws, ends } = setup({ machine: () => ({ cores: 2, load: 3, availMB: avail, totalMB: 3800 }), now: () => now,
      memoryOf: (pids) => new Map(pids.map((p) => [p, sizes[bg.list().find((t) => t.pid === p)!.name] || 0])) });
    await bg.agent(["start", "--name", "old", "--", "sleep 30"], ws, who);
    now += 1000;
    await bg.agent(["start", "--name", "new", "--", "sleep 30"], ws, who);
    expect(bg.checkMemory()).toBeNull();
    // A small newer task (a viewer) is left alone; the big older one goes.
    await bg.agent(["start", "--name", "tiny", "--", "sleep 30"], ws, who);
    sizes = { old: 300, new: 1900, tiny: 40 };
    avail = 200;
    expect(bg.checkMemory()).toBe("new");
    expect(bg.checkMemory()).toBeNull(); // one at a time: its memory gets time to come back
    await until(() => ends.length === 1);
    expect(ends[0].why).toBe("memory");
    expect(bg.list().find((t) => t.name === "new")!.status).toBe("stopped");
    expect(bg.list().find((t) => t.name === "old")!.status).toBe("running");
    const text = endedText(ends[0]);
    expect(text).toContain("nearly out of memory (0.2 GB free of 3.7 GB");
    expect(text).toContain("using the most (1.9 GB)");
    expect(text).toContain("one after another");
    // Started again (by an agent that may not have seen the notice): it starts, and the reply says why it stopped.
    expect(await bg.agent(["list"], ws, who)).toContain("machine ran out of memory (it used 1.9 GB)");
    const again = await bg.agent(["start", "--name", "new", "--", "sleep 30"], ws, who);
    expect(again).toContain("Started new");
    expect(again).toContain("the hub stopped new");
    expect(again).toContain("because the machine ran out of memory (it was using 1.9 GB)");
    await bg.agent(["stop", "new"], ws, who);
    await until(() => bg.list().find((t) => t.name === "new")!.status !== "running");
    now += 31_000;
    expect(bg.checkMemory()).toBe("old");
    await until(() => ends.length === 2);
    await bg.agent(["stop", "tiny"], ws, who);
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
    expect(prompt).toContain("NEVER SIT WAITING IN YOUR TURN");
    expect(prompt).toContain("hearth-bg here, hearth-run --bg on another machine");
    expect(s.body).not.toContain("wait a minute");
  });
});

describe("out of memory", () => {
  test("a process tree's memory counts everything under it", () => {
    if (process.platform !== "linux") return;
    const m = treeMemoryMB([process.pid]);
    expect(m.get(process.pid)!).toBeGreaterThan(5);
  });

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

describe("hearth-bg command words", () => {
  test("several words keep their quoting: bash -c '<script>' runs the whole script, not just its first word", async () => {
    const { bg, ws, ends } = setup();
    // How the agent's shell hands `hearth-bg start -- bash -c 'echo "$(cat spec.txt)" > out.txt'` to the hub.
    await Bun.write(join(ws, "spec.txt"), "the spec");
    const out = await bg.agent(["start", "--name", "wrapped", "--", "bash", "-c", 'echo "got: $(cat spec.txt)" > out.txt'], ws, who);
    expect(out).toContain("Started wrapped");
    await until(() => ends.length === 1);
    expect(ends[0].task.code).toBe(0);
    expect(readFileSync(join(ws, "out.txt"), "utf8").trim()).toBe("got: the spec");
  });

  test("one word is a shell line as is; several are quoted back", () => {
    expect(commandLine(["cd sim && python3 run.py --resume"])).toBe("cd sim && python3 run.py --resume");
    expect(commandLine(["python3", "run.py", "--resume"])).toBe("python3 run.py --resume");
    expect(commandLine(["bash", "-c", "a && b"])).toBe("bash -c 'a && b'");
    expect(commandLine(["echo", "it's"])).toBe("echo 'it'\\''s'");
  });

  test("won't start another coding agent to do the agent's own work", async () => {
    const { bg, ws } = setup();
    for (const words of [["bash", "-c", "codex exec --skip-git-repo-check \"$(cat spec.md)\""], ["codex exec - < spec.md"], ["cd x && claude -p 'write it'"], ["timeout", "3600", "codex", "exec", "go"]]) {
      expect(await bg.agent(["start", "--name", "build", "--", ...words], ws, who)).toContain("another coding agent");
    }
    expect(codingAgent("python3 scripts/codex_flight.py --realtime")).toBeNull();
    expect(codingAgent("bash scripts/run16_10hour.sh")).toBeNull();
    expect(codingAgent("cd sim && python3 run.py")).toBeNull();
  });

  test("the thread's view lists its tasks with their last lines", async () => {
    const { bg, ws, ends } = setup();
    await bg.agent(["start", "--name", "boom", "--", "echo oh no; exit 2"], ws, who);
    await until(() => ends.length === 1);
    const v = bgView(bg.list(), "t1");
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ name: "boom", status: "failed", code: 2, where: "hub", jobId: "j1" });
    expect(v[0].tail).toContain("oh no");
    expect(bgView(bg.list(), "other")).toHaveLength(0);
  });
});

describe("steps say when someone else is on it", () => {
  test("background, other machines, the lead, other coding agents", () => {
    expect(describeSkillStep("hearth-bg start --name run16 --restart -- bash x.sh")).toBe("Started in the background: run16");
    expect(describeSkillStep("hearth-bg status run16")).toBe("Checking on background work");
    expect(describeSkillStep("hearth-run mac --bg -- python3 x.py")).toBe("Started in the background on your Mac");
    expect(describeSkillStep('hearth-lead "which approach?"')).toBe("Asking the lead (a stronger model)");
    expect(describeSkillStep("cd w && codex exec - < spec.md")).toBe("Handing work to Codex");
    expect(describeSkillStep("python3 scripts/codex_flight.py")).toBeNull();
  });
});
