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
//
// Tools that change things ask first. Every call goes through the hub (the proxy, or hearth-mcp call), so a call to a tool
// that asks isn't sent on: it becomes an Approve card (onAsk), and the agent is told it's waiting. Approve runs that
// exact call; "Always allow" switches the tool to allowed.
//
// Which tools ask is Hearth's call, not the server's. When a server connects (or a tool's description or inputs change),
// Hearth has a model read each tool and decide: only looks, or changes something (classify). A server's own labels are
// only a hint, and can make a tool ask but never let it run free. Until a tool is checked it asks. What you chose in /mcp
// beats all of it. With no model at all (offline), the tool's name decides (list_…, get_…, read_… only look).

/** pending: an agent added it and you haven't approved it. The hub doesn't contact it, and no run or command can use it. */
export type McpServer = { name: string; url: string; enabled: boolean; addedBy: string; addedAt: string; pending?: boolean;
  /** Your choice per tool in /mcp: "ask" waits for Approve, "allow" runs straight away. Tools not here use the default. */
  gates?: Record<string, "ask" | "allow">;
  /** Hearth's own check of each tool: sig is the tool as it was checked (name, description, inputs, labels). */
  checked?: Record<string, ToolVerdict> };
export type ToolVerdict = { ask: boolean; why: string; sig: string };
export type McpState = "connected" | "signin" | "failed" | "off" | "checking" | "pending";
export type McpStatus = { state: McpState; tools: string[]; error?: string; checkedAt?: string };
/** ask: the tools that wait for your Approve. why: why, per tool (Hearth's reason, or that you chose). checking: Hearth is reading its tools now. */
export type McpView = Omit<McpServer, "checked"> & McpStatus & { auth: "oauth" | "key" | "none"; ask: string[]; why: Record<string, string>; checking: boolean };
/** readOnly: what the server says (a hint only). */
export type McpTool = { name: string; description?: string; inputSchema?: unknown; readOnly?: boolean };
/** Hearth's model, reading tools: for each name it's sure of, whether it changes anything and why. */
export type Classify = (server: string, tools: McpTool[]) => Promise<Record<string, { ask: boolean; why: string }>>;
/** A call held for your Approve. jobId: the job whose run made it, when the run said. */
export type McpAsk = { server: string; tool: string; args: unknown; jobId?: string };

/** With no model to check them: names of tools that only look (list_x, get_x, read_x, x_status…). Anything else asks. */
const LOOKS = /^(list|get|read|search|find|fetch|load|query|describe|view|show|lookup|count|check|whoami|me)([_-]|$)|[_-](status|info|details)$/i;

type OAuthCreds = {
  kind: "oauth"; clientId: string; clientSecret?: string; authMethod: AuthMethod; tokenEndpoint: string; resource: string;
  accessToken: string; refreshToken?: string; expiresAt?: number; scope?: string;
};
/** query: the key goes in the address as ?<query>=<key> (Browserbase's browserbaseApiKey), never in mcp.json; else in header. */
type KeyCreds = { kind: "key"; header: string; value: string; query?: string };
const QUERY_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
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
const REGISTER_TIMEOUT_MS = 12_000;
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
  /** An agent asked for a server: an Approve card in the job's thread that asked (jobId), with a notification. Returns
   * what the agent is told. */
  onPending?: (s: McpServer, jobId?: string) => Promise<string | void> | string | void;
  /** A server is now connected (signed in, a key added, or it needs no login): a card waiting on it is settled. */
  onConnected?: (name: string, tools: string[]) => void;
  /** A call to a tool that asks: make the Approve card. Returns what the agent is told. Without it, nothing is held. */
  onAsk?: (c: McpAsk) => Promise<string>;
  /** Hearth's check of a server's tools. Without it, the tool's name decides. */
  classify?: Classify;
  fetch?: typeof fetch;
  now?: () => number;
};

export class Mcp {
  private file: string;
  private servers: McpServer[] = [];
  private status = new Map<string, McpStatus>();
  /** Each server's tools as last listed, for checking them. */
  private defs = new Map<string, McpTool[]>();
  /** Servers whose tools Hearth is reading right now. */
  private classifying = new Map<string, Promise<void>>();
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
      const { checked: _, ...shown } = s;
      const st = s.pending ? { state: "pending" as const, tools: [] }
        : !s.enabled ? { state: "off" as const, tools: this.status.get(s.name)?.tools || [] } : this.status.get(s.name) ?? { state: "checking" as const, tools: [] };
      return { ...shown, ...st, auth: c?.kind === "key" ? "key" : c?.kind === "oauth" || this.status.get(s.name)?.state === "signin" ? "oauth" : "none",
        ask: st.tools.filter((t) => this.asks(s.name, t)),
        why: Object.fromEntries(st.tools.map((t) => [t, this.reason(s.name, t)])), checking: this.classifying.has(s.name) };
    });
  }

  /** Does this tool wait for your Approve? Your choice, else Hearth's check of it, else (not checked yet) yes. */
  asks(name: string, tool: string): boolean {
    const s = this.get(name);
    const chosen = s?.gates?.[tool];
    if (chosen) return chosen === "ask";
    const v = this.verdict(name, tool);
    if (v) return v.ask;
    if (this.o.classify) return true; // not checked yet (or the check failed): ask
    const def = this.defs.get(name)?.find((t) => t.name === tool);
    return def?.readOnly === false || !LOOKS.test(tool);
  }

  /** Hearth's check of this tool, if it's still for the tool the server lists now (a changed description is checked again). */
  private verdict(name: string, tool: string): ToolVerdict | null {
    const v = this.get(name)?.checked?.[tool];
    if (!v) return null;
    const def = this.defs.get(name)?.find((t) => t.name === tool);
    return !def || v.sig === toolSig(def) ? v : null;
  }

  private reason(name: string, tool: string): string {
    const chosen = this.get(name)?.gates?.[tool];
    if (chosen) return chosen === "ask" ? "You chose: ask first." : "You chose: runs without asking.";
    const v = this.verdict(name, tool);
    if (v) return v.why;
    if (this.o.classify) return this.classifying.has(name) ? "Hearth is checking it; it asks until then." : "Not checked yet, so it asks.";
    return this.asks(name, tool) ? "Its name doesn't say it only looks." : "Its name says it only looks.";
  }

  /**
   * Hearth reads the tools it hasn't checked (new ones, and any whose description or inputs changed) and decides for
   * each. A tool the model isn't sure of, or can't answer for, keeps asking. Runs in the background after a check.
   */
  classifyTools(name: string): Promise<void> {
    const busy = this.classifying.get(name);
    if (busy) return busy;
    const s = this.get(name), defs = this.defs.get(name) || [];
    const todo = defs.filter((t) => !s?.checked?.[t.name] || s.checked[t.name].sig !== toolSig(t));
    if (!s || !this.o.classify || !todo.length) return Promise.resolve();
    const run = (async () => {
      for (let i = 0; i < todo.length; i += 25) {
        const part = todo.slice(i, i + 25);
        let got: Record<string, { ask: boolean; why: string }> = {};
        try { got = await this.o.classify!(name, part); } catch (e: any) { console.warn(`mcp: couldn't check ${name}'s tools: ${String(e?.message || e).slice(0, 200)}`); continue; }
        const cur = this.get(name);
        if (!cur) return;
        for (const t of part) {
          const g = got[t.name];
          if (!g || typeof g.ask !== "boolean") continue;
          // The server saying it changes things always counts; it saying it only looks never lets it off.
          const ask = g.ask || t.readOnly === false;
          cur.checked = { ...cur.checked, [t.name]: { ask, why: String(g.why || "").slice(0, 200) || (ask ? "It changes something." : "It only looks."), sig: toolSig(t) } };
        }
        this.save();
      }
    })().finally(() => { this.classifying.delete(name); this.changed(); });
    this.classifying.set(name, run);
    this.changed();
    return run;
  }

  /** /mcp: make one tool ask first, or let it run (also "Always allow" on its Approve card). */
  setGate(name: string, tool: string, ask: boolean): Result<McpView> {
    const s = this.get(name);
    if (!s) return { error: `No MCP server called ${name}.` };
    if (!tool || tool.length > 128) return { error: "Which tool?" };
    s.gates = { ...s.gates, [tool]: ask ? "ask" : "allow" };
    this.save();
    return { value: this.view(name)! };
  }

  /** A call an agent made: null to send it on, or what to tell the agent because it's waiting for your Approve. */
  async hold(name: string, tool: string, args: unknown, jobId?: string): Promise<string | null> {
    if (!this.o.onAsk || !this.asks(name, tool)) return null;
    return this.o.onAsk({ server: name, tool, args: args ?? {}, jobId });
  }
  get(name: string) { return this.servers.find((s) => s.name === name) ?? null; }
  view(name: string) { return this.list().find((s) => s.name === name) ?? null; }
  /** Servers an agent asked for, waiting for you (Activity's "Needs you"). */
  waiting(): McpServer[] { return this.servers.filter((s) => s.pending); }

  /**
   * Add one (or change its address). An API key goes in a header; without one, the hub signs in with OAuth if asked to.
   * agent: an agent asked (hearth-mcp add). It waits for you, untouched, and it can't change a server that's already here.
   */
  async add(input: { name?: string; url: string; header?: string; key?: string }, by: string, opts: { agent?: boolean; jobId?: string } = {}): Promise<Result<McpView & { told?: string }>> {
    let url: URL;
    try { url = new URL(String(input.url || "").trim()); } catch { return { error: "That isn't a web address." }; }
    // https only: no plain-http server, local ones included (the hub would be calling its own machine's services).
    if (url.protocol !== "https:") return { error: "MCP servers need an https:// address." };
    if (url.username || url.password) return { error: "Put the key in the key field, not in the address." };
    const name = (input.name || nameFromUrl(url.href)).trim().toLowerCase();
    if (!NAME_RE.test(name)) return { error: "Names are lowercase letters, numbers, - and _ (up to 31)." };
    if (opts.agent) {
      const same = this.servers.find((s) => s.url === url.href);
      if (same) {
        // Asked again while it still waits: the same card (the hub doesn't make a second one).
        const told = same.pending ? await Promise.resolve(this.o.onPending?.(same, opts.jobId)).catch(() => undefined) : undefined;
        return { value: { ...this.view(same.name)!, ...(told ? { told } : {}) } };
      }
      if (this.get(name)) return { error: `There's already a server called ${name}. Only the user can change it (in /mcp); pick another name to ask for a new one.` };
      const s: McpServer = { name, url: url.href, enabled: true, addedBy: by, addedAt: new Date(this.now()).toISOString(), pending: true };
      this.servers = [...this.servers, s].sort((a, b) => a.name.localeCompare(b.name));
      this.save();
      const told = await Promise.resolve(this.o.onPending?.(s, opts.jobId)).catch(() => undefined);
      return { value: { ...this.view(name)!, ...(told ? { told } : {}) } };
    }
    if (input.key) {
      if (!this.o.vault) return { error: "This hub has no key vault." };
      const header = (input.header || "Authorization").trim();
      if (!HEADER_RE.test(header)) return { error: "That isn't a header name." };
      const value = header.toLowerCase() === "authorization" && !/^\w+ /.test(input.key.trim()) ? `Bearer ${input.key.trim()}` : input.key.trim();
      this.o.vault.set(`mcp:${name}`, JSON.stringify({ kind: "key", header, value } satisfies KeyCreds));
    }
    const old = this.get(name);
    if (old && old.url !== url.href && !input.key) this.forget(name); // a new address: the old sign-in isn't for it
    // You adding it (yourself, or again over one an agent asked for) is your approval.
    const s: McpServer = { name, url: url.href, enabled: true, addedBy: old?.addedBy || by, addedAt: old?.addedAt || new Date(this.now()).toISOString(),
      // The same server again keeps your choices and Hearth's checks; a new address starts over.
      ...(old && old.url === url.href ? { gates: old.gates, checked: old.checked } : {}) };
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

  /** You approved a server an agent asked for: the hub contacts it for the first time (it may need a sign-in next). */
  async approve(name: string): Promise<Result<McpView>> {
    const s = this.get(name);
    if (!s) return { error: `No MCP server called ${name}.` };
    if (!s.pending) return { value: this.view(name)! };
    delete s.pending;
    this.save();
    await this.check(name);
    return { value: this.view(name)! };
  }

  async setEnabled(name: string, on: boolean): Promise<Result<McpView>> {
    const s = this.get(name);
    if (!s) return { error: `No MCP server called ${name}.` };
    if (s.pending) return { error: `${name} is waiting for your approval.` };
    s.enabled = on;
    this.save();
    if (on) await this.check(name); else this.changed();
    return { value: this.view(name)! };
  }

  /**
   * An agent saves an API key it got from the server's site (for one whose login it couldn't do): only for a server you
   * approved that isn't connected, so it can't swap the login of one that works.
   */
  async agentKey(name: string, key: string, header = "Authorization"): Promise<Result<McpView>> {
    const s = this.get(name);
    if (!s) return { error: `No MCP server called ${name}.` };
    if (s.pending) return { error: `${name} is waiting for the user to approve it (its Approve card, or /mcp).` };
    if (this.status.get(name)?.state === "connected") return { error: `${name} is connected already; its login stays as it is.` };
    if (!this.o.vault) return { error: "This hub has no key vault." };
    const k = String(key || "").trim();
    if (!k || k.length > 4000 || /\s/.test(k.replace(/^Bearer /, ""))) return { error: "That doesn't look like a key." };
    const h = header.trim();
    // "?name": the server wants the key in its address (?name=<key>) rather than a header.
    const query = h.startsWith("?") ? h.slice(1) : null;
    if (query !== null ? !QUERY_RE.test(query) : !HEADER_RE.test(h)) return { error: query !== null ? "That isn't a parameter name." : "That isn't a header name." };
    const prev = this.o.vault.get(`mcp:${name}`);
    this.o.vault.set(`mcp:${name}`, JSON.stringify((query !== null ? { kind: "key", header: "", value: k.replace(/^Bearer /, ""), query }
      : { kind: "key", header: h, value: h.toLowerCase() === "authorization" && !/^\w+ /.test(k) ? `Bearer ${k}` : k }) satisfies KeyCreds));
    const st = await this.check(name);
    if (st.state !== "connected") {
      // A key the server refused isn't kept (nor does it wipe a sign-in that was there).
      if (prev) this.o.vault.set(`mcp:${name}`, prev); else this.forget(name);
      await this.check(name).catch(() => {});
      return { error: `${name} didn't take that key${st.error ? ` (${st.error})` : ""}. Check you copied the whole key, or where it wants it: a header (hearth-mcp key ${name} <key> <header>) or the address (hearth-mcp key ${name} <key> ?<param>).` };
    }
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
  forRun(base: string, key: string, jobId?: string): { name: string; url: string; headers: Record<string, string> }[] {
    // The job in the address, so a call that waits for Approve puts its card in that job's thread.
    const q = jobId ? `?job=${encodeURIComponent(jobId)}` : "";
    return this.servers.filter((s) => s.enabled && !s.pending && this.status.get(s.name)?.state === "connected")
      .map((s) => ({ name: s.name, url: `${base}/api/agent/mcp/${s.name}${q}`, headers: { "X-Hearth-Agent": key } }));
  }

  // ---- signing in ----

  /** The link to sign in to one (or connected: it needs no sign-in, or a fresh token was enough). */
  async signIn(name: string, redirectUri = this.o.redirectUri()): Promise<Result<{ url: string } | { connected: true }>> {
    const s = this.get(name);
    if (!s) return { error: `No MCP server called ${name}.` };
    if (s.pending) return { error: `${name} is waiting for the user to approve it (its Approve card, or /mcp). There's no sign-in until they do.` };
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
      const why = e?.name === "TimeoutError" || /timed out/i.test(String(e?.message)) ? `its login service didn't answer (it may be down)` : String(e?.message || e).slice(0, 200);
      return { error: `Couldn't start signing in to ${name}: ${why}. You can use an API key from ${name} instead.` };
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

  async checkAll() { await Promise.all(this.servers.filter((s) => s.enabled && !s.pending).map((s) => this.check(s.name).catch(() => {}))); }

  /** Connect for real (initialize, tools/list) and keep what happened: connected with its tools, needs sign-in, or failed. */
  async check(name: string): Promise<McpStatus> {
    const s = this.get(name);
    if (!s) return { state: "failed", tools: [], error: "Not on the list." };
    if (s.pending) return { state: "pending", tools: [] }; // not contacted until you approve it
    if (!s.enabled) return { state: "off", tools: [] };
    try {
      const tools = await this.tools(name);
      this.defs.set(name, tools);
      const st = this.setStatus(name, { state: "connected", tools: tools.map((t) => t.name) });
      void this.classifyTools(name);
      return st;
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
        out.push(...(Array.isArray(r?.tools) ? r.tools : []).map((t: any) => ({ name: String(t?.name || ""), description: t?.description ? String(t.description) : undefined, inputSchema: t?.inputSchema,
          // What the server says: readOnlyHint true, it only looks; destructiveHint true (or readOnlyHint false), it changes things. A hint only.
          readOnly: t?.annotations?.readOnlyHint === true ? true : t?.annotations?.readOnlyHint === false || t?.annotations?.destructiveHint === true ? false : undefined })).filter((t: McpTool) => t.name));
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
    if (!s || !s.enabled || s.pending) return new Response(JSON.stringify({ error: `No MCP server called ${name} is on.` }), { status: 404, headers: { "Content-Type": "application/json" } });
    const headers: Record<string, string> = {};
    for (const h of PASS_UP) { const v = req.headers.get(h); if (v) headers[h] = v; }
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    // A call to a tool that asks first isn't sent on: it waits for your Approve, and the run is told so.
    if (body && this.o.onAsk) {
      let msg: any = null;
      try { msg = JSON.parse(new TextDecoder().decode(body)); } catch {}
      const calls = (Array.isArray(msg) ? msg : [msg]).filter((m) => m?.method === "tools/call" && this.asks(name, String(m?.params?.name || "")));
      if (calls.length && Array.isArray(msg)) return rpcReply(msg.filter((m) => m?.id !== undefined).map((m) => ({ jsonrpc: "2.0", id: m.id, error: { code: -32600, message: "Send calls to tools that ask first one at a time." } })));
      if (calls.length) {
        const job = new URL(req.url).searchParams.get("job") || undefined;
        const text = await this.o.onAsk({ server: name, tool: String(msg.params.name), args: msg.params.arguments ?? {}, jobId: job });
        return rpcReply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } });
      }
    }
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
    const was = this.status.get(name)?.state;
    this.status.set(name, full);
    if (before !== JSON.stringify({ ...full, checkedAt: 0 })) this.changed();
    if (full.state === "connected" && was !== "connected") { try { this.o.onConnected?.(name, full.tools); } catch {} }
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
    if (c?.kind === "key" && !c.query) headers.set(c.header, c.value);
    if (c?.kind === "key" && c.query) { const u = new URL(url); u.searchParams.set(c.query, c.value); url = u.href; }
    const r = await this.fetch(url, { ...init, headers, redirect: "error" });
    if (r.status === 401 && again && c?.kind === "oauth" && c.refreshToken && (await this.refresh(name))) {
      try { await r.body?.cancel(); } catch {}
      return this.send(name, url, init, false);
    }
    return r;
  }

  /** An MCP session over streamable HTTP: initialize, then fn's requests, then close it. */
  private async session(name: string, fn: (rpc: (method: string, params: unknown) => Promise<any>) => Promise<void>) {
    const s = this.get(name);
    if (!s) throw new Error(`No MCP server called ${name}.`);
    if (s.pending) throw new Error(`${name} is waiting for the user to approve it (its Approve card, or /mcp).`);
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
    // A login service that hangs here shouldn't keep your tap waiting half a minute.
    const r = await this.fetch(String(meta.registration_endpoint), { method: "POST", signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
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

/** A tool as the server describes it: when this changes, Hearth checks it again. */
export function toolSig(t: McpTool): string {
  return createHash("sha256").update(JSON.stringify([t.name, t.description || "", t.inputSchema ?? null, t.readOnly ?? null])).digest("base64url").slice(0, 22);
}

const rpcReply = (m: unknown) => new Response(JSON.stringify(m), { status: 200, headers: { "Content-Type": "application/json" } });

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
# Inside a script run the user approved, the hub's one-time token for that run: its calls need no second Approve.
run=()
if [ -n "\${HEARTH_RUN:-}" ]; then run=(-H "X-Hearth-Run: \${HEARTH_RUN}"); fi
# The job this run is for: a call that waits for an Approve goes to its thread.
if [ -n "\${HEARTH_JOB:-}" ]; then run+=(-H "X-Hearth-Job: \${HEARTH_JOB}"); fi
exec curl -sS -m 600 -H "X-Hearth-Agent: ${key}" \${run[@]+"\${run[@]}"} "\${args[@]}" "${hubUrl}/api/agent/mcp"
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
- \`hearth-mcp add <https url> [name]\`: ask for a new server. It's an Approve card in this conversation; one tap
  approves it and opens its sign-in (or takes an API key). Use the server's official address, and say in your reply
  what it's for. Once it's connected you get a turn to carry on, so don't ask the user to tell you.
- \`hearth-mcp signin <server>\`: a fresh sign-in link for an approved server that's signed out. Open it in your own
  browser and go through it yourself (your browser has the user's logins; ask them only for a password you don't have).
- \`hearth-mcp key <server> <api key> [header | ?param]\`: for an approved server whose sign-in doesn't work: get an API key
  from its website in your browser and save it here. It goes in the Authorization header unless you name another header,
  or \`?param\` for a server that wants it in its address (\`?browserbaseApiKey\`). It's checked right away; a key it
  refuses isn't kept.

Use the server's own tools when you have them; \`call\` is for a server added after this run started.

Tools that change things (send, post, react, delete, connect…) wait for the user's Approve. Calling one doesn't run it:
the answer says it's waiting. Don't call it again or look for another way round; say in your reply that it's waiting for
their Approve. When they tap Approve the hub makes that exact call. So put everything in the one call (the full message,
the attachment) and get it right first time.`,
  };
}

/** What `hearth-mcp <argv>` does, for the hub's /api/agent/mcp. Text back for the agent to read. */
/** o.approved: the call comes from a script run the user approved, so a tool that asks first runs without a second card. o.jobId: the run's job. */
export async function mcpAgent(mcp: Mcp, argv: string[], by: string, o: { approved?: boolean; jobId?: string } = {}): Promise<string> {
  const [cmd = "list", a, b, c] = argv;
  // What to do next, in each answer, so an agent never needs the user to explain it.
  const next = (s: McpView) => s.state === "signin" ? `\n  next: you sign in: run hearth-mcp signin ${s.name} and open the link in your browser`
    : s.state === "pending" ? `\n  next: waiting for the user's Approve (its card in the conversation that asked)`
    : s.state === "failed" ? `\n  next: run hearth-mcp signin ${s.name} to reconnect it, or save an API key: hearth-mcp key ${s.name} <key>` : "";
  const line = (s: McpView) => `${s.name}  ${s.state}${s.error ? ` (${s.error})` : ""}  ${s.url}${s.tools.length ? `\n  tools: ${s.tools.join(", ")}` : ""}${next(s)}`;
  const keyWay = (name: string) => `Get an API key instead: in your browser, open ${name}'s website, sign in (your browser has the user's logins; if it asks for a password you don't have, ask the user to sign in on that page while they watch), copy the API key or token from its dashboard, and save it: hearth-mcp key ${name} <key>. That checks it right away.`;
  switch (cmd) {
    case "list": {
      const all = mcp.list();
      return all.length ? all.map(line).join("\n") : "No MCP servers yet. Add one with: hearth-mcp add <https url>";
    }
    case "tools": {
      if (!a || !mcp.get(a)) return `No MCP server called ${a || "?"}. Run: hearth-mcp list`;
      const tools = await mcp.tools(a);
      return tools.map((t) => `${t.name}${mcp.asks(a, t.name) ? " (waits for the user's Approve)" : ""}: ${(t.description || "").replace(/\s+/g, " ").slice(0, 300)}\n  takes: ${JSON.stringify(t.inputSchema ?? {}).slice(0, 1500)}`).join("\n") || "No tools.";
    }
    case "call": {
      if (!a || !b) return "usage: hearth-mcp call <server> <tool> '<json arguments>'";
      if (!mcp.get(a)) return `No MCP server called ${a}. Run: hearth-mcp list`;
      let args: unknown = {};
      if (c?.trim()) { try { args = JSON.parse(c); } catch { return "The arguments must be JSON, like '{\"query\": \"…\"}'."; } }
      const held = o.approved ? null : await mcp.hold(a, b, args, o.jobId);
      if (held) return held;
      return JSON.stringify(await mcp.call(a, b, args), null, 1);
    }
    case "add": {
      if (!a) return "usage: hearth-mcp add <https url> [name]";
      const r = await mcp.add({ url: a, name: b }, by, { agent: true, jobId: o.jobId });
      if (!r.value) return r.error;
      if (r.value.state !== "pending") return `Already added:\n${line(r.value)}`;
      return r.value.told || `Asked the user to approve ${r.value.name} (${r.value.url}). It stays off until they do. Tell them in your reply what it's for.`;
    }
    case "signin": {
      if (!a) return "usage: hearth-mcp signin <server>";
      const s = await mcp.signIn(a);
      if (!s.value) return mcp.get(a) && !mcp.get(a)!.pending ? `${s.error}\n\n${keyWay(a)}` : s.error;
      return "url" in s.value
        ? `Sign in to ${a} yourself: open this link in your browser and go through it (pick the account, allow access). It ends back on Hearth; then hearth-mcp list shows ${a} connected. Ask the user only for a password you don't have.\n${s.value.url}\n\nIf the sign-in page doesn't work: ${keyWay(a)}`
        : `${a} is connected.`;
    }
    case "key": {
      if (!a || !b) return "usage: hearth-mcp key <server> <api key> [header | ?param]";
      const r = await mcp.agentKey(a, b, c || undefined);
      if (!r.value) return r.error;
      return `Saved. ${line(r.value)}`;
    }
    default:
      return "usage: hearth-mcp list | tools <server> | call <server> <tool> [json|-] | add <url> [name] | signin <server> | key <server> <api key> [header | ?param]";
  }
}
