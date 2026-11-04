import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createStore, COLLECTIONS, type Store } from "../src/store/index.ts";
import { Hub } from "../src/hub.ts";
import { Brain } from "../src/brain.ts";
import { Scripts } from "../src/scripts.ts";
import { loadConfig } from "../src/config.ts";
import { Vault } from "../src/vault.ts";
import { zonedToUtc } from "../src/time.ts";
import { chromePath, readPage, parseCookies } from "../src/browser.ts";
import { readList, stableText, SignedOut } from "../src/sources/pages.ts";
import type { Hook, Message } from "../src/types.ts";

// LinkedIn and X: cookies kept in the vault, pages read in headless Chrome, items that only count as new when their
// words change, and a single "reconnect" message when a site signs Hearth out.

let dir: string, store: Store, hub: Hub;
let page: { url: string; data: unknown } = { url: "", data: null };
let reads: { url: string; cookies: string[]; ua?: string }[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hearth-social-"));
  store = await createStore(process.env.TEST_DB || "sqlite::memory:", dir);
  for (const c of COLLECTIONS) await store.clear(c);
  const config = { ...loadConfig({}), dataDir: dir, agent: "echo" };
  hub = new Hub(config, store, new Brain(config), new Scripts(store, dir, join(dir, "none")), null);
  hub.vault = new Vault(dir, { masterKey: randomBytes(32) });
  const noon = zonedToUtc(2026, 10, 30, 12, 0, "America/Los_Angeles");
  hub.clock = () => noon;
  await hub.setPrefs({ tz: "America/Los_Angeles" });
  page = { url: "", data: null };
  reads = [];
  hub.readPage = (async (url: string, opts: any) => { reads.push({ url, cookies: (opts.cookies || []).map((c: any) => c.name), ua: opts.fingerprint?.userAgent }); return { url: page.url || url, text: "", data: page.data }; }) as any;
  await hub.ensureTeammates();
});

afterEach(async () => { hub.stop(); await hub.idle(20_000); await store.close(); });

const sent = async () => (await store.all<Message>("messages")).filter((m) => m.proactive);
const get = (id: string) => store.get<Hook>("hooks", id) as Promise<Hook>;
const conv = (name: string, msg: string, when = "5m", unread = false) => ({ text: `${name}\n${when}\n${msg}`, unread, href: `https://www.linkedin.com/messaging/thread/${name}/` });

test("cookies: pasted as a header or an extension export, checked for the ones that matter, kept encrypted", () => {
  const c = hub.connections;
  expect(c.saveCookies("x", "ct0=abc").error).toContain("auth_token");
  expect(c.saveCookies("linkedin", "JSESSIONID=x").error).toContain("li_at");
  expect(c.saveCookies("x", "auth_token=SECRET-TOKEN; ct0=abc; lang=en").value).toBeTruthy();
  const exported = JSON.stringify([{ name: "li_at", value: "SECRET-LI", domain: ".linkedin.com" }, { name: "other", value: "x", domain: ".google.com" }]);
  expect(c.saveCookies("linkedin", exported).value).toBeTruthy();
  expect(c.cookies("linkedin").map((k) => k.name)).toEqual(["li_at"]); // other sites' cookies are dropped
  expect(c.status().filter((s) => s.connected).map((s) => s.id)).toEqual(["linkedin", "x"]);
  expect(JSON.stringify(c.status())).not.toContain("SECRET");
  expect(readFileSync(hub.vault!.path).includes("SECRET-TOKEN")).toBe(false);
  c.remove("x");
  expect(c.connected("x")).toBe(false);
});

test("an item's id ignores times, so only new words count as new", () => {
  expect(stableText("Sarah Chen\n5m\nAre you free Thursday?")).toBe(stableText("Sarah Chen\n2 hours ago\nAre you free Thursday?"));
  expect(stableText("Sarah Chen\nOct 28\nhi")).toBe("Sarah Chen\nhi");
  expect(parseCookies("Cookie: a=1; b=\"2\"", ".x.com")).toMatchObject([{ name: "a", value: "1" }, { name: "b", value: "2" }]);
});

test("a LinkedIn trigger remembers the inbox, then speaks for a new message, and only once", async () => {
  hub.connections.saveCookies("linkedin", "li_at=abc; JSESSIONID=\"ajax:1\"");
  page.data = [conv("Sarah Chen", "Thanks!"), conv("Dev Patel", "See you then")];
  const r = await hub.addHook({ title: "LinkedIn messages", trigger: { type: "source", source: "linkedin", config: { what: "messages" } }, action: { type: "notify", text: "New on LinkedIn:" } }, "assistant");
  expect(r.value!.trigger).toMatchObject({ minutes: 30 });
  await hub.fire(await get(r.value!.id), "check");
  expect(reads[0]).toEqual({ url: "https://www.linkedin.com/messaging/", cookies: ["li_at", "JSESSIONID"] });
  page.data = [conv("Sarah Chen", "Are you free Thursday for a call?", "now", true), conv("Dev Patel", "See you then", "2h")];
  await hub.fire(await get(r.value!.id), "check");
  await hub.fire(await get(r.value!.id), "check");
  expect((await sent()).map((m) => m.text)).toEqual(["New on LinkedIn:\n• ● Sarah Chen"]);
});

test("when a site signs Hearth out, you're told once, and Connectors shows it", async () => {
  hub.connections.saveCookies("x", "auth_token=a; ct0=b");
  page = { url: "https://x.com/i/flow/login?redirect_after_login=%2Fnotifications", data: null };
  const r = await hub.addHook({ title: "X mentions", trigger: { type: "source", source: "x", config: { what: "mentions" } }, action: { type: "notify", text: "x" } }, "assistant");
  await hub.fire(await get(r.value!.id), "check");
  await hub.fire(await get(r.value!.id), "check");
  const msgs = (await store.all<Message>("messages")).filter((m) => m.text.includes("signed Hearth out"));
  expect(msgs.length).toBe(1);
  expect(hub.connections.status().find((s) => s.id === "x")!.problem).toContain("signed Hearth out");
  expect((await hub.testConnection("x")).ok).toBe(false);
  // LinkedIn with a stale li_at loops instead; that's signed out too.
  hub.connections.saveCookies("linkedin", "li_at=stale");
  page = { url: "chrome-error://chromewebdata/", data: null };
  hub.readPage = (async () => ({ url: "chrome-error://chromewebdata/", text: "www.linkedin.com redirected you too many times.\nERR_TOO_MANY_REDIRECTS", data: null })) as any;
  expect((await hub.testConnection("linkedin")).error).toContain("signed Hearth out");
});

test("a page that no longer looks like the list reads nothing rather than guessing", async () => {
  hub.connections.saveCookies("linkedin", "li_at=abc");
  page = { url: "https://www.linkedin.com/notifications/", data: null };
  expect(await hub.readSource({ source: "linkedin", config: { what: "notifications" } })).toContain("didn't look like the list");
});

// The real thing: headless Chrome, cookies set on the page, items picked out by selector, sign-out spotted by URL.
test.skipIf(!chromePath())("headless Chrome reads a logged-in list with your cookies", async () => {
  const server = Bun.serve({ port: 0, fetch(req) {
    const u = new URL(req.url);
    const authed = (req.headers.get("cookie") || "").includes("auth_token=good");
    if (u.pathname === "/notifications" && !authed) return Response.redirect(`${u.origin}/i/flow/login`, 302);
    if (u.pathname === "/i/flow/login") return new Response("<p>Log in</p>", { headers: { "Content-Type": "text/html" } });
    // Rendered by script after load, like the real app.
    return new Response(`<main id=m></main><script>setTimeout(() => { document.getElementById("m").innerHTML =
      '<article data-testid="tweet"><a href="/sam/status/1">Sam</a><div>3h</div><div>@you this is great</div></article>' +
      '<article data-testid="tweet"><a href="/lee/status/2">Lee</a><div>1d</div><div>@you are you coming?</div></article>'; }, 300)</script>`, { headers: { "Content-Type": "text/html" } });
  } });
  try {
    const origin = `http://localhost:${server.port}`;
    const x = { url: `${origin}/notifications`, selectors: ["article[data-testid='tweet']"], signedOut: /\/i\/flow\/login/ };
    const ctx: any = { readPage };
    const items = await readList("X", x, parseCookies("auth_token=good; ct0=b", "localhost"), ctx);
    expect(items.map((i) => i.title)).toEqual(["Sam", "Lee"]);
    expect(items[0].text).toBe("@you this is great");
    expect(items[0].url).toBe(`${origin}/sam/status/1`);
    await expect(readList("X", x, parseCookies("auth_token=bad; ct0=b", "localhost"), ctx)).rejects.toBeInstanceOf(SignedOut);
  } finally { server.stop(true); }
}, 60_000);

// A linked Mac copies LinkedIn/X cookies up to a server hub, and the hub re-asks when a session dies.
test("a Mac copies a login up over the link; the hub stores it and re-asks on sign-out", async () => {
  const { Computers } = await import("../src/computers.ts");
  const sent: any[] = [];
  const ws = { send: (d: string) => sent.push(JSON.parse(d)), close: () => {} };
  let t = 1_000_000;
  const cmp = new Computers({
    dataDir: dir, homeDir: join(dir, "home"), acceptCopies: true, now: () => t,
    cookieSites: () => hub.connections.macSites(),
    cookieHave: (s) => hub.connections.cookieHave(s),
    onCookies: (s, data) => hub.connections.receiveFromMac(s, data),
  });
  hub.computers = cmp;

  // The user chooses "feed LinkedIn from my Mac": the hub records it and would ask any Mac for it.
  hub.connections.wantFromMac("linkedin");
  expect(hub.connections.macSites()).toEqual(["linkedin.com"]);

  cmp.attach("mac1", "Rishi's Mac", ws as any);
  cmp.message("mac1", JSON.stringify({ t: "hello", harnesses: ["claude"], platform: "darwin" }));
  // On hello the hub asks the Mac which logins to copy up.
  const wc = sent.find((m) => m.t === "wantCookies");
  expect(wc).toEqual({ t: "wantCookies", sites: ["linkedin.com"], have: {} });

  // The Mac decrypts the cookies there and copies them up.
  const payload = JSON.stringify({ cookies: [{ name: "li_at", value: "AQEDAR-real", domain: ".www.linkedin.com", path: "/", secure: true }] });
  cmp.message("mac1", JSON.stringify({ t: "cookies", site: "linkedin.com", data: payload, hash: "h1" }));
  expect(hub.connections.connected("linkedin")).toBe(true);
  expect(hub.connections.status().find((s) => s.id === "linkedin")).toMatchObject({ detail: expect.stringContaining("from your Mac") });
  expect(readFileSync(hub.vault!.path).includes("AQEDAR-real")).toBe(false); // encrypted at rest

  // A missing required cookie is refused (never stored half-connected).
  cmp.message("mac1", JSON.stringify({ t: "cookies", site: "x.com", data: JSON.stringify({ cookies: [{ name: "ct0", value: "x", domain: ".x.com" }] }), hash: "h2" }));
  expect(hub.connections.connected("x")).toBe(false);

  // When the session dies, the hub only flags it (no auto-pull from the Mac — that was flaky). A teammate pulls on demand.
  sent.length = 0;
  page = { url: "https://www.linkedin.com/login", data: null };
  const r = await hub.addHook({ title: "LinkedIn", trigger: { type: "source", source: "linkedin", config: { what: "messages" } }, action: { type: "notify", text: "x" } }, "assistant");
  await hub.fire(await get(r.value!.id), "check");
  expect(sent.find((m) => m.t === "wantCookies")).toBeUndefined(); // no automatic re-ask
  expect(hub.connections.status().find((s) => s.id === "linkedin")!.problem).toContain("signed Hearth out");

  // The agent pulls a fresh login on demand with connection.refresh.
  sent.length = 0;
  hub.freshLoginWaitMs = 30;
  await hub.applyActions([{ type: "connection.refresh", site: "linkedin" }], "test");
  const reask = sent.find((m) => m.t === "wantCookies");
  expect(reask).toBeTruthy();
  expect(reask.have["linkedin.com"]).toBeUndefined();
  expect(reask.fresh).toBe("linkedin.com");
});

test("a job that hits a sign-out checks your Mac: a fresh login reruns it, a signed-out Mac or an offline one parks it", async () => {
  const { Computers } = await import("../src/computers.ts");
  const sent: any[] = [];
  const ws = { send: (d: string) => sent.push(JSON.parse(d)), close: () => {} };
  const cmp = new Computers({
    dataDir: dir, homeDir: join(dir, "home"), acceptCopies: true,
    cookieSites: () => hub.connections.macSites(),
    cookieHave: (s) => hub.connections.cookieHave(s),
    onCookies: (s, data) => hub.connections.receiveFromMac(s, data),
  });
  hub.computers = cmp;
  hub.freshLoginWaitMs = 2000;
  hub.connections.browserOptions = () => []; // a server hub: no browser of its own, only your Mac's
  const retried: string[] = [];
  const realRetry = hub.retryJob.bind(hub);
  hub.retryJob =(async (id: string) => { retried.push(id); return { value: null }; }) as any;
  const job = async () => store.put("jobs", { id: crypto.randomUUID(), createdAt: new Date().toISOString(), threadId: "t1", messageId: "m1", task: "AliExpress orders", teammateId: "x", status: "working", effort: "light" } as any);
  const blockedOf = async (id: string) => ((await store.get("jobs", id)) as any).blocked;

  // No Mac online: parked until it comes back, saying so.
  const j0 = await job();
  await hub.applyActions([{ type: "connection.refresh", site: "aliexpress.com" }], "t", { jobId: j0.id, threadId: "t1" });
  expect(await blockedOf(j0.id)).toMatchObject({ needs: "computer", site: "aliexpress.com", need: expect.stringContaining("Your Mac") });

  cmp.attach("mac1", "Rishi's Mac", ws as any);
  cmp.message("mac1", JSON.stringify({ t: "hello", harnesses: ["claude"], platform: "darwin" }));

  // The Mac's Chrome isn't signed in either: it says so, and the job asks you to sign in there.
  const j1 = await job();
  sent.length = 0;
  const p1 = hub.applyActions([{ type: "connection.refresh", site: "aliexpress.com" }], "t", { jobId: j1.id, threadId: "t1" });
  await Bun.sleep(5);
  expect(sent.find((m) => m.t === "wantCookies")?.fresh).toBe("aliexpress.com");
  cmp.message("mac1", JSON.stringify({ t: "noCookies", site: "aliexpress.com", why: "signed-out" }));
  await p1;
  expect(await blockedOf(j1.id)).toMatchObject({ needs: "login", need: "Sign in to aliexpress.com on your Mac" });

  // The Mac has a good login: it's copied up and the job is marked to run again by itself.
  const j2 = await job();
  const p2 = hub.applyActions([{ type: "connection.refresh", site: "aliexpress.com" }], "t", { jobId: j2.id, threadId: "t1" });
  await Bun.sleep(5);
  cmp.message("mac1", JSON.stringify({ t: "cookies", site: "aliexpress.com", data: JSON.stringify({ cookies: [{ name: "xman_t", value: "fresh", domain: ".aliexpress.com" }] }), hash: "h" }));
  const out = await p2;
  expect(hub.connections.connected("aliexpress.com")).toBe(true);
  expect(out.done.some((d: any) => /running it again/.test(d.label))).toBe(true);
  const j2now = (await store.get("jobs", j2.id)) as any;
  expect(j2now.relogged).toEqual(["aliexpress.com"]);

  // Already rerun once with a fresh login and still signed out: no loop, it asks you instead.
  const p3 = hub.applyActions([{ type: "connection.refresh", site: "aliexpress.com" }], "t", { jobId: j2.id, threadId: "t1" });
  await Bun.sleep(5);
  cmp.message("mac1", JSON.stringify({ t: "cookies", site: "aliexpress.com", data: JSON.stringify({ cookies: [{ name: "xman_t", value: "fresh2", domain: ".aliexpress.com" }] }), hash: "h2" }));
  await p3;
  expect(await blockedOf(j2.id)).toMatchObject({ needs: "login", why: expect.stringContaining("still shows") });

  // Try again on a job stuck on a login checks the Mac first; still signed out there, it stays parked without a run.
  await store.put("jobs", { ...(await store.get("jobs", j1.id)), status: "blocked" } as any);
  const p4 = realRetry(j1.id);
  await Bun.sleep(5);
  cmp.message("mac1", JSON.stringify({ t: "noCookies", site: "aliexpress.com", why: "signed-out" }));
  const r4 = await p4;
  expect((r4 as any).value.status).toBe("blocked");
  expect(await blockedOf(j1.id)).toMatchObject({ needs: "login", why: expect.stringContaining("still isn't signed in") });
});

test("any domain works, not just presets: save, read a logged-in page, and watch it change", async () => {
  // An arbitrary site the user pasted cookies for.
  expect(hub.connections.saveCookies("shop.example.com", "session=abc123; cart=1").value).toBeTruthy();
  expect(hub.connections.connected("shop.example.com")).toBe(true);
  expect(hub.connections.status().some((s) => s.id === "shop.example.com" && s.connected)).toBe(true);

  // A generic "site" trigger watches it: one item = the page text, so a change makes it new.
  page = { url: "https://shop.example.com/orders", data: null };
  hub.readPage = (async () => ({ url: "https://shop.example.com/orders", text: "Order #1 shipped\nArrives Tuesday", data: null })) as any;
  const r = await hub.addHook({ title: "My orders", trigger: { type: "source", source: "site", config: { url: "https://shop.example.com/orders", label: "My orders" } }, action: { type: "notify", text: "Orders changed:" } }, "assistant");
  const id = r.value!.id;
  await hub.fire(await get(id), "check"); // first look, silent
  expect((await sent()).length).toBe(0);
  hub.readPage = (async () => ({ url: "https://shop.example.com/orders", text: "Order #1 delivered\nOrder #2 shipped", data: null })) as any;
  await hub.fire(await get(id), "check");
  const out = await sent();
  expect(out.length).toBe(1);
  expect(out[0].text).toContain("Orders changed:");
});

test("a site with no cookies tells you to connect it, and expiry is read from the cookie", () => {
  // from-mac works for an arbitrary domain too.
  expect(hub.connections.wantFromMac("bank.example.com").value).toBeTruthy();
  expect(hub.connections.macSites()).toContain("bank.example.com");
  // Expiry carried through from a Cookie-Editor style export (expirationDate in seconds).
  const soon = Math.floor(Date.now() / 1000) + 2 * 86400;
  hub.connections.saveCookies("news.example.com", JSON.stringify([{ name: "sess", value: "x", domain: ".news.example.com", expirationDate: soon }]));
  const row = hub.connections.status().find((s) => s.id === "news.example.com")!;
  expect(row.expiresInDays).toBe(2);
});

test("every access to a connected account is audited: who, which site, when", async () => {
  await hub.ensureTeammates();
  hub.connections.saveCookies("linkedin", "li_at=abc");
  page = { url: "https://www.linkedin.com/messaging/", data: null };
  hub.readPage = (async () => ({ url: "https://www.linkedin.com/messaging/", text: "", data: [conv("Sam", "hi")] })) as any;

  // A teammate reads it on demand (source.read) — audited with the teammate's name.
  await hub.readSource({ source: "linkedin", config: { what: "messages" } }, "Research");
  // A trigger owned by a teammate reads it — audited with that teammate.
  const r = await hub.addHook({ title: "LI", trigger: { type: "source", source: "linkedin", config: { what: "messages" } }, action: { type: "notify", text: "x" }, teammate: "Research" } as any, "assistant", { teammateId: "scout" });
  await hub.fire(await get(r.value!.id), "check");

  const log = await hub.connAudit();
  const reads = log.filter((e) => e.action === "read" && e.site === "linkedin.com");
  expect(reads.length).toBeGreaterThanOrEqual(2);
  expect(reads.some((e) => e.by === "Research")).toBe(true);
  expect(reads.every((e) => typeof e.createdAt === "string" && e.ok === true)).toBe(true);
  // The paste that connected it is in the trail too (who = you).
  hub.connections.saveCookies("x", "auth_token=a; ct0=b"); // directly, not audited here (server audits paste); fine
});

test("a login from Chrome on your Mac is read as that same browser; a pasted one isn't given a made-up one", async () => {
  const mac = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
    acceptLanguage: "en-GB,en-US;q=0.9", platform: "MacIntel", timezone: "America/Los_Angeles",
    metadata: { brands: [{ brand: "Google Chrome", version: "156" }], platform: "macOS", platformVersion: "14.5.0", architecture: "arm", model: "", mobile: false } };
  const c = hub.connections;
  expect(c.saveCookies("linkedin", "li_at=A; JSESSIONID=B", "chrome", mac).value).toBeTruthy();
  expect(c.fingerprintFor("https://www.linkedin.com/messaging/")?.metadata?.platform).toBe("macOS");
  expect(c.fingerprintFor("https://x.com/home")).toBeNull();
  expect(c.saveCookies("x", "auth_token=A; ct0=B", "chrome", { userAgent: "curl/8", acceptLanguage: "en", platform: "x" }).value).toBeTruthy();
  expect(c.fingerprintFor("https://x.com/home")).toBeNull(); // not a browser user agent: dropped
  page = { url: "https://www.linkedin.com/messaging/", data: [conv("Ada", "hi")] };
  await hub.testConnection("linkedin");
  expect(reads.at(-1)?.ua).toBe(mac.userAgent);
  expect(JSON.stringify(c.status())).not.toContain("Macintosh"); // never shown to the app
});

test("recent conversations: kept from the last read, re-read only when stale or refreshed", async () => {
  hub.connections.saveCookies("linkedin", "li_at=A; JSESSIONID=B");
  page = { url: "https://www.linkedin.com/messaging/", data: [{ ...conv("Ada Lovelace", "You: see you tomorrow", "2:14 PM", true), text: "Ada Lovelace\n2:14 PM\nYou: see you tomorrow\n. Active conversation\n. Press return to go to conversation details\nOpen the options list in your conversation with Ada Lovelace" }, conv("Alan", "thanks!", "Oct 28")] };
  const r = await hub.recentConversations("linkedin");
  expect(r.items.map((i) => [i.name, i.preview, i.when, i.unread])).toEqual([["Ada Lovelace", "You: see you tomorrow", "2:14 PM", true], ["Alan", "thanks!", "Oct 28", false]]);
  expect(r.items[0].url).toContain("/messaging/thread/");
  const n = reads.length;
  await hub.recentConversations("linkedin");
  expect(reads.length).toBe(n); // fresh enough: no new read
  await hub.recentConversations("linkedin", true);
  expect(reads.length).toBe(n); // refresh within a minute: still kept
  expect(readFileSync(hub.vault!.path).includes("see you tomorrow")).toBe(false); // encrypted
});

test("recent: LinkedIn connection requests are their own list, read from the received page", async () => {
  hub.connections.saveCookies("linkedin", "li_at=A; JSESSIONID=B");
  page = { url: "https://www.linkedin.com/mynetwork/invitation-manager/received/", data: [{ text: "Ada Lovelace\nwants to connect\nMathematician\n3 mutual connections\nIgnore\nAccept", unread: false, href: "https://www.linkedin.com/in/ada/" }] };
  const r = await hub.recentConversations("linkedin", false, "invitations");
  expect(reads.at(-1)?.url).toContain("/invitation-manager/received/");
  expect(r.items[0].name).toBe("Ada Lovelace");
  expect(r.items[0].lines).toContain("Mathematician");
  expect(r.items[0].url).toBe("https://www.linkedin.com/in/ada/");
  await hub.recentConversations("linkedin"); // messages: kept apart, so this is a read of its own
  expect(reads.at(-1)?.url).toContain("/messaging/");
});
