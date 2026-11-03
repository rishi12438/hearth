import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Vault } from "../src/vault.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, COLLECTIONS, type Store } from "../src/store/index.ts";
import { Hub } from "../src/hub.ts";
import { Brain } from "../src/brain.ts";
import { Scripts } from "../src/scripts.ts";
import { loadConfig } from "../src/config.ts";
import { zonedToUtc } from "../src/time.ts";
import { Google, mailText } from "../src/google.ts";
import { validateHook, describeTrigger } from "../src/hooks.ts";
import type { Hook, Message } from "../src/types.ts";

// Google with your own OAuth client, and the Gmail and Calendar trigger modules, against a fake Google.

const TZ = "America/Los_Angeles";
const CLIENT = "123-abc.apps.googleusercontent.com";
let dir: string, store: Store, hub: Hub, now: Date;
let inbox: { id: string; from: string; subject: string; body: string }[];
let events: { id: string; summary: string; start: string; created: string }[];
let calls: string[];

const b64 = (s: string) => Buffer.from(s).toString("base64url");

/** Answers like Google's token, userinfo, Gmail and Calendar endpoints. */
function fakeGoogle(url: string, init?: RequestInit): Response {
  const u = new URL(url);
  calls.push(`${init?.method || "GET"} ${u.host}${u.pathname}`);
  const ok = (j: unknown) => new Response(JSON.stringify(j), { headers: { "Content-Type": "application/json" } });
  if (u.host === "oauth2.googleapis.com" && u.pathname === "/token") {
    const p = new URLSearchParams(String(init?.body));
    if (p.get("grant_type") === "authorization_code") return p.get("code") === "good" ? ok({ access_token: "at1", refresh_token: "rt1", expires_in: 3600, scope: "email https://www.googleapis.com/auth/gmail.readonly" }) : new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    return p.get("refresh_token") === "rt1" ? ok({ access_token: "at2", expires_in: 3600 }) : new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
  }
  if (u.pathname === "/revoke") return ok({});
  if (u.pathname === "/v1/userinfo") return ok({ email: "rishi@example.com" });
  if (u.pathname === "/gmail/v1/users/me/messages") {
    const q = u.searchParams.get("q") || "";
    const want = q.match(/from:(\S+?)\)/)?.[1];
    return ok({ messages: inbox.filter((m) => !want || m.from.includes(want)).map((m) => ({ id: m.id, threadId: `t${m.id}` })) });
  }
  const one = u.pathname.match(/\/messages\/(\w+)$/);
  if (one) {
    const m = inbox.find((x) => x.id === one[1])!;
    return ok({ id: m.id, threadId: `t${m.id}`, snippet: m.body.slice(0, 40), labelIds: ["INBOX"], payload: { mimeType: "multipart/alternative",
      headers: [{ name: "From", value: m.from }, { name: "Subject", value: m.subject }, { name: "Date", value: "Fri, 30 Oct 2026 12:00:00 -0700" }],
      parts: [{ mimeType: "text/plain", body: { data: b64(m.body) } }, { mimeType: "text/html", body: { data: b64(`<p>${m.body}</p>`) } }] } });
  }
  if (u.pathname === "/calendar/v3/calendars/primary/events") {
    const max = new Date(u.searchParams.get("timeMax")!), min = new Date(u.searchParams.get("timeMin")!);
    return ok({ items: events.filter((e) => new Date(e.start) >= min && new Date(e.start) <= max).map((e) => ({ id: e.id, summary: e.summary, start: { dateTime: e.start }, end: { dateTime: e.start }, created: e.created, status: "confirmed", organizer: { email: "boss@example.com" } })) });
  }
  return new Response("not found", { status: 404 });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hearth-google-"));
  store = await createStore(process.env.TEST_DB || "sqlite::memory:", dir);
  for (const c of COLLECTIONS) await store.clear(c);
  const config = { ...loadConfig({}), dataDir: dir, agent: "echo" };
  hub = new Hub(config, store, new Brain(config), new Scripts(store, dir, join(dir, "none")), null);
  now = zonedToUtc(2026, 10, 30, 12, 0, TZ);
  hub.clock = () => now;
  hub.vault = new Vault(dir, { masterKey: randomBytes(32) });
  await hub.setPrefs({ tz: TZ });
  inbox = [{ id: "m1", from: "Ms Rivera <office@lincoln.k12.ca.us>", subject: "Picture day", body: "Picture day is Monday." }];
  events = [{ id: "e1", summary: "Dentist", start: new Date(now.getTime() + 3 * 3600_000).toISOString(), created: "2026-10-01T00:00:00Z" }];
  calls = [];
  hub.google.fetch = async (url, init) => fakeGoogle(String(url), init);
});

afterEach(async () => { hub.stop(); await hub.idle(20_000); await store.close(); });

const sent = async () => (await store.all<Message>("messages")).filter((m) => m.proactive);
const get = (id: string) => store.get<Hook>("hooks", id) as Promise<Hook>;

async function connect(g: Google = hub.google) {
  expect(g.setClient(CLIENT, "GOCSPX-secret-value").value).toBeTruthy();
  const url = new URL(g.authUrl("https://hub.example.com/api/google/callback").value!);
  return g.finish("good", url.searchParams.get("state")!);
}

test("connecting: your client, Google's consent (read, and send after Approve), a refresh token kept privately", async () => {
  const g = hub.google;
  expect(g.setClient("not-a-client", "x").error).toContain("client ID");
  expect(g.authUrl("https://x/cb").error).toContain("client ID");
  g.setClient(CLIENT, "GOCSPX-secret-value");
  const url = new URL(g.authUrl("https://hub.example.com/api/google/callback").value!);
  expect(url.host).toBe("accounts.google.com");
  expect(url.searchParams.get("access_type")).toBe("offline");
  expect(url.searchParams.get("scope")).toContain("gmail.readonly");
  // Sending is asked for (it only happens after an Approve); nothing that changes or deletes mail is.
  expect(url.searchParams.get("scope")).toContain("gmail.send");
  expect(url.searchParams.get("scope")).not.toMatch(/gmail\.modify|mail\.google\.com|gmail\.compose/);
  expect((await g.finish("good", "made-up-state")).error).toContain("expired");
  const r = await g.finish("good", url.searchParams.get("state")!);
  expect(r.value).toMatchObject({ connected: true, email: "rishi@example.com" });
  expect((await g.finish("good", url.searchParams.get("state")!)).error).toContain("expired"); // a state works once
  const status = JSON.stringify(g.status());
  expect(status).not.toContain("rt1");
  expect(status).not.toContain("GOCSPX");
  // Kept in the encrypted vault with every other key: not in plain text on disk, not in exports.
  expect(hub.vault!.names()).toContain("google");
  expect(readFileSync(hub.vault!.path).includes("rt1")).toBe(false);
  expect(existsSync(join(dir, "google.json"))).toBe(false);
  expect(JSON.stringify(await hub.exportAll())).not.toContain("rt1");
  await g.disconnect();
  expect(g.status()).toMatchObject({ connected: false, hasClient: true });
  expect(hub.vault!.get("google")).not.toContain("rt1");
});

test("email text: the plain part, else the HTML without tags", () => {
  expect(mailText({ mimeType: "text/html", body: { data: b64("<style>x{}</style><p>Due <b>Friday</b></p>") } })).toBe("Due Friday");
});

test("source triggers: unknown sources and bad config are refused; descriptions read well", () => {
  expect(validateHook({ title: "x", trigger: { type: "source", source: "myspace" }, action: { type: "notify", text: "x" } }).error).toContain("gmail");
  expect(validateHook({ title: "x", trigger: { type: "source", source: "gmail", config: {} }, action: { type: "notify", text: "x" } }).error).toContain("search");
  const v = validateHook({ title: "x", trigger: { type: "source", source: "gmail", config: { query: "from:linkedin.com" }, minutes: 30 }, action: { type: "notify", text: "x" } }).value!;
  expect(describeTrigger(v.trigger, TZ)).toBe("new email matching “from:linkedin.com” (checked every 30 min)");
});

test("a Gmail trigger stays quiet until Google is connected, remembers what's there, then speaks for new mail only", async () => {
  const r = await hub.addHook({ title: "School email", trigger: { type: "source", source: "gmail", config: { query: "from:k12.ca.us" } }, action: { type: "notify", text: "New school email:" } }, "assistant");
  const id = r.value!.id;
  await hub.fire(await get(id), "check");
  expect((await get(id)).seen).toBeUndefined(); // not connected: nothing read
  await connect();
  await hub.fire(await get(id), "check");
  expect((await sent()).length).toBe(0); // first look
  inbox.unshift({ id: "m2", from: "office@lincoln.k12.ca.us", subject: "Field trip slips due Tuesday", body: "Slips and $15 due Tue 8am." });
  inbox.unshift({ id: "m3", from: "deals@shoes.example.com", subject: "Sale", body: "40% off" });
  await hub.fire(await get(id), "check");
  const msgs = await sent();
  expect(msgs.length).toBe(1);
  expect(msgs[0].text).toBe("New school email:\n• office@lincoln.k12.ca.us — Field trip slips due Tuesday");
  await hub.fire(await get(id), "check");
  expect((await sent()).length).toBe(1); // already seen
  expect(calls.filter((c) => c.endsWith("/token")).length).toBe(1); // the access token is reused
});

test("a calendar trigger speaks before an event starts, once", async () => {
  await connect();
  const r = await hub.addHook({ title: "Heads-up", trigger: { type: "source", source: "calendar", config: { when: "starting", minutesBefore: 30 } }, action: { type: "notify", text: "Starting soon:" } }, "assistant");
  expect(r.value!.trigger).toMatchObject({ minutes: 5 });
  await hub.fire(await get(r.value!.id), "check"); // first look: nothing in the next 30 min
  now = new Date(now.getTime() + (3 * 60 - 20) * 60_000); // 20 min before the dentist
  await hub.fire(await get(r.value!.id), "check");
  await hub.fire(await get(r.value!.id), "check");
  expect((await sent()).map((m) => m.text)).toEqual(["Starting soon:\n• Dentist"]);
});

test("source.read lets a teammate look things up", async () => {
  expect(await hub.readSource({ source: "calendar", config: { when: "new" } })).toContain("isn't connected");
  await connect();
  const out = await hub.readSource({ source: "gmail", config: { query: "from:k12.ca.us" } });
  expect(out).toContain("Picture day is Monday.");
  expect(out).toContain("<untrusted>");
});

test("a Google sign-in saved before the vault moves into it, and the plain file goes", () => {
  const saved = JSON.stringify({ clientId: CLIENT, clientSecret: "GOCSPX-old", refreshToken: "rt-old", email: "old@example.com" });
  writeFileSync(join(dir, "google.json"), saved, { mode: 0o600 });
  hub.vault!.migrate(dir);
  expect(existsSync(join(dir, "google.json"))).toBe(false);
  expect(hub.google.status()).toMatchObject({ connected: true, email: "old@example.com" });
});

// ---------------- several accounts ----------------

/** Two accounts behind one client: "good" signs in rishi@example.com (the inbox above), "work" signs in work@corp.com. */
function twoAccounts(workInbox: typeof inbox, workEvents: typeof events, sentFrom: string[]) {
  hub.google.fetch = async (url, init) => {
    const u = new URL(String(url));
    const auth = String((init?.headers as any)?.Authorization || "");
    const ok = (j: unknown) => new Response(JSON.stringify(j), { headers: { "Content-Type": "application/json" } });
    if (u.pathname === "/token") {
      const p = new URLSearchParams(String(init?.body));
      if (p.get("code") === "work") return ok({ access_token: "atw", refresh_token: "rtw", expires_in: 3600, scope: "email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send" });
      if (p.get("refresh_token") === "rtw") return ok({ access_token: "atw", expires_in: 3600 });
    }
    if (!auth.includes("atw")) return fakeGoogle(String(url), init);
    calls.push(`work ${u.pathname}`);
    if (u.pathname === "/v1/userinfo") return ok({ email: "work@corp.com" });
    if (u.pathname.endsWith("/messages/send")) { sentFrom.push("work@corp.com"); return ok({ id: "s1" }); }
    if (u.pathname === "/gmail/v1/users/me/messages") return ok({ messages: workInbox.map((m) => ({ id: m.id, threadId: `t${m.id}` })) });
    const one = u.pathname.match(/\/messages\/(\w+)$/);
    if (one) { const m = workInbox.find((x) => x.id === one[1])!; return ok({ id: m.id, threadId: `t${m.id}`, snippet: m.body, payload: { mimeType: "text/plain", headers: [{ name: "From", value: m.from }, { name: "Subject", value: m.subject }, { name: "Date", value: "Fri, 30 Oct 2026 13:00:00 -0700" }], body: { data: b64(m.body) } } }); }
    if (u.pathname.endsWith("/events")) return ok({ items: workEvents.map((e) => ({ id: e.id, summary: e.summary, start: { dateTime: e.start }, end: { dateTime: e.start }, created: e.created, status: "confirmed" })) });
    return new Response("not found", { status: 404 });
  };
}

async function addWork() {
  const url = new URL(hub.google.authUrl("https://hub.example.com/api/google/callback").value!);
  // Google asks which account every time, so the same Connect adds a second one.
  expect(url.searchParams.get("prompt")).toContain("select_account");
  return hub.google.finish("work", url.searchParams.get("state")!);
}

test("several Google accounts: added side by side, read together or one at a time, removed one at a time", async () => {
  const sentFrom: string[] = [];
  const later = new Date(now.getTime() + 3600_000).toISOString();
  twoAccounts([{ id: "w1", from: "ceo@corp.com", subject: "Offsite", body: "Offsite is Thursday." }],
    [{ id: "e1", summary: "Dentist", start: events[0].start, created: "2026-10-01T00:00:00Z" }, { id: "w-e2", summary: "Standup", start: later, created: "2026-10-02T00:00:00Z" }], sentFrom);
  await connect();
  const r = await addWork();
  expect(r.value).toMatchObject({ added: "work@corp.com", email: "rishi@example.com" });
  expect(hub.google.status().accounts.map((a) => [a.email, a.canSend])).toEqual([["rishi@example.com", false], ["work@corp.com", true]]);
  // Signing in to one you already have replaces its token instead of adding a duplicate.
  await addWork();
  expect(hub.google.accounts().length).toBe(2);
  expect(JSON.stringify(hub.google.status())).not.toMatch(/rtw|rt1/);
  expect(hub.google.authUrl("https://x/cb", "work@corp.com").value).toContain("login_hint=work%40corp.com");

  // Mail from both, newest first, each saying which account it came to.
  const both = await hub.google.searchMail("in:inbox", 10);
  expect(both.map((m) => [m.id, m.account])).toEqual([["w1", "work@corp.com"], ["m1", "rishi@example.com"]]);
  expect((await hub.google.searchMail("in:inbox", 10, "WORK@corp.com")).map((m) => m.id)).toEqual(["w1"]);
  await expect(hub.google.searchMail("x", 10, "nobody@x.com")).rejects.toThrow("No Google account");
  const out = await hub.readSource({ source: "gmail", config: { query: "in:inbox" } });
  expect(out).toContain("Account: work@corp.com");
  expect(out).toContain("authuser=work%40corp.com");

  // The same meeting on both calendars shows once.
  const evs = await hub.google.events(now, new Date(now.getTime() + 86_400_000));
  expect(evs.map((e) => e.title)).toEqual(["Standup", "Dentist"]);

  // Sending goes from an account allowed to send; naming one that can't is refused before an Approve card.
  expect(hub.google.canSend()).toBe(true);
  expect(hub.google.canSend("rishi@example.com")).toBe(false);
  expect((await hub.requestMessage({ channel: "gmail", to: "sam@x.com", text: "hi", from: "rishi@example.com" }, {})).error).toContain("permission to send from rishi@example.com");
  expect((await hub.requestMessage({ channel: "gmail", to: "sam@x.com", text: "hi", from: "nobody@x.com" }, {})).error).toContain("No Gmail account nobody@x.com");
  await hub.google.sendMail("sam@x.com", "Hi", "hello");
  expect(sentFrom).toEqual(["work@corp.com"]);

  // One signed out doesn't hide the other.
  const s = JSON.parse(hub.vault!.get("google")!); s.accounts[0].refreshToken = "dead"; hub.vault!.set("google", JSON.stringify(s));
  (hub.google as any).access.clear();
  expect((await hub.google.searchMail("in:inbox", 10)).map((m) => m.id)).toEqual(["w1"]);
  expect(hub.google.status().accounts[0].problem).toContain("signed Hearth out of rishi@example.com");

  await hub.google.disconnect("work@corp.com");
  expect(hub.google.accounts().map((a) => a.email)).toEqual(["rishi@example.com"]);
  await hub.google.disconnect();
  expect(hub.google.status()).toMatchObject({ connected: false, hasClient: true, accounts: [] });
});

test("a single sign-in saved before several accounts still works, and a second one joins it", async () => {
  hub.vault!.set("google", JSON.stringify({ clientId: CLIENT, clientSecret: "GOCSPX-secret-value", refreshToken: "rt1", email: "rishi@example.com", scopes: ["email"] }));
  expect(hub.google.status()).toMatchObject({ connected: true, email: "rishi@example.com", accounts: [{ email: "rishi@example.com" }] });
  twoAccounts([], [], []);
  await addWork();
  expect(hub.google.accounts().map((a) => a.email)).toEqual(["rishi@example.com", "work@corp.com"]);
  expect(JSON.parse(hub.vault!.get("google")!).refreshToken).toBeUndefined();
});
