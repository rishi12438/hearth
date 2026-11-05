import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, COLLECTIONS, type Store } from "../src/store/index.ts";
import { Hub } from "../src/hub.ts";
import { Brain } from "../src/brain.ts";
import { Scripts } from "../src/scripts.ts";
import { loadConfig } from "../src/config.ts";
import { Computers } from "../src/computers.ts";
import { browseHere } from "../src/computer.ts";
import { CLOUD_BROWSERS, STUCK, stuckHelp, stuckKind } from "../src/help.ts";
import { describeSkillStep } from "../src/brains/skills.ts";
import { OtherBrowser, macSession, otherBrowserSkill, parseArgv, type Act, type MacGate } from "../src/other-browser.ts";
import type { Approval, Job } from "../src/types.ts";

test("hearth-browser's words become one action", () => {
  expect(parseArgv(["open", "priceline.com", "a", "human", "check"])).toEqual({ action: "open", params: { url: "https://priceline.com/", why: "a human check" } });
  expect(parseArgv(["click", "e12"])).toEqual({ action: "click", params: { ref: "e12" } });
  expect(parseArgv(["click", '{"x":10,"y":20}'])).toEqual({ action: "click", params: { x: 10, y: 20 } });
  expect(parseArgv(["type", "e3", "Phoenix", "AZ"])).toEqual({ action: "type", params: { ref: "e3", text: "Phoenix AZ" } });
  expect(parseArgv(["screenshot", "full"])).toEqual({ action: "screenshot", params: { full_page: true } });
  expect(typeof parseArgv(["open", "file:///etc/passwd"])).toBe("string");
  expect(typeof parseArgv(["click", "submit"])).toBe("string");
  expect(String(parseArgv([]))).toContain("usage: hearth-browser");
});

/** A router with a pretend Mac that records what it's asked, and maybe a connected cloud-browser MCP server. */
function router(o: { mac?: string | null; gate?: MacGate } = {}) {
  const calls: { sid: string; a: Act }[] = [], asked: any[] = [];
  let mac = o.mac === undefined ? "Studio" : o.mac, gate: MacGate = o.gate ?? "ask";
  const b = new OtherBrowser({
    mac: { name: () => mac, act: async (sid, a) => { calls.push({ sid, a }); return { text: `mac ${a.action}` }; } },
    gate: async () => gate,
    ask: async (c) => { asked.push(c); gate = "pending"; },
  });
  return { b, calls, asked, setMac: (m: string | null) => { mac = m; }, setGate: (g: MacGate) => { gate = g; } };
}

test("Mac online: the first open asks once and waits; after Approve it runs there, in the conversation's session", async () => {
  const r = router();
  const told = await r.b.run(["open", "https://www.priceline.com/", "human check"], { threadId: "t1", jobId: "j1" });
  expect("text" in told && told.text).toContain("waits for their Approve");
  expect(r.asked).toEqual([{ threadId: "t1", jobId: "j1", url: "https://www.priceline.com/", why: "human check", mac: "Studio" }]);
  await r.b.run(["open", "https://www.priceline.com/"], { threadId: "t1" });
  expect(r.asked.length).toBe(1);
  expect(r.calls).toEqual([]);
  r.setGate("ok");
  const out = await r.b.run(["open", "https://www.priceline.com/"], { threadId: "t1" });
  expect("text" in out && out.text).toContain("Opened in Chrome on Studio");
  await r.b.run(["observe"], { threadId: "t1" });
  expect(r.calls.map((c) => c.a.action)).toEqual(["open", "observe"]);
  expect(r.calls[0].sid).toBe(macSession("t1"));
  expect(r.calls[0].a.params).toEqual({ url: "https://www.priceline.com/" });
  const where = await r.b.run(["where"], { threadId: "t1" });
  expect("text" in where && where.text).toContain("Chrome on Studio");
});

test("no Mac, or you said no: nothing opens, and the agent is sent to hearth-help stuck", async () => {
  const r = router({ mac: null });
  const out = await r.b.run(["open", "expedia.com"], { threadId: "t2" });
  expect("text" in out && out.text).toContain("Mac isn't online");
  expect("text" in out && out.text).toContain("hearth-help stuck blocked for what you can use instead");
  const no = router({ gate: "no" });
  const t = await no.b.run(["open", "expedia.com"], { threadId: "t1" });
  expect("text" in t && t.text).toContain("said no");
  expect(r.asked).toEqual([]);
  expect([...r.calls, ...no.calls]).toEqual([]);
});

test("commands before an open, and a Mac that went offline mid-way", async () => {
  const r = router({ gate: "ok" });
  const t = await r.b.run(["observe"], { threadId: "t1" });
  expect("text" in t && t.text).toContain("Start with: hearth-browser open");
  await r.b.run(["open", "kayak.com"], { threadId: "t1" });
  r.setMac(null);
  const gone = await r.b.run(["observe"], { threadId: "t1" });
  expect("text" in gone && gone.text).toContain("went offline");
  expect("text" in gone && gone.text).toContain("hearth-help stuck");
});

// ---- hearth-help stuck

test("stuck kinds: each has a name, other words for it, and steps that end in telling the user plainly", () => {
  expect(stuckKind("bot-detection")!.id).toBe("blocked");
  expect(stuckKind("Can't scrape")?.id).toBe("blocked");
  expect(stuckKind("login")!.id).toBe("signed-out");
  expect(stuckKind("no tool")!.id).toBe("no-access");
  expect(stuckKind("error")!.id).toBe("failing");
  expect(stuckKind("nope")).toBeNull();
  const words = STUCK.flatMap((k) => [k.id, ...k.aka]);
  expect(new Set(words).size).toBe(words.length); // no word means two kinds
  for (const k of STUCK) {
    const out = stuckHelp(k.id, { mac: null, gate: null, servers: [] });
    expect(out).toStartWith(`You're stuck (${k.id}: ${k.when}).`);
    expect(out).toContain("tell the user plainly");
  }
  expect(stuckHelp("failing", { mac: null, gate: null, servers: [] })).toContain("hearth-lead");
  expect(stuckHelp("no-access", { mac: null, gate: null, servers: [] })).toContain("hearth-mcp add <https url> <name>");
});

const server = (name: string, url: string, state: string): any => ({ name, url, state, enabled: true, tools: [], ask: [], why: {}, auth: "key", checking: false, addedBy: "x", addedAt: "" });

test("stuck, Mac online: ask the user to use it; already allowed: just open it", () => {
  const ask = stuckHelp("blocked", { mac: "Studio", gate: "ask", servers: [] });
  expect(ask).toContain("Ask the user if you can use Chrome on their Mac (Studio)");
  expect(ask).toContain('hearth-browser open <url> "<what blocked you, in a few words>"');
  expect(ask.indexOf("Studio")).toBeLessThan(ask.indexOf(CLOUD_BROWSERS[0].label));
  const ok = stuckHelp("blocked", { mac: "Studio", gate: "ok", servers: [] });
  expect(ok).toContain("is yours in this conversation already");
  const no = stuckHelp("blocked", { mac: "Studio", gate: "no", servers: [] });
  expect(no).not.toContain("Chrome on Studio");
});

test("stuck, no Mac: a connected cloud browser first; else add one yourself, with its free plan and how it signs in", () => {
  const [first, second] = CLOUD_BROWSERS;
  const on = stuckHelp("blocked", { mac: null, gate: null, servers: [server(first.name, first.url, "connected")] });
  expect(on).toContain(`${first.label} is connected as the MCP server ${first.name}`);
  expect(on).toContain(`If that one can't get through either, add another yourself: ${second.label}`);
  const none = stuckHelp("blocked", { mac: null, gate: null, servers: [] });
  expect(none).toContain(`hearth-mcp add ${first.url} ${first.name}`);
  expect(none).toContain(first.free);
  expect(none).toContain("no need to ask the user to do it");
  for (const b of CLOUD_BROWSERS.slice(1)) expect(none).toContain(`hearth-mcp add ${b.url} ${b.name}`);
  // Asked already and waiting: says so, doesn't add it again.
  const waiting = stuckHelp("blocked", { mac: null, gate: null, servers: [server(first.name, first.url, "pending")] });
  expect(waiting).toContain("waits for the user's Approve");
  expect(waiting).not.toContain(`hearth-mcp add ${first.url}`);
  // A key provider, approved but not signed in: get the key yourself, in the right place.
  const bb = CLOUD_BROWSERS.find((b) => b.key?.query)!;
  const keyless = stuckHelp("blocked", { mac: null, gate: null, servers: [server(bb.name, bb.url, "signin")] });
  expect(keyless).toContain(`hearth-mcp key ${bb.name} <key> ?${bb.key!.query}`);
  expect(keyless).toContain("never a paid one");
});

test("hub: hearth-help stuck reads the Mac, this conversation's answer and the MCP servers", async () => {
  hub.macName = () => "Studio";
  await store.put<Job>("jobs", { id: "j1", createdAt: new Date().toISOString(), task: "cars", status: "working", threadId: "t1" } as Job);
  expect(await hub.helpAgent(["stuck", "bot-detection", "priceline", "press-and-hold"], "j1")).toContain("Ask the user if you can use Chrome on their Mac (Studio)");
  await hub.setAlwaysAllowed(["browser:mac"]);
  expect(await hub.helpAgent(["stuck", "blocked", "x"], "j1")).toContain("is yours in this conversation already");
  // Signed out: the Mac's Chrome has their logins, and connection.refresh.
  const login = await hub.helpAgent(["stuck", "login", "amazon"], "j1");
  expect(login).toContain("You're stuck (signed-out:");
  expect(login).toContain("Chrome on Studio");
  expect(login).toContain("connection.refresh {site}");
  hub.macName = () => null;
  expect(await hub.helpAgent(["stuck", "blocked", "x"], "j1")).toContain("hearth-mcp add");
  // Waiting: names what's waiting for this job.
  await store.put<Approval>("approvals", { id: "ap9", createdAt: new Date().toISOString(), jobId: "j1", threadId: "t1", summary: "Send the email to Sam", action: { type: "message", channel: "gmail", to: "s@x.com", text: "hi" }, status: "pending" } as Approval);
  expect(await hub.helpAgent(["stuck", "waiting"], "j1")).toContain("Waiting now: Send the email to Sam");
  // No kind, or one it doesn't know: the menu, so it picks.
  for (const argv of [["stuck"], ["stuck", "priceline", "blocked"]]) {
    const menu = await hub.helpAgent(argv, "j1");
    for (const k of STUCK) expect(menu).toContain(`  ${k.id}`);
  }
  expect(await hub.helpAgent([], "j1")).toContain("hearth-help topics");
  // Words after the kind change nothing in the answer (the hub ignores them).
  expect(await hub.helpAgent(["stuck", "failing", "curl", "keeps", "timing", "out"], "j1")).toBe(await hub.helpAgent(["stuck", "failing"], "j1"));
});

// ---- the Mac link

function fakeSocket() {
  const sent: any[] = [];
  return { sent, send(d: string) { sent.push(JSON.parse(d)); }, close() {} };
}

test("the hub sends a browser command to your Mac only, and gets its answer (text or a screenshot)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-ob-"));
  const c = new Computers({ dataDir: dir, homeDir: dir, acceptCopies: true });
  const box = fakeSocket();
  c.attach("box", "Sandbox", box, [], true);
  c.message("box", JSON.stringify({ t: "hello", harnesses: ["claude"], platform: "darwin" }));
  expect(c.macName()).toBeNull();
  const ws = fakeSocket();
  c.attach("mac1", "Studio", ws);
  c.message("mac1", JSON.stringify({ t: "hello", harnesses: ["claude"], platform: "darwin" }));
  expect(c.macName()).toBe("Studio");
  const p = c.browse("hearth-other-abc123", "observe", {});
  const m = ws.sent.find((x) => x.t === "browse");
  expect(m).toMatchObject({ sid: "hearth-other-abc123", action: "observe", params: {} });
  c.message("mac1", JSON.stringify({ t: "browsed", id: m.id, ok: true, out: '{"tree":"…"}' }));
  expect(await p).toEqual({ text: '{"tree":"…"}' });
  const s = c.browse("hearth-other-abc123", "screenshot", {});
  const m2 = ws.sent.filter((x) => x.t === "browse").at(-1);
  c.message("mac1", JSON.stringify({ t: "browsed", id: m2.id, ok: true, png: Buffer.from("JPG").toString("base64"), mime: "image/jpeg" }));
  const shot: any = await s;
  expect(Buffer.from(shot.png).toString()).toBe("JPG");
  expect(shot.mime).toBe("image/jpeg");
  const bad = c.browse("hearth-other-abc123", "click", { ref: "e9" });
  const m3 = ws.sent.filter((x) => x.t === "browse").at(-1);
  c.message("mac1", JSON.stringify({ t: "browsed", id: m3.id, ok: false, out: "no element e9" }));
  await expect(bad).rejects.toThrow("no element e9");
  // Going offline mid-command fails it rather than hanging.
  const hung = c.browse("hearth-other-abc123", "observe", {});
  c.detach("mac1");
  await expect(hung).rejects.toThrow("went offline");
  expect(box.sent.some((x) => x.t === "browse")).toBe(false);
});

test("on the Mac: a fresh session opens a visible Chrome; screenshots are read off disk; odd sessions are refused", async () => {
  const ran: string[][] = [];
  const dir = mkdtempSync(join(tmpdir(), "hearth-ob-mac-"));
  const png = join(dir, "s.png");
  writeFileSync(png, "PNGBYTES");
  const run = async (argv: string[]) => {
    ran.push(argv);
    if (argv[0] === "session" && argv[1] === "get") return { code: 1, out: '{"message":"no session"}' };
    if (argv[3] === "screenshot") return { code: 0, out: JSON.stringify({ file: png }) };
    return { code: 0, out: '{"ok":true}' };
  };
  const r = await browseHere("hearth-other-abc123", "open", { url: "https://priceline.com/" }, { bin: "/x/enkidu-browser", run });
  expect(r.ok).toBe(true);
  expect(ran.map((a) => a.slice(0, 2).join(" "))).toEqual(["session get", "session close", "session new", "session use"]);
  expect(JSON.parse(ran.at(-1)![4])).toEqual({ url: "https://priceline.com/", headless: false });
  const s = await browseHere("hearth-other-abc123", "screenshot", {}, { bin: "/x/enkidu-browser", run });
  expect(Buffer.from(s.png!, "base64").toString()).toBe("PNGBYTES");
  expect((await browseHere("../../etc", "observe", {}, { bin: "/x", run })).ok).toBe(false);
  expect((await browseHere("hearth-other-abc123", "record", {}, { bin: "/x", run })).ok).toBe(false);
  expect((await browseHere("hearth-other-abc123", "observe", {}, { bin: null, run })).out).toContain("no enkidu-browser");
});

// ---- the hub: the card, Approve, No, Always allow

let dir: string, store: Store, hub: Hub;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hearth-ob-hub-"));
  store = await createStore(process.env.TEST_DB || "sqlite::memory:", dir);
  for (const c of COLLECTIONS) await store.clear(c);
  const config = { ...loadConfig({}), dataDir: dir, agent: "echo" };
  hub = new Hub(config, store, new Brain(config), new Scripts(store, dir, join(import.meta.dir, "../scripts")), null);
});
afterEach(async () => { hub.stop(); await hub.idle(20_000); await store.close(); });

test("hub: one card per conversation; Approve opens the Mac there; No and Always allow are remembered", async () => {
  const calls: string[] = [];
  hub.otherBrowser = new OtherBrowser({
    mac: { name: () => "Studio", act: async (_sid, a) => { calls.push(a.action); return { text: "ok" }; } },
    gate: (t) => hub.macBrowserGate(t), ask: (c) => hub.requestMacBrowser(c),
  });
  await store.put<Job>("jobs", { id: "j1", createdAt: new Date().toISOString(), task: "rental car prices", status: "working", threadId: "t1" } as Job);
  const told = await hub.browserAgent(["open", "https://www.priceline.com/", "a human check"], "j1");
  expect("text" in told && told.text).toContain("waits for their Approve");
  await hub.browserAgent(["open", "https://www.priceline.com/"], "j1");
  const cards = (await store.all<Approval>("approvals")).filter((a) => a.action.type === "browser");
  expect(cards.length).toBe(1);
  expect(cards[0]).toMatchObject({ threadId: "t1", jobId: "j1", summary: "Use Chrome on Studio for priceline.com" });
  expect(cards[0].details).toContain("a human check");
  expect(calls).toEqual([]);
  const r = await hub.decideApproval(cards[0].id, true);
  expect(r.value!.status).toBe("done");
  expect(r.value!.result).toContain("hearth-browser open https://www.priceline.com/");
  expect(await hub.macBrowserGate("t1")).toBe("ok");
  expect(await hub.macBrowserGate("t2")).toBe("ask");
  await hub.browserAgent(["open", "https://www.priceline.com/"], "j1");
  expect(calls).toEqual(["open"]);

  // Another conversation: No is remembered there.
  await store.put<Job>("jobs", { id: "j2", createdAt: new Date().toISOString(), task: "flights", status: "working", threadId: "t2" } as Job);
  await hub.browserAgent(["open", "https://www.expedia.com/"], "j2");
  const c2 = (await store.all<Approval>("approvals")).find((a) => a.action.type === "browser" && a.threadId === "t2")!;
  await hub.decideApproval(c2.id, false);
  expect(await hub.macBrowserGate("t2")).toBe("no");

  // Always allow: every conversation, no more cards.
  await store.put<Job>("jobs", { id: "j3", createdAt: new Date().toISOString(), task: "hotels", status: "working", threadId: "t3" } as Job);
  await hub.browserAgent(["open", "https://www.hotels.com/"], "j3");
  const c3 = (await store.all<Approval>("approvals")).find((a) => a.action.type === "browser" && a.threadId === "t3")!;
  await hub.decideApproval(c3.id, true, true);
  expect(await hub.alwaysAllowed()).toContain("browser:mac");
  expect(await hub.macBrowserGate("t9")).toBe("ok");
});

test("the thread's step line says when it's stuck and when it's on the Mac", () => {
  expect(describeSkillStep('hearth-help stuck blocked "priceline"')).toBe("Stuck (blocked): finding another way");
  expect(describeSkillStep("hearth-help stuck")).toBe("Stuck: working out what to do");
  expect(describeSkillStep('hearth-browser open https://priceline.com "human check"')).toBe("Opening the page in Chrome on your Mac");
  expect(describeSkillStep("hearth-browser click e3")).toBe("Using Chrome on your Mac");
});

test("the skill brings the command, and enkidu-browser's rules point to it", () => {
  const sk = otherBrowserSkill("http://127.0.0.1:1", "k");
  expect(sk.commands).toEqual(["hearth-browser"]);
  expect(sk.description).toMatch(/prove you are human/);
  expect(sk.body).toContain("hearth-browser open <url>");
  expect(readFileSync(join(import.meta.dir, "../src/brains/skills.ts"), "utf8")).toContain("hearth-help stuck blocked\\` and do what it says");
});

test("the command saves a screenshot where the agent works and prints its path", async () => {
  const srv = Bun.serve({ port: 0, fetch: async (req) => {
    const f = await req.formData();
    if (req.headers.get("x-hearth-agent") !== "k") return new Response("no", { status: 401 });
    return f.get("a") === "screenshot" ? new Response(new Blob([Buffer.from("PNG")]), { headers: { "Content-Type": "image/png" } }) : new Response(`said ${f.getAll("a").join(" ")}\n`);
  } });
  try {
    const sk = otherBrowserSkill(`http://127.0.0.1:${srv.port}`, "k");
    const work = mkdtempSync(join(tmpdir(), "hearth-ob-cmd-"));
    const cmd = join(work, "hearth-browser");
    writeFileSync(cmd, sk.scripts["hearth-browser"], { mode: 0o755 });
    const sh = async (...a: string[]) => { const p = Bun.spawn([cmd, ...a], { cwd: work, stdout: "pipe" }); const o = await new Response(p.stdout).text(); await p.exited; return o; };
    const out = await sh("screenshot");
    const file = JSON.parse(out).file;
    expect(file.startsWith(join(realpathSync(work), "hearth-browser-shots"))).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("PNG");
    expect(await sh("click", "e3")).toContain("said click e3");
  } finally { srv.stop(true); }
});
