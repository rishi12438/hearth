import { test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { chromePath, sendInPage, withSite, SignedOut, type OpenSite } from "../src/browser.ts";
import { encUrn, LinkedInApi, learnQueryIds, QUERY_IDS, linkedinAgent, linkedinSkill, parseConversation, profileOf, threadLink, threadOf } from "../src/connectors/linkedin-api.ts";
import { sendByApi, webSender } from "../src/connectors/web-senders.ts";
import { linkedin } from "../src/sources/linkedin.ts";
import { createStore, COLLECTIONS, type Store } from "../src/store/index.ts";
import { Hub } from "../src/hub.ts";
import { Brain } from "../src/brain.ts";
import { Scripts } from "../src/scripts.ts";
import { loadConfig } from "../src/config.ts";
import { Vault } from "../src/vault.ts";
import type { Message } from "../src/types.ts";

// LinkedIn through its own API (Voyager), like OpenOutreach: reads give each conversation its link, sends post into the
// conversation without typing, and typing is only the fallback when the API refused before anything went out.

const ME = "urn:li:fsd_profile:ACoAAME000";
const conv = (id: string, name: string, urn: string, last: string, opts: { mine?: boolean; unread?: number; at?: number; group?: boolean } = {}) => ({
  entityUrn: `urn:li:msg_conversation:(${ME},${id})`, unreadCount: opts.unread ?? 0, lastActivityAt: opts.at ?? 1_790_000_000_000, groupChat: !!opts.group,
  conversationParticipants: [
    { hostIdentityUrn: ME, participantType: { member: { firstName: { text: "Rishi" }, lastName: { text: "M" } } } },
    { hostIdentityUrn: urn, participantType: { member: { firstName: { text: name.split(" ")[0] }, lastName: { text: name.split(" ").slice(1).join(" ") }, profileUrl: `https://www.linkedin.com/in/${name.toLowerCase().replace(/ /g, "-")}` } } },
  ],
  messages: { elements: [{ entityUrn: `urn:li:msg_message:${id}-${encodeURIComponent(last)}`, body: { text: last }, deliveredAt: opts.at ?? 1_790_000_000_000,
    sender: { hostIdentityUrn: opts.mine ? ME : urn, participantType: { member: { firstName: { text: opts.mine ? "Rishi" : name.split(" ")[0] }, lastName: { text: "" } } } } }] },
});

type Call = { method: string; url: string; headers: Record<string, string>; body?: string };
let calls: Call[] = [];
let convs: any[] = [];
let sendStatus = 201;
let listStatus = 200;
let opened: string[] = [];
let staleIds = false;
const FRESH = "ffffffffffffffffffffffffffffffff";

/** A fake LinkedIn page: answers Voyager calls the way the real one does. */
const fakeSite: OpenSite = async (url, o, fn) => {
  opened.push(url);
  if (!o.cookies.length) throw new SignedOut("no cookies");
  return fn({
    cookie: async (n) => (n === "JSESSIONID" ? "\"ajax:123\"" : ""),
    fetched: async () => (url.includes("/messaging/") ? [`https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.${FRESH}&variables=(mailboxUrn:${encUrn(ME)})`] : []),
    call: async (req) => {
      calls.push({ method: req.method || "GET", url: req.url, headers: req.headers || {}, body: req.body });
      if (req.url.endsWith("/voyager/api/me")) return { status: 200, body: JSON.stringify({ data: { "*miniProfile": "urn:li:fs_miniProfile:ACoAAME000" } }) };
      if (req.url.includes("memberIdentity=sam-lee")) return { status: 200, body: JSON.stringify({ data: { "*elements": ["urn:li:fsd_profile:SAM111111"] } }) };
      if (req.url.includes("memberIdentity=new-person")) return { status: 200, body: JSON.stringify({ data: { "*elements": ["urn:li:fsd_profile:NEW999999"] } }) };
      if (req.url.includes("messengerConversations") && staleIds && !req.url.includes(FRESH)) return { status: 400, body: "{}" };
      if (req.url.includes("messengerConversations")) return { status: listStatus, body: JSON.stringify({ data: { messengerConversationsBySyncToken: { elements: convs } } }) };
      if (req.url.includes("messengerMessages")) return { status: 200, body: JSON.stringify({ data: { messengerMessagesBySyncToken: { elements: [
        { entityUrn: "m2", body: { text: "Thursday works" }, deliveredAt: 1_790_000_100_000, sender: { hostIdentityUrn: "urn:li:fsd_profile:SAM111111", participantType: { member: { firstName: { text: "Sam" }, lastName: { text: "Lee" } } } } },
        { entityUrn: "m1", body: { text: "Free this week?" }, deliveredAt: 1_790_000_000_000, sender: { hostIdentityUrn: ME, participantType: { member: { firstName: { text: "Rishi" }, lastName: { text: "M" } } } } },
      ] } } }) };
      if (req.url.includes("createMessage")) return { status: sendStatus, body: "{}" };
      return { status: 404, body: "" };
    },
  });
};

const cookies = [{ name: "li_at", value: "v", domain: ".linkedin.com" }];
const api = () => new LinkedInApi(() => cookies, fakeSite);

beforeEach(() => {
  calls = []; opened = []; sendStatus = 201; listStatus = 200; staleIds = false;
  convs = [conv("2-sam==", "Sam Lee", "urn:li:fsd_profile:SAM111111", "Thursday works", { unread: 1 }), conv("2-dev", "Dev Patel", "urn:li:fsd_profile:DEV222222", "see you", { mine: true }),
    conv("2-alex1", "Alex Kim", "urn:li:fsd_profile:ALEX1", "a"), conv("2-alex2", "Alex Kim", "urn:li:fsd_profile:ALEX2", "b")];
});

test("links: thread ids and profile ids come out of links, and conversation URNs make links", () => {
  expect(threadOf("https://www.linkedin.com/messaging/thread/2-ZmFrZQ%3D%3D/")).toBe("2-ZmFrZQ==");
  expect(threadOf("https://www.linkedin.com/messaging/thread/new/")).toBeNull();
  expect(threadOf("https://www.linkedin.com/messaging/")).toBeNull();
  expect(profileOf("https://www.linkedin.com/in/jane-doe-123/")).toBe("jane-doe-123");
  expect(profileOf("https://evil.example/in/jane")).toBeNull();
  expect(threadLink(`urn:li:msg_conversation:(${ME},2-abc==)`)).toBe("https://www.linkedin.com/messaging/thread/2-abc%3D%3D/");
  const c = parseConversation(convs[1], ME)!;
  expect(c).toMatchObject({ name: "Dev Patel", group: false, unread: false, last: { from: "You", mine: true, text: "see you" } });
});

test("reads go to the API with the page's CSRF token, and every row has its conversation's link", async () => {
  const items = await linkedin.items({ what: "messages", page: 1 }, { cookies: () => cookies, openSite: fakeSite, readPage: (async () => { throw new Error("no page reads"); }) as any } as any);
  expect(items.map((i) => i.title)).toEqual(["● Sam Lee", "Dev Patel", "Alex Kim", "Alex Kim"]);
  expect(items[0]).toMatchObject({ url: "https://www.linkedin.com/messaging/thread/2-sam%3D%3D/", text: "Sam: Thursday works", unread: true });
  expect(items[1].text).toBe("You: see you");
  expect(items.every((i) => i.id.startsWith("li:"))).toBe(true);
  expect(calls[0].headers["csrf-token"]).toBe("ajax:123");
  expect(calls.find((c) => c.url.includes("messengerConversations"))!.url).toContain(`mailboxUrn:${encUrn(ME)}`);
  // One whole conversation, newest first.
  const msgs = await linkedin.items(linkedin.validate({ what: "messages", thread: items[0].url }) as any, { cookies: () => cookies, openSite: fakeSite } as any);
  expect(msgs.map((m) => `${m.title}: ${m.text}`)).toEqual(["Sam Lee: Thursday works", "You: Free this week?"]);
  expect(calls.at(-1)!.url).toContain("variables=(conversationUrn:urn%3Ali%3Amsg_conversation%3A%28urn%3Ali%3Afsd_profile%3AACoAAME000%2C2-sam%3D%3D%29)");
});

test("a stale query id: reads the current one off the messaging page and tries again", async () => {
  const before = { ...QUERY_IDS };
  staleIds = true;
  const list: any = await linkedinAgent(api(), ["conversations"]);
  expect(list.conversations.length).toBe(4);
  expect(opened).toEqual(["https://www.linkedin.com/feed/", "https://www.linkedin.com/messaging/"]);
  expect(QUERY_IDS.conversations).toBe(`messengerConversations.${FRESH}`);
  // Only the list that takes just the mailbox counts (the paged one takes a category and a cursor).
  expect(learnQueryIds(["https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.cee0648f17e09c88a360194008a806c5&variables=(query:(x),count:20,mailboxUrn:urn%3Ali%3Afsd_profile%3AX)"])).toBe(false);
  Object.assign(QUERY_IDS, before);
});

test("when the API refuses, the inbox page is read as before", async () => {
  listStatus = 400;
  const pageReads: string[] = [];
  const items = await linkedin.items({ what: "messages", page: 1 }, { cookies: () => cookies, openSite: fakeSite,
    readPage: (async (url: string) => { pageReads.push(url); return { url, text: "", data: [{ text: "Sam Lee\n5m\nhi", unread: false, href: "" }] }; }) as any } as any);
  expect(pageReads).toEqual(["https://www.linkedin.com/messaging/"]);
  expect(items[0].title).toBe("Sam Lee");
});

test("sends post into the right conversation without typing; a name or a profile link finds it", async () => {
  expect(await sendByApi(api(), "https://www.linkedin.com/messaging/thread/2-dev/", "hi")).toBe("sent");
  const post = calls.find((c) => c.method === "POST")!;
  expect(post.url).toContain("voyagerMessagingDashMessengerMessages?action=createMessage");
  expect(JSON.parse(post.body!)).toMatchObject({ mailboxUrn: ME, message: { body: { text: "hi" }, conversationUrn: `urn:li:msg_conversation:(${ME},2-dev)` } });
  calls = [];
  expect(await sendByApi(api(), "● Sam Lee", "hello")).toBe("sent");
  expect(JSON.parse(calls.find((c) => c.method === "POST")!.body!).message.conversationUrn).toBe(`urn:li:msg_conversation:(${ME},2-sam==)`);
  calls = [];
  expect(await sendByApi(api(), "https://www.linkedin.com/in/sam-lee/", "yo")).toBe("sent");
  expect(JSON.parse(calls.find((c) => c.method === "POST")!.body!).message.conversationUrn).toBe(`urn:li:msg_conversation:(${ME},2-sam==)`);
  // Two of that name, or nobody recent: the inbox search (typing) takes it. Nobody you've talked to: a new conversation.
  calls = [];
  expect(await sendByApi(api(), "Alex Kim", "x")).toBe("fallback");
  expect(await sendByApi(api(), "https://www.linkedin.com/in/new-person/", "x")).toBe("new");
  expect(calls.some((c) => c.method === "POST")).toBe(false);
});

test("typing is only the fallback: a refused send types it, one that may have gone out never sends twice", async () => {
  const typed: { url: string; click?: string[]; open?: any }[] = [];
  const s = webSender("linkedin", () => cookies, async (url, _t, o) => { typed.push({ url, click: o.click, open: o.open }); }, api());
  await s.send("https://www.linkedin.com/messaging/thread/2-dev/", "hi");
  expect(typed).toEqual([]);
  sendStatus = 403; // refused: nothing went, so type it like before
  await s.send("https://www.linkedin.com/messaging/thread/2-dev/", "hi");
  expect(typed.map((t) => t.url)).toEqual(["https://www.linkedin.com/messaging/thread/2-dev/"]);
  sendStatus = 502; // may have gone: say so, don't type it again
  await expect(s.send("https://www.linkedin.com/messaging/thread/2-dev/", "hi")).rejects.toThrow(/may have gone out/);
  expect(typed.length).toBe(1);
  // A new conversation: their profile page and its Message button.
  sendStatus = 201;
  await s.send("https://www.linkedin.com/in/new-person/", "Hi, great talk today");
  expect(typed[1]).toMatchObject({ url: "https://www.linkedin.com/in/new-person/" });
  expect(typed[1].click!.length).toBeGreaterThan(0);
  // Signed out: told so, nothing typed.
  const out = webSender("linkedin", () => cookies, async () => { typed.push({ url: "x" }); }, new LinkedInApi(() => cookies, async () => { throw new SignedOut("x"); }));
  await expect(out.send("https://www.linkedin.com/messaging/thread/2-dev/", "hi")).rejects.toThrow(/signed Hearth out/);
  expect(typed.length).toBe(2);
});

test("hearth-linkedin lists and searches conversations, and reads one by link or name", async () => {
  const list: any = await linkedinAgent(api(), ["conversations"]);
  expect(list.conversations[0]).toMatchObject({ name: "Sam Lee", thread: "https://www.linkedin.com/messaging/thread/2-sam%3D%3D/", unread: true, last: "Sam: Thursday works",
    people: [{ name: "Sam Lee", profile: "https://www.linkedin.com/in/sam-lee" }] });
  expect(((await linkedinAgent(api(), ["conversations", "--query", "dev"])) as any).conversations.map((c: any) => c.name)).toEqual(["Dev Patel"]);
  expect(((await linkedinAgent(api(), ["conversations", "--query", "nobody"])) as any).note).toContain("source.read");
  const byLink: any = await linkedinAgent(api(), ["messages", "https://www.linkedin.com/messaging/thread/2-sam%3D%3D/"]);
  expect(byLink.messages).toEqual([{ from: "You", text: "Free this week?", at: "2026-09-21T14:13:20.000Z" }, { from: "Sam Lee", text: "Thursday works", at: "2026-09-21T14:15:00.000Z" }]);
  expect(((await linkedinAgent(api(), ["messages", "Sam", "Lee"])) as any).conversation.name).toBe("Sam Lee");
  expect(((await linkedinAgent(api(), ["messages", "Alex Kim"])) as any).error).toContain("2 conversations");
  expect(((await linkedinAgent(new LinkedInApi(() => [], fakeSite), ["conversations"])) as any).error).toContain("isn't connected");
  expect(((await linkedinAgent(api(), ["send"])) as any).error).toContain("usage");
  const sk = linkedinSkill("http://127.0.0.1:1", "KEY");
  expect(sk.commands).toEqual(["hearth-linkedin"]);
  expect(sk.scripts!["hearth-linkedin"]).toContain("/api/agent/linkedin");
  expect(sk.body).toContain("message.send");
});

// ── The hub: a watcher whose rows changed how their ids are made (page hashes -> API ids) doesn't fire for every row.
let dir: string, store: Store, hub: Hub;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hearth-li-api-"));
  store = await createStore(process.env.TEST_DB || "sqlite::memory:", dir);
  for (const c of COLLECTIONS) await store.clear(c);
  const config = { ...loadConfig({}), dataDir: dir, agent: "echo" };
  hub = new Hub(config, store, new Brain(config), new Scripts(store, dir, join(dir, "none")), null);
  hub.vault = new Vault(dir, { masterKey: randomBytes(32) });
  await hub.ensureTeammates();
});
afterEach(async () => { hub.stop(); await hub.idle(20_000); await store.close(); });

test("switching a LinkedIn watcher from page reads to the API only remembers, then speaks for a real new message", async () => {
  hub.connections.saveCookies("linkedin", "li_at=abc; JSESSIONID=\"ajax:1\"");
  hub.readPage = (async (url: string) => ({ url, text: "", data: [{ text: "Sam Lee\n5m\nThursday works", unread: false, href: "" }] })) as any;
  const w = await hub.pipeline.addWatcher({ name: "li", kind: "app", app: "linkedin", config: { what: "messages" } }, "Hearth");
  await hub.pipeline.addTrigger({ name: "li", source: "li", formula: "true", action: { type: "notify", text: "New: {{title}}" } }, "Hearth");
  const look = async () => { hub.pipeline.checkNow((x) => x.id === w.value!.id); await hub.pipeline.tick(); };
  await look(); // page read: remembers
  hub.openSite = fakeSite; // now the API answers
  await look(); // new kind of ids: remembers only
  expect((await store.all<Message>("messages")).filter((m) => m.proactive)).toEqual([]);
  convs[1] = conv("2-dev", "Dev Patel", "urn:li:fsd_profile:DEV222222", "running late", { at: 1_790_000_500_000 });
  await look();
  expect((await store.all<Message>("messages")).filter((m) => m.proactive).map((m) => m.text)).toEqual(["New: Dev Patel"]);
  expect(opened.every((u) => u === "https://www.linkedin.com/feed/")).toBe(true);
});

// ── Real Chrome: in-page API calls, and a new conversation typed only into the box the Message button opened.
const landed: string[] = [];
const site = Bun.serve({ port: 0, fetch(req) {
  const u = new URL(req.url);
  if (u.pathname === "/api") return Response.json({ csrf: req.headers.get("csrf-token"), cookie: req.headers.get("cookie") || "" });
  if (u.pathname === "/landed") { landed.push(u.searchParams.get("v")!); return new Response("ok"); }
  return new Response(`<!doctype html><main><button aria-label="Message Jane">Message</button></main>
  <div class="msg-form__contenteditable old" contenteditable="true" id="old" style="min-height:20px">left open</div>
  <script>
    document.querySelector("button").onclick = () => setTimeout(() => {
      const box = document.createElement("div"); box.className = "msg-form__contenteditable"; box.contentEditable = "true"; box.style.minHeight = "20px";
      box.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); const t = box.innerText.trim();
        fetch("/landed?v=" + encodeURIComponent("new:" + t)); const p = document.createElement("p"); p.innerText = t; document.body.append(p); box.innerHTML = ""; } });
      document.body.append(box);
    }, 300);
  </script>`, { headers: { "Content-Type": "text/html" } });
} });
afterAll(() => site.stop(true));

test.skipIf(!chromePath())("withSite: fetch() runs inside the page, with its cookies and the given headers", async () => {
  const r = await withSite(`http://127.0.0.1:${site.port}/`, { cookies: [{ name: "JSESSIONID", value: "ajax:9", domain: "127.0.0.1" }], signedOut: /\/login/, timeoutMs: 30_000 },
    async (s) => ({ csrf: await s.cookie("JSESSIONID"), res: await s.call({ url: `http://127.0.0.1:${site.port}/api`, headers: { "csrf-token": "T" } }) }));
  expect(r.csrf).toBe("ajax:9");
  expect(JSON.parse(r.res.body)).toMatchObject({ csrf: "T", cookie: "JSESSIONID=ajax:9" });
}, 60_000);

test.skipIf(!chromePath())("a new conversation: clicks Message and types only into the box that opened", async () => {
  await sendInPage(`http://127.0.0.1:${site.port}/`, "Hi Jane", { cookies: [], composer: [".msg-form__contenteditable[contenteditable='true']"], signedOut: /\/login/,
    click: ["main button[aria-label^='Message' i]"], timeoutMs: 60_000 });
  await Bun.sleep(300);
  expect(landed).toEqual(["new:Hi Jane"]);
}, 90_000);
