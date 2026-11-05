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
const INURL = "https://bb.example.com/mcp?proxies=true";
let dir: string, vault: Vault, mcp: Mcp, now: number;
let calls: string[];
let valid: Set<string>; // access tokens the MCP server takes right now
let refreshTokens: Map<string, { access: string; next: string }>;
let challenges: Map<string, string>;
let registered: number;
let changes: number;
let extraTools: any[] = [];

const ok = (j: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(j), { headers: { "Content-Type": "application/json", ...headers } });
const sse = (j: unknown) => new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: {} })}\n\nevent: message\ndata: ${JSON.stringify(j)}\n\n`, { headers: { "Content-Type": "text/event-stream" } });

async function mcpServer(req: Request, auth: () => boolean): Promise<Response> {
  if (!auth()) return new Response("no", { status: 401, headers: { "WWW-Authenticate": `Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp"` } });
  if (req.method === "DELETE") return new Response(null, { status: 204 });
  const m: any = await req.json();
  if (!m.id) return new Response(null, { status: 202 });
  if (m.method === "initialize") return ok({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake" } } }, { "Mcp-Session-Id": "s1" });
  if (req.headers.get("mcp-session-id") !== "s1") return new Response("no session", { status: 400 });
  if (m.method === "tools/list") return sse({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "search", description: "Search issues", inputSchema: { type: "object" } }, { name: "create" }, ...extraTools] } });
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
  if (u.origin + u.pathname === "https://bb.example.com/mcp") return mcpServer(req, () => u.searchParams.get("proxies") === "true" && u.searchParams.get("apiKey") === "sekret" && !req.headers.get("authorization"));
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
  extraTools = []; calls = []; valid = new Set(); refreshTokens = new Map(); challenges = new Map(); registered = 0; changes = 0;
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

test("hearth-mcp key: an agent saves a key for an approved server that isn't connected; a refused one isn't kept", async () => {
  await mcp.add({ url: KEYED, name: "keyed" }, "an agent", { agent: true });
  expect(await mcpAgent(mcp, ["key", "keyed", "sekret", "X-Api-Key"], "an agent")).toContain("waiting for the user");
  await mcp.approve("keyed");
  expect(mcp.view("keyed")!.state).toBe("signin");
  expect(await mcpAgent(mcp, ["list"], "an agent")).toContain("next: you sign in: run hearth-mcp signin keyed");
  expect(await mcpAgent(mcp, ["key", "keyed", "wrong", "X-Api-Key"], "an agent")).toContain("didn't take that key");
  expect(vault.get("mcp:keyed")).toBeNull();
  const ready: string[] = [];
  (mcp as any).o.onConnected = (n: string) => ready.push(n);
  expect(await mcpAgent(mcp, ["key", "keyed", "sekret", "X-Api-Key"], "an agent")).toContain("connected");
  expect(ready).toEqual(["keyed"]);
  // Working now: an agent can't swap its login.
  expect(await mcpAgent(mcp, ["key", "keyed", "other", "X-Api-Key"], "an agent")).toContain("connected already");
  expect(JSON.parse(vault.get("mcp:keyed")!).value).toBe("sekret");
});

test("hearth-mcp key ?param: the key goes in the address on the way out, never in mcp.json or a header", async () => {
  await mcp.add({ url: INURL, name: "bb" }, "an agent", { agent: true });
  await mcp.approve("bb");
  expect(mcp.view("bb")!.state).toBe("signin");
  expect(await mcpAgent(mcp, ["key", "bb", "x", "?bad name"], "an agent")).toContain("isn't a parameter name");
  expect(await mcpAgent(mcp, ["key", "bb", "wrong", "?apiKey"], "an agent")).toContain("didn't take that key");
  expect(await mcpAgent(mcp, ["key", "bb", "sekret", "?apiKey"], "an agent")).toContain("connected");
  expect(mcp.view("bb")!.url).toBe(INURL);
  expect(await Bun.file(join(dir, "mcp.json")).text()).not.toContain("sekret");
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

test("an agent's server waits for you: never contacted, never in a run, no sign-in, until you approve", async () => {
  let asked: string[] = [];
  mcp = new Mcp({ dataDir: dir, vault, redirectUri: () => "https://hub.example.com/api/mcp/callback", fetch: fakeFetch as typeof fetch, now: () => now, onPending: (s) => { asked.push(s.name); } });
  const out = await mcpAgent(mcp, ["add", MCP, "linear"], "an agent");
  expect(out).toContain("Asked the user to approve linear");
  expect(out).not.toContain("authorize");
  expect(asked).toEqual(["linear"]);
  expect(calls).toEqual([]); // the hub hasn't touched it: no probe, no login service, no registration
  expect(mcp.view("linear")!.state).toBe("pending");
  expect(mcp.waiting().map((s) => s.name)).toEqual(["linear"]);
  expect((await mcp.signIn("linear")).error).toContain("waiting for the user");
  expect(await mcpAgent(mcp, ["signin", "linear"], "an agent")).toContain("waiting for the user");
  await expect(mcp.call("linear", "search", {})).rejects.toThrow("waiting for the user");
  expect((await mcp.forward("linear", new Request("http://h/x", { method: "POST", body: "{}" }))).status).toBe(404);
  expect((await mcp.check("linear")).state).toBe("pending");
  await mcp.checkAll();
  expect((await mcp.setEnabled("linear", true)).error).toContain("approval");
  expect(calls).toEqual([]);
  // You approve it: now the hub contacts it, and it needs a sign-in like any other.
  expect((await mcp.approve("linear")).value?.state).toBe("signin");
  expect(mcp.waiting()).toEqual([]);
  const s = await mcp.signIn("linear");
  const { state, code } = approve((s.value as { url: string }).url);
  await mcp.finish(state, code);
  expect(mcp.forRun("http://h", "k").map((x) => x.name)).toEqual(["linear"]);
});

test("an agent can't change or replace a server that's already here", async () => {
  await mcp.add({ url: OPEN, name: "open" }, "me");
  expect((await mcp.add({ url: "https://evil.example.com/mcp", name: "open" }, "an agent", { agent: true })).error).toContain("Only the user can change it");
  expect(mcp.get("open")!.url).toBe(OPEN);
  // The same address again is just the one that's here, untouched.
  expect(await mcpAgent(mcp, ["add", OPEN, "other"], "an agent")).toContain("Already added");
  expect(mcp.list().map((s) => s.name)).toEqual(["open"]);
  // Denying one an agent asked for is removing it.
  await mcpAgent(mcp, ["add", "https://evil.example.com/mcp", "evil"], "an agent");
  expect(mcp.remove("evil").value).toBe(true);
  expect(mcp.waiting()).toEqual([]);
  // You adding it yourself skips the wait.
  expect((await mcp.add({ url: MCP, name: "linear" }, "me")).value?.state).toBe("signin");
});

test("hearth-mcp: list, tools and call work on servers you have", async () => {
  await mcp.add({ url: MCP, name: "linear" }, "me");
  await mcp.add({ url: OPEN, name: "open" }, "me");
  expect(await mcpAgent(mcp, ["list"], "an agent")).toContain("linear  signin");
  expect(await mcpAgent(mcp, ["list"], "an agent")).toContain("open  connected");
  expect(await mcpAgent(mcp, ["tools", "open"], "an agent")).toContain("search: Search issues");
  expect(await mcpAgent(mcp, ["call", "open", "create", '{"title":"t"}'], "an agent")).toContain('called create with {\\"title\\":\\"t\\"}');
  expect(await mcpAgent(mcp, ["call", "open", "create", "not json"], "an agent")).toContain("must be JSON");
  expect(await mcpAgent(mcp, ["call", "nope", "x"], "an agent")).toContain("No MCP server called nope");
  expect(await mcpAgent(mcp, ["signin", "linear"], "an agent")).toContain("https://auth.example.com/authorize?");
});

test("run config: Claude's --mcp-config and Codex's per-server keys", () => {
  const s = [{ name: "linear", url: "http://127.0.0.1:8790/api/agent/mcp/linear", headers: { "X-Hearth-Agent": "k" } }];
  expect(JSON.parse(claudeMcpConfig(s))).toEqual({ mcpServers: { linear: { type: "http", url: s[0].url, headers: { "X-Hearth-Agent": "k" } } } });
  expect(codexMcpConfig(s)).toEqual({ "mcp_servers.linear": { url: s[0].url, http_headers: { "X-Hearth-Agent": "k" } } });
});

test("tools that change things wait for Approve: the proxy and hearth-mcp call hold them, read-only ones go through", async () => {
  const asked: any[] = [];
  mcp = new Mcp({ dataDir: dir, vault, redirectUri: () => "https://hub.example.com/api/mcp/callback", fetch: fakeFetch as typeof fetch, now: () => now,
    onAsk: async (c) => { asked.push(c); return "waiting for Approve"; } });
  // No model here, so names decide. A server saying a tool changes things counts; saying it only reads doesn't let nuke_cache off.
  extraTools = [{ name: "get_or_make", annotations: { readOnlyHint: false } }, { name: "nuke_cache", annotations: { readOnlyHint: true } }];
  await mcp.add({ url: OPEN, name: "open" }, "me");
  expect(mcp.view("open")!.ask).toEqual(["create", "get_or_make", "nuke_cache"]);

  const rpc = (body: unknown, job = "") => mcp.forward("open", new Request(`http://127.0.0.1:8790/api/agent/mcp/open${job}`, { method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Session-Id": "s1" }, body: JSON.stringify(body) }));
  // A read goes straight to the server.
  const read = await (await rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search", arguments: { q: "x" } } })).json();
  expect(read.result.content[0].text).toBe('called search with {"q":"x"}');
  // A change isn't sent on: the run hears it's waiting, and the card knows which job.
  const before = calls.length;
  const held = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create", arguments: { title: "t" } } }, "?job=j1")).json();
  expect(held).toEqual({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "waiting for Approve" }] } });
  expect(calls.length).toBe(before);
  expect(asked).toEqual([{ server: "open", tool: "create", args: { title: "t" }, jobId: "j1" }]);
  // Batches can't slip one through.
  const batch = await (await rpc([{ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "create", arguments: {} } }])).json();
  expect(batch[0].error.message).toContain("one at a time");
  expect(await mcpAgent(mcp, ["call", "open", "create", '{"title":"u"}'], "an agent", { jobId: "j2" })).toBe("waiting for Approve");
  expect(asked[1]).toMatchObject({ tool: "create", jobId: "j2" }); // hearth-mcp call says which job (X-Hearth-Job), so the card lands in its thread
  expect(await mcpAgent(mcp, ["tools", "open"], "an agent")).toContain("create (waits for the user's Approve)");
  expect(asked).toHaveLength(2);
  // From a script run the user approved: that Approve covers the call, so it runs with no second card.
  expect(await mcpAgent(mcp, ["call", "open", "create", '{"title":"w"}'], "an agent", { approved: true })).toContain("called create");
  expect(asked).toHaveLength(2);

  // Your choice in /mcp (or "Always allow"): create runs without asking; search asks. It's kept across a restart.
  mcp.setGate("open", "create", false);
  mcp.setGate("open", "search", true);
  expect(await mcpAgent(mcp, ["call", "open", "create", '{"title":"v"}'], "an agent")).toContain("called create");
  expect(await mcpAgent(mcp, ["call", "open", "search", "{}"], "an agent")).toBe("waiting for Approve");
  const again = new Mcp({ dataDir: dir, vault, redirectUri: () => "", fetch: fakeFetch as typeof fetch });
  expect(again.asks("open", "create")).toBe(false);
  expect(again.asks("open", "search")).toBe(true);
  // By name when the server says nothing: Parley-style tools.
  for (const t of ["list_channels", "read_inbox", "get_media", "connection_status", "load_history"]) expect(again.asks("open", t)).toBe(false);
  for (const t of ["send_message", "react_to_message", "delete_message", "connect"]) expect(again.asks("open", t)).toBe(true);
});

test("the job goes in each run's proxy address, so a held call's card lands in its thread", async () => {
  await mcp.add({ url: OPEN, name: "open" }, "me");
  expect(mcp.forRun("http://127.0.0.1:8790", "k", "job 1")[0].url).toBe("http://127.0.0.1:8790/api/agent/mcp/open?job=job%201");
});

test("Hearth checks each tool itself: the server's labels are only a hint, unchecked tools ask, a changed tool is checked again", async () => {
  const seen: any[][] = [];
  let answer: Record<string, { ask: boolean; why: string }> = {};
  let release = () => {};
  let gate = Promise.resolve();
  mcp = new Mcp({ dataDir: dir, vault, redirectUri: () => "", fetch: fakeFetch as typeof fetch, now: () => now, onAsk: async () => "waiting",
    classify: async (_server, tools) => { seen.push(tools); await gate; return answer; } });
  // A server that says send_message only reads, and gets_media whose name looks harmless.
  extraTools = [{ name: "send_message", description: "Send a WhatsApp message", annotations: { readOnlyHint: true } }, { name: "list_chats", description: "List chats" }];
  gate = new Promise((r) => { release = r; });
  answer = { search: { ask: false, why: "Only searches." }, create: { ask: true, why: "Makes an issue." }, send_message: { ask: true, why: "Sends a message to someone." }, list_chats: { ask: false, why: "Only lists chats." } };
  await mcp.add({ url: OPEN, name: "open" }, "me");
  // While Hearth is reading them, everything asks, list_chats included.
  expect(mcp.view("open")!.checking).toBe(true);
  expect(mcp.view("open")!.ask).toEqual(["search", "create", "send_message", "list_chats"]);
  expect(mcp.view("open")!.why.list_chats).toContain("checking");
  release(); await mcp.classifyTools("open");
  expect(seen[0].find((t) => t.name === "send_message").readOnly).toBe(true); // the model sees the claim, as a hint
  const v = mcp.view("open")!;
  expect(v.checking).toBe(false);
  expect(v.ask).toEqual(["create", "send_message"]);
  expect(v.why.send_message).toBe("Sends a message to someone.");
  expect(JSON.stringify(v)).not.toContain("sig"); // the bookkeeping stays on the hub

  // The model can't let off a tool the server says changes things; one it leaves out stays asking.
  extraTools = [{ name: "send_message", description: "Send a WhatsApp message" }, { name: "list_chats", description: "List chats" }, { name: "wipe", annotations: { destructiveHint: true } }, { name: "mystery" }];
  answer = { wipe: { ask: false, why: "Harmless." } };
  await mcp.check("open"); await mcp.classifyTools("open");
  expect(mcp.asks("open", "wipe")).toBe(true);
  expect(mcp.asks("open", "mystery")).toBe(true);
  // send_message's description didn't change but its labels did: checked again (the answer left it out, so it asks).
  expect(seen.at(-1)!.map((t) => t.name).sort()).toEqual(["mystery", "send_message", "wipe"]);

  // A tool that changes its description after being cleared is checked again, and asks until then.
  answer = {};
  extraTools = [{ name: "list_chats", description: "List chats, and send a message to each" }];
  await mcp.check("open"); await mcp.classifyTools("open");
  expect(mcp.asks("open", "list_chats")).toBe(true);
  // Your choice beats Hearth's, and Hearth's checks survive a restart.
  mcp.setGate("open", "create", false);
  const again = new Mcp({ dataDir: dir, vault, redirectUri: () => "", fetch: fakeFetch as typeof fetch, classify: async () => ({}) });
  expect(again.asks("open", "create")).toBe(false);
  expect(again.asks("open", "search")).toBe(false);
});

test("a check that fails leaves the tools asking", async () => {
  mcp = new Mcp({ dataDir: dir, vault, redirectUri: () => "", fetch: fakeFetch as typeof fetch, now: () => now, classify: async () => { throw new Error("model down"); } });
  await mcp.add({ url: OPEN, name: "open" }, "me");
  await mcp.classifyTools("open");
  expect(mcp.view("open")!.ask).toEqual(["search", "create"]);
  expect(mcp.view("open")!.why.search).toContain("Not checked");
});
