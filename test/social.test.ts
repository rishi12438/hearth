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
let reads: { url: string; cookies: string[] }[] = [];

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
  hub.readPage = (async (url: string, opts: any) => { reads.push({ url, cookies: (opts.cookies || []).map((c: any) => c.name) }); return { url: page.url || url, text: "", data: page.data }; }) as any;
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

  // When the session dies, the hub asks the Mac again (fresh want, hash dropped) instead of only nagging.
  sent.length = 0;
  page = { url: "https://www.linkedin.com/login", data: null };
  const r = await hub.addHook({ title: "LinkedIn", trigger: { type: "source", source: "linkedin", config: { what: "messages" } }, action: { type: "notify", text: "x" } }, "assistant");
  await hub.fire(await get(r.value!.id), "check");
  const reask = sent.find((m) => m.t === "wantCookies");
  expect(reask).toBeTruthy();
  expect(reask.have["linkedin.com"]).toBeUndefined(); // dropped, so the Mac re-copies even if it looks unchanged
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
