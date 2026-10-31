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

test("connecting: your client, Google's consent with read-only scopes, a refresh token kept privately", async () => {
  const g = hub.google;
  expect(g.setClient("not-a-client", "x").error).toContain("client ID");
  expect(g.authUrl("https://x/cb").error).toContain("client ID");
  g.setClient(CLIENT, "GOCSPX-secret-value");
  const url = new URL(g.authUrl("https://hub.example.com/api/google/callback").value!);
  expect(url.host).toBe("accounts.google.com");
  expect(url.searchParams.get("access_type")).toBe("offline");
  expect(url.searchParams.get("scope")).toContain("gmail.readonly");
  expect(url.searchParams.get("scope")).not.toContain("gmail.send");
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
