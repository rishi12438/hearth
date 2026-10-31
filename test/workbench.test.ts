import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createStore, COLLECTIONS, type Store } from "../src/store/index.ts";
import { Hub } from "../src/hub.ts";
import { Brain } from "../src/brain.ts";
import { Scripts } from "../src/scripts.ts";
import { Files } from "../src/files.ts";
import { loadConfig } from "../src/config.ts";
import { Vault } from "../src/vault.ts";
import { newPairingCode, redeemPairingCode } from "../src/auth.ts";
import { startServer } from "../src/server.ts";
import { DockerBench, PlainBench, Workbench, installsIn, dockerAvailable, type E2bSdk, type E2bBox } from "../src/workbench.ts";
import type { Job, WorkSession, WorkSettings } from "../src/types.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
const until = async (fn: () => boolean | Promise<boolean>, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end && !(await fn())) await Bun.sleep(25); };

async function bench(settings: Partial<WorkSettings> & { workbench: WorkSettings["workbench"] }, extra: Partial<ConstructorParameters<typeof Workbench>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "hearth-wb-"));
  const store: Store = await createStore("sqlite::memory:", dir);
  for (const c of COLLECTIONS) await store.clear(c);
  const files = new Files(store, dir);
  const vault = new Vault(dir, { masterKey: randomBytes(32) });
  const wb = new Workbench({ store, files, dataDir: dir, vault, settings: async () => ({ agent: "mac-first", ...settings }), docker: () => false, ...extra });
  cleanups.push(() => store.close());
  return { wb, store, files, vault, dir };
}

test("installs are noticed so the environment can be rebuilt later", () => {
  expect(installsIn("pip install pandas matplotlib && python x.py")).toEqual(["pip:pandas", "pip:matplotlib"]);
  expect(installsIn("sudo apt-get install -y ffmpeg; npm i sharp")).toEqual(["apt:ffmpeg", "npm:sharp"]);
  expect(installsIn("python make.py")).toEqual([]);
});

test("your setting decides the workbench; auto never falls back to plain", async () => {
  expect(await (await bench({ workbench: "off" })).wb.pick()).toBeNull();
  expect(await (await bench({ workbench: "auto" })).wb.pick()).toBeNull(); // no E2B, no Docker: nothing, not plain
  expect((await (await bench({ workbench: "plain" })).wb.pick())!.kind).toBe("plain");
  const withDocker = await bench({ workbench: "auto" }, { docker: () => true });
  expect((await withDocker.wb.pick())!.kind).toBe("docker");
  const withE2b = await bench({ workbench: "auto" }, { docker: () => true });
  withE2b.vault.set("e2b", "e2b_key_0000000000");
  expect((await withE2b.wb.pick())!.kind).toBe("e2b"); // E2B wins when connected
});

test("plain: tools work in the teammate's folder, write a session, and refuse paths and links that lead outside", async () => {
  const { wb, store } = await bench({ workbench: "plain" });
  const g = (await wb.open({ jobId: "j1", threadId: "t1", teammateId: "scout", teammateName: "Research", task: "make a chart" }))!;
  expect((await wb.tool(g.token, "write_file", { path: "hello.py", content: "print(6*7)" })).ok).toBe(true);
  const run = await wb.tool(g.token, "run", { command: "python3 hello.py || python hello.py" });
  expect(run.text).toContain("42");
  expect((await wb.tool(g.token, "write_file", { path: "../shared/notes.md", content: "for the team" })).ok).toBe(true);
  expect((await wb.tool(g.token, "read_file", { path: "../../../etc/passwd" })).text).toContain("Stay inside");
  // Code can make a link that points out; the tools still won't follow it.
  await wb.tool(g.token, "run", { command: "ln -s /etc/hosts sneaky" });
  expect((await wb.tool(g.token, "read_file", { path: "sneaky" })).ok).toBe(false);
  await wb.close(g.token, true);
  expect((await wb.tool(g.token, "run", { command: "echo hi" })).text).toContain("ended");
  const s = (await store.all<WorkSession>("sessions"))[0];
  expect(s).toMatchObject({ jobId: "j1", teammateId: "scout", machine: "plain", status: "done" });
  expect(s.folder.endsWith("/research")).toBe(true);
  expect(s.steps.map((x) => x.tool)).toEqual(["write_file", "run", "write_file", "read_file", "run", "read_file"]);
});

test("copy_in only reaches files from this chat; copy_out brings a file back to the chat", async () => {
  const { wb, files } = await bench({ workbench: "plain" });
  await files.save(new TextEncoder().encode("a,b\n1,2\n"), { name: "sales.csv", source: "you", threadId: "t1" });
  await files.save(new TextEncoder().encode("secret"), { name: "other.txt", source: "you", threadId: "t2" });
  const g = (await wb.open({ jobId: "j1", threadId: "t1", teammateName: "Research" }))!;
  expect((await wb.tool(g.token, "copy_in", { file: "other.txt" })).ok).toBe(false);
  expect((await wb.tool(g.token, "copy_in", { file: "sales.csv" })).ok).toBe(true);
  expect((await wb.tool(g.token, "run", { command: "wc -l < sales.csv && cp sales.csv out.csv" })).text).toContain("2");
  expect((await wb.tool(g.token, "copy_out", { path: "out.csv", name: "result.csv" })).text).toContain("Saved result.csv");
  const made = await wb.close(g.token, true);
  expect(made.length).toBe(1);
});

test("E2B: one shared sandbox, made once, resumed after a pause, and paused when idle", async () => {
  const calls: string[] = [];
  const fs = new Map<string, Uint8Array>();
  const box = (id: string): E2bBox => ({
    sandboxId: id,
    async run(cmd) { calls.push(`run ${cmd.slice(0, 20)}`); return { code: 0, stdout: "ok", stderr: "" }; },
    async write(p, d) { fs.set(p, d); }, async read(p) { return fs.get(p) || null; },
  });
  const sdk: E2bSdk = {
    async create() { calls.push("create"); return box("sb-1"); },
    async connect(_k, id) { calls.push(`connect ${id}`); return box(id); },
    async pause(_k, id) { calls.push(`pause ${id}`); },
  };
  let t = 1_000_000;
  const { wb, vault, dir } = await bench({ workbench: "auto" }, { e2bSdk: sdk, now: () => t });
  vault.set("e2b", "e2b_key_0000000000");
  const g = (await wb.open({ jobId: "j", teammateName: "Bills" }))!;
  expect((await wb.tool(g.token, "write_file", { path: "a.txt", content: "hi" })).ok).toBe(true);
  expect(fs.has("/home/user/work/bills/a.txt")).toBe(true);
  expect(calls[0]).toBe("create");
  expect(JSON.parse(readFileSync(join(dir, "workbench-e2b.json"), "utf8")).sandboxId).toBe("sb-1");
  const e2b: any = await wb.pick();
  t += 20 * 60_000;
  await e2b.idle(20 * 60_000);
  expect(calls.at(-1)).toBe("pause sb-1");
  await wb.tool(g.token, "read_file", { path: "a.txt" });
  expect(calls).toContain("connect sb-1"); // woke the same sandbox, didn't make another
  expect(calls.filter((c) => c === "create").length).toBe(1);
});

test.skipIf(!dockerAvailable())("Docker: a locked-down container runs the code, keeps files between jobs, and hands files back", async () => {
  const name = `hearth-test-${randomBytes(4).toString("hex")}`;
  const docker = new DockerBench({ name, volume: `${name}-vol`, memory: "512m" });
  cleanups.push(() => { Bun.spawnSync(["docker", "rm", "-f", name]); Bun.spawnSync(["docker", "volume", "rm", "-f", `${name}-vol`]); });
  const { wb } = await bench({ workbench: "docker" }, { dockerBench: docker });
  const g = (await wb.open({ jobId: "j1", threadId: "t1", teammateName: "Research" }))!;
  expect((await wb.tool(g.token, "write_file", { path: "sq.py", content: "import sys; print(sum(i*i for i in range(10)))" })).ok).toBe(true);
  expect((await wb.tool(g.token, "run", { command: "python sq.py" })).text).toContain("285");
  // It's not root and can't see the hub's files.
  expect((await wb.tool(g.token, "run", { command: "id -u" })).text).toContain("1000");
  expect((await wb.tool(g.token, "run", { command: `ls ${process.cwd()} 2>&1 || true` })).text).toMatch(/No such file|cannot access/);
  expect((await wb.tool(g.token, "copy_out", { path: "sq.py" })).ok).toBe(true);
  await wb.close(g.token, true);
  // The next job of the same teammate finds its file still there.
  const g2 = (await wb.open({ jobId: "j2", threadId: "t1", teammateName: "Research" }))!;
  expect((await wb.tool(g2.token, "read_file", { path: "sq.py" })).text).toContain("range(10)");
  await wb.close(g2.token, true);
}, 120_000);

test("end to end: a job's agent uses the tools through the MCP server and the hub; the session is logged and its file lands in the chat", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-wb-hub-"));
  const store = await createStore("sqlite::memory:", dir);
  for (const c of COLLECTIONS) await store.clear(c);
  const config = { ...loadConfig({ HEARTH_PORT: "0", HEARTH_AGENT: "echo" }), dataDir: dir };
  const hub = new Hub(config, store, new Brain(config), new Scripts(store, dir, join(import.meta.dir, "../scripts")), null);
  await hub.setPrefs({ tz: "UTC", work: { workbench: "plain" } });
  await hub.ensureTeammates();
  const phone = await redeemPairingCode(store, (await newPairingCode(store, "owner")).code, "Phone");
  const { server, computers, workbench } = await startServer(hub, null, { docker: () => false, checkE2b: async (k) => (k.startsWith("e2b_good") ? null : "E2B didn't accept that key.") });
  cleanups.push(async () => { workbench.stopTimer(); computers.stop(); server.stop(true); await store.close(); });
  const url = `http://127.0.0.1:${server.port}`;
  expect(hub.brain.toolUrl).toBe(url);
  const api = (p: string, init: RequestInit = {}) => fetch(url + p, { ...init, headers: { Authorization: `Bearer ${phone!.token}`, "Content-Type": "application/json" } });
  expect(((await (await api("/api/work")).json()) as any).workbench.kind).toBe("plain");

  // Stand in for Claude: when the job thinks, talk to the real MCP server the way Claude Code would.
  const think = hub.brain.think.bind(hub.brain);
  let sawToken = false;
  hub.brain.think = async (b, p, m) => {
    if (!b.workbench) return think(b, p, m);
    sawToken = true;
    const mcp = Bun.spawn([process.execPath, join(import.meta.dir, "../src/tools-mcp.ts")], {
      env: { ...process.env, HEARTH_TOOL_URL: url, HEARTH_TOOL_TOKEN: b.workbench.token }, stdin: "pipe", stdout: "pipe" });
    const msgs = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "write_file", arguments: { path: "plan.md", content: "# Day 1\\nTsukiji" } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "run", arguments: { command: "pip install --help >/dev/null 2>&1; wc -c plan.md" } } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "copy_out", arguments: { path: "plan.md", name: "tokyo-plan.md" } } },
    ];
    // One call at a time, waiting for each answer, like an agent working step by step.
    const out: any[] = [];
    const reader = mcp.stdout.getReader(); let buf = "";
    for (const x of msgs) {
      mcp.stdin.write(JSON.stringify(x) + "\n"); mcp.stdin.flush();
      while (!out.some((r) => r.id === x.id)) {
        const { value, done } = await reader.read(); if (done) break;
        buf += new TextDecoder().decode(value);
        let i; while ((i = buf.indexOf("\n")) >= 0) { out.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
      }
    }
    mcp.kill();
    expect(out.find((r) => r.id === 2).result.tools.map((t: any) => t.name)).toEqual(["run", "write_file", "read_file", "copy_in", "copy_out"]);
    expect(out.find((r) => r.id === 4).result.content[0].text).toContain("plan.md");
    expect(out.find((r) => r.id === 5).result.isError).toBe(false);
    return "Made your plan.";
  };
  await hub.ramble("plan day 1 in tokyo");
  await until(async () => (await store.all<Job>("jobs")).some((j) => j.status === "done" || j.status === "failed"), 15_000);
  const job = (await store.all<Job>("jobs"))[0];
  expect(sawToken).toBe(true);
  expect(job.status).toBe("done");
  expect(job.fileIds?.length).toBe(1);
  const sessions = (await (await api("/api/sessions")).json()) as WorkSession[];
  expect(sessions[0]).toMatchObject({ jobId: job.id, machine: "plain", status: "done" });
  expect(sessions[0].steps.map((s) => s.tool)).toEqual(["write_file", "run", "copy_out"]);
  // The job's key is dead once the job ends.
  const dead = await fetch(url + "/api/tool", { method: "POST", headers: { Authorization: "Bearer " + "x".repeat(32), "Content-Type": "application/json" }, body: JSON.stringify({ name: "run", arguments: { command: "id" } }) });
  expect(((await dead.json()) as any).ok).toBe(false);

  // Only the primary device changes where work runs, and "plain" must be asked for by name.
  const put = await api("/api/work", { method: "PUT", body: JSON.stringify({ workbench: "auto" }) });
  expect(((await put.json()) as any).settings).toEqual({ workbench: "auto" });

  // Connecting E2B: a bad key is turned away, a good one makes "auto" pick E2B.
  expect((await api("/api/work/e2b-key", { method: "POST", body: JSON.stringify({ key: "e2b_bad_0123456789" }) })).status).toBe(400);
  const on = (await (await api("/api/work/e2b-key", { method: "POST", body: JSON.stringify({ key: "e2b_good_0123456789" }) })).json()) as any;
  expect([on.e2b, on.workbench.kind]).toEqual([true, "e2b"]);
  const off = (await (await api("/api/work/e2b-key", { method: "DELETE" })).json()) as any;
  expect([off.e2b, off.workbench]).toEqual([false, null]);
}, 60_000);

test("tool calls made at the same time are all logged; none overwrite another", async () => {
  const { wb, store } = await bench({ workbench: "plain" });
  const g = (await wb.open({ jobId: "j", teammateName: "Research" }))!;
  await Promise.all([1, 2, 3, 4, 5].map((n) => wb.tool(g.token, "run", { command: `echo ${n}` })));
  await wb.close(g.token, true);
  expect((await store.all<WorkSession>("sessions"))[0].steps.length).toBe(5);
});
