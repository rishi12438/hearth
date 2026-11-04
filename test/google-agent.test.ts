import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/vault.ts";
import { Google, GOOGLE_SCOPES } from "../src/google.ts";
import { googleAgent, googleSkills, csvRows } from "../src/connectors/google-agent.ts";
import { Computers } from "../src/computers.ts";
import { describeSkillStep } from "../src/brains/skills.ts";

// The agent's Gmail, Drive and Calendar commands against a fake Google: what they read, what they may change, and how
// the bash commands reach the hub.

const CLIENT = "123-abc.apps.googleusercontent.com";
const ALL = GOOGLE_SCOPES.join(" ");
let g: Google, calls: { method: string; url: URL; body: string; type: string }[], scopes: string;
let events: Record<string, any>;

function fake(url: string, init: RequestInit = {}): Response {
  const u = new URL(url);
  const body = typeof init.body === "string" ? init.body : init.body instanceof Uint8Array ? Buffer.from(init.body).toString("utf8") : "";
  const method = init.method || "GET";
  calls.push({ method, url: u, body, type: String((init.headers as any)?.["Content-Type"] || "") });
  const ok = (j: unknown) => Response.json(j);
  if (u.pathname === "/token") {
    const p = new URLSearchParams(String(init.body));
    return p.get("grant_type") === "authorization_code" ? ok({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: scopes }) : ok({ access_token: "at", expires_in: 3600 });
  }
  if (u.pathname === "/v1/userinfo") return ok({ email: "rishi@example.com" });
  if (u.pathname.startsWith("/gmail/v1/users/me/threads/")) return ok({ messages: [
    { id: "a", threadId: "t1", snippet: "hi", payload: { headers: [{ name: "From", value: "x@y.com" }, { name: "Subject", value: "Order" }], mimeType: "text/plain", body: { data: Buffer.from("Your Lego order shipped").toString("base64url") } } },
    { id: "b", threadId: "t1", snippet: "thanks", payload: { headers: [{ name: "From", value: "me@y.com" }], mimeType: "text/plain", body: { data: Buffer.from("Thanks!").toString("base64url") } } }] });
  if (u.host === "www.googleapis.com" && u.pathname === "/drive/v3/files" && method === "POST")
    return ok({ id: "fold1", name: JSON.parse(body).name, mimeType: "application/vnd.google-apps.folder", webViewLink: "https://drive.google.com/drive/folders/fold1" });
  if (u.pathname === "/upload/drive/v3/files" && method === "POST") {
    const meta = JSON.parse(body.match(/\r\n\r\n(\{.*?\})\r\n/)![1]);
    return ok({ id: "new1", name: meta.name, mimeType: meta.mimeType || "text/plain", webViewLink: "https://docs.google.com/spreadsheets/d/new1" });
  }
  if (u.pathname === "/upload/drive/v3/files/new1" && method === "PATCH") return ok({ id: "new1" });
  if (u.pathname.startsWith("/drive/v3/files/") && !u.pathname.endsWith("/export"))
    return ok({ id: "new1", name: "Lego tracker", mimeType: "application/vnd.google-apps.spreadsheet", webViewLink: "https://docs.google.com/spreadsheets/d/new1" });
  if (u.pathname.endsWith("/export")) return new Response("Set,Price\n10294,679.99\n");
  if (u.host === "sheets.googleapis.com") return ok({ updates: { updatedRange: "Sheet1!A2:B3", updatedRows: JSON.parse(body).values.length } });
  if (u.pathname === "/calendar/v3/calendars/primary/events" && method === "POST") {
    const e = { id: "ev1", ...JSON.parse(body), htmlLink: "https://calendar.google.com/ev1", organizer: { self: true } };
    events.ev1 = e;
    return ok(e);
  }
  const ev = u.pathname.match(/\/calendar\/v3\/calendars\/primary\/events\/(\w+)$/);
  if (ev) {
    const e = events[ev[1]];
    if (!e) return new Response("nope", { status: 404 });
    if (method === "DELETE") { delete events[ev[1]]; return new Response(null, { status: 204 }); }
    if (method === "PATCH") { Object.assign(e, JSON.parse(body)); return ok(e); }
    return ok(e);
  }
  return new Response(`not faked: ${method} ${u}`, { status: 404 });
}

async function connect(withScopes = ALL) {
  scopes = withScopes;
  g.setClient(CLIENT, "GOCSPX-secret-value");
  const url = new URL(g.authUrl("https://hub.example.com/api/google/callback").value!);
  await g.finish("good", url.searchParams.get("state")!);
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-gagent-"));
  g = new Google(new Vault(dir, { masterKey: randomBytes(32) }), {});
  g.fetch = async (url, init) => fake(String(url), init);
  calls = []; events = {};
});

test("Google asks for saving to Drive (only Hearth's own files) and adding events; still nothing that deletes mail or shares files", () => {
  expect(GOOGLE_SCOPES).toContain("https://www.googleapis.com/auth/drive.file");
  expect(GOOGLE_SCOPES).toContain("https://www.googleapis.com/auth/calendar.events");
  expect(GOOGLE_SCOPES.join(" ")).not.toMatch(/auth\/drive( |$)|gmail\.modify|mail\.google\.com/);
});

test("not connected: every command says how to connect", async () => {
  await expect(googleAgent(g, "drive", ["search"])).rejects.toThrow("Connectors → Google");
});

test("gmail: a whole conversation, and the accounts with what each allows", async () => {
  await connect();
  const t: any = await googleAgent(g, "gmail", ["thread", "t1"]);
  expect(t.count).toBe(2);
  expect(t.mails[0]).toMatchObject({ from: "x@y.com", subject: "Order", text: "Your Lego order shipped" });
  const a: any = await googleAgent(g, "gmail", ["accounts"]);
  expect(a.accounts[0]).toMatchObject({ email: "rishi@example.com", canSend: true, canSaveToDrive: true, canAddEvents: true });
  await expect(googleAgent(g, "gmail", ["send", "x@y.com"])).rejects.toThrow("usage");
});

test("drive: a folder, then a Sheet from CSV inside it, rows appended, and the Sheet read back", async () => {
  await connect();
  const folder: any = await googleAgent(g, "drive", ["folder", "Lego", "orders"]);
  expect(folder).toMatchObject({ id: "fold1", name: "Lego orders", link: expect.stringContaining("fold1") });
  const sheet: any = await googleAgent(g, "drive", ["sheet", "Lego tracker", "--in", "fold1"], { body: "Set,Price\n10294,679.99\n" });
  expect(sheet).toMatchObject({ id: "new1", link: expect.stringContaining("spreadsheets") });
  const up = calls.find((c) => c.url.pathname === "/upload/drive/v3/files")!;
  expect(up.body).toContain('"mimeType":"application/vnd.google-apps.spreadsheet"');
  expect(up.body).toContain('"parents":["fold1"]');
  expect(up.body).toContain("Content-Type: text/csv\r\n\r\nSet,Price");
  await expect(googleAgent(g, "drive", ["sheet", "Empty"], { body: "  " })).rejects.toThrow("Pipe the CSV in");

  const add: any = await googleAgent(g, "drive", ["append", "new1"], { body: '75367,"1,099.99"\n\n10300,169.99\n' });
  expect(add.rows).toBe(2);
  expect(JSON.parse(calls.find((c) => c.url.host === "sheets.googleapis.com")!.body).values).toEqual([["75367", "1,099.99"], ["10300", "169.99"]]);

  const read: any = await googleAgent(g, "drive", ["read", "new1"]);
  expect(read.text).toContain("10294,679.99");
});

test("an older sign-in (read-only Drive and Calendar) gets a clear reconnect, not a Google 403", async () => {
  await connect("email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/drive.readonly");
  await expect(googleAgent(g, "drive", ["sheet", "x"], { body: "a,b" })).rejects.toThrow("reconnects");
  await expect(googleAgent(g, "calendar", ["add", "Dentist", "--start", "2026-11-05T15:00:00-08:00", "--end", "2026-11-05T16:00:00-08:00"])).rejects.toThrow("reconnects");
  expect(calls.some((c) => c.method === "POST" && c.url.host !== "oauth2.googleapis.com")).toBe(false);
});

test("calendar: add an event with no guests and no emails; once approved, move or remove any event", async () => {
  await connect();
  const e: any = await googleAgent(g, "calendar", ["add", "Dentist", "--start", "2026-11-05T15:00:00-08:00", "--end", "2026-11-05T16:00:00-08:00", "--location", "Main St"]);
  expect(e).toMatchObject({ id: "ev1", title: "Dentist", start: "2026-11-05T23:00:00.000Z", location: "Main St" });
  const post = calls.find((c) => c.method === "POST" && c.url.pathname.endsWith("/events"))!;
  expect(post.url.searchParams.get("sendUpdates")).toBe("none");
  expect(JSON.parse(post.body).attendees).toBeUndefined();

  const moved: any = await googleAgent(g, "calendar", ["move", "ev1", "--start", "2026-11-05T16:00:00-08:00", "--end", "2026-11-05T17:00:00-08:00"]);
  expect(moved.start).toBe("2026-11-06T00:00:00.000Z");

  // A meeting the owner organizes with guests: Google emails them the change, so it isn't silent on their calendars.
  events.sync = { id: "sync", summary: "Team sync", start: { dateTime: "2026-11-05T10:00:00Z" }, organizer: { self: true }, attendees: [{ email: "me@x.com", self: true }, { email: "a@x.com" }] };
  expect(await googleAgent(g, "calendar", ["remove", "sync"])).toEqual({ deleted: "sync" });
  expect(calls.at(-1)!.url.searchParams.get("sendUpdates")).toBe("all");
  expect(await googleAgent(g, "calendar", ["remove", "ev1"])).toEqual({ deleted: "ev1" });
  expect(calls.at(-1)!.url.searchParams.get("sendUpdates")).toBe("none");

  const allDay: any = await googleAgent(g, "calendar", ["add", "Birthday", "--all-day", "--start", "2026-11-20", "--end", "2026-11-21"]);
  expect(allDay.allDay).toBe(true);
});

test("csv: quotes, doubled quotes, commas and newlines inside a cell", () => {
  expect(csvRows('a,"b,c","say ""hi""","two\nlines"\r\nx,y')).toEqual([["a", "b,c", 'say "hi"', "two\nlines"], ["x", "y"]]);
});

test("the bash commands post their words, what's piped in, and uploads to the hub with the key", async () => {
  const got: any[] = [];
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const f = await req.formData(), file = f.get("file") as File | null;
    got.push({ path: new URL(req.url).pathname, key: req.headers.get("x-hearth-agent"), a: f.getAll("a"), body: f.get("body"), file: file ? { name: file.name, text: await file.text() } : null });
    return Response.json({ ok: true });
  } });
  const dir = mkdtempSync(join(tmpdir(), "hearth-gbin-"));
  const skills = googleSkills(`http://127.0.0.1:${srv.port}`, "k3y");
  expect(skills.map((s) => s.name)).toEqual(["hearth-gmail", "hearth-drive", "hearth-calendar"]);
  for (const s of skills) for (const [n, t] of Object.entries(s.scripts!)) writeFileSync(join(dir, n), t);
  const run = async (args: string[], stdin?: string) => {
    const p = Bun.spawn(["bash", ...args], { cwd: dir, stdout: "pipe", stdin: stdin != null ? new Blob([stdin]) : "ignore" });
    return new Response(p.stdout).text();
  };
  expect(await run([join(dir, "hearth-gmail"), "search", "from:@lego.com <x> & y"])).toContain('"ok":true');
  await run([join(dir, "hearth-drive"), "sheet", "Lego tracker", "--in", "fold1"], "Set,Price\n10294,679.99\n");
  writeFileSync(join(dir, "shot.png"), "PNGDATA");
  await run([join(dir, "hearth-drive"), "upload", join(dir, "shot.png")]);
  await run([join(dir, "hearth-calendar"), "list", "--days", "3"]);
  srv.stop(true);
  expect(got[0]).toEqual({ path: "/api/agent/google/gmail", key: "k3y", a: ["search", "from:@lego.com <x> & y"], body: null, file: null });
  expect(got[1]).toMatchObject({ path: "/api/agent/google/drive", a: ["sheet", "Lego tracker", "--in", "fold1"], body: "Set,Price\n10294,679.99\n" });
  expect(got[2]).toMatchObject({ a: ["upload", join(dir, "shot.png")], file: { name: "shot.png", text: "PNGDATA" } });
  expect(got[3]).toMatchObject({ path: "/api/agent/google/calendar", a: ["list", "--days", "3"], body: null });
  // Sending email is never a command: the skill sends it through the owner's Approve.
  expect(skills[0].body).toContain("message.send");
});

test("a linked computer gets the Google skills with a key of its own, which dies with its connection", () => {
  let on = true;
  const c = new Computers({ dataDir: mkdtempSync(join(tmpdir(), "hearth-gcmp-")), homeDir: tmpdir(), acceptCopies: false, agentSkills: () => ({ google: on }) });
  const sent: any[] = [];
  c.attach("mac1", "Mac", { send: (d: string) => sent.push(JSON.parse(d)), close() {} });
  c.message("mac1", JSON.stringify({ t: "hello", harnesses: ["claude"] }));
  const msg = sent.find((m) => m.t === "skills");
  expect(msg.google).toBe(true);
  expect(msg.key).toMatch(/^[0-9a-f]{48}$/);
  expect(c.agentKeyOwner(msg.key)).toBe("Mac");
  expect(c.agentKeyOwner("nope")).toBeNull();
  on = false;
  c.skillsChanged();
  expect(sent.filter((m) => m.t === "skills").at(-1).google).toBe(false);
  c.drop("mac1", "bye");
  expect(c.agentKeyOwner(msg.key)).toBeNull();
});

test("the step feed says what the Google commands are doing", () => {
  expect(describeSkillStep('hearth-drive sheet "Lego" <<\'CSV\'')).toBe("Saving to your Drive");
  expect(describeSkillStep("hearth-gmail search from:x")).toBe("Searching your email");
  expect(describeSkillStep("hearth-calendar add Dentist")).toBe("Adding to your calendar");
});

test("the hub's route: the hub's key only from this machine, a computer's key while it's linked, nothing else", async () => {
  const { createStore, COLLECTIONS } = await import("../src/store/index.ts");
  const { Hub } = await import("../src/hub.ts");
  const { Brain } = await import("../src/brain.ts");
  const { Scripts } = await import("../src/scripts.ts");
  const { loadConfig } = await import("../src/config.ts");
  const { startServer } = await import("../src/server.ts");
  const { hubSkills } = await import("../src/brains/skills.ts");
  const dir = mkdtempSync(join(tmpdir(), "hearth-groute-"));
  const store = await createStore("sqlite::memory:", dir);
  for (const c of COLLECTIONS) await store.clear(c);
  const config = { ...loadConfig({ HEARTH_PORT: "0" }), dataDir: dir, agent: "echo" };
  const hub = new Hub(config, store, new Brain(config), new Scripts(store, dir, join(dir, "none")), null);
  const { server, computers } = await startServer(hub, null); // it opens the hub's vault
  try {
    g = hub.google;
    g.fetch = async (url, init) => fake(String(url), init);
    const sent: any[] = [];
    computers.attach("mac1", "Mac", { send: (d: string) => sent.push(JSON.parse(d)), close() {} });
    computers.message("mac1", JSON.stringify({ t: "hello", harnesses: ["claude"] }));
    expect(sent.find((m) => m.t === "skills").google).toBe(false); // not connected yet
    expect(hubSkills(dir).some((s) => s.name === "hearth-drive")).toBe(false);
    await connect();
    hub.emit("connections");
    const macKey = sent.filter((m) => m.t === "skills").at(-1);
    expect(macKey.google).toBe(true);
    const hubKey = hubSkills(dir).find((s) => s.name === "hearth-drive")!.scripts!["hearth-drive"].match(/X-Hearth-Agent: (\w+)/)![1];

    const call = (key: string, headers: Record<string, string> = {}) => {
      const f = new FormData(); f.append("a", "folder"); f.append("a", "Lego");
      return fetch(`http://127.0.0.1:${server.port}/api/agent/google/drive`, { method: "POST", body: f, headers: { "X-Hearth-Agent": key, ...headers } });
    };
    expect((await call("wrong")).status).toBe(401);
    expect(await (await call(hubKey)).json()).toMatchObject({ id: "fold1", name: "Lego" });
    expect((await call(hubKey, { "X-Forwarded-For": "1.2.3.4" })).status).toBe(401); // through the public proxy: no
    expect((await call(macKey.key, { "X-Forwarded-For": "1.2.3.4" })).status).toBe(200); // the Mac reaches the public address
    const bad = await fetch(`http://127.0.0.1:${server.port}/api/agent/google/calendar`, { method: "POST", body: (() => { const f = new FormData(); f.append("a", "nope"); return f; })(), headers: { "X-Hearth-Agent": hubKey } });
    expect([bad.status, (await bad.json()).error]).toEqual([400, expect.stringContaining("usage: hearth-calendar")]);
    computers.drop("mac1", "bye");
    expect((await call(macKey.key)).status).toBe(401);

    // Removing an event: staged, not done; the agent's action makes an Approve card; Always allow runs it and the next one.
    events.gym = { id: "gym", summary: "Gym", start: { dateTime: "2026-11-05T10:00:00Z" }, organizer: { self: true } };
    events.run = { id: "run", summary: "Run", start: { dateTime: "2026-11-06T10:00:00Z" }, organizer: { self: true } };
    const remove = async (id: string) => {
      const f = new FormData(); f.append("a", "remove"); f.append("a", id);
      return (await fetch(`http://127.0.0.1:${server.port}/api/agent/google/calendar`, { method: "POST", body: f, headers: { "X-Hearth-Agent": hubKey } })).json() as Promise<any>;
    };
    const staged = await remove("gym");
    expect(staged).toMatchObject({ needsApprove: true, kind: "calendar:remove", action: { type: "google.change" } });
    expect(events.gym).toBeTruthy();
    const card = await hub.requestGoogleChange(staged.action, { threadId: "t1" });
    expect(card.value).toMatchObject({ status: "pending", summary: "Remove “Gym” (2026-11-05T10:00:00Z) from your calendar", action: { type: "google", kind: "calendar:remove" } });
    expect((await hub.requestGoogleChange(staged.action, {})).error).toContain("expired"); // one card per staged change
    const done = await hub.decideApproval(card.value!.id, true, true);
    expect(done.value).toMatchObject({ status: "done" });
    expect(events.gym).toBeUndefined();
    expect(await hub.alwaysAllowed()).toContain("google:calendar:remove");
    expect(await remove("run")).toMatchObject({ done: true, alwaysAllowed: true, result: { deleted: "run" } });
    expect(events.run).toBeUndefined();
    // Always allow for your own events doesn't reach a meeting with other guests.
    events.sync = { id: "sync", summary: "Team sync", start: { dateTime: "2026-11-05T10:00:00Z" }, organizer: { self: true }, attendees: [{ email: "a@x.com" }] };
    expect(await remove("sync")).toMatchObject({ needsApprove: true, kind: "calendar:remove-guests" });
    expect(events.sync).toBeTruthy();
  } finally { computers.stop(); server.stop(true); hub.stop(); await store.close(); }
});

test("what waits for Approve: moving or removing events (meetings with guests their own kind), replacing or trashing files", async () => {
  const { changeFor } = await import("../src/connectors/google-agent.ts");
  await connect();
  events.mine = { id: "mine", summary: "Gym", start: { dateTime: "2026-11-05T10:00:00Z" }, organizer: { self: true } };
  events.sync = { id: "sync", summary: "Team sync", start: { dateTime: "2026-11-05T10:00:00Z" }, organizer: { email: "boss@x.com" }, attendees: [{ email: "me@x.com", self: true }, { email: "boss@x.com" }, { email: "c@x.com" }] };
  expect(await changeFor(g, "calendar", ["add", "x", "--start", "a", "--end", "b"])).toBeNull();
  expect(await changeFor(g, "drive", ["append", "new1"], { body: "a,b" })).toBeNull();
  const mv = (await changeFor(g, "calendar", ["move", "mine", "--start", "2026-11-05T11:00:00Z"]))!;
  expect([mv.kind, mv.summary]).toEqual(["calendar:move", "Change “Gym” (2026-11-05T10:00:00Z): start 2026-11-05T11:00:00Z"]);
  const rm = (await changeFor(g, "calendar", ["remove", "sync"]))!;
  expect(rm.kind).toBe("calendar:remove-guests");
  expect(rm.summary).toContain("2 other guests (you're not the organizer)");
  expect(rm.details).toContain("tells them you declined");
  expect((await changeFor(g, "drive", ["replace", "new1"], { body: "a,b" }))!.kind).toBe("drive:replace");
  expect((await changeFor(g, "drive", ["trash", "new1"]))!.summary).toBe("Move “Lego tracker” to Drive's trash");
  // Nothing was changed by looking.
  expect(calls.some((c) => c.method !== "GET" && c.url.host !== "oauth2.googleapis.com")).toBe(false);
});

test("the Sheets API switched off in the owner's project: a plain message with the link to turn it on", async () => {
  await connect();
  const real = g.fetch;
  g.fetch = async (url, init) => new URL(String(url)).host === "sheets.googleapis.com"
    ? new Response(JSON.stringify({ error: { code: 403, message: "Google Sheets API has not been used in project 123456 before or it is disabled.", status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } }), { status: 403 })
    : real(url, init);
  await expect(googleAgent(g, "drive", ["append", "new1"], { body: "a,b" })).rejects.toThrow("console.cloud.google.com/apis/library/sheets.googleapis.com?project=123456");
});

test("Connectors warns when an account needs reconnecting for what it can't do yet, and not once it can", async () => {
  await connect("email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/drive.readonly");
  expect(g.needs()).toEqual(["Reconnect rishi@example.com to allow saving to Drive and adding calendar events."]);
  await connect(); // the same account again, now allowing everything
  expect(g.needs()).toEqual([]);
});
