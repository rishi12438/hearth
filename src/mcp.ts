import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Vault } from "./vault.ts";

// MCP servers for every brain, signed in once on the hub.
//
// You (or an agent, with `hearth-mcp add`) add a server's URL once. The hub signs in to it itself: it finds the server's
// login service (the MCP spec's protected-resource and authorization-server metadata), registers itself as a client, and
// sends you a sign-in link; the browser comes back to <hub>/api/mcp/callback. The tokens stay in the vault and only the
// hub uses them: it renews each one in the background before it runs out.
//
// Brains never see a token. Each working run (Claude or Codex) gets the servers as the hub's own proxy,
// /api/agent/mcp/<name>, opened with the agent key; the proxy adds the current token on the way out. So a token renewed
// or a server reconnected mid-job just works for the run that's already going: nothing restarts. A server added mid-job
// is reachable at once through `hearth-mcp call` (the run's own tool list was fixed when it started).
//
// The list (names and URLs, nothing secret) is <data>/mcp.json; tokens and API keys are in the vault as mcp:<name>.

export type McpServer = { name: string; url: string; enabled: boolean; addedBy: string; addedAt: string };
export type McpState = "connected" | "signin" | "failed" | "off" | "checking";
export type McpStatus = { state: McpState; tools: string[]; error?: string; checkedAt?: string };
export type McpView = McpServer & McpStatus & { auth: "oauth" | "key" | "none" };
export type McpTool = { name: string; description?: string; inputSchema?: unknown };

type OAuthCreds = {
  kind: "oauth"; clientId: string; clientSecret?: string; authMethod: AuthMethod; tokenEndpoint: string; resource: string;
  accessToken: string; refreshToken?: string; expiresAt?: number; scope?: string;
};
type KeyCreds = { kind: "key"; header: string; value: string };
type Creds = OAuthCreds | KeyCreds;
type AuthMethod = "none" | "client_secret_post" | "client_secret_basic";
type Client = { clientId: string; clientSecret?: string; authMethod: AuthMethod; redirectUri: string; issuer: string };
type Pending = { name: string; verifier: string; client: Client; tokenEndpoint: string; resource: string; scope?: string; until: number };
type Result<T> = { value: T; error?: undefined } | { error: string; value?: undefined };

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/;
const HEADER_RE = /^[A-Za-z0-9-]{1,64}$/;
const PROTOCOL = "2025-06-18";
const STATE_TTL_MS = 15 * 60_000;
/** Renew a token this long before it runs out. */
const EARLY_MS = 5 * 60_000;
const TIMEOUT_MS = 30_000;
/** Request headers the proxy passes on (MCP's own and content negotiation); everything else, keys included, stays here. */
const PASS_UP = ["content-type", "accept", "mcp-session-id", "mcp-protocol-version", "last-event-id"];
const PASS_DOWN = ["content-type", "mcp-session-id", "mcp-protocol-version", "cache-control"];

/** A name from the server's address: mcp.linear.app → linear, api.githubcopilot.com/mcp → githubcopilot. */
export function nameFromUrl(url: string): string {
  try {
    const parts = new URL(url).hostname.split(".").filter((p) => !/^(mcp|api|www|app)$/.test(p));
    const base = (parts.length > 1 ? parts[parts.length - 2] : parts[0]) || "server";
    return base.toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 31) || "server";
  } catch { return "server"; }
}

const b64url = (b: Buffer) => b.toString("base64url");

export type McpOptions = {
  dataDir: string;
  vault: Vault | null;
  /** Where the login service sends the browser back: <public hub URL>/api/mcp/callback. */
  redirectUri: () => string;
  onChange?: () => void;
  fetch?: typeof fetch;
  now?: () => number;
};

export class Mcp {
  private file: string;
  private servers: McpServer[] = [];
  private status = new Map<string, McpStatus>();
  private pending = new Map<string, Pending>();
  private refreshing = new Map<string, Promise<boolean>>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private fetch: typeof fetch;
  private now: () => number;

  constructor(private o: McpOptions) {
    this.file = join(o.dataDir, "mcp.json");
    this.fetch = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
    try { if (existsSync(this.file)) this.servers = (JSON.parse(readFileSync(this.file, "utf8")).servers || []).filter((s: any) => NAME_RE.test(s?.name) && typeof s?.url === "string"); } catch {}
  }

  /** Renew tokens in the background (every minute) and look at every server again every 15 minutes. */
  start() {
    void this.checkAll();
    this.timers.push(setInterval(() => void this.refreshDue(), 60_000), setInterval(() => void this.checkAll(), 15 * 60_000));
    for (const t of this.timers) (t as any).unref?.();
  }
  stop() { for (const t of this.timers) clearInterval(t); this.timers = []; }

  // ---- the list ----

  list(): McpView[] {
    return this.servers.map((s) => {
      const c = this.creds(s.name);
      const st = !s.enabled ? { state: "off" as const, tools: this.status.get(s.name)?.tools || [] } : this.status.get(s.name) ?? { state: "checking" as const, tools: [] };
      return { ...s, ...st, auth: c?.kind === "key" ? "key" : c?.kind === "oauth" || this.status.get(s.name)?.state === "signin" ? "oauth" : "none" };
    });
  }
  get(name: string) { return this.servers.find((s) => s.name === name) ?? null; }
  view(name: string) { return this.list().find((s) => s.name === name) ?? null; }

  /** Add one (or change its address). An API key goes in a header; without one, the hub signs in with OAuth if asked to. */
  async add(input: { name?: string; url: string; header?: string; key?: string }, by: string): Promise<Result<McpView>> {
    let url: URL;
    try { url = new URL(String(input.url || "").trim()); } catch { return { error: "That isn't a web address." }; }
    // https only: no plain-http server, local ones included (the hub would be calling its own machine's services).
    if (url.protocol !== "https:") return { error: "MCP servers need an https:// address." };
    if (url.username || url.password) return { error: "Put the key in the key field, not in the address." };
    const name = (input.name || nameFromUrl(url.href)).trim().toLowerCase();
    if (!NAME_RE.test(name)) return { error: "Names are lowercase letters, numbers, - and _ (up to 31)." };
    if (input.key) {
      if (!this.o.vault) return { error: "This hub has no key vault." };
      const header = (input.header || "Authorization").trim();
      if (!HEADER_RE.test(header)) return { error: "That isn't a header name." };
      const value = header.toLowerCase() === "authorization" && !/^\w+ /.test(input.key.trim()) ? `Bearer ${input.key.trim()}` : input.key.trim();
      this.o.vault.set(`mcp:${name}`, JSON.stringify({ kind: "key", header, value } satisfies KeyCreds));
    }
    const old = this.get(name);
    if (old && old.url !== url.href && !input.key) this.forget(name); // a new address: the old sign-in isn't for it
    const s: McpServer = { name, url: url.href, enabled: true, addedBy: old?.addedBy || by, addedAt: old?.addedAt || new Date(this.now()).toISOString() };
    this.servers = [...this.servers.filter((x) => x.name !== name), s].sort((a, b) => a.name.localeCompare(b.name));
    this.save();
    await this.check(name);
    return { value: this.view(name)! };
  }

  remove(name: string): Result<true> {
    if (!this.get(name)) return { error: `No MCP server called ${name}.` };
    this.servers = this.servers.filter((s) => s.name !== name);
    this.forget(name);
    this.o.vault?.delete(`mcp-client:${name}`);
    this.status.delete(name);
    this.save();
    return { value: true };
  }

  async setEnabled(name: string, on: boolean): Promise<Result<McpView>> {
    const s = this.get(name);
    if (!s) return { error: `No MCP server called ${name}.` };
    s.enabled = on;
    this.save();
    if (on) await this.check(name); else this.changed();
    return { value: this.view(name)! };
  }

  /** Sign out of one: its tokens go, the server stays on the list. */
  signOut(name: string): Result<true> {
    if (!this.get(name)) return { error: `No MCP server called ${name}.` };
    this.forget(name);
    this.setStatus(name, { state: "signin", tools: [] });
    return { value: true };
  }

  /** What a working run gets: each server that's on and usable, as this hub's proxy. */
  forRun(base: string, key: string): { name: string; url: string; headers: Record<string, string> }[] {
    return this.servers.filter((s) => s.enabled && this.status.get(s.name)?.state === "connected")
      .map((s) => ({ name: s.name, url: `${base}/api/agent/mcp/${s.name}`, headers: { "X-Hearth-Agent": key } }));
  }

  // ---- signing in ----

  /** The link to sign in to one (or connected: it needs no sign-in, or a fresh token was enough). */
  async signIn(name: string, redirectUri = this.o.redirectUri()): Promise<Result<{ url: string } | { connected: true }>> {
    const s = this.get(name);
    if (!s) return { error: `No MCP server called ${name}.` };
    if (!this.o.vault) return { error: "This hub has no key vault." };
    // Reconnect: a refresh is enough when the login service still honours it.
    const c = this.creds(name);
    if (c?.kind === "oauth" && c.refreshToken && (await this.refresh(name)) && (await this.check(name)).state === "connected") return { value: { connected: true } };
    try {
      const d = await this.discover(s.url);
      if (!d.needsAuth) { await this.check(name); return { value: { connected: true } }; }
      const client = await this.client(name, d.meta, redirectUri);
      const verifier = b64url(randomBytes(32));
      const state = b64url(randomBytes(24));
      this.pending.set(state, { name, verifier, client, tokenEndpoint: String(d.meta.token_endpoint), resource: d.resource, scope: d.scope, until: this.now() + STATE_TTL_MS });
      for (const [k, p] of this.pending) if (p.until < this.now()) this.pending.delete(k);
      const q = new URLSearchParams({ response_type: "code", client_id: client.clientId, redirect_uri: redirectUri, state,
        code_challenge: b64url(createHash("sha256").update(verifier).digest()), code_challenge_method: "S256", resource: d.resource,
        ...(d.scope ? { scope: d.scope } : {}) });
      const at = new URL(String(d.meta.authorization_endpoint));
      for (const [k, v] of q) at.searchParams.set(k, v);
      return { value: { url: at.href } };
    } catch (e: any) {
      return { error: `Couldn't start signing in to ${name}: ${String(e?.message || e).slice(0, 200)}` };
    }
  }

  /** The browser came back from the login service with a code. */
  async finish(state: string, code: string): Promise<Result<string>> {
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || p.until < this.now()) return { error: "That sign-in link expired. Open /mcp and sign in again." };
    if (!code) return { error: "The login service sent no code." };
    try {
      const t = await this.token(p.tokenEndpoint, p.client, { grant_type: "authorization_code", code, redirect_uri: p.client.redirectUri, code_verifier: p.verifier, resource: p.resource });
      if (!t.access_token) return { error: `${p.name}'s login service sent no token.` };
      this.saveTokens(p.name, { kind: "oauth", clientId: p.client.clientId, clientSecret: p.client.clientSecret, authMethod: p.client.authMethod, tokenEndpoint: p.tokenEndpoint, resource: p.resource, scope: t.scope || p.scope, accessToken: "" }, t);
      await this.check(p.name);
      return { value: p.name };
    } catch (e: any) {
      return { error: `Signing in to ${p.name} didn't work: ${String(e?.message || e).slice(0, 200)}` };
    }
  }

  /** Renew every token that runs out in the next few minutes. Runs every minute. */
  async refreshDue() {
    for (const s of this.servers) {
      const c = this.creds(s.name);
      if (c?.kind === "oauth" && c.refreshToken && c.expiresAt && c.expiresAt - this.now() < EARLY_MS) await this.refresh(s.name);
    }
  }

  /** A new access token from the refresh token. One at a time per server (the login service may rotate the refresh token). */
  refresh(name: string): Promise<boolean> {
    const busy = this.refreshing.get(name);
    if (busy) return busy;
    const run = (async () => {
      const c = this.creds(name);
      if (c?.kind !== "oauth" || !c.refreshToken) return false;
      try {
        const t = await this.token(c.tokenEndpoint, { clientId: c.clientId, clientSecret: c.clientSecret, authMethod: c.authMethod, redirectUri: "", issuer: "" },
          { grant_type: "refresh_token", refresh_token: c.refreshToken, resource: c.resource });
        if (!t.access_token) return false;
        this.saveTokens(name, c, t);
        return true;
      } catch (e: any) {
        // Refused (revoked, expired): sign in again. A network error leaves it for the next try.
        if (e instanceof Refused) { this.forget(name); this.setStatus(name, { state: "signin", tools: [], error: "Signed out. Sign in again." }); }
        else console.warn(`mcp: couldn't renew ${name}'s token: ${String(e?.message || e).slice(0, 200)}`);
        return false;
      }
    })().finally(() => this.refreshing.delete(name));
    this.refreshing.set(name, run);
    return run;
  }

  // ---- talking to servers ----

  async checkAll() { await Promise.all(this.servers.filter((s) => s.enabled).map((s) => this.check(s.name).catch(() => {}))); }

  /** Connect for real (initialize, tools/list) and keep what happened: connected with its tools, needs sign-in, or failed. */
  async check(name: string): Promise<McpStatus> {
    const s = this.get(name);
    if (!s) return { state: "failed", tools: [], error: "Not on the list." };
    if (!s.enabled) return { state: "off", tools: [] };
    try {
      const tools = await this.tools(name);
      return this.setStatus(name, { state: "connected", tools: tools.map((t) => t.name) });
    } catch (e: any) {
      if (e instanceof NeedsSignIn) return this.setStatus(name, { state: "signin", tools: [], error: this.creds(name)?.kind === "key" ? "The server refused the key." : undefined });
      return this.setStatus(name, { state: "failed", tools: [], error: String(e?.message || e).slice(0, 300) });
    }
  }

  async tools(name: string): Promise<McpTool[]> {
    const out: McpTool[] = [];
    await this.session(name, async (rpc) => {
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const r = await rpc("tools/list", cursor ? { cursor } : {});
        out.push(...(Array.isArray(r?.tools) ? r.tools : []).map((t: any) => ({ name: String(t?.name || ""), description: t?.description ? String(t.description) : undefined, inputSchema: t?.inputSchema })).filter((t: McpTool) => t.name));
        cursor = typeof r?.nextCursor === "string" && r.nextCursor ? r.nextCursor : undefined;
        if (!cursor) break;
      }
    });
    return out;
  }

  /** One tool call (hearth-mcp call), on a session of its own. */
  async call(name: string, tool: string, args: unknown): Promise<unknown> {
    let out: unknown;
    await this.session(name, async (rpc) => { out = await rpc("tools/call", { name: tool, arguments: args ?? {} }); });
    return out;
  }

  /**
   * The proxy: a brain's request to /api/agent/mcp/<name>, sent on with the current token. A 401 renews the token and
   * tries once more, so a run that's going never sees a token run out.
   */
  async forward(name: string, req: Request): Promise<Response> {
    const s = this.get(name);
    if (!s || !s.enabled) return new Response(JSON.stringify({ error: `No MCP server called ${name} is on.` }), { status: 404, headers: { "Content-Type": "application/json" } });
    const headers: Record<string, string> = {};
    for (const h of PASS_UP) { const v = req.headers.get(h); if (v) headers[h] = v; }
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    let up: Response;
    try { up = await this.send(name, s.url, { method: req.method, headers, body, signal: req.signal }); }
    catch (e: any) { return new Response(JSON.stringify({ error: `Couldn't reach ${name}: ${String(e?.message || e).slice(0, 200)}` }), { status: 502, headers: { "Content-Type": "application/json" } }); }
    if (up.status === 401) this.setStatus(name, { state: "signin", tools: [], error: "Signed out. Sign in again." });
    const out = new Headers();
    for (const h of PASS_DOWN) { const v = up.headers.get(h); if (v) out.set(h, v); }
    return new Response(up.body, { status: up.status, headers: out });
  }

  // ---- inside ----

  private creds(name: string): Creds | null {
    try { const t = this.o.vault?.get(`mcp:${name}`); return t ? JSON.parse(t) : null; } catch { return null; }
  }
  private forget(name: string) { this.o.vault?.delete(`mcp:${name}`); }

  private saveTokens(name: string, base: OAuthCreds, t: TokenResponse) {
    const c: OAuthCreds = { ...base, accessToken: t.access_token!, refreshToken: t.refresh_token || base.refreshToken,
      expiresAt: Number(t.expires_in) > 0 ? this.now() + Number(t.expires_in) * 1000 : undefined, scope: t.scope || base.scope };
    this.o.vault!.set(`mcp:${name}`, JSON.stringify(c));
  }

  private setStatus(name: string, st: McpStatus): McpStatus {
    const full = { ...st, checkedAt: new Date(this.now()).toISOString() };
    const before = JSON.stringify({ ...this.status.get(name), checkedAt: 0 });
    this.status.set(name, full);
    if (before !== JSON.stringify({ ...full, checkedAt: 0 })) this.changed();
    return full;
  }
  private changed() { try { this.o.onChange?.(); } catch {} }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ servers: this.servers }, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
    this.changed();
  }

  /** A request to the server with its credentials. On a 401 with a refresh token: renew once and try again. */
  private async send(name: string, url: string, init: RequestInit, again = true): Promise<Response> {
    const c = this.creds(name);
    const headers = new Headers(init.headers);
    if (c?.kind === "oauth") headers.set("Authorization", `Bearer ${c.accessToken}`);
    if (c?.kind === "key") headers.set(c.header, c.value);
    const r = await this.fetch(url, { ...init, headers, redirect: "error" });
    if (r.status === 401 && again && c?.kind === "oauth" && c.refreshToken && (await this.refresh(name))) {
      try { await r.body?.cancel(); } catch {}
      return this.send(name, url, init, false);
    }
    return r;
  }

  /** An MCP session over streamable HTTP: initialize, then fn's requests, then close it. */
  private async session(name: string, fn: (rpc: (method: string, params: unknown) => Promise<any>) => Promise<void>) {
    const s = this.get(name)!;
    let sid: string | null = null;
    let id = 0;
    const post = async (msg: Record<string, unknown>) => {
      const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": PROTOCOL };
      if (sid) headers["Mcp-Session-Id"] = sid;
      const r = await this.send(name, s.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...msg }), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (r.status === 401 || r.status === 403) { try { await r.body?.cancel(); } catch {} throw new NeedsSignIn(); }
      return r;
    };
    const rpc = async (method: string, params: unknown) => {
      const my = ++id;
      const r = await post({ id: my, method, params });
      if (!r.ok) throw new Error(`${name} answered ${r.status}${await errorText(r)}`);
      sid = r.headers.get("mcp-session-id") || sid;
      const m = await readReply(r, my);
      if (m.error) throw new Error(`${name}: ${String(m.error.message || "error").slice(0, 200)}`);
      return m.result;
    };
    await rpc("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "hearth", version: "1" } });
    const n = await post({ method: "notifications/initialized" });
    try { await n.body?.cancel(); } catch {}
    try { await fn(rpc); }
    finally {
      if (sid) void this.send(name, s.url, { method: "DELETE", headers: { "Mcp-Session-Id": sid }, signal: AbortSignal.timeout(5000) }).then((r) => r.body?.cancel()).catch(() => {});
    }
  }

  /** Does the server want a login, and where is its login service? (MCP authorization: RFC 9728, then RFC 8414.) */
  private async discover(url: string): Promise<{ needsAuth: boolean; meta: Record<string, any>; resource: string; scope?: string }> {
    const probe = await this.fetch(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": PROTOCOL },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "hearth", version: "1" } } }) });
    try { await probe.body?.cancel(); } catch {}
    if (probe.status !== 401 && probe.status !== 403) {
      if (probe.ok) return { needsAuth: false, meta: {}, resource: url };
      throw new Error(`the server answered ${probe.status}`);
    }
    const www = probe.headers.get("www-authenticate") || "";
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, "");
    const prm = await this.firstJson([/resource_metadata="([^"]+)"/.exec(www)?.[1], `${u.origin}/.well-known/oauth-protected-resource${path}`, `${u.origin}/.well-known/oauth-protected-resource`]);
    const issuer = new URL(String(prm?.authorization_servers?.[0] || u.origin));
    const ipath = issuer.pathname.replace(/\/$/, "");
    const meta = await this.firstJson(ipath
      ? [`${issuer.origin}/.well-known/oauth-authorization-server${ipath}`, `${issuer.origin}/.well-known/openid-configuration${ipath}`, `${issuer.origin}${ipath}/.well-known/openid-configuration`]
      : [`${issuer.origin}/.well-known/oauth-authorization-server`, `${issuer.origin}/.well-known/openid-configuration`])
      // Servers from before the metadata documents: the default paths on the server's own origin.
      ?? { issuer: u.origin, authorization_endpoint: `${u.origin}/authorize`, token_endpoint: `${u.origin}/token`, registration_endpoint: `${u.origin}/register` };
    if (!meta.authorization_endpoint || !meta.token_endpoint) throw new Error("its login service didn't say where to sign in");
    const scopes = /scope="([^"]+)"/.exec(www)?.[1] || (Array.isArray(prm?.scopes_supported) ? prm.scopes_supported.join(" ") : undefined);
    return { needsAuth: true, meta: { ...meta, issuer: meta.issuer || issuer.href }, resource: String(prm?.resource || url), scope: scopes || undefined };
  }

  private async firstJson(urls: (string | undefined)[]): Promise<Record<string, any> | null> {
    for (const href of urls) {
      if (!href) continue;
      try {
        const r = await this.fetch(href, { headers: { Accept: "application/json", "MCP-Protocol-Version": PROTOCOL }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!r.ok) { try { await r.body?.cancel(); } catch {} continue; }
        const j = await r.json();
        if (j && typeof j === "object") return j as Record<string, any>;
      } catch {}
    }
    return null;
  }

  /** This hub as a client of the login service: registered once (dynamic client registration), kept for next time. */
  private async client(name: string, meta: Record<string, any>, redirectUri: string): Promise<Client> {
    try {
      const kept = JSON.parse(this.o.vault!.get(`mcp-client:${name}`) || "null") as Client | null;
      if (kept && kept.redirectUri === redirectUri && kept.issuer === meta.issuer) return kept;
    } catch {}
    if (!meta.registration_endpoint) throw new Error("its login service doesn't let apps register; add it with an API key instead");
    const r = await this.fetch(String(meta.registration_endpoint), { method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_name: "Hearth", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) });
    if (!r.ok) throw new Error(`registering with its login service failed (${r.status}${await errorText(r)})`);
    const j: any = await r.json();
    if (!j?.client_id) throw new Error("its login service gave no client id");
    const supported: string[] = Array.isArray(meta.token_endpoint_auth_methods_supported) ? meta.token_endpoint_auth_methods_supported : [];
    const authMethod: AuthMethod = !j.client_secret ? "none"
      : j.token_endpoint_auth_method === "client_secret_basic" || (supported.length && !supported.includes("client_secret_post")) ? "client_secret_basic" : "client_secret_post";
    const c: Client = { clientId: String(j.client_id), clientSecret: j.client_secret ? String(j.client_secret) : undefined, authMethod, redirectUri, issuer: String(meta.issuer) };
    this.o.vault!.set(`mcp-client:${name}`, JSON.stringify(c));
    return c;
  }

  private async token(endpoint: string, c: Client, params: Record<string, string>): Promise<TokenResponse> {
    const form = new URLSearchParams(params);
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
    if (c.authMethod === "client_secret_basic") headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(c.clientId)}:${encodeURIComponent(c.clientSecret || "")}`).toString("base64")}`;
    else { form.set("client_id", c.clientId); if (c.authMethod === "client_secret_post" && c.clientSecret) form.set("client_secret", c.clientSecret); }
    const r = await this.fetch(endpoint, { method: "POST", headers, body: form.toString(), signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await r.text();
    let j: any = null;
    try { j = JSON.parse(text); } catch { j = Object.fromEntries(new URLSearchParams(text)); }
    if (!r.ok) {
      const why = `${j?.error || r.status}${j?.error_description ? `: ${j.error_description}` : ""}`;
      if (r.status === 400 || r.status === 401) throw new Refused(why);
      throw new Error(why);
    }
    return j;
  }
}

type TokenResponse = { access_token?: string; refresh_token?: string; expires_in?: number | string; scope?: string };
class NeedsSignIn extends Error {}
class Refused extends Error {}

async function errorText(r: Response) {
  try { const t = (await r.text()).replace(/\s+/g, " ").trim(); return t ? `: ${t.slice(0, 200)}` : ""; } catch { return ""; }
}

/** The JSON-RPC answer with this id, from a JSON body or an event stream (which may carry other messages first). */
async function readReply(r: Response, id: number): Promise<any> {
  if (!(r.headers.get("content-type") || "").includes("text/event-stream")) {
    const j: any = await r.json();
    const all = Array.isArray(j) ? j : [j];
    const m = all.find((x) => x?.id === id);
    if (!m) throw new Error("the server's answer had no reply");
    return m;
  }
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.search(/\r?\n\r?\n/)) >= 0) {
        const event = buf.slice(0, i); buf = buf.slice(i).replace(/^\r?\n\r?\n/, "");
        const data = event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
        if (!data) continue;
        try { const m = JSON.parse(data); if (m?.id === id) return m; } catch {}
      }
      if (done) throw new Error("the server closed the stream without replying");
    }
  } finally { try { await reader.cancel(); } catch {} }
}

/** The agent's hearth-mcp command: a few lines of curl to the hub with its agent key (like hearth-lead). */
export function mcpSkill(hubUrl: string, key: string) {
  const script = `#!/usr/bin/env bash
# hearth-mcp: MCP servers on this hub. list | tools <server> | call <server> <tool> [json|-] | add <url> [name] | signin <server>
set -uo pipefail
if [ $# -eq 0 ]; then set -- list; fi
args=()
for a in "$@"; do
  if [ "$a" = "-" ]; then a="$(cat)"; fi
  args+=(--data-urlencode "a=$a")
done
exec curl -sS -m 600 -H "X-Hearth-Agent: ${key}" "\${args[@]}" "${hubUrl}/api/agent/mcp"
`;
  return {
    name: "hearth-mcp", common: true, commands: ["hearth-mcp"], reads: [], scripts: { "hearth-mcp": script },
    description: "MCP servers (Linear, Notion, GitHub…) the hub is signed in to: list them, see their tools, call one, or add a new server.",
    body: `# MCP servers

The hub keeps your MCP servers and their logins. The ones that were connected when this run started are already your
tools (named mcp__<server>__<tool> on Claude). This command reaches all of them, including any added since you started.

- \`hearth-mcp list\`: every server, whether it's connected, and its tools
- \`hearth-mcp tools <server>\`: its tools with what each takes
- \`hearth-mcp call <server> <tool> '<json arguments>'\` (or \`-\` to read the JSON from stdin): prints the result
- \`hearth-mcp add <https url> [name]\`: add a server. If it needs a login, this prints a sign-in link: give the user
  that link (or tell them to type /mcp in Hearth). You can't sign in for them. Once they have, \`call\` works right away.
- \`hearth-mcp signin <server>\`: a fresh sign-in link for one that's signed out

Use the server's own tools when you have them; \`call\` is for a server added after this run started.`,
  };
}

/** What `hearth-mcp <argv>` does, for the hub's /api/agent/mcp. Text back for the agent to read. */
export async function mcpAgent(mcp: Mcp, argv: string[], by: string): Promise<string> {
  const [cmd = "list", a, b, c] = argv;
  const line = (s: McpView) => `${s.name}  ${s.state}${s.error ? ` (${s.error})` : ""}  ${s.url}${s.tools.length ? `\n  tools: ${s.tools.join(", ")}` : ""}`;
  switch (cmd) {
    case "list": {
      const all = mcp.list();
      return all.length ? all.map(line).join("\n") : "No MCP servers yet. Add one with: hearth-mcp add <https url>";
    }
    case "tools": {
      if (!a || !mcp.get(a)) return `No MCP server called ${a || "?"}. Run: hearth-mcp list`;
      const tools = await mcp.tools(a);
      return tools.map((t) => `${t.name}: ${(t.description || "").replace(/\s+/g, " ").slice(0, 300)}\n  takes: ${JSON.stringify(t.inputSchema ?? {}).slice(0, 1500)}`).join("\n") || "No tools.";
    }
    case "call": {
      if (!a || !b) return "usage: hearth-mcp call <server> <tool> '<json arguments>'";
      if (!mcp.get(a)) return `No MCP server called ${a}. Run: hearth-mcp list`;
      let args: unknown = {};
      if (c?.trim()) { try { args = JSON.parse(c); } catch { return "The arguments must be JSON, like '{\"query\": \"…\"}'."; } }
      return JSON.stringify(await mcp.call(a, b, args), null, 1);
    }
    case "add": {
      if (!a) return "usage: hearth-mcp add <https url> [name]";
      const r = await mcp.add({ url: a, name: b }, by);
      if (!r.value) return r.error;
      const added = r.value;
      if (added.state !== "signin") return line(added);
      const s = await mcp.signIn(added.name);
      if (!s.value) return `${added.name} needs a sign-in, but: ${s.error}`;
      return "url" in s.value ? `Added ${added.name}. It needs a sign-in: give the user this link (or tell them to type /mcp in Hearth):\n${s.value.url}` : line(mcp.view(added.name)!);
    }
    case "signin": {
      if (!a) return "usage: hearth-mcp signin <server>";
      const s = await mcp.signIn(a);
      if (!s.value) return s.error;
      return "url" in s.value ? `Give the user this link to sign in to ${a}:\n${s.value.url}` : `${a} is connected.`;
    }
    default:
      return "usage: hearth-mcp list | tools <server> | call <server> <tool> [json|-] | add <url> [name] | signin <server>";
  }
}
