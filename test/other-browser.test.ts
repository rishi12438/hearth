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
import { OtherBrowser, macSession, otherBrowserSkill, parseArgv, type Act, type MacGate, type MacMode } from "../src/other-browser.ts";
import { actionJs, chromeHere } from "../src/mac-chrome.ts";
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
function router(o: { mac?: string | null; gate?: MacGate; mode?: MacMode } = {}) {
  const calls: { sid: string; a: Act; mode: MacMode }[] = [], asked: any[] = [], frames: { jobId: string; n: number }[] = [];
  let mac = o.mac === undefined ? "Studio" : o.mac, gate: MacGate = o.gate ?? "ask", mode: MacMode = o.mode ?? "background";
  const b = new OtherBrowser({
    mac: { name: () => mac, act: async (sid, a, mode) => { calls.push({ sid, a, mode }); return { text: `mac ${a.action}`, frame: new Uint8Array([1, 2]) }; } },
    gate: async () => ({ state: gate, mode }),
    onFrame: (jobId, f) => frames.push({ jobId, n: f.length }),
    ask: async (c) => { asked.push(c); gate = "pending"; },
  });
  return { b, calls, asked, frames, setMac: (m: string | null) => { mac = m; }, setGate: (g: MacGate) => { gate = g; } };
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
  const out = await r.b.run(["open", "https://www.priceline.com/"], { threadId: "t1", jobId: "j1" });
  expect("text" in out && out.text).toContain("Opened in a background Chrome (the user watches in live view) on Studio");
  // The background Chrome's picture after each step goes to the job's live view, not to the agent.
  expect(r.frames).toEqual([{ jobId: "j1", n: 2 }]);
  expect("text" in out && "frame" in out).toBe(false);
  await r.b.run(["observe"], { threadId: "t1" });
  expect(r.calls.map((c) => c.a.action)).toEqual(["open", "observe"]);
  expect(r.calls[0].sid).toBe(macSession("t1"));
  expect(r.calls[0].a.params).toEqual({ url: "https://www.priceline.com/" });
  const where = await r.b.run(["where"], { threadId: "t1" });
  expect("text" in where && where.text).toContain("a background Chrome on Studio");
  expect(r.calls.every((c) => c.mode === "background")).toBe(true);
});

test("you picked your own Chrome: every command goes there", async () => {
  const r = router({ gate: "ok", mode: "mine" });
  const out = await r.b.run(["open", "kayak.com"], { threadId: "t1" });
  expect("text" in out && out.text).toContain("the user's own Chrome");
  await r.b.run(["click", "e4"], { threadId: "t1" });
  expect(r.calls.map((c) => c.mode)).toEqual(["mine", "mine"]);
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
  expect(ask).toContain("Pick one below");
  // The Mac comes before adding a cloud browser: none is suggested yet, only "ask again if they say no".
  expect(ask).not.toContain("hearth-mcp add");
  expect(ask).toContain("run hearth-help stuck blocked again");
  // A cloud browser that's connected already comes first, the Mac after it.
  const b = CLOUD_BROWSERS[0];
  const both = stuckHelp("blocked", { mac: "Studio", gate: "ask", servers: [server(b.name, b.url, "connected")] });
  expect(both.indexOf(`${b.label} is connected`)).toBeLessThan(both.indexOf("Chrome on their Mac"));
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

test("on the Mac, in the background: a fresh headless session, a live-view frame after each step; odd sessions are refused", async () => {
  const ran: string[][] = [];
  const dir = mkdtempSync(join(tmpdir(), "hearth-ob-mac-"));
  const png = join(dir, "s.png");
  writeFileSync(png, "PNGBYTES");
  const run = async (argv: string[]) => {
    ran.push(argv);
    if (argv[0] === "session" && argv[1] === "get") return { code: 1, out: '{"message":"no session"}' };
    if (argv[3] === "screenshot") return { code: 0, out: JSON.stringify({ method: "screenshot", ok: true, result: { file: png } }) };
    return { code: 0, out: '{"ok":true}' };
  };
  const r = await browseHere("hearth-other-abc123", "open", { url: "https://priceline.com/" }, { bin: "/x/enkidu-browser", run });
  expect(r.ok).toBe(true);
  expect(ran.map((a) => (a[1] === "use" ? a.slice(0, 4) : a.slice(0, 3)).join(" "))).toEqual(["session get hearth-other-abc123-0", "session close hearth-other-abc123-0", "session new hearth-other-abc123-1", "session use hearth-other-abc123-1 open", "session use hearth-other-abc123-1 screenshot"]);
  expect(JSON.parse(ran[3][4])).toEqual({ url: "https://priceline.com/", headless: true });
  // The frame is the picture shrunk with sips; this fake PNG isn't one, so there's no frame, and the answer still comes.
  expect(r.out).toBe('{"ok":true}');
  const quiet = await browseHere("hearth-other-abc123", "observe", {}, { bin: "/x/enkidu-browser", run, frames: false });
  expect(quiet.ok).toBe(true);
  expect(ran.at(-1)!.slice(3, 4)).toEqual(["observe"]);
  // Closed names can't be reused in enkidu-browser: opening again starts a fresh one.
  await browseHere("hearth-other-abc123", "close", {}, { bin: "/x/enkidu-browser", run });
  await browseHere("hearth-other-abc123", "open", { url: "https://kayak.com/" }, { bin: "/x/enkidu-browser", run, frames: false });
  expect(ran.filter((a) => a[1] === "new").map((a) => a[2])).toEqual(["hearth-other-abc123-1", "hearth-other-abc123-3"]);
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
    mac: { name: () => "Studio", act: async (_sid, a, mode) => { calls.push(`${a.action}:${mode}`); return { text: "ok" }; } },
    gate: (t) => hub.macBrowserChoice(t), ask: (c) => hub.requestMacBrowser(c),
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
  expect(cards[0].details).toContain("in the background");
  expect(cards[0].details).toContain("your own Chrome");
  const r = await hub.decideApproval(cards[0].id, true, false, "mine");
  expect(r.value!.status).toBe("done");
  expect(r.value!.result).toContain("The user's own Chrome");
  expect(r.value!.result).toContain("hearth-browser open https://www.priceline.com/");
  expect(await hub.macBrowserGate("t1")).toBe("ok");
  expect(await hub.macBrowserGate("t2")).toBe("ask");
  await hub.browserAgent(["open", "https://www.priceline.com/"], "j1");
  expect(calls).toEqual(["open:mine"]);
  expect(await hub.macBrowserChoice("t1")).toEqual({ state: "ok", mode: "mine" });

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
  await hub.decideApproval(c3.id, true, true, "background");
  expect(await hub.alwaysAllowed()).toContain("browser:mac");
  expect(await hub.macBrowserChoice("t9")).toEqual({ state: "ok", mode: "background" });
  // Always with the other button swaps it, rather than keeping both.
  await store.put<Job>("jobs", { id: "j4", createdAt: new Date().toISOString(), task: "x", status: "working", threadId: "t4" } as Job);
  await store.put<Approval>("approvals", { id: "ap4", createdAt: new Date().toISOString(), jobId: "j4", threadId: "t4", summary: "Use Chrome", action: { type: "browser", computer: "Studio", url: "https://x.com/", threadId: "t4" }, status: "pending" } as Approval);
  await hub.decideApproval("ap4", true, true, "mine");
  expect((await hub.alwaysAllowed()).filter((k) => k.startsWith("browser:"))).toEqual(["browser:mac:mine"]);
  expect(await hub.macBrowserChoice("t9")).toEqual({ state: "ok", mode: "mine" });
});

// ---- "Use my Chrome": AppleScript on a pretend Chrome

function fakeChrome(o: { jsOff?: boolean } = {}) {
  const tabs = new Map<string, { url: string }>(), ran: { what: string; arg: string }[] = [];
  let next = 100;
  const osa = async (script: string, args: string[]) => {
    if (script.includes("make new tab")) { const id = String(next++); tabs.set(id, { url: args[0] }); return { code: 0, out: id, err: "" }; }
    const [tid, what, arg] = args;
    ran.push({ what, arg });
    const t = tabs.get(tid);
    if (!t) return { code: 0, out: "NO_TAB", err: "" };
    if (what === "go") { t.url = arg; return { code: 0, out: "ok", err: "" }; }
    if (what === "loading") return { code: 0, out: "false", err: "" };
    if (what === "close") { tabs.delete(tid); return { code: 0, out: "ok", err: "" }; }
    if (what === "show") return { code: 0, out: "0,25,1280,825", err: "" };
    if (what === "js") {
      if (o.jsOff) return { code: 1, out: "", err: "execution error: Google Chrome got an error: Executing JavaScript through AppleScript is turned off. (12)" };
      if (arg.includes("elements")) return { code: 0, out: JSON.stringify({ url: t.url, title: "Cars", text: "Cars from $40", elements: ['e1 button "Search"'] }), err: "" };
      return { code: 0, out: JSON.stringify({ ok: true, url: t.url, title: "Cars" }), err: "" };
    }
    return { code: 1, out: "", err: "?" };
  };
  return { tabs, ran, osa };
}

test("your own Chrome: one tab per conversation, read and clicked with JavaScript, closed when done", async () => {
  const c = fakeChrome();
  const go = (a: string, p: Record<string, unknown> = {}) => chromeHere("hearth-other-aaa111", a, p, { osa: c.osa, sleep: async () => {} });
  expect((await go("observe")).out).toContain("Run hearth-browser open");
  const open = await go("open", { url: "https://www.priceline.com/" });
  expect(open.ok).toBe(true);
  expect(c.tabs.size).toBe(1);
  // Opening again reuses that tab instead of making another.
  await go("navigate", { url: "https://www.priceline.com/rental-cars/" });
  expect(c.tabs.size).toBe(1);
  expect([...c.tabs.values()][0].url).toBe("https://www.priceline.com/rental-cars/");
  expect((await go("observe")).out).toContain("Cars from $40");
  await go("click", { ref: "e1" });
  expect(c.ran.some((r) => r.what === "js" && r.arg.includes('"e1"') && r.arg.includes(".click()"))).toBe(true);
  // A different conversation gets its own tab.
  await chromeHere("hearth-other-bbb222", "open", { url: "https://kayak.com/" }, { osa: c.osa, sleep: async () => {} });
  expect(c.tabs.size).toBe(2);
  expect((await go("close")).ok).toBe(true);
  expect(c.tabs.size).toBe(1);
  expect((await go("open", { url: "file:///etc/passwd" })).ok).toBe(false);
});

test("your own Chrome: its off switch is explained in plain words", async () => {
  const c = fakeChrome({ jsOff: true });
  const r = await chromeHere("hearth-other-ccc333", "open", { url: "https://x.com/" }, { osa: c.osa, sleep: async () => {} });
  expect(r.ok).toBe(false);
  expect(r.out).toContain("View → Developer → Allow JavaScript from Apple Events");
});

test("the JavaScript for each action only ever carries the values as JSON", () => {
  const nasty = `"); alert(1); ("`;
  expect(actionJs("type", { ref: "e2", text: nasty })).toContain(JSON.stringify(nasty));
  expect(actionJs("evaluate", { expression: nasty })).toContain(JSON.stringify(nasty));
  expect(actionJs("press", { key: "Nope" })).toBeNull();
  expect(actionJs("press", { key: "Enter" })).toContain("requestSubmit");
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
