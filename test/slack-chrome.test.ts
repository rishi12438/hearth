import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Vault } from "../src/vault.ts";
import { Slack, slackCookie, chromeWorkspaces, addFromChrome, cleanSlackText, snippet } from "../src/connectors/slack.ts";

const D = "xoxd-abc%2Fdef%3D";
const fp = { userAgent: "Mozilla/5.0 (Macintosh) Chrome/140.0.0.0", acceptLanguage: "en-US,en", platform: "MacIntel" };
// A pretend Slack: app.slack.com lists two workspaces; each page carries a session token; auth.test checks token + cookie.
function fakeSlack(seen: { url: string; headers: any }[] = [], tokens: Record<string, string> = { acme: "xoxc-1-acme", beta: "xoxc-2-beta" }) {
  return (async (url: string, init: any = {}) => {
    seen.push({ url, headers: init.headers || {} });
    const cookieOk = String(init.headers?.Cookie || "") === `d=${D}`;
    if (url === "https://app.slack.com/") return new Response(cookieOk ? `<a href="https://acme.slack.com/ssb/redirect">Acme</a><a href="https://beta.slack.com/ssb/redirect?x=1">Beta</a>` : "<html>sign in</html>");
    const m = url.match(/^https:\/\/(\w+)\.slack\.com\/customize\/emoji$/);
    if (m) return new Response(cookieOk ? `boot={"api_token":"${tokens[m[1]]}","x":1}` : "");
    if (url.startsWith("https://slack.com/api/")) {
      const tok = String(init.headers?.Authorization || "").replace("Bearer ", "");
      const team = Object.entries(tokens).find(([, t]) => t === tok)?.[0];
      if (!cookieOk || !team) return Response.json({ ok: false, error: "invalid_auth" });
      if (url.includes("auth.test")) return Response.json({ ok: true, team: team.toUpperCase(), user: "rishi" });
      return Response.json({ ok: true, channels: [] });
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
}

test("finds the d cookie in what the Mac app sends", () => {
  expect(slackCookie(JSON.stringify({ cookies: [{ name: "b", value: "x" }, { name: "d", value: D }] }))).toBe(D);
  expect(slackCookie(`lc=1; d=${D}; x=2`)).toBe(D);
  expect(slackCookie(JSON.stringify({ cookies: [{ name: "d", value: "nope" }] }))).toBeNull();
  expect(slackCookie("")).toBeNull();
});

test("lists the workspaces a Chrome login opens, with the browser's user agent", async () => {
  const seen: any[] = [];
  const ws = await chromeWorkspaces(D, fp, fakeSlack(seen));
  expect(ws.map((w) => [w.domain, w.team])).toEqual([["acme.slack.com", "ACME"], ["beta.slack.com", "BETA"]]);
  expect(seen.every((s) => s.headers["User-Agent"] === fp.userAgent)).toBe(true);
});

test("connects one workspace, calls the API with token + cookie, and re-mints a turned-over token", async () => {
  const vault = new Vault(mkdtempSync(join(tmpdir(), "hearth-sl-")), { masterKey: randomBytes(32) });
  const tokens = { acme: "xoxc-1-acme", beta: "xoxc-2-beta" };
  const f = fakeSlack([], tokens);
  const slack = new Slack(vault, f);
  const raw = JSON.stringify({ cookies: [{ name: "d", value: D }] });
  expect(await addFromChrome(slack, raw, { fingerprint: fp }, f)).toBe("Pick a workspace.");
  expect(await addFromChrome(slack, raw, { fingerprint: fp, workspace: "nope.slack.com" }, f)).toContain("isn't signed in");
  expect(await addFromChrome(slack, raw, { fingerprint: fp, workspace: "beta.slack.com" }, f)).toBeNull();
  expect(slack.status()).toMatchObject({ team: "BETA", via: "chrome" });
  expect((await slack.call("conversations.list")).ok).toBe(true);
  tokens.beta = "xoxc-3-beta"; // Slack turned the session token over; the cookie still works
  expect((await slack.call("conversations.list")).ok).toBe(true);
  expect(JSON.parse(vault.get("slack")!).token).toBe("xoxc-3-beta");
});

test("probe proves read access: identity, DM count, people", async () => {
  const f = (async (url: string, init: any = {}) => {
    const tok = String(init.headers?.Authorization || "").replace("Bearer ", "");
    if (tok !== "xoxc-tok") return Response.json({ ok: false, error: "invalid_auth" });
    if (url.includes("auth.test")) return Response.json({ ok: true, team: "Acme", user: "rishi" });
    if (url.includes("conversations.list")) return Response.json({ ok: true, channels: [{ id: "D1", user: "U1" }, { id: "D2", user: "U2" }] });
    if (url.includes("users.info")) return Response.json({ ok: true, user: { real_name: url.includes("U1") ? "Alice" : "Bob" } });
    if (url.includes("conversations.history")) return Response.json({ ok: true, messages: [] });
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
  const vault = new Vault(mkdtempSync(join(tmpdir(), "hearth-pb-")), { masterKey: randomBytes(32) });
  const slack = new Slack(vault, f);
  slack.save("xoxc-tok", "Acme", "rishi", { cookie: "xoxd-x", domain: "acme.slack.com", fingerprint: null });
  const r = await slack.probe();
  expect(r).toMatchObject({ ok: true, team: "Acme", user: "rishi", dmCount: 2, people: ["Alice", "Bob"] });
});

test("probe degrades when the app token lacks DM scopes: identity + scope note, mentions fallback", async () => {
  const f = (async (url: string, init: any = {}) => {
    if (url.includes("auth.test")) return Response.json({ ok: true, team: "Acme", user: "rishi" });
    if (url.includes("conversations.list")) return Response.json({ ok: false, error: "missing_scope", needed: "channels:read,im:read", provided: "users:read,search:read" });
    if (url.includes("search.messages")) return Response.json({ ok: true, messages: { matches: [{ channel: { id: "C1", name: "general" }, ts: "1700000000.0", text: "hi rishi", username: "Bob" }] } });
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
  const vault = new Vault(mkdtempSync(join(tmpdir(), "hearth-sc-")), { masterKey: randomBytes(32) });
  const slack = new Slack(vault, f);
  slack.save("xoxp-tok", "Acme", "rishi");
  const r: any = await slack.probe();
  expect(r.ok).toBe(true);
  expect(r.user).toBe("rishi");
  expect(r.note).toContain("im:read");
  expect(r.recent[0]).toContain("general"); // mentions still work via search:read
});

test("cleanSlackText strips mrkdwn and resolves entities; snippet trims on a word boundary", () => {
  expect(cleanSlackText("*rishi* from *Verbiflow* was <@U1|added>")).toBe("rishi from Verbiflow was @added");
  expect(cleanSlackText("see <https://x.com|the link> &amp; <#C1|general>")).toBe("see the link & #general");
  const long = "slackbot in openai-yc-w25: rishi from Verbiflow was added to this channel by samanthak and you can invite more";
  const out = snippet(long, 90);
  expect(out.length).toBeLessThanOrEqual(91);
  expect(out.endsWith("…")).toBe(true);
  expect(out).not.toMatch(/\s…$/); // no space before the ellipsis, no mid-word cut
});

test("mentions skips channel-join and system notices", async () => {
  const f = (async (url: string) => {
    if (url.includes("search.messages")) return Response.json({ ok: true, messages: { matches: [
      { channel: { id: "C1", name: "general" }, ts: "1700000002.0", text: "rishi was added to this channel by sam", username: "slackbot" },
      { channel: { id: "C2", name: "random" }, ts: "1700000001.0", text: "hey <@U1> can you review this?", username: "Bob" },
    ] } });
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
  const vault = new Vault(mkdtempSync(join(tmpdir(), "hearth-mn-")), { masterKey: randomBytes(32) });
  const slack = new Slack(vault, f); slack.save("xoxp-t", "Acme", "rishi");
  const m = await slack.mentions(3);
  expect(m.length).toBe(1);
  expect(m[0].title).toContain("random");
});
