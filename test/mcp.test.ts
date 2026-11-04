import { test, expect, beforeEach } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/vault.ts";
import { Mcp, mcpAgent, nameFromUrl } from "../src/mcp.ts";
import { claudeMcpConfig, codexMcpConfig } from "../src/brain.ts";

// MCP servers signed in once on the hub (mcp.ts), against a fake MCP server with its own OAuth login service.

const MCP = "https://mcp.example.com/mcp";
const OPEN = "https://open.example.com/mcp";
const KEYED = "https://keyed.example.com/mcp";
let dir: string, vault: Vault, mcp: Mcp, now: number;
let calls: string[];
let valid: Set<string>; // access tokens the MCP server takes right now
let refreshTokens: Map<string, { access: string; next: string }>;
let challenges: Map<string, string>;
let registered: number;
let changes: number;

const ok = (j: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(j), { headers: { "Content-Type": "application/json", ...headers } });
const sse = (j: unknown) => new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}\n\nevent: message\ndata: ${JSON.stringify(j)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });

async function mcpServer(req: Request, auth: () => boolean): Promise<Response> {
  if (!auth()) return new Response("no", { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"` } });
  if (req.method === "DELETE") return new Response(null, { status: 204 });
  const m: any = await req.json();
  if (!m.id) return new Response(null, { status: 202 });
  if (m.method === "initialize") return ok({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake" } } }, { "Mcp-Session-Id": "s1" });
  if (req.headers.get("mcp-session-id") !== "s1") return new Response("no session", { status: 400 });
  if (m.method === "tools/list") return sse({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "search", description: "Search issues", inputSchema: { type: "object" } }, { name: "create" }] } });
  if (m.method === "tools/call") return ok({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: `called ${m.params.name} with ${JSON.stringify(m.params.arguments)}` }] } });
  return ok({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no such method" } });
}

async function fakeFetch(input: any, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init);
  const u = new URL(req.url);
  calls.push(`${req.method} ${u.host}${u.pathname}`);
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
  if (u.href === MCP) return mcpServer(req, () => valid.has(bearer));
  if (u.href === OPEN) return mcpServer(req, () => true);
  if (u.href === KEYED) return mcpServer(req, () => req.headers.get("x-api-key") === "sekret");
  if (u.href === "https://mcp.example.com/.well-known/oauth-protected-resource/mcp") return ok({ resource: MCP, authorization_servers: ["https://auth.example.com"], scopes_supported: ["read", "write"] });
  if (u.href === "https://auth.example.com/.well-known/oauth-authorization-server") return ok({ issuer: "https://auth.example.com", authorization_endpoint: "https://auth.example.com/authorize", token_endpoint: "https://auth.example.com/token", registration_endpoint: "https://auth.example.com/register" });
  if (u.href === "https://auth.example.com/register") {
    registered++;
    const b: any = await req.json();
    expect(b.redirect_uris).toEqual(["https://hub.example.com/api/mcp/callback"]);
    return ok({ client_id: "c1" }, {});
  }
  if (u.href === "https://auth.example.com/token") {
    const p = new URLSearchParams(await req.text());
    expect(p.get("client_id")).toBe("c1");
    expect(p.get("resource")).toBe(MCP);
    if (p.get("grant_type") === "authorization_code") {
      const want = challenges.get(p.get("code") || "");
      const got = createHash("sha256").update(p.get("code_verifier") || "").digest("base64url");
      if (!want || want !== got) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      valid.add("at1"); refreshTokens.set("rt1", { access: "at2", next: "rt2" });
      return ok({ access_token: "at1", refresh_token: "rt1", expires_in: 3600, token_type: "Bearer" });
    }
    const r = refreshTokens.get(p.get("refresh_token") || "");
    if (!r) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
    refreshTokens.delete(p.get("refresh_token")!); // rotates: the old one is spent
    valid.add(r.access);
    refreshTokens.set(r.next, { access: `${r.access}+`, next: `${r.next}+` });
    return ok({ access_token: r.access, refresh_token: r.next, expires_in: 3600 });
  }
  return new Response("not found", { status: 404 });
}

/** The user approves on the login service: it sends the browser back with a code for this sign-in's challenge. */
function approve(link: string) {
  const u = new URL(link);
  const code = `code-${challenges.size + 1}`;
  challenges.set(code, u.searchParams.get("code_challenge")!);
  return { state: u.searchParams.get("state")!, code };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hearth-mcp-"));
  vault = new Vault(dir, { masterKey: randomBytes(32) });
  now = Date.parse("2026-11-04T10:00:00Z");
  calls = []; valid = new Set(); refreshTokens = new Map(); challenges = new Map(); registered = 0; changes = 0;
  mcp = new Mcp({ dataDir: dir, vault, redirectUri: () => "https://hub.example.com/api/mcp/callback", fetch: fakeFetch as typeof fetch, now: () => now, onChange: () => changes++ });
});

async function signedIn() {
  await mcp.add({ url: MCP, name: "linear" }, "me");
  const s = await mcp.signIn("linear");
  const { state, code } = approve((s.value as { url: string }).url);
  expect((await mcp.finish(state, code)).value).toBe("linear");
}

test("a server with no login connects and lists its tools (an event-stream answer too)", async () => {
  const r = await mcp.add({ url: OPEN, name: "open" }, "me");
  expect(r.value?.name).toBe("open");
  expect(r.value?.state).toBe("connected");
  expect(r.value?.tools).toEqual(["search", "create"]);
  expect(r.value?.auth).toBe("none");
  expect(await mcp.call("open", "search", { q: "bug" })).toEqual({ content: [{ type: "text", text: 'called search with {"q":"bug"}' }] });
  expect(changes).toBeGreaterThan(0);
});

test("an OAuth server: needs sign-in, then the hub registers, signs in with PKCE, and connects", async () => {
  const r = await mcp.add({ url: MCP, name: "linear" }, "me");
  expect(r.value?.state).toBe("signin");
  expect(mcp.forRun("http://127.0.0.1:8790", "key")).toEqual([]); // nothing to give a run yet
  const s = await mcp.signIn("linear");
  const link = new URL((s.value as { url: string }).url);
  expect(link.origin + link.pathname).toBe("https://auth.example.com/authorize");
  expect(link.searchParams.get("client_id")).toBe("c1");
  expect(link.searchParams.get("code_challenge_method")).toBe("S256");
  expect(link.searchParams.get("resource")).toBe(MCP);
  expect(link.searchParams.get("scope")).toBe("read write");
  expect(link.searchParams.get("redirect_uri")).toBe("https://hub.example.com/api/mcp/callback");
  const { state, code } = approve(link.href);
  expect((await mcp.finish(state, code)).value).toBe("linear");
  const v = mcp.view("linear")!;
  expect(v.state).toBe("connected");
  expect(v.auth).toBe("oauth");
  expect(v.tools).toEqual(["search", "create"]);
  // No token in what the app or a run sees: the run gets the hub's proxy and the agent key.
  expect(JSON.stringify(mcp.list())).not.toContain("at1");
  expect(mcp.forRun("http://127.0.0.1:8790", "key")).toEqual([{ name: "linear", url: "http://127.0.0.1:8790/api/agent/mcp/linear", headers: { "X-Hearth-Agent": "key" } }]);
  // The state is single-use; a second sign-in reuses the registered client.
  expect((await mcp.finish(state, code)).error).toContain("expired");
  await mcp.signOut("linear");
  await mcp.signIn("linear");
  expect(registered).toBe(1);
});

test("a sign-in link runs out after 15 minutes", async () => {
  await mcp.add({ url: MCP, name: "linear" }, "me");
  const s = await mcp.signIn("linear");
  const { state, code } = approve((s.value as { url: string }).url);
  now += 16 * 60_000;
  expect((await mcp.finish(state, code)).error).toContain("expired");
});

test("tokens are renewed in the background before they run out, and the rotated refresh token is kept", async () => {
  await signedIn();
  await mcp.refreshDue();
  expect(calls.filter((c) => c === "POST auth.example.com/token")).toHaveLength(1); // only the sign-in: not due yet
  now += 3600_000 - 60_000; // a minute left
  await mcp.refreshDue();
  const c = JSON.parse(vault.get("mcp:linear")!);
  expect(c.accessToken).toBe("at2");
  expect(c.refreshToken).toBe("rt2");
  valid.delete("at1"); // the old one stops working; the new one does
  expect((await mcp.check("linear")).state).toBe("connected");
});

test("the proxy adds the token, and a 401 mid-run renews it and tries again: the run never sees it", async () => {
  await signedIn();
  valid.clear(); // the server dropped at1 early (revoked, rotated)
  const req = new Request("http://127.0.0.1:8790/api/agent/mcp/linear", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-Hearth-Agent": "key", "Mcp-Session-Id": "s1" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "search", arguments: { q: "x" } } }) });
  const res = await mcp.forward("linear", req);
  expect(res.status).toBe(200);
  expect((await res.json()).result.content[0].text).toBe('called search with {"q":"x"}');
  expect(JSON.parse(vault.get("mcp:linear")!).accessToken).toBe("at2");
  // The agent's key never goes on to the server.
  expect(calls.filter((c) => c === "POST mcp.example.com/mcp").length).toBeGreaterThanOrEqual(2);
});

test("a refused refresh signs it out, and /mcp shows Sign in", async () => {
  await signedIn();
  refreshTokens.clear();
  now += 3600_000;
  await mcp.refreshDue();
  expect(vault.get("mcp:linear")).toBeNull();
  expect(mcp.view("linear")!.state).toBe("signin");
  expect(mcp.forRun("http://h", "k")).toEqual([]);
});

test("reconnect: a fresh token is enough when the refresh token still works (no new sign-in)", async () => {
  await signedIn();
  valid.clear();
  expect((await mcp.check("linear")).state).toBe("connected"); // check renewed on the 401
  valid.clear();
  const r = await mcp.signIn("linear");
  expect(r.value).toEqual({ connected: true });
});

test("an API key goes in its header, kept in the vault, not in mcp.json", async () => {
  const r = await mcp.add({ url: KEYED, name: "keyed", header: "X-Api-Key", key: "sekret" }, "me");
  expect(r.value?.state).toBe("connected");
  expect(r.value?.auth).toBe("key");
  expect(await Bun.file(join(dir, "mcp.json")).text()).not.toContain("sekret");
  const bad = await mcp.add({ url: KEYED, name: "keyed", header: "X-Api-Key", key: "wrong" }, "me");
  expect(bad.value?.state).toBe("signin");
  expect(bad.value?.error).toContain("refused the key");
});

test("bad input is refused", async () => {
  expect((await mcp.add({ url: "ftp://x" }, "me")).error).toContain("https");
  expect((await mcp.add({ url: "http://example.com/mcp" }, "me")).error).toContain("https");
  expect((await mcp.add({ url: "http://127.0.0.1:8790/api/health" }, "me")).error).toContain("https");
  expect((await mcp.add({ url: "http://localhost:3000/mcp" }, "me")).error).toContain("https");
  expect((await mcp.add({ url: "https://user:pw@example.com/mcp" }, "me")).error).toContain("key field");
  expect((await mcp.add({ url: OPEN, name: "Bad Name!" }, "me")).error).toContain("Names");
  expect(nameFromUrl("https://mcp.linear.app/mcp")).toBe("linear");
  expect(nameFromUrl("https://api.githubcopilot.com/mcp/")).toBe("githubcopilot");
});

test("the list survives a restart; off servers aren't given to runs; remove forgets the login", async () => {
  await signedIn();
  await mcp.add({ url: OPEN, name: "open" }, "me");
  const again = new Mcp({ dataDir: dir, vault, redirectUri: () => "https://hub.example.com/api/mcp/callback", fetch: fakeFetch as typeof fetch, now: () => now });
  await again.checkAll();
  expect(again.list().map((s) => [s.name, s.state])).toEqual([["linear", "connected"], ["open", "connected"]]);
  await again.setEnabled("open", false);
  expect(again.view("open")!.state).toBe("off");
  expect(again.forRun("http://h", "k").map((s) => s.name)).toEqual(["linear"]);
  expect((await again.forward("open", new Request("http://h/x", { method: "POST", body: "{}" }))).status).toBe(404);
  again.remove("linear");
  expect(vault.get("mcp:linear")).toBeNull();
  expect(vault.get("mcp-client:linear")).toBeNull();
});

test("hearth-mcp: add prints the sign-in link for the user; list, tools and call work", async () => {
  const out = await mcpAgent(mcp, ["add", MCP, "linear"], "an agent");
  expect(out).toContain("It needs a sign-in");
  expect(out).toContain("https://auth.example.com/authorize?");
  expect(await mcpAgent(mcp, ["add", OPEN, "open"], "an agent")).toContain("open  connected");
  expect(await mcpAgent(mcp, ["list"], "an agent")).toContain("linear  signin");
  expect(await mcpAgent(mcp, ["tools", "open"], "an agent")).toContain("search: Search issues");
  expect(await mcpAgent(mcp, ["call", "open", "create", '{"title":"t"}'], "an agent")).toContain('called create with {\\"title\\":\\"t\\"}');
  expect(await mcpAgent(mcp, ["call", "open", "create", "not json"], "an agent")).toContain("must be JSON");
  expect(await mcpAgent(mcp, ["call", "nope", "x"], "an agent")).toContain("No MCP server called nope");
});

test("run config: Claude's --mcp-config and Codex's per-server keys", () => {
  const s = [{ name: "linear", url: "http://127.0.0.1:8790/api/agent/mcp/linear", headers: { "X-Hearth-Agent": "k" } }];
  expect(JSON.parse(claudeMcpConfig(s))).toEqual({ mcpServers: { linear: { type: "http", url: s[0].url, headers: { "X-Hearth-Agent": "k" } } } });
  expect(codexMcpConfig(s)).toEqual({ "mcp_servers.linear": { url: s[0].url, http_headers: { "X-Hearth-Agent": "k" } } });
});
