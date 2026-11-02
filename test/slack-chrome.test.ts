import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Vault } from "../src/vault.ts";
import { Slack, slackCookie, chromeWorkspaces, addFromChrome } from "../src/connectors/slack.ts";

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
