import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, COLLECTIONS, type Store } from "../src/store/index.ts";
import { Hub } from "../src/hub.ts";
import { Brain } from "../src/brain.ts";
import { Scripts } from "../src/scripts.ts";
import { loadConfig } from "../src/config.ts";
import { Computers } from "../src/computers.ts";
import { RunElsewhere, diff, execHere, parseRunArgv, runElsewhereSkill, safeRel, scan, type RunGate } from "../src/run-elsewhere.ts";
import type { Approval } from "../src/types.ts";

test("hearth-run's words", () => {
  expect(parseRunArgv(["list"])).toBe("list");
  expect(parseRunArgv(["mac", "--why", "needs Xcode", "--", "xcodebuild", "-scheme", "App"])).toEqual({ place: "mac", why: "needs Xcode", cmd: "xcodebuild -scheme App", bg: false, with: [], get: [], timeoutMin: 30 });
  expect(parseRunArgv(["box", "--bg", "npm", "run", "dev"])).toMatchObject({ place: "box", bg: true, cmd: "npm run dev" });
  expect(parseRunArgv(["mac", "--get", "./out/video.mp4"])).toMatchObject({ get: ["out/video.mp4"], cmd: "true" });
  expect(String(parseRunArgv(["mac", "--with", "../secret", "--", "ls"]))).toContain("inside your folder");
  expect(String(parseRunArgv(["mac"]))).toContain("usage: hearth-run");
  expect(safeRel("a/b.txt")).toBe("a/b.txt");
  for (const bad of ["/etc/passwd", "../x", "a/../b", "a//b", ""]) expect(safeRel(bad)).toBeNull();
});

test("scan skips symlinks and build folders; diff sees changes and deletions", () => {
  const d = mkdtempSync(join(tmpdir(), "hr-scan-"));
  writeFileSync(join(d, "a.txt"), "a");
  mkdirSync(join(d, "node_modules"));
  writeFileSync(join(d, "node_modules", "x.js"), "x");
  symlinkSync("/etc/hosts", join(d, "link"));
  const m = scan(d);
  expect(Object.keys(m)).toEqual(["a.txt"]);
  writeFileSync(join(d, "a.txt"), "changed");
  writeFileSync(join(d, "b.txt"), "b");
  rmSync(join(d, "a.txt"));
  expect(diff(m, scan(d, m))).toEqual({ changed: ["b.txt"], deleted: ["a.txt"] });
});

/** A hub folder, a pretend computer (its home in a temp folder, talking to a real Computers over a fake socket). */
function rig(o: { gate?: RunGate; mac?: boolean; old?: boolean; onBgEnd?: (w: any, text: string) => Promise<void>; busy?: (t: string) => boolean } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "hr-")));
  const root = join(base, "brain"), ws = join(root, "workspaces", "app"), home = join(base, "mac-home"), state = join(base, "run-sync");
  mkdirSync(ws, { recursive: true });
  const computers = new Computers({ dataDir: base, homeDir: base, acceptCopies: false });
  const asked: any[] = [];
  let gate: RunGate = o.gate ?? "ok";
  const socket = {
    send(raw: string) {
      const m = JSON.parse(raw);
      if (m.t !== "exec") return;
      void execHere(m, {
        home, side: "Studio",
        fetchIn: async (tid, to) => { writeFileSync(to, readFileSync(computers.stagedFile("d1", tid)!)); },
        sendUp: async (file) => { expect(await computers.takeUpload("d1", m.id, readFileSync(file).buffer as ArrayBuffer, join(state, "tmp"))).toBe(true); },
      }).then((r) => computers.message("d1", JSON.stringify({ t: "execd", id: m.id, ...r })));
    },
    close() {},
  };
  computers.attach("d1", "Studio", socket);
  computers.message("d1", JSON.stringify({ t: "hello", harnesses: [], platform: o.mac === false ? "linux" : "darwin", can: o.old ? [] : ["exec"] }));
  const run = new RunElsewhere({
    root, stateDir: state, places: () => computers.places(),
    exec: (id, req, staged, onLine) => computers.exec(id, req, staged, onLine),
    gate: async () => gate, ask: async (c) => { asked.push(c); gate = "pending"; },
    onBgEnd: o.onBgEnd, busy: o.busy, checkEveryMs: 3_600_000,
  });
  const there = (p: string) => {
    const runs = join(home, "Hearth", "runs");
    const dirs = existsSync(runs) ? require("node:fs").readdirSync(runs).filter((n: string) => !n.startsWith(".")) : [];
    return join(runs, dirs[0] || "none", p);
  };
  return { base, root, ws, home, run, asked, there, setGate: (g: RunGate) => { gate = g; }, go: (argv: string[], cwd = ws) => run.run(argv, { threadId: "t1", jobId: "j1", cwd }) };
}

test("asks first: no run, no copy until the user says yes", async () => {
  const r = rig({ gate: "ask" });
  writeFileSync(join(r.ws, "main.swift"), "print(1)");
  const out = await r.go(["mac", "--why", "it needs Xcode", "--", "echo hi"]);
  expect(out.code).toBe(3);
  expect(out.text).toContain("waits for the user's Yes");
  expect(out.text).toContain("Can I run this on your Mac? it needs Xcode");
  expect(r.asked).toEqual([expect.objectContaining({ threadId: "t1", jobId: "j1", cmd: "echo hi", why: "it needs Xcode" })]);
  expect(existsSync(join(r.home, "Hearth"))).toBe(false);
  // Asking again while the card waits doesn't make a second card.
  await r.go(["mac", "--", "echo hi"]);
  expect(r.asked.length).toBe(1);
  r.setGate("no");
  expect((await r.go(["mac", "--", "echo hi"])).text).toContain("said no");
});

test("copies the folder there, runs, and brings changes back; next time only what changed", async () => {
  const r = rig();
  writeFileSync(join(r.ws, "in.txt"), "hello");
  mkdirSync(join(r.ws, "src"));
  writeFileSync(join(r.ws, "src", "old.txt"), "old");
  const one = await r.go(["mac", "--", "cat in.txt; echo built > out.txt; rm src/old.txt; mkdir -p dist && echo x > dist/app.bin; exit 4"]);
  expect(one.code).toBe(4);
  expect(one.text).toContain("Ran on Studio: exit 4");
  expect(one.text).toContain("Copied 2 changed files there first.");
  expect(one.text).toContain("hello");
  expect(readFileSync(join(r.ws, "out.txt"), "utf8")).toBe("built\n");
  expect(readFileSync(join(r.ws, "dist", "app.bin"), "utf8")).toBe("x\n");
  expect(existsSync(join(r.ws, "src", "old.txt"))).toBe(false);
  // Second run: nothing new; the hub's edit and deletion go over, nothing else.
  writeFileSync(join(r.ws, "in.txt"), "again");
  rmSync(join(r.ws, "out.txt"));
  const two = await r.go(["mac", "--", "cat in.txt; ls"]);
  expect(two.text).toContain("Copied 1 changed file there first.");
  expect(two.text).toContain("again");
  expect(two.text).not.toContain("out.txt");
  expect(two.text).toContain("It changed no files.");
  expect(existsSync(r.there("out.txt"))).toBe(false);
});

test("a file changed on both sides keeps both", async () => {
  const r = rig();
  writeFileSync(join(r.ws, "notes.md"), "v1");
  await r.go(["mac", "--", "true"]);
  // Changed on the Mac (a background job, say) and on the hub before the next run.
  writeFileSync(r.there("notes.md"), "mac edit");
  writeFileSync(join(r.ws, "notes.md"), "hub edit");
  const out = await r.go(["mac", "--", "cat notes.md"]);
  expect(out.text).toContain("hub edit");
  expect(out.text).toContain("changed on both sides");
  expect(readFileSync(join(r.ws, "notes.md"), "utf8")).toBe("hub edit");
  expect(readFileSync(join(r.ws, "notes.on-studio.md"), "utf8")).toBe("mac edit");
});

test("big files stay put unless asked for", async () => {
  const r = rig();
  writeFileSync(join(r.ws, "small.txt"), "s");
  writeFileSync(join(r.ws, "huge.bin"), Buffer.alloc(26 * 1024 * 1024));
  const out = await r.go(["mac", "--", "ls; head -c 27000000 /dev/zero > made.bin"]);
  expect(out.text).toContain("Not copied there (big): huge.bin");
  expect(out.text).not.toContain("huge.bin\n");
  expect(out.text).toContain("Left on Studio (big): made.bin");
  expect(existsSync(join(r.ws, "made.bin"))).toBe(false);
  const got = await r.go(["mac", "--get", "made.bin"]);
  expect(got.text).toContain("Back here, changed: made.bin");
  expect(readFileSync(join(r.ws, "made.bin")).length).toBe(27_000_000);
  const sent = await r.go(["mac", "--with", "huge.bin", "--", "ls -l huge.bin | wc -l"]);
  expect(sent.text).toContain("Copied 1 changed file there first.");
}, 30_000);

test("the machine lost its copy: the hub sends everything again", async () => {
  const r = rig();
  writeFileSync(join(r.ws, "a.txt"), "a");
  await r.go(["mac", "--", "true"]);
  rmSync(join(r.home, "Hearth"), { recursive: true, force: true });
  const out = await r.go(["mac", "--", "cat a.txt"]);
  expect(out.code).toBe(0);
  expect(out.text).toContain("Copied 1 changed file there first.");
});

test("only the workspace can be copied, and only to a machine that's there", async () => {
  const r = rig();
  expect((await r.go(["mac", "--", "ls"], r.base)).text).toContain("has to be your workspace");
  expect((await r.go(["mac", "--", "ls"], r.root)).text).toContain("has to be your workspace");
  expect((await r.go(["pc", "--", "ls"])).text).toContain('no machine called "pc"');
  expect((await r.go(["list"])).text).toContain("- mac (Studio): the user's own Mac");
  // A symlink in the folder isn't followed out of it.
  symlinkSync("/etc", join(r.ws, "etc"));
  await r.go(["mac", "--", "true"]);
  expect(existsSync(r.there("etc"))).toBe(false);
});

test("an older Mac app that can't take runs says so right away", async () => {
  const r = rig({ old: true });
  const out = await r.go(["mac", "--", "ls"]);
  expect(out.code).toBe(3);
  expect(out.text).toContain("too old for hearth-run");
  expect((await r.go(["list"])).text).toContain("needs an update");
});

test("--bg starts it and returns", async () => {
  const r = rig({ mac: false });
  const out = await r.go(["studio", "--bg", "--", "echo started; sleep 0.2; echo later"]);
  expect(out.text).toContain("Started on Studio.");
  expect(out.text).toMatch(/pid \d+/);
  await Bun.sleep(600);
  const next = await r.go(["studio", "--", "cat .hearth-bg/*.log"]);
  expect(next.text).toContain("later");
  expect(next.text).toMatch(/Back here, changed: .*\.hearth-bg\//);
});

test("--bg: the hub watches it and gives the conversation a turn when it ends, with the exit code and its files", async () => {
  const ended: { w: any; text: string }[] = [];
  let busy = false;
  const r = rig({ mac: true, onBgEnd: async (w, text) => { ended.push({ w, text }); }, busy: () => busy });
  const out = await r.go(["mac", "--bg", "--", "echo flying; sleep 0.4; echo landed > result.txt; echo done-flying"]);
  expect(out.text).toContain("Started on Studio.");
  expect(out.text).toContain("don't wait or check on it now");
  expect(r.run.bgRuns("t1")).toEqual([expect.objectContaining({ threadId: "t1", jobId: "j1", cmd: expect.stringContaining("echo flying") })]);
  // Still going: nothing said.
  await r.run.checkBg();
  expect(ended).toEqual([]);
  await Bun.sleep(900);
  // A turn is working in that conversation: it waits, so copying files back doesn't race it.
  busy = true;
  await r.run.checkBg();
  expect(ended).toEqual([]);
  busy = false;
  await r.run.checkBg();
  expect(ended.length).toBe(1);
  expect(ended[0].w.threadId).toBe("t1");
  expect(ended[0].text).toContain("[Background run on the user's Mac finished: exit 0");
  expect(ended[0].text).toContain("done-flying");
  expect(ended[0].text).toMatch(/Back here, changed: .*result\.txt/);
  expect(readFileSync(join(r.ws, "result.txt"), "utf8")).toBe("landed\n");
  expect(r.run.bgRuns()).toEqual([]);
  // Said once.
  await r.run.checkBg();
  expect(ended.length).toBe(1);
});

test("--bg: a failed run says so, and watches survive a hub restart", async () => {
  const ended: string[] = [];
  const r = rig({ mac: true, onBgEnd: async (_w, text) => { ended.push(text); } });
  await r.go(["mac", "--bg", "--", "sleep 0.3; echo oops >&2; exit 4"]);
  // The hub restarts: a new RunElsewhere over the same state folder still knows the run.
  const again = new RunElsewhere({ root: r.root, stateDir: join(r.base, "run-sync"), places: () => (r.run as any).o.places(), exec: (r.run as any).o.exec,
    gate: async () => "ok", ask: async () => {}, onBgEnd: async (_w, text) => { ended.push(text); }, checkEveryMs: 3_600_000 });
  expect(again.bgRuns().length).toBe(1);
  await Bun.sleep(700);
  await again.checkBg();
  expect(ended.length).toBe(1);
  expect(ended[0]).toContain("failed: exit 4");
  expect(ended[0]).toContain("oops");
});

test("the skill's command passes the exit code through", () => {
  const s = runElsewhereSkill("http://127.0.0.1:1", "k");
  expect(s.commands).toEqual(["hearth-run"]);
  expect(s.scripts["hearth-run"]).toContain('exit "$code"');
  expect(s.body).toContain("It asks the user first");
});

// ---------------------------------------------------------------- the hub's card

let dir: string, store: Store, hub: Hub;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hr-hub-"));
  store = await createStore(process.env.TEST_DB || "sqlite::memory:", dir);
  for (const c of COLLECTIONS) await store.clear(c);
  const config = { ...loadConfig({}), dataDir: dir, agent: "echo" };
  hub = new Hub(config, store, new Brain(config), new Scripts(store, dir, join(import.meta.dir, "../scripts")), null);
});
afterEach(async () => { hub.stop(); await hub.idle(20_000); await store.close(); });

test("hub: one card per conversation and machine; Yes lets it run there, No is remembered, no Always", async () => {
  const place = { deviceId: "d1", name: "Studio", mac: true, online: true, platform: "darwin" };
  expect(await hub.runGate("t1", "d1")).toBe("ask");
  await hub.requestRun({ threadId: "t1", place, cmd: "xcodebuild build", why: "it needs Xcode" });
  const cards = (await store.all<Approval>("approvals")).filter((a) => a.action.type === "run");
  expect(cards.length).toBe(1);
  expect(cards[0].summary).toBe("Run code on your Mac (Studio)");
  expect(cards[0].details).toContain("it needs Xcode");
  expect(cards[0].details).toContain("xcodebuild build");
  expect(await hub.runGate("t1", "d1")).toBe("pending");
  expect(await hub.runGate("t2", "d1")).toBe("ask");
  const yes = await hub.decideApproval(cards[0].id, true, true);
  expect((yes as any).value.result).toContain("run the same hearth-run again");
  expect(await hub.runGate("t1", "d1")).toBe("ok");
  // Yes in one conversation (even with "always") is only for that one, and that machine.
  expect(await hub.runGate("t2", "d1")).toBe("ask");
  expect(await hub.runGate("t1", "d2")).toBe("ask");
  await hub.requestRun({ threadId: "t2", place, cmd: "ls" });
  const c2 = (await store.all<Approval>("approvals")).find((a) => a.action.type === "run" && a.status === "pending")!;
  await hub.decideApproval(c2.id, false);
  expect(await hub.runGate("t2", "d1")).toBe("no");
});
