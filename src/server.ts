import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, extname, dirname } from "node:path";
type Server = Bun.Server<unknown>;
import { rotateToken, sha256, deviceForToken, newPairingCode, redeemPairingCode, RateLimiter, addDevice, owners, personalDevices, isOwner, newChallenge, verifyPasskeyRegistration, verifyPasskeyAssertion, Sessions, AccessRequests } from "./auth.ts";
import QRCode from "qrcode";
import type { Hub } from "./hub.ts";
import { deepgramLive, type VoiceSettings } from "./voice.ts";
import { randomBytes } from "node:crypto";
import { availableHarnesses } from "./brain.ts";
import { Computers, COPY_ITEMS, isCopyItem } from "./computers.ts";
import { Machines, realE2b, realSsh, type E2b, type Ssh } from "./machines.ts";
import { Vault } from "./vault.ts";
import { Connect } from "./connectors/index.ts";
import { sourceById } from "./sources/index.ts";
import { chromeWorkspaces, slackCookie } from "./connectors/slack.ts";
import { webhookOk } from "./connectors/plaid.ts";
import { changeFor, googleAgent, GoogleAgentError, type GoogleService } from "./connectors/google-agent.ts";
import { cleanFingerprint } from "./browser.ts";
import { adminToken, isAdminRequest } from "./admin.ts";
import { detectBrains } from "./brains/logins.ts";
import { toolStatus } from "./brains/tools.ts";
import { hasLogin, readLogin } from "./computer.ts";
import { homedir, hostname, networkInterfaces, cpus, freemem, totalmem } from "node:os";
import { lookup } from "node:dns/promises";

/** How busy the hub's machine is, as whole percents: CPU over a short sample, memory in use (Linux: MemAvailable, since freemem counts cache as used). */
async function hubLoad(): Promise<{ cpu: number; mem: number; cores: number; memUsed: number; memTotal: number }> {
  const tick = () => cpus().reduce((a, c) => { const t = Object.values(c.times).reduce((x, y) => x + y, 0); return { idle: a.idle + c.times.idle, total: a.total + t }; }, { idle: 0, total: 0 });
  const a = tick();
  await new Promise((r) => setTimeout(r, 250));
  const b = tick();
  const span = b.total - a.total;
  const cpu = span > 0 ? Math.round(100 * (1 - (b.idle - a.idle) / span)) : 0;
  let free = freemem();
  try { const m = /MemAvailable:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8")); if (m) free = Number(m[1]) * 1024; } catch {}
  const total = totalmem(), used = Math.max(0, total - free);
  const mem = Math.round(100 * used / total);
  return { cpu: Math.min(100, Math.max(0, cpu)), mem: Math.min(100, Math.max(0, mem)), cores: cpus().length, memUsed: used, memTotal: total };
}

/** The IP the hub answers on: its public name resolved, else this machine's first outside-facing address. */
const hubIpCache = new Map<string, { ip: string | null; at: number }>();
async function hubIp(address: string): Promise<string | null> {
  const hit = hubIpCache.get(address);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.ip;
  let ip: string | null = null;
  try {
    const host = new URL(/^https?:\/\//.test(address) ? address : `http://${address}`).hostname;
    if (/^[\d.]+$|:/.test(host) && host !== "0.0.0.0") ip = host;
    else if (!/^(localhost|0\.0\.0\.0)$/.test(host)) ip = (await lookup(host, { family: 4 })).address;
  } catch {}
  if (!ip || /^127\.|^::1$/.test(ip)) {
    const nic = Object.values(networkInterfaces()).flat().find((n) => n && n.family === "IPv4" && !n.internal);
    ip = nic?.address || ip;
  }
  hubIpCache.set(address, { ip, at: Date.now() });
  return ip;
}
import { MAX_FILE_BYTES } from "./files.ts";
import { fetchPublic } from "./watch.ts";
import { isCookieSite } from "./connections.ts";
import { labelFor } from "./cookie-sites.ts";
import { appCsp } from "./apps.ts";
import { isActive, search } from "./memory.ts";
import { isValidTimeZone } from "./time.ts";
import type { Shares } from "./shares.ts";
import { sharePage } from "./share-page.ts";
import { mcpAgent } from "./mcp.ts";
import { portsAgent } from "./events/ports.ts";
import { installedSkills } from "./brains/skill-store.ts";
import type { Component, Person, StoredFile, Approval, Device, Fact, LocationFix, MiniApp, Message, Notebook, Place, Prefs, Skill, Teammate, Workflow } from "./types.ts";
import pkg from "../package.json" with { type: "json" };

const WEB = resolve(import.meta.dir, "../web");
const MAX_BODY = 64 * 1024;
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json",
};

type Asset = { body: Buffer | string; type: string; immutable: boolean };

/** Bundles the TypeScript front end in memory at startup. No build step, no build folder. */
export async function buildWeb() {
  const sources = [
    ...readdirSync(join(WEB, "src")).map((f) => join(WEB, "src", f)),
    ...readdirSync(WEB).filter((f) => /\.(html|css|svg|png|webmanifest)$/.test(f)).map((f) => join(WEB, f)),
  ].sort();
  const build = sha256(sources.map((f) => readFileSync(f)).reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0))).slice(0, 10);
  const result = await Bun.build({
    entrypoints: [join(WEB, "src/app.ts"), join(WEB, "src/sw.ts")],
    target: "browser", minify: true, sourcemap: "none",
    define: { __BUILD__: JSON.stringify(build) },
  });
  if (!result.success) throw new Error("Web build failed:\n" + result.logs.map(String).join("\n"));
  const assets = new Map<string, Asset>();
  for (const out of result.outputs) {
    const name = out.path.split("/").pop()!;
    assets.set(`/${name}`, { body: await out.text(), type: TYPES[".js"], immutable: false });
  }
  for (const f of readdirSync(WEB)) {
    const ext = extname(f);
    if (!TYPES[ext] || f === "setup.html") continue; // the setup window is served by `hearth wizard`, never by a hub
    let body: Buffer | string = readFileSync(join(WEB, f));
    if (ext === ".html") body = body.toString().replaceAll("{{BUILD}}", build);
    assets.set(f === "index.html" ? "/" : `/${f}`, { body, type: TYPES[ext], immutable: false });
  }
  return { build, assets };
}

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

/** drivers: stand-ins for E2B and ssh in tests. */
export async function startServer(hub: Hub, voice: VoiceSettings | null = null,
  drivers: { e2b?: E2b; ssh?: Ssh; readLogin?: typeof readLogin; allowLocalHub?: boolean; vault?: Vault; shares?: Shares | null } = {}) {
  const shares = drivers.shares ?? null;
  const voiceLimiter = new RateLimiter(5, 10 * 60_000);
  const plaidLimiter = new RateLimiter(20, 60_000);
  const liveTickets = new Map<string, number>();
  const tileKey = randomBytes(12).toString("base64url");
  const tileLimiter = new RateLimiter(600, 60_000);
  const imgLimiter = new RateLimiter(120, 60_000);
  const { config, store } = hub;
  const web = await buildWeb();
  const pairLimiter = new RateLimiter(5, 10 * 60_000);
  const pairGlobal = new RateLimiter(30, 10 * 60_000);
  const ideaLimiter = new RateLimiter(2, 10 * 60_000);
  // Webhook hooks: anyone with the secret URL can call it, so each hook gets 30 calls a minute at most.
  const webhookLimiter = new RateLimiter(30, 60_000);
  // Wrong device tokens: 20 in 10 minutes and that address is shut out of the API for the rest of the window.
  const badToken = new RateLimiter(20, 10 * 60_000);
  // Access requests notify all your devices, so strangers can't spam them.
  const askLimiter = new RateLimiter(3, 10 * 60_000);
  const askGlobal = new RateLimiter(10, 10 * 60_000);
  const sessions = new Sessions(config.unlockHours * 3600_000);
  const access = new AccessRequests();
  const visitorLimiter = new RateLimiter(60, 60_000);
  // Computers linked to this hub (your Mac): brain calls run there when one is online, here (the cloud) when none is.
  const computers = new Computers({ dataDir: config.dataDir, homeDir: homedir(), acceptCopies: config.target === "lightsail", readLogin: drivers.readLogin ?? readLogin,
    hasLogin: drivers.readLogin ? (i) => !!drivers.readLogin!(i) : hasLogin,
    // Browser logins (LinkedIn, X) the user chose to feed from their Mac: the Mac decrypts and copies them up here.
    cookieSites: () => hub.connections.macSites(),
    cookieHave: (site) => hub.connections.cookieHave(site),
    onCookies: (site, data) => { hub.connections.receiveFromMac(site, data); hub.emit("connections"); hub.audit("mac-copy", site, "your Mac", { ok: true }).catch(() => {}); },
    // Jobs that run on a linked computer get the Google commands too, while Google is connected (connectors/google-agent.ts).
    agentSkills: () => ({ google: hub.google.connected }) });
  // A connection came or went (Google signed in or out…): the skills that depend on it follow, here and on computers.
  hub.on((e) => { if (e.type === "connections") { computers.skillsChanged(); hub.brain.refreshSkills?.(); } });
  const linkedComputers = async () => (await store.all<Device>("devices")).filter((d) => d.role === "computer");
  const recount = async () => { computers.known = (await linkedComputers()).length; };
  await recount();
  hub.brain.remote = computers;
  hub.computers = computers;
  computers.onChange = () => hub.emit("computers", {});
  computers.onOnline = () => { hub.resumeForComputer().catch((e) => console.error(e)); };
  computers.start();
  // Cloud computers the hub sets up itself: an E2B sandbox or your VM. Each becomes a linked computer.
  const vault = drivers.vault ?? new Vault(config.dataDir);
  vault.migrate(config.dataDir);
  hub.vault = vault;
  // Every connector (the grid in Settings, the API, the `hearth` CLI) goes through this one object.
  const connect = new Connect(hub, vault, voice);
  void connect.start();
  hub.connect = connect;
  const admin = adminToken(config.dataDir);
  const machines = new Machines({
    dataDir: config.dataDir, vault,
    hubUrl: () => process.env.HEARTH_PUBLIC_URL || null,
    addComputer: async (name, machineId) => {
      const { token, device } = await addDevice(store, name, "computer");
      await store.put<Device>("devices", { ...device, machine: machineId });
      await recount();
      return { token, deviceId: device.id };
    },
    removeComputer: async (deviceId) => { computers.drop(deviceId, "removed", 4001); await store.remove("devices", deviceId); await recount(); },
    rekey: async (deviceId) => { const t = await rotateToken(store, deviceId); computers.drop(deviceId, "new key"); return t; },
    isOnline: (id) => computers.isOnline(id),
    isBusy: (id) => computers.status(id, "").running > 0,
    e2b: drivers.e2b ?? realE2b, ssh: drivers.ssh ?? realSsh, allowLocalHub: drivers.allowLocalHub,
  });
  machines.onChange = () => hub.emit("computers", {});
  machines.startTimer();
  hub.onNeedsComputer = () => { machines.wake().catch((e) => console.error(e)); };
  const computerSummary = async () => {
    const list = (await linkedComputers()).map((d) => computers.status(d.id, d.name, d.lastSeenAt));
    const rank = { online: 0, asleep: 1, offline: 2 };
    list.sort((x, y) => rank[x.state] - rank[y.state] || y.level - x.level);
    return { linked: list.length, online: list.filter((c) => c.state === "online").map((c) => c.name), list, acceptCopies: config.target === "lightsail" };
  };
  const streams = new Map<string, Set<ReadableStreamDefaultController>>();
  const enc = new TextEncoder();

  hub.on((e) => {
    const chunk = enc.encode(`data: ${JSON.stringify(e)}\n\n`);
    for (const set of streams.values()) for (const c of set) { try { c.enqueue(chunk); } catch {} }
  });

  const security = (origin: string | null, sameOrigin: boolean) => {
    const h: Record<string, string> = {
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Permissions-Policy": "geolocation=(self), camera=(), microphone=(self), payment=()",
      "Content-Security-Policy": [
        "default-src 'self'", "script-src 'self'", "style-src 'self'", `img-src 'self' data: blob: ${config.allowedOrigins.join(" ")}`.trim(), "media-src 'self' blob:",
        `connect-src 'self' ${config.allowedOrigins.join(" ")}`.trim(), "manifest-src 'self'", "worker-src 'self'", `frame-src 'self' ${config.allowedOrigins.join(" ")}`.trim(),
        "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'", "object-src 'none'",
      ].join("; "),
    };
    if (config.behindProxy) h["Strict-Transport-Security"] = "max-age=31536000";
    // Other hubs you own can call this one from the same app, but only if you list them.
    if (origin && !sameOrigin && config.allowedOrigins.includes(origin)) {
      h["Access-Control-Allow-Origin"] = origin;
      h["Access-Control-Allow-Headers"] = "Authorization, Content-Type, X-Hearth-Unlock";
      h["Access-Control-Allow-Methods"] = "GET, POST, PATCH, DELETE";
      h["Access-Control-Max-Age"] = "600";
      h["Vary"] = "Origin";
    }
    return h;
  };

  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

  async function body(req: Request): Promise<any> {
    if (!(req.headers.get("content-type") || "").includes("application/json")) throw new HttpError(415, "Send JSON.");
    const len = Number(req.headers.get("content-length") || 0);
    if (len > MAX_BODY) throw new HttpError(413, "Too large.");
    const text = await req.text();
    if (text.length > MAX_BODY) throw new HttpError(413, "Too large.");
    try { return text ? JSON.parse(text) : {}; } catch { throw new HttpError(400, "Bad JSON."); }
  }

  const fromThisMachine = (req: Request, server: Server) => {
    if (req.headers.has("x-forwarded-for") || req.headers.has("forwarded") || req.headers.has("x-real-ip")) return false;
    const a = server.requestIP(req)?.address || "";
    return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
  };
  const clientIp = (req: Request, server: Server) =>
    (config.behindProxy && req.headers.get("x-forwarded-for")?.split(",").pop()!.trim()) || server.requestIP(req)?.address || "?";

  const publicPrefs = (p: Prefs) => ({ userName: p.userName, tz: p.tz });

  /** Visitor traffic for a shared link. Never authenticated as you, never touches the hub's API or data. */
  async function visitor(req: Request, url: URL, server: Server, link: string, rest: string): Promise<Response> {
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, X-Visitor", "Access-Control-Allow-Methods": "GET, POST", "Access-Control-Max-Age": "600" };
    const out = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Security-Policy": "sandbox; default-src 'none'" } });
    if (!rest) return new Response(null, { status: 301, headers: { Location: `/t/${link}/` } });
    const box = await shares!.target(link);
    if (rest === "/" && req.method === "GET") {
      if (!box) return new Response("This link is turned off.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Security-Policy": "sandbox; default-src 'none'" } });
      const proto = config.behindProxy ? req.headers.get("x-forwarded-proto") || "https" : url.protocol.replace(":", "");
      return sharePage(`${proto}://${req.headers.get("x-forwarded-host") || req.headers.get("host")}`);
    }
    if (!rest.startsWith("/api/")) return out({ error: "Not found." }, 404);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "GET" && req.method !== "POST") return out({ error: "Not allowed." }, 405);
    if (!box) return out({ error: "This link is turned off." }, 404);
    const ip = clientIp(req, server);
    if (!visitorLimiter.allow(ip)) return out({ error: "Slow down a little." }, 429);
    let payload: string | undefined;
    if (req.method === "POST") {
      payload = await req.text();
      if (payload.length > 16 * 1024) return out({ error: "Too long." }, 413);
    }
    server.timeout(req, 300); // a turn can take a few minutes
    try {
      const res = await fetch(`${box.url}${rest}`, {
        method: req.method, body: payload, signal: AbortSignal.timeout(290_000), redirect: "error",
        headers: { "Content-Type": "application/json", "X-Box-Secret": box.secret, "X-Visitor": (req.headers.get("x-visitor") || "").slice(0, 100), "X-Visitor-Ip": ip },
      });
      const text = await res.text();
      if (text.length > 2_000_000) return out({ error: "Too big." }, 502);
      return new Response(text, { status: res.status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store", "Content-Security-Policy": "sandbox; default-src 'none'" } });
    } catch { return out({ error: "This teammate is offline right now." }, 503); }
  }

  async function api(req: Request, url: URL, server: Server): Promise<Response> {
    const path = url.pathname;
    const method = req.method;
    const seg = path.split("/").filter(Boolean); // ["api", resource, id?, verb?]

    const ip = clientIp(req, server);
    // An address that keeps sending wrong keys loses pairing and access requests too. Paired devices are never shut out.
    const banned = () => new HttpError(429, "Too many wrong keys from this address. Wait 10 minutes.");
    const isPublic = path === "/api/pair" || path.startsWith("/api/access/request") || path.startsWith("/api/access/poll");
    if (isPublic && badToken.blocked(ip)) throw banned();
    // Passkeys are bound to the page's own origin; a call from another hub's page can't use them.
    const pageOrigin = (() => {
      const o = req.headers.get("origin"), host = req.headers.get("x-forwarded-host") || req.headers.get("host");
      try { return o && new URL(o).host === host ? o : null; } catch { return null; }
    })();

    // ---- public ----
    if (path === "/api/health") return json({ name: config.name, version: pkg.version, build: web.build, setup: (await store.all<Device>("devices")).length === 0 });
    // A new device asks to join. Every one of your signed-in devices gets a notification with the same short code to compare.
    if (path === "/api/access/request" && method === "POST") {
      if (!askLimiter.allow(ip) || !askGlobal.allow("all")) throw new HttpError(429, "Too many requests. Wait 10 minutes.");
      if ((await store.all<Device>("devices")).length === 0) throw new HttpError(409, "This hub isn't set up yet. Use the setup code from the server.");
      const b = await body(req);
      const { poll, request } = access.create(b.deviceName, ip, b.kind);
      hub.emit("access", { pending: access.pending().length });
      await hub.push?.send({ title: request.kind === "computer" ? "A computer wants to link" : "New device wants in", body: `${request.name} · code ${request.code}. Open Hearth to approve or deny.`, tag: "access", url: "/#access" }, (await personalDevices(store)).map((d) => d.id));
      return json({ poll, code: request.code, expiresInMin: 10 });
    }
    if (path === "/api/access/poll" && method === "POST") {
      const r = access.poll((await body(req)).poll);
      if (!r) throw new HttpError(404, "That request expired. Ask again.");
      return json({ status: r.status, token: r.token, deviceId: r.deviceId, hub: { name: config.name, build: web.build } });
    }
    // The URL webhooks had before they became push sources: the token is that source's secret now, so old URLs still work.
    if (seg[1] === "webhook" && seg[2] && !seg[3]) {
      if (method !== "POST") throw new HttpError(405, "POST to this address.");
      if (badToken.blocked(ip)) throw banned();
      if (!webhookLimiter.allow(seg[2])) throw new HttpError(429, "Too many calls. Wait a minute.");
      if (Number(req.headers.get("content-length") || 0) > 64_000) throw new HttpError(413, "Too large.");
      const text = (await req.text()).slice(0, 64_000);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { if (!/^(authorization|cookie|x-hearth-)/i.test(k)) headers[k] = v.slice(0, 500); });
      const r = hub.pipeline.pushBySecret(decodeURIComponent(seg[2]), text, headers);
      if (!r) { if (!badToken.allow(ip)) throw banned(); throw new HttpError(404, "No webhook here."); }
      if (r.error) throw new HttpError(409, r.error);
      return json({ ok: true }, 202);
    }
    // An event-pipeline source's secret URL: anything can POST JSON here; it's saved as an event and matched to triggers.
    if (seg[1] === "events" && seg[2] && seg[3] && !seg[4]) {
      if (method !== "POST") throw new HttpError(405, "POST to this address.");
      if (badToken.blocked(ip)) throw banned();
      if (!webhookLimiter.allow(`events:${seg[2]}`)) throw new HttpError(429, "Too many calls. Wait a minute.");
      if (Number(req.headers.get("content-length") || 0) > 64_000) throw new HttpError(413, "Too large.");
      const text = (await req.text()).slice(0, 64_001);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => { if (!/^(authorization|cookie|x-hearth-)/i.test(k)) headers[k] = v.slice(0, 500); });
      const r = hub.pipeline.push(decodeURIComponent(seg[2]), decodeURIComponent(seg[3]), text, headers);
      if (!r) { if (!badToken.allow(ip)) throw banned(); throw new HttpError(404, "No source here."); }
      if (r.error) throw new HttpError(r.error === "Too large." ? 413 : 409, r.error);
      return json({ ok: true, event: r.value!.id }, 202);
    }
    // The agent's hearth-plaid command (from this machine, with the hub's agent key): read-only bank questions.
    // Only straight from this machine: the key is written in the brain's tool, so a copy leaked off the box (or a request
    // through the public proxy, which adds X-Forwarded-For) is refused.
    if (path === "/api/agent/plaid" && method === "GET") {
      // The agent's key, or the Plaid-only key an approved script gets with `needs: plaid`.
      const k = req.headers.get("x-hearth-agent");
      if (!fromThisMachine(req, server) || !(connect.isAgentKey(k) || connect.isPlaidKey(k))) { if (!badToken.allow(ip)) throw banned(); throw new HttpError(401, "Not the agent's key."); }
      const argv = url.searchParams.getAll("a").slice(0, 20).map((a) => a.slice(0, 200));
      try {
        const r = await connect.plaid.agent(argv);
        await hub.log("plaid.agent", `hearth-plaid ${argv.join(" ").slice(0, 120)}`);
        return new Response(JSON.stringify(r, null, 1), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
      } catch (e: any) { throw new HttpError(400, e.message); }
    }
    // The agent's hearth-lead: a job asks the lead (the heavy model) for advice mid-run (brains/lead.ts). Same keys as Google's.
    if (path === "/api/agent/lead" && method === "POST") {
      const key = req.headers.get("x-hearth-agent");
      const from = fromThisMachine(req, server) && connect.isAgentKey(key) ? "hub" : computers.agentKeyOwner(key);
      if (!from) { if (!badToken.allow(ip)) throw banned(); throw new HttpError(401, "Not the agent's key."); }
      let q = "";
      try { q = String((await req.formData()).get("q") || ""); } catch { throw new HttpError(400, "Send the question as q."); }
      if (!q.trim()) throw new HttpError(400, "Ask something.");
      try {
        const answer = await hub.askLead(q.slice(0, 20_000));
        return new Response(answer + "\n", { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
      } catch (e: any) { throw new HttpError(503, `The lead couldn't answer: ${String(e?.message || e).slice(0, 200)}`); }
    }
    // MCP for brains (mcp.ts). /api/agent/mcp/<name> is the proxy a run's MCP client talks to (the hub adds the server's
    // login on the way out); /api/agent/mcp is the hearth-mcp command. Same keys as hearth-lead.
    if (seg[1] === "agent" && seg[2] === "mcp") {
      const key = req.headers.get("x-hearth-agent");
      const from = fromThisMachine(req, server) && connect.isAgentKey(key) ? "hub" : computers.agentKeyOwner(key);
      if (!from) { if (!badToken.allow(ip)) throw banned(); throw new HttpError(401, "Not the agent's key."); }
      if (seg[3] && !seg[4]) {
        if (Number(req.headers.get("content-length") || 0) > 20_000_000) throw new HttpError(413, "Too large.");
        server.timeout(req, 0); // a server's event stream stays open as long as the run does
        return connect.mcp.forward(decodeURIComponent(seg[3]), req);
      }
      if (seg[3] || method !== "POST") throw new HttpError(404, "Not here.");
      let argv: string[] = [];
      try { argv = (await req.formData()).getAll("a").slice(0, 10).map((a) => String(a).slice(0, 200_000)); } catch { throw new HttpError(400, "Send the command's words as a fields."); }
      server.timeout(req, 300);
      try {
        // A script run you approved (its one-time token): your Approve covers its MCP calls too.
        const out = await mcpAgent(connect.mcp, argv, from === "hub" ? "an agent" : `an agent on ${from}`, { approved: hub.scripts.isApprovedRun(req.headers.get("x-hearth-run")), jobId: req.headers.get("x-hearth-job")?.slice(0, 100) || undefined });
        if (argv[0] === "add" || argv[0] === "call") await hub.log("mcp.agent", `hearth-mcp ${argv.slice(0, 3).join(" ").slice(0, 160)}`);
        return new Response(out + "\n", { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
      } catch (e: any) { return new Response(`Error: ${String(e?.message || e).slice(0, 500)}\n`, { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } }); }
    }
    // The agent's hearth-skill-store (brains/skill-store.ts): find, read and install public skills. An install is an Approve
    // card in the job's thread (X-Hearth-Job); nothing is installed until you tap it. Same keys as hearth-mcp.
    if (path === "/api/agent/skills" && method === "POST") {
      const key = req.headers.get("x-hearth-agent");
      const from = fromThisMachine(req, server) && connect.isAgentKey(key) ? "hub" : computers.agentKeyOwner(key);
      if (!from) { if (!badToken.allow(ip)) throw banned(); throw new HttpError(401, "Not the agent's key."); }
      let argv: string[] = [];
      try { argv = (await req.formData()).getAll("a").slice(0, 20).map((a) => String(a).slice(0, 2000)); } catch { throw new HttpError(400, "Send the command's words as a fields."); }
      server.timeout(req, 120);
      const jobId = req.headers.get("x-hearth-job")?.slice(0, 100) || undefined;
      const job = jobId ? await store.get<any>("jobs", jobId) : null;
      const mate = job?.teammateId ? await store.get<any>("teammates", job.teammateId) : null;
      const out = await hub.skillStoreAgent(argv, `${mate?.name || "an agent"}${from === "hub" ? "" : ` on ${from}`}`, jobId);
      return new Response(out + "\n", { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    }
    // The agent's hearth-trigger-port (events/ports.ts): claim a callback URL for a webhook, list, release. The claim
    // records which teammate and job took it (X-Hearth-Job), so every live URL can be traced to the task that wanted it.
    if (path === "/api/agent/ports" && method === "POST") {
      const key = req.headers.get("x-hearth-agent");
      const from = fromThisMachine(req, server) && connect.isAgentKey(key) ? "hub" : computers.agentKeyOwner(key);
      if (!from) { if (!badToken.allow(ip)) throw banned(); throw new HttpError(401, "Not the agent's key."); }
      let argv: string[] = [];
      try { argv = (await req.formData()).getAll("a").slice(0, 30).map((a) => String(a).slice(0, 4000)); } catch { throw new HttpError(400, "Send the command's words as a fields."); }
      const jobId = req.headers.get("x-hearth-job")?.slice(0, 100) || null;
      const job = jobId ? await store.get<any>("jobs", jobId) : null;
      const mate = job?.teammateId ? await store.get<any>("teammates", job.teammateId) : null;
      const who = { by: `${mate?.name || "Hearth"}${from === "hub" ? "" : ` (on ${from})`}`, jobId: job ? job.id : null, threadId: job?.threadId ?? null, teammateId: job?.teammateId ?? null };
      // The agent calls from this machine, so its Host is local: the public address is what an outside service needs.
      const base = (process.env.HEARTH_PUBLIC_URL || `${url.protocol}//${req.headers.get("host") || url.host}`).replace(/\/$/, "");
      const out = portsAgent(hub.pipeline, argv, who, base);
      if (argv[0] === "claim" || argv[0] === "release") await hub.log(`port.${argv[0]}`, `${who.by}: hearth-trigger-port ${argv.filter((a) => !/^https?:/.test(a)).join(" ").slice(0, 200)}`);
      return new Response(out + "\n", { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    }
    // An MCP server's login service sends the browser back here (no device key on a redirect; the state ties it to the
    // sign-in the hub started).
    if (path === "/api/mcp/callback" && method === "GET") {
      const err = url.searchParams.get("error");
      const r = err ? { error: err === "access_denied" ? "You didn't allow access." : (url.searchParams.get("error_description") || err).slice(0, 200) }
        : await connect.mcp.finish(url.searchParams.get("state") || "", url.searchParams.get("code") || "");
      if (r.error && badToken.blocked(ip)) throw banned();
      if (r.error) badToken.allow(ip);
      else await hub.log("mcp.connected", `MCP: signed in to ${r.value}`);
      const to = `/#mcp=${r.error ? `error:${encodeURIComponent(r.error)}` : `ok:${encodeURIComponent(r.value!)}`}`;
      return new Response(null, { status: 302, headers: { Location: to, "Cache-Control": "no-store" } });
    }
    // The agent's hearth-gmail / hearth-drive / hearth-calendar commands. Two keys open them: the hub's agent key, only
    // straight from this machine (like hearth-plaid), or a linked computer's key, which lives only as long as that
    // computer's line to the hub is open (a job running on your Mac). Neither key opens anything else.
    const agentGoogle = path.match(/^\/api\/agent\/google\/(gmail|drive|calendar)$/);
    if (agentGoogle && method === "POST") {
      const key = req.headers.get("x-hearth-agent");
      const from = fromThisMachine(req, server) && connect.isAgentKey(key) ? "hub" : computers.agentKeyOwner(key);
      if (!from) { if (!badToken.allow(ip)) throw banned(); throw new HttpError(401, "Not the agent's key."); }
      if (Number(req.headers.get("content-length") || 0) > 30_000_000) throw new HttpError(413, "Too large (30 MB at most).");
      let form: FormData;
      try { form = await req.formData(); } catch { throw new HttpError(400, "Send the command's words as form fields."); }
      const argv = form.getAll("a").slice(0, 40).map((a) => String(a).slice(0, 2000));
      const body = form.get("body"), file = form.get("file");
      const input = {
        ...(body != null ? { body: (typeof body === "string" ? body : await body.text()).slice(0, 5_000_000) } : {}),
        ...(file && typeof file !== "string" ? { file: { name: file.name || "upload", type: file.type, data: new Uint8Array(await file.arrayBuffer()) } } : {}),
      };
      const service = agentGoogle[1] as GoogleService;
      try {
        // A change or removal waits for the owner: stage it and hand the agent the action for its ```hearth block,
        // unless they said "Always allow" for this kind, in which case it runs now (and is logged as an approval).
        const change = await changeFor(hub.google, service, argv, input);
        if (change) {
          const id = hub.stageGoogleChange(change);
          const out = { needsApprove: true, kind: change.kind, summary: change.summary, action: { type: "google.change", id },
            say: "Put this action in your ```hearth block exactly as given. The owner taps Approve before it happens: tell them it's waiting for them." };
          if (await hub.googleAllowed(change.kind)) {
            const r = await hub.requestGoogleChange({ id }, {});
            await hub.log("google.agent", `hearth-${service} ${argv.join(" ").slice(0, 120)} (always allowed)`);
            return new Response(JSON.stringify(r.value ? { done: true, alwaysAllowed: true, summary: change.summary, result: JSON.parse(r.value.result || "null") } : { error: r.error }, null, 1),
              { status: r.value ? 200 : 502, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
          }
          await hub.log("google.agent", `hearth-${service} ${argv.join(" ").slice(0, 120)} (staged for Approve)`);
          return new Response(JSON.stringify(out, null, 1), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
        }
        const r = await googleAgent(hub.google, service, argv, input);
        await hub.log("google.agent", `hearth-${service} ${argv.join(" ").slice(0, 120)}${from === "hub" ? "" : ` (from ${from})`}`);
        return new Response(JSON.stringify(r, null, 1), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: String(e?.message || e) }, null, 1), { status: e instanceof GoogleAgentError ? 400 : 502, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
      }
    }
    // Plaid says a bank has news (new transactions, signed out). Only a body Plaid signed counts; answer fast, work after.
    if (path === "/api/plaid/webhook") {
      if (method !== "POST") throw new HttpError(405, "POST to this address.");
      if (!webhookLimiter.allow("plaid")) throw new HttpError(429, "Too many calls. Wait a minute.");
      if (Number(req.headers.get("content-length") || 0) > 64_000) throw new HttpError(413, "Too large.");
      const raw = (await req.text()).slice(0, 64_000);
      if (!(await connect.plaid.verify(raw, req.headers.get("plaid-verification")))) throw new HttpError(401, "Not signed by Plaid.");
      let b: any = null;
      try { b = JSON.parse(raw); } catch { throw new HttpError(400, "Not JSON."); }
      const what = connect.plaid.handle(b);
      // Ports claimed for plaid get the ping too (item X has updates); their triggers' scripts fetch the details.
      const bank = connect.plaid.items().find((i) => i.itemId === b?.item_id)?.institution.name ?? null;
      const ports = hub.pipeline.forwardToPorts("plaid", { ...b, bank });
      await hub.log("plaid.webhook", `${b.webhook_type || "?"} ${b.webhook_code || "?"}: ${what}${ports ? ` · to ${ports} port(s)` : ""}`);
      return json({ ok: true });
    }
    // Google sends the browser back here after you approve (no device key on a redirect; the state ties it to your Connect).
    if (path === "/api/google/callback" && method === "GET") {
      const err = url.searchParams.get("error");
      const r = err ? { error: err === "access_denied" ? "You didn't allow access." : err }
        : await hub.google.finish(url.searchParams.get("code") || "", url.searchParams.get("state") || "");
      if (r.error && badToken.blocked(ip)) throw banned();
      if (r.error) badToken.allow(ip);
      else { await hub.log("google.connected", `Google connected (${(r as any).value?.added || "account"})`); hub.emit("connections"); }
      const to = `/#connections=${r.error ? `error:${encodeURIComponent(r.error)}` : `google:${encodeURIComponent((r as any).value?.added || "")}`}`;
      return new Response(null, { status: 302, headers: { Location: to, "Cache-Control": "no-store" } });
    }
    if (path === "/api/pair" && method === "POST") {
      if (!pairLimiter.allow(ip) || !pairGlobal.allow("all")) throw new HttpError(429, "Too many attempts. Wait 10 minutes.");
      const b = await body(req);
      const r = await redeemPairingCode(store, b.code, b.deviceName);
      if (!r) throw new HttpError(401, "That code didn't work. Codes are single-use and last 10 minutes.");
      if (typeof b.tz === "string" && isValidTimeZone(b.tz)) {
        const p = await hub.prefs();
        if (p.tz === "UTC") await hub.setPrefs({ tz: b.tz });
      }
      await hub.log("device.paired", `${r.device.name} paired`);
      return json({ token: r.token, deviceId: r.device.id, hub: { name: config.name, build: web.build } });
    }

    // ---- everything else needs a paired device ----
    // The `hearth` CLI on this machine (you or an agent over SSH): acts as the owner, but only on a direct localhost call.
    const cli = isAdminRequest(req, server.requestIP(req)?.address || "?", admin);
    const device = cli
      ? ({ id: "cli", name: "hearth CLI", tokenHash: "", lastSeenAt: new Date().toISOString(), createdAt: "1970-01-01T00:00:00.000Z", role: "owner" } as Device)
      : await deviceForToken(store, req.headers.get("authorization"));
    if (!device) { if (!badToken.allow(ip)) throw banned(); throw new HttpError(401, "Not paired."); }
    // A linked computer's key opens its link and nothing else: it can't read chats or memory through the API.
    if (device.role === "computer") throw new HttpError(403, "This key only links a computer to the hub.");
    // Face ID lock: a device with a passkey (or every device, with HEARTH_REQUIRE_PASSKEY=1) needs a recent unlock.
    // A copied device token alone then gets nothing but this lock screen.
    if (!cli && (device.passkey || config.requirePasskey) && !sessions.valid(req.headers.get("x-hearth-unlock"), device.id)) {
      const lockOk = seg[1] === "unlock" || (seg[1] === "passkey" && !device.passkey);
      if (!lockOk) return json({ error: "Locked.", locked: true, hasPasskey: !!device.passkey }, 423);
    }
    const owner = cli || (await isOwner(store, device));
    const ownerOnly = () => { if (!owner) throw new HttpError(403, "Only your primary device can do that."); };
    if (!cli && (Date.now() - new Date(device.lastSeenAt).getTime() > 5 * 60_000 || (ip !== "?" && device.ip !== ip))) await store.put<Device>("devices", { ...device, lastSeenAt: new Date().toISOString(), ip: ip !== "?" ? ip : device.ip });
    const id = seg[2];

    switch (seg[1]) {
      case "state": {
        const prefs = await hub.prefs();
        return json({
          hub: { name: config.name, version: pkg.version, build: web.build, brain: hub.brain.label, storage: store.kind },
          device: { id: device.id, name: device.name, primary: owner, passkey: !!device.passkey }, requirePasskey: config.requirePasskey,
          pendingAccess: access.pending().length, prefs: publicPrefs(prefs), thinking: hub.thinking,
          push: { available: !!hub.push, subscribed: hub.push ? await hub.push.hasDevice(device.id) : false },
          pendingScripts: (await hub.scripts.list()).filter((s) => s.status === "proposed").length,
          voice: voice?.current?.name ?? null,
          computers: await computerSummary(),
          brainProblems: await hub.brainProblems(),
          brains: await hub.brainStatus(),
          // Shown as a warning on Connectors (a Google account to reconnect).
          connectorWarnings: hub.google.needs(),
          tileKey,
        });
      }
      case "stream": {
        let ctrl: ReadableStreamDefaultController;
        let beat: ReturnType<typeof setInterval>;
        server.timeout(req, 0);
        const stream = new ReadableStream({
          start(c) {
            ctrl = c;
            if (!streams.has(device.id)) streams.set(device.id, new Set());
            streams.get(device.id)!.add(c);
            c.enqueue(enc.encode(`data: ${JSON.stringify({ type: "hello", data: { build: web.build, thinking: hub.thinking } })}\n\n`));
            beat = setInterval(() => { try { c.enqueue(enc.encode(": beat\n\n")); } catch {} }, 20_000);
          },
          cancel() { clearInterval(beat); streams.get(device.id)?.delete(ctrl); },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
      }
      case "today": {
        const now = Date.now();
        const upcoming = hub.upcomingPlans((await hub.prefs()).tz).filter((h) => new Date(h.nextAt).getTime() - now < 36 * 3.6e6);
        const watching = hub.pipeline.watchers().filter((w) => w.status === "active").map((w) => ({ id: w.id, title: w.name, when: w.describe }));
        const msgs = await store.recent<Message>("messages", 80);
        return json({
          upcoming: upcoming.slice(0, 8), watching: watching.slice(0, 8),
          proactive: msgs.filter((m) => m.proactive).slice(-6).reverse(),
          activity: (await store.recent("activity", 25)).reverse(),
          location: (await store.recent<LocationFix>("locations", 1))[0] || null,
          memoryCount: (await store.all<Fact>("memory")).filter((f) => isActive(f)).length,
        });
      }
      case "threads": {
        if (method === "GET" && !id) return json(await hub.listThreads());
        if (method === "POST" && id && seg[3] === "topic") { const b = await body(req); return json({ ok: await hub.decideMove(id, String(b.messageId || ""), b.how === "keep" ? "keep" : "move") }); }
        if (method === "POST" && id === "similar") return json({ match: await hub.similarRamble(String((await body(req)).text || "")) });
        if (method === "GET" && id === "seen") return json(await hub.chatSeen());
        if (method === "POST" && id && seg[3] === "seen") return json({ at: await hub.markChatSeen(id), marked: await hub.markStuckSeen({ threadId: id }) });
        if (method === "GET" && id) { const d = await hub.threadDetail(id); if (!d) break; return json({ ...d, approvals: (await store.all<Approval>("approvals")).filter((a) => a.threadId === id) }); }
        if (method === "POST" && (!id || seg[3] === "messages")) {
          const b = await body(req);
          const fileIds = Array.isArray(b.fileIds) ? b.fileIds.map(String).slice(0, 5) : [];
          const r = await hub.ramble(String(b.text || ""), id || undefined, fileIds, !id && b.projectId ? String(b.projectId) : undefined);
          if (r.error) throw new HttpError(400, r.error);
          return json(r.value);
        }
        if (method === "DELETE" && id) return json({ ok: await hub.removeThread(id) });
        if (method === "POST" && id && seg[3] === "project") { const r = await hub.fileThread(id, (await body(req)).projectId || null); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        if (method === "PATCH" && id) { const r = await hub.renameThread(id, String((await body(req)).channel || "")); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        break;
      }
      case "projects": {
        if (method === "GET" && !id) return json(await hub.listProjects());
        if (method === "GET" && id) { const d = await hub.projectDetail(id); if (!d) break; return json(d); }
        if (method === "POST" && !id) { const b = await body(req); const r = await hub.createProject(String(b.name || ""), b.emoji ? String(b.emoji) : undefined); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        if (method === "PATCH" && id) { const r = await hub.updateProject(id, await body(req)); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        if (method === "DELETE" && id) return json({ ok: await hub.removeProject(id) });
        break;
      }
      case "files": {
        if (method === "POST" && !id) {
          const len = Number(req.headers.get("content-length") || 0);
          if (len > MAX_FILE_BYTES) throw new HttpError(413, "That file is over 15 MB.");
          const bytes = new Uint8Array(await req.arrayBuffer());
          let name = "file";
          try { name = decodeURIComponent(req.headers.get("x-file-name") || "file"); } catch {}
          const r = await hub.files.save(bytes, { name, source: "you" });
          if (r.error) throw new HttpError(413, r.error);
          hub.emit("files");
          return json(r.value);
        }
        if (method === "GET" && !id) {
          const thread = url.searchParams.get("thread");
          return json((await store.all<StoredFile>("files")).filter((f) => !thread || f.threadId === thread).reverse());
        }
        if (method === "GET" && id) {
          const f = await store.get<StoredFile>("files", id);
          const bytes = f && hub.files.bytes(f.id);
          if (!f || !bytes) break;
          // Only harmless types may display inline; anything that could run (html, svg) always downloads.
          const inlineOk = url.searchParams.get("inline") === "1" && /^(image\/(png|jpeg|gif|webp|heic|avif)|application\/pdf|text\/(plain|markdown|csv|tab-separated-values|calendar)|application\/json|audio\/|video\/)/.test(f.mime);
          return new Response(bytes, { headers: {
            "Content-Type": inlineOk ? f.mime : "application/octet-stream",
            "Content-Disposition": `${inlineOk ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
            "Content-Security-Policy": "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
            "Cache-Control": "private, max-age=3600",
          } });
        }
        if (method === "DELETE" && id) { const ok = await hub.files.remove(id); hub.emit("files"); return json({ ok }); }
        break;
      }
      case "skills": {
        if (method === "GET") {
          const [skills, workflows, components] = await Promise.all([store.all<Skill>("skills"), store.all<Workflow>("workflows"), store.all<Component>("components")]);
          return json({ skills, workflows, search: hub.library.mode,
            components: components.map(({ html, versions, ...c }) => ({ ...c, versions: versions.length })).sort((a, b) => b.uses - a.uses) });
        }
        if (method === "PATCH" && id) {
          const sk = await store.get<Skill>("skills", id);
          if (!sk) break;
          const b = await body(req);
          if (typeof b.pinned === "boolean") { await store.put("skills", { ...sk, pinned: b.pinned }); hub.emit("skills"); return json({ ok: true }); }
          const r = await hub.saveSkill({ ...sk, description: b.description ?? sk.description, steps: Array.isArray(b.steps) ? b.steps : sk.steps });
          if (r.error) throw new HttpError(400, r.error);
          return json(r.value);
        }
        if (method === "DELETE" && id) { const ok = await store.remove("skills", id); hub.emit("skills"); return json({ ok }); }
        break;
      }
      // Public skills (brains/skill-store.ts): search the catalog, read one, install, update, remove. You're asking, so no card.
      case "skillstore": {
        if (method === "GET" && id === "search") {
          try { return json(await hub.searchSkills(url.searchParams.get("q") || "")); }
          catch (e: any) { throw new HttpError(502, `Couldn't search skills.sh: ${String(e?.message || e).slice(0, 200)}`); }
        }
        if (method === "GET" && id === "preview") {
          const r = await hub.previewSkill(url.searchParams.get("ref") || "");
          if (r.error) throw new HttpError(400, r.error);
          return json(r.value);
        }
        if (method === "GET" && id === "installed") return json(installedSkills(hub.config.dataDir));
        if (method === "POST" && id === "install") {
          const b = await body(req);
          const r = await hub.installSkill(String(b.ref || ""));
          if (r.error) throw new HttpError(400, r.error);
          return json(r.value);
        }
        if (method === "POST" && id === "update" && seg[3]) {
          const r = await hub.updateSkill(decodeURIComponent(seg[3]));
          if (r.error) throw new HttpError(400, r.error);
          return json(r.value);
        }
        if (method === "DELETE" && id) return json({ ok: await hub.removeInstalledSkill(decodeURIComponent(id)) });
        break;
      }
      case "library": {
        if (method === "POST" && id === "purge") return json({ removed: await hub.purgeLibrary() });
        break;
      }
      case "workflows": {
        if (method === "POST" && id === "from-ramble") { const b = await body(req); const r = await hub.saveRambleAsWorkflow(String(b.messageId || ""), typeof b.name === "string" ? b.name : undefined); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        if (method === "PATCH" && id) { const w = await store.get<Workflow>("workflows", id); if (!w) break; const b = await body(req); await store.put("workflows", { ...w, pinned: !!b.pinned }); hub.emit("skills"); return json({ ok: true }); }
        if (method === "POST" && seg[3] === "activate") { const w = await store.get<Workflow>("workflows", id); if (!w) break; await store.put("workflows", { ...w, status: "active" }); hub.emit("skills"); return json({ ok: true }); }
        if (method === "DELETE" && id) { const ok = await store.remove("workflows", id); hub.emit("skills"); return json({ ok }); }
        break;
      }
      case "always-allow": {
        // The chats teammates may message without asking. You can only remove from here; adding is "Always allow" on a card.
        if (method === "GET") return json({ keys: await hub.alwaysAllowed() });
        ownerOnly();
        if (method === "DELETE") { const k = String(url.searchParams.get("key") || ""); await hub.setAlwaysAllowed((await hub.alwaysAllowed()).filter((x) => x !== k)); return json({ keys: await hub.alwaysAllowed() }); }
        break;
      }
      case "approvals": {
        if (method === "GET") return json((await store.all<Approval>("approvals")).filter((a) => !url.searchParams.get("thread") || a.threadId === url.searchParams.get("thread")));
        if (method === "POST" && (seg[3] === "approve" || seg[3] === "reject")) {
          const r = await hub.decideApproval(id, seg[3] === "approve", (await body(req).catch(() => ({}))).always === true);
          if (r.error) throw new HttpError(409, r.error);
          return json(r.value);
        }
        break;
      }
      case "apps": {
        const meta = (a: MiniApp) => ({ id: a.id, name: a.name, title: a.title, description: a.description, teammateId: a.teammateId, threadId: a.threadId, pinned: a.pinned, inline: !!a.inline, size: a.size === ("tall" as string) ? "large" : a.size || "small", order: a.order, createdAt: a.createdAt, updatedAt: a.updatedAt, versions: a.versions.length });
        if (method === "GET" && !id) return json((await hub.apps.list()).map(meta).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))));
        const a = id ? await store.get<MiniApp>("apps", id) : null;
        if (!a) break;
        if (method === "GET" && !seg[3]) return json({ ...meta(a), data: a.data });
        if (method === "POST" && seg[3] === "open") return json({ url: `/app-frame/${hub.apps.ticket(a.id, (await body(req)).view)}` });
        if (method === "PUT" && seg[3] === "state") { const r = await hub.apps.setState(a.id, (await body(req)).state); if (r.error) throw new HttpError(413, r.error); return json({ ok: true }); }
        if (method === "POST" && seg[3] === "undo") { const r = await hub.apps.undo(a.id); if (!r) throw new HttpError(400, "There's no earlier version."); hub.emit("apps"); return json(meta(r)); }
        if (method === "POST" && seg[3] === "ask") { const r = await hub.askFromApp(a.id, String((await body(req)).text || "")); if (r.error) throw new HttpError(429, r.error); return json({ ok: true }); }
        if (method === "PATCH" && !seg[3]) {
          const b = await body(req);
          if (b.pinned !== undefined || b.size !== undefined) await hub.apps.pin(a.name, b.pinned === undefined ? a.pinned : !!b.pinned, b.size);
          if (typeof b.title === "string" && b.title.trim()) await store.put<MiniApp>("apps", { ...(await store.get<MiniApp>("apps", a.id))!, title: b.title.trim().slice(0, 60) });
          if (b.inline === false) await store.put<MiniApp>("apps", { ...(await store.get<MiniApp>("apps", a.id))!, inline: false }); // "Keep as app"
          hub.emit("apps");
          return json({ ok: true });
        }
        if (method === "DELETE" && !seg[3]) { await hub.apps.remove(a.id); hub.emit("apps"); return json({ ok: true }); }
        break;
      }
      case "messages": {
        // A message queued behind a run that's going: send it now (into the run), or take it back.
        if (method === "POST" && id && seg[3] === "send") { const r = await hub.sendQueuedNow(id); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        // Or start it now on its own (New session): a new thread here, or its own ramble.
        if (method === "POST" && id && (seg[3] === "ramble" || seg[3] === "thread")) { const r = await hub.startQueuedApart(id, seg[3]); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        if (method === "DELETE" && id) { const r = await hub.unqueueMessage(id); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        break;
      }
      case "jobs": {
        if (method === "POST" && seg[3] === "reply") { const b = await body(req); const r = await hub.replyToJob(id, String(b.text || ""), { queue: b.queue === true, fileIds: Array.isArray(b.fileIds) ? b.fileIds.map(String).slice(0, 5) : [] }); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        if (method === "POST" && seg[3] === "stop") { const r = await hub.stopJob(id); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        if (method === "POST" && seg[3] === "retry") { const r = await hub.retryJob(id); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        if (method === "GET" && seg[3] === "frame") {
          const f = hub.liveFrame(id);
          if (!f) throw new HttpError(404, "No live view right now.");
          return json({ n: f.n, at: f.at, src: `data:${f.mime};base64,${Buffer.from(f.data).toString("base64")}` });
        }
        if (method === "POST" && seg[3] === "save-skill") { const r = await hub.saveJobAsSkill(id); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        break;
      }
      case "brains": {
        // Which brains are installed and signed in here, which ones you picked, and each one's live plan usage.
        if (method === "GET" && id === "detect") return json({ brains: detectBrains() });
        if (method === "GET" && id === "usage") {
          const pool = await hub.brainPool();
          await Promise.all(pool.map((h) => hub.brain.usage.refresh(h, url.searchParams.get("fresh") === "1").catch(() => {})));
          return json({ pool, usage: hub.brain.usage.view(pool) });
        }
        // "Check again": one tiny real call, so you see right away whether the brain is signed in.
        if (method === "POST" && id === "check" && (seg[3] === "claude" || seg[3] === "codex")) {
          ownerOnly();
          if (!availableHarnesses(config).includes(seg[3])) throw new HttpError(400, `${seg[3] === "claude" ? "Claude Code" : "Codex"} isn't installed on the hub.`);
          return json(await hub.brain.check(seg[3]));
        }
        if (method === "PUT" && id === "pool") { ownerOnly(); const r = await hub.setBrainPool((await body(req)).pool); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        // A long-lived login copied up from your Mac: a Claude setup-token, or Codex's auth.json.
        if (method === "PUT" && id === "login" && seg[3]) {
          ownerOnly();
          const r = connect.brainLogin(seg[3], await body(req));
          if (r.error) throw new HttpError(400, r.error);
          await hub.log("brains.login", `${seg[3] === "claude" ? "Claude" : "Codex"} login copied to the hub by ${device.name}`);
          return json({ result: r.value, brains: detectBrains() });
        }
        if (method === "DELETE" && id === "login" && seg[3]) { ownerOnly(); const r = connect.brainLogout(seg[3]); if (r.error) throw new HttpError(400, r.error); return json({ brains: detectBrains() }); }
        if (method === "GET") return json({ current: await hub.brains(), available: availableHarnesses(config), hybrid: (await hub.prefs()).hybrid !== false, pool: await hub.brainPool() });
        if (method === "PATCH") { const r = await hub.setBrains(await body(req)); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        break;
      }
      case "connectors": {
        // The grid: every brain, key and account, and adding or removing one.
        if (method === "GET" && !id) return json({ connectors: await connect.tiles() });
        ownerOnly();
        if (method === "POST" && id && seg[3] === "risk") { const r = await connect.acceptRisk(id, device.name); if (r.error) throw new HttpError(400, r.error); return json({ connectors: await connect.tiles() }); }
        // Slack from your Chrome login: which workspaces it opens, so you can pick one (tokens stay on the hub).
        if (method === "POST" && id === "slack" && seg[3] === "workspaces") {
          if (!voiceLimiter.allow("slack-workspaces")) throw new HttpError(429, "Too many tries. Wait a few minutes.");
          const b = await body(req);
          const d = slackCookie(b.cookies);
          if (!d) throw new HttpError(400, "That isn't a Slack login. Sign in to Slack in Chrome, then try again.");
          const all = await chromeWorkspaces(d, cleanFingerprint(b.fingerprint)).catch(() => null);
          if (!all) throw new HttpError(502, "Couldn't reach Slack.");
          return json({ workspaces: all.map(({ domain, team, user }) => ({ domain, team, user })) });
        }
        // Plaid: add a bank through a Plaid-hosted page (or sign one in again), then pick up the result; remove one bank.
        if (id === "plaid" && seg[3] === "link" && method === "POST") {
          const b = await body(req);
          // Checking is polled every few seconds while the page is open; starting a link is the thing to limit.
          if (!(typeof b.check === "string" ? tileLimiter.allow("plaid-check") : voiceLimiter.allow("plaid-link"))) throw new HttpError(429, "Too many tries. Wait a few minutes.");
          try {
            if (typeof b.check === "string") {
              const r = await connect.plaid.finishLink(b.check);
              if (r.added.length) { await hub.log("connector.added", `Plaid: ${r.added.map((a) => a.institution).join(", ")} added by ${device.name}`); hub.emit("connections"); }
              else if (r.done) hub.emit("connections");
              return json(r);
            }
            // Plaid tells this address about new transactions: the hub's own address, as your browser sees it.
            const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || url.host;
            const proto = config.behindProxy ? (req.headers.get("x-forwarded-proto") || "https") : url.protocol.replace(":", "");
            const hook = `${proto}://${host}/api/plaid/webhook`;
            const ok = webhookOk(hook) ? hook : null;
            if (ok) void connect.plaid.ensureWebhook(ok);
            return json({ ...(await connect.plaid.startLink(typeof b.update === "string" ? b.update : null, ok, b.kind === "investments" ? "investments" : "bank")), webhook: !!ok });
          } catch (e: any) { throw new HttpError(400, e.message); }
        }
        if (id === "plaid" && seg[3] === "items" && seg[4] && method === "DELETE") {
          const name = connect.plaid.items().find((i) => i.itemId === seg[4])?.institution.name;
          try { await connect.plaid.removeItem(seg[4]); } catch (e: any) { throw new HttpError(400, e.message); }
          await hub.log("connector.removed", `Plaid: ${name ?? "a bank"} removed by ${device.name}`);
          hub.emit("connections");
          return json({ connectors: await connect.tiles() });
        }
        // Proof it's reading: run the connector's source once and show what came back (Slack DMs, etc.).
        if (method === "POST" && id && seg[3] === "test") {
          // Plaid's screen reads your banks each time it opens: allow that often (Plaid's own limits are far higher),
          // and don't count it when there's no bank to read.
          if (id === "plaid") {
            if (connect.plaid.items().length && !plaidLimiter.allow("test")) throw new HttpError(429, "Give it a few seconds, then try again.");
            return json(await connect.plaid.probe());
          }
          if (!voiceLimiter.allow(`test:${id}`)) throw new HttpError(429, "Give it a moment, then try again.");
          if (id === "slack") return json(await connect.slack.probe());
          if (!sourceById(id)) throw new HttpError(400, `${id} can't be tested.`);
          return json(await hub.testConnection(id));
        }
        if (method === "PUT" && id) {
          if (!voiceLimiter.allow(`connect:${id}`)) throw new HttpError(429, "Too many tries. Wait a few minutes.");
          const r = await connect.add(id, await body(req), device.name);
          if (r.error) throw new HttpError(400, r.error);
          return json(r.value);
        }
        if (method === "DELETE" && id) { const r = await connect.remove(id, device.name); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        break;
      }
      case "whatsapp": {
        // Status (and the QR code while linking), the ignore rules, and the chats to pick from.
        if (method === "GET" && !id) return json(await connect.whatsappView());
        ownerOnly();
        if (method === "PUT" && id === "ignore") { const rules = await connect.setIgnore(await body(req)); hub.emit("connections"); return json({ rules }); }
        if (method === "POST" && id === "ignore") {
          const b = await body(req);
          const kind = b.kind === "group" || b.kind === "keyword" ? b.kind : "contact";
          try { const rules = await connect.whatsapp.editRule(kind, String(b.value || ""), b.remove === true); hub.emit("connections"); return json({ rules }); }
          catch (e: any) { throw new HttpError(400, e.message); }
        }
        if (method === "POST" && id === "relink") {
          if (!voiceLimiter.allow("connect:whatsapp")) throw new HttpError(429, "Too many tries. Wait a few minutes.");
          try { await connect.whatsapp.relink(); } catch (e: any) { throw new HttpError(400, e.message); }
          hub.emit("connections");
          return json(await connect.whatsapp.status());
        }
        if (method === "GET" && id === "qr") {
          // Only ever draws the code WhatsApp gave us right now, never arbitrary text.
          const st = await connect.whatsapp.status();
          if (!st.qr || url.searchParams.get("text") !== st.qr) throw new HttpError(404, "No QR code to show.");
          return json({ dataUrl: await QRCode.toDataURL(st.qr, { margin: 1, width: 320 }) });
        }
        if (method === "GET" && id === "messages") return json({ messages: await connect.whatsapp.recent(Math.min(Number(url.searchParams.get("limit")) || 50, 200)) });
        break;
      }
      case "roster": return json(await hub.roster());
      case "board": return json(await hub.board(url.searchParams.get("teammate") || undefined));
      case "inbox":
        if (id === "seen") {
          if (method === "POST") return json({ at: await hub.markInboxSeen() });
          if (method === "GET") return json({ at: await hub.inboxSeen() });
          break;
        }
        {
          // MCP servers an agent asked for wait here too ("Needs you"), next to approvals.
          const asked = connect.mcp.waiting().map((s) => ({ kind: "mcp", at: s.addedAt, id: `mcp:${s.name}`, summary: `${s.name} · ${s.url}`, server: { name: s.name, url: s.url, addedBy: s.addedBy }, teammateId: "hearth" }));
          return json([...asked, ...(await hub.inbox())]);
        }
      case "teammates": {
        if (method === "GET" && id) { const d = await hub.teammateDetail(id); if (!d) break; return json(d); }
        if (method === "POST" && id && seg[3] === "seen") return json({ at: await hub.markChatSeen(`tm-${id}`), marked: await hub.markStuckSeen({ teammateId: id }) });
        if (method === "POST" && id && seg[3] === "messages") { const b = await body(req); const r = await hub.askTeammate(id, String(b.text || ""), { queue: b.queue === true }); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        if (method === "GET") return json(await store.all<Teammate>("teammates"));
        if (method === "POST") { const r = await hub.addTeammate(await body(req)); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        if (method === "PATCH" && id) { const r = await hub.updateTeammate(id, await body(req)); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        if (method === "DELETE" && id) return json({ ok: await hub.removeTeammate(id) });
        break;
      }
      case "shares": {
        // Shared teammates. Everything here is about what you share; visitors never reach these routes.
        if (!shares) throw new HttpError(503, "Sharing isn't available on this hub.");
        ownerOnly(); // sharing hands your data to other people, so only the primary device decides
        const verb = seg[3];
        if (method === "GET" && !id) return json({ ...(await shares.overview()), shares: (await shares.list()).map((x) => shares.view(x)) });
        if (method === "POST" && id === "mint") {
          const b = await body(req);
          const r = b.code ? await shares.mintFinish(b.code) : await shares.mintStart();
          if (r.error) throw new HttpError(400, r.error);
          return json(r.value);
        }
        if (method === "PATCH" && id === "settings") { const r = await shares.saveSettings(await body(req)); if (r.error) throw new HttpError(400, r.error); return json(await shares.overview()); }
        if (method === "POST" && !id) { const r = await shares.create(await body(req)); if (r.error) throw new HttpError(400, r.error); return json(shares.view(r.value!)); }
        if (!id) break;
        const s = await shares.get(id);
        if (!s) throw new HttpError(404, "No such link.");
        if (method === "GET" && !verb) return json({ share: shares.view(s), running: await shares.alive(s), events: await shares.events(id) });
        if (method === "PATCH" && !verb) { const r = await shares.update(id, await body(req)); if (r.error) throw new HttpError(400, r.error); return json(shares.view(r.value!)); }
        if (method === "DELETE" && !verb) return json({ ok: await shares.revoke(id) });
        if (method === "GET" && verb === "events" && seg[4]) { const e = await shares.event(id, seg[4]); if (!e) throw new HttpError(404, "Not found."); return json(e); }
        if (method !== "POST") break;
        const b = await body(req);
        const ids = Array.isArray(b.ids) ? b.ids.filter((x: unknown) => typeof x === "string").slice(0, 200) : [];
        if (verb === "publish") { await shares.publish(s); return json(shares.view((await shares.get(id))!)); }
        if (verb === "pause") { const p = await shares.pause(id, b.paused !== false); return json(p ? shares.view(p) : null); }
        if (verb === "apply") {
          const mode = b.mode === "copy" || b.mode === "branch" ? b.mode : "apply";
          const r: any = await shares.apply(id, ids, mode);
          return json(r, r.error ? 409 : 200);
        }
        if (verb === "reject") return json({ rejected: await shares.reject(id, ids) });
        if (verb === "undo") { const r = await shares.undo(id, String(b.applyId || "")); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        if (verb === "answer") { const r = await shares.answer(id, String(b.eventId || ""), b); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        break;
      }
      case "voice": {
        // Connect speech-to-text from the app. The key is checked with Deepgram, kept in a 0600 file on the hub,
        // and never sent back (only its last 4 characters).
        if (!voice) throw new HttpError(503, "Voice isn't available on this hub.");
        if (method === "GET") return json(voice.status());
        if (method === "PUT") {
          if (!voiceLimiter.allow("connect")) throw new HttpError(429, "Too many tries. Wait a few minutes.");
          const r = await voice.connect(String((await body(req)).key || ""));
          if (r.error) throw new HttpError(400, r.error);
          hub.emit("voice");
          return json(r.value);
        }
        if (method === "DELETE") { const r = voice.disconnect(); if (r.error) throw new HttpError(400, r.error); hub.emit("voice"); return json(r.value); }
        if (method === "POST" && seg[2] === "clean") return json({ text: await hub.cleanDictation(String((await body(req)).text || "")) });
        if (method === "POST" && seg[2] === "live") {
          // A one-time ticket for the live dictation socket (browsers can't put the device token on a WebSocket).
          if (!voice.deepgramKey()) throw new HttpError(503, "Voice isn't set up yet. Connect Deepgram in Settings → Voice.");
          const t = randomBytes(18).toString("base64url");
          for (const [k, v] of liveTickets) if (v < Date.now()) liveTickets.delete(k);
          liveTickets.set(t, Date.now() + 60_000);
          return json({ ticket: t });
        }
        break;
      }
      case "transcribe": {
        if (method !== "POST") break;
        const stt = voice?.current;
        if (!stt) throw new HttpError(503, "Voice isn't set up yet. Connect Deepgram in Settings → Voice.");
        const type = req.headers.get("content-type") || "";
        if (!/^audio\//.test(type)) throw new HttpError(415, "Send audio.");
        const audio = new Uint8Array(await req.arrayBuffer());
        if (audio.length > 15 * 1024 * 1024) throw new HttpError(413, "Recording too long.");
        try { return json({ text: await stt.transcribe(audio, type) }); }
        catch (err: any) { throw new HttpError(502, `Transcription failed: ${err.message}`); }
      }
      // MCP servers (/mcp in the app): GET the list; POST {url, name?, header?, key?} adds one; POST <name>/signin gives a
      // sign-in link (or reconnects with a fresh token); POST <name>/check looks again; PATCH <name> {enabled}; DELETE.
      case "mcp": {
        const name = id ? decodeURIComponent(id) : "";
        const verb = seg[3];
        if (method === "GET" && !name) return json({ servers: connect.mcp.list() });
        ownerOnly();
        const res = <T>(r: { value?: T; error?: string }) => { if (r.error) throw new HttpError(400, r.error); return r.value as T; };
        if (method === "POST" && !name) {
          const b = await body(req);
          const v = res(await connect.mcp.add({ url: String(b.url || ""), name: b.name ? String(b.name) : undefined, header: b.header ? String(b.header) : undefined, key: b.key ? String(b.key) : undefined }, device.name));
          await hub.log("mcp.added", `MCP: ${v.name} added by ${device.name}`);
          return json({ server: v });
        }
        if (!connect.mcp.get(name)) throw new HttpError(404, `No MCP server called ${name}.`);
        if (method === "POST" && verb === "signin") {
          // The browser comes back to this hub as you reached it (a hub with no public address: localhost).
          const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || url.host;
          const proto = config.behindProxy ? (req.headers.get("x-forwarded-proto") || "https") : url.protocol.replace(":", "");
          const v = res(await connect.mcp.signIn(name, process.env.HEARTH_PUBLIC_URL ? undefined : `${proto}://${host}/api/mcp/callback`));
          return json({ ...v, server: connect.mcp.view(name) });
        }
        // A server an agent asked for: you approve it (the hub contacts it for the first time) or deny it (DELETE).
        if (method === "POST" && verb === "approve") {
          const v = res(await connect.mcp.approve(name));
          await hub.log("mcp.approved", `MCP: ${name} approved by ${device.name}`);
          hub.emit("inbox");
          return json({ server: v });
        }
        if (method === "POST" && verb === "signout") { res(connect.mcp.signOut(name)); return json({ server: connect.mcp.view(name) }); }
        if (method === "POST" && verb === "check") { await connect.mcp.check(name); return json({ server: connect.mcp.view(name) }); }
        if (method === "PATCH" && !verb) {
          const b = await body(req);
          // {tool, ask}: that tool waits for Approve (or runs without asking); {enabled}: the server on or off.
          if (typeof b.tool === "string") return json({ server: res(connect.mcp.setGate(name, b.tool, b.ask !== false)) });
          return json({ server: res(await connect.mcp.setEnabled(name, b.enabled !== false)) });
        }
        if (method === "DELETE" && !verb) {
          const asked = !!connect.mcp.get(name)?.pending;
          res(connect.mcp.remove(name));
          await hub.log("mcp.removed", `MCP: ${name} ${asked ? "denied" : "removed"} by ${device.name}`);
          if (asked) hub.emit("inbox");
          return json({ ok: true });
        }
        throw new HttpError(404, "Not here.");
      }
      case "google": {
        // The redirect Google must allow: this hub's own address, as your browser sees it.
        const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || url.host;
        const proto = config.behindProxy ? (req.headers.get("x-forwarded-proto") || "https") : url.protocol.replace(":", "");
        const redirectUri = `${proto}://${host}/api/google/callback`;
        if (method === "GET" && !id) return json({ ...hub.google.status(), redirectUri });
        if (method === "PUT" && id === "client") {
          ownerOnly();
          const b = await body(req);
          const r = hub.google.setClient(String(b.clientId || ""), String(b.clientSecret || ""));
          if (r.error) throw new HttpError(400, r.error);
          hub.emit("connections");
          return json({ ...r.value, redirectUri });
        }
        if (method === "POST" && id === "connect") {
          ownerOnly();
          const b = await body(req).catch(() => ({}));
          // {account} reconnects that one (Google preselects it); without it, Google asks which, so it can add another.
          const r = hub.google.authUrl(redirectUri, typeof b?.account === "string" ? b.account.trim().slice(0, 200) || undefined : undefined);
          if (r.error) throw new HttpError(400, r.error);
          return json({ url: r.value });
        }
        // DELETE /api/google signs out of every account; ?account=me@x.com just that one.
        if (method === "DELETE" && !id) {
          ownerOnly();
          const account = url.searchParams.get("account")?.trim() || undefined;
          if (account && !hub.google.accounts().some((a) => a.email.toLowerCase() === account.toLowerCase())) throw new HttpError(404, `No Google account ${account} is connected.`);
          const st = await hub.google.disconnect(account);
          await hub.log("google.disconnected", account ? `Google disconnected (${account})` : "Google disconnected");
          hub.emit("connections");
          return json({ ...st, redirectUri });
        }
        break;
      }
      case "connections": {
        if (method === "GET" && !id) return json({ connections: hub.connections.status() });
        if (!isCookieSite(id)) break;
        if (method === "GET" && seg[3] === "browsers") { ownerOnly(); return json(hub.connections.browserOptions(id)); }
        if (method === "POST" && seg[3] === "import") {
          ownerOnly();
          const r = hub.importFromBrowser(id, String((await body(req)).profile || ""));
          if (r.error) throw new HttpError(400, r.error);
          await hub.log("connection.saved", `${labelFor(id)} imported from browser`);
          await hub.audit("import", hub.connections.domainFor(id) || id, "you", { ok: true });
          return json({ status: r.value, test: await hub.testConnection(id) });
        }
        if (method === "PUT" && !seg[3]) {
          ownerOnly();
          const b = await body(req);
          const fromChrome = b.source === "chrome";
          const r = hub.connections.saveCookies(id, String(b.cookies || ""), fromChrome ? "chrome" : "paste", fromChrome ? b.fingerprint : undefined);
          if (r.error) throw new HttpError(400, r.error);
          await hub.log("connection.saved", `${labelFor(id)} ${fromChrome ? "login brought from Chrome on your Mac" : "cookies saved"}`);
          await hub.audit(fromChrome ? "import" : "paste", hub.connections.domainFor(id) || id, "you", { ok: true, detail: fromChrome ? "from Chrome on your Mac" : undefined });
          hub.emit("connections");
          return json({ status: r.value, test: await hub.testConnection(id) });
        }
        if (method === "POST" && seg[3] === "test") { ownerOnly(); return json(await hub.testConnection(id)); }
        if (method === "GET" && seg[3] === "recent") { ownerOnly(); return json(await hub.recentConversations(id, url.searchParams.get("fresh") === "1", url.searchParams.get("what") || "messages")); }
        if (method === "DELETE" && !seg[3]) { ownerOnly(); for (const k of ["", ":invitations", ":notifications"]) hub.vault?.delete(`recent:${id}${k}`); const st = hub.connections.remove(id); await hub.log("connection.removed", `${labelFor(id)} disconnected`); await hub.audit("remove", hub.connections.domainFor(id) || id, "you", { ok: true }); hub.emit("connections"); return json(st); }
        break;
      }
      // The event pipeline: sources, triggers, timers and the event log. Reading is for any device; changes are the owner's.
      case "pipeline": {
        const p = hub.pipeline;
        const sub = seg[2], key = seg[3] ? decodeURIComponent(seg[3]) : "";
        const ok = <T,>(r: { value?: T; error?: string; conflict?: unknown }) => { if (r.error) return json({ error: r.error, conflict: r.conflict ?? null }, 409); return json(r.value); };
        const withUrl = (src: ReturnType<typeof p.sources>[number]) => ({ ...src, pushPath: src.kind === "push" && owner && p.secretOf(src.id) ? `/api/events/${src.name}/${p.secretOf(src.id)}` : null });
        if (method === "GET" && !sub) return json({ sources: p.sources().map(withUrl), triggers: p.triggers(), timers: p.timers(), watchers: p.watchers() });
        if (method === "GET" && sub === "events" && key) { const e = p.getEvent(key); if (!e) break; return json(e); }
        if (method === "GET" && sub === "triggers" && key && seg[4] === "examples") return json(p.examples(key));
        if (method === "GET" && sub === "events") {
          const q = url.searchParams;
          return json(p.events({ source: q.get("source") || undefined, status: q.get("status") || undefined, limit: Number(q.get("limit")) || 50, before: q.get("before") || undefined }));
        }
        ownerOnly();
        if (sub === "sources") {
          if (method === "POST" && !key) { const r = p.createSource(await body(req), "you"); return r.value ? json({ ...withUrl(r.value.source) }) : ok(r); }
          if (method === "PATCH" && key) return ok(p.updateSource(key, await body(req)));
          if (method === "POST" && seg[4] === "release") { const b = await body(req); const r = p.releasePort(key, "you", String(b.reason || "")); if (r.value) await hub.log("port.release", `you released ${r.value.name}`); return r.value ? json(withUrl(r.value)) : ok(r); }
          if (method === "POST" && seg[4] === "rotate") { const r = p.rotateSecret(key); return r.value ? json(withUrl(r.value.source)) : ok(r); }
          if (method === "POST" && seg[4] === "test") {
            const r = p.publish(key, (await body(req)).payload ?? {}, {}, true);
            if (!r.value) return ok(r);
            await p.drain();
            return json(p.getEvent(r.value.id));
          }
          if (method === "DELETE" && key) return ok(p.removeSource(key, url.searchParams.get("purge") === "1"));
        }
        if (sub === "triggers") {
          if (method === "POST" && key === "dryrun") { const b = await body(req); return ok(p.dryrun(String(b.source || ""), String(b.formula || ""))); }
          if (method === "POST" && !key) return ok(await p.addTrigger(await body(req), "you"));
          if (method === "PATCH" && key) return ok(await p.updateTrigger(key, await body(req)));
          if (method === "DELETE" && key) return json({ ok: p.removeTrigger(key) });
        }
        // A reminder or routine you set yourself (a timer and its trigger in one).
        if (sub === "reminders" && method === "POST" && !key) return ok(await p.remind(await body(req), "you"));
        if (sub === "timers") {
          if (method === "POST" && !key) return ok(await p.addTimer(await body(req), "you"));
          if (method === "POST" && seg[4] === "run") { const e = await p.runTimerNow(key); if (!e) break; return json(e); }
          if (method === "PATCH" && key) return ok(await p.updateTimer(key, await body(req)));
          if (method === "DELETE" && key) return json({ ok: p.removeTimer(key) });
        }
        if (sub === "watchers") {
          if (method === "POST" && !key) return ok(await p.addWatcher(await body(req), "you"));
          if (method === "POST" && seg[4] === "check") { p.checkNow((w) => w.id === key || w.name === key); await p.tick(); const w = p.findWatcher(key); if (!w) break; return json(w); }
          if (method === "PATCH" && key) return ok(await p.updateWatcher(key, await body(req)));
          if (method === "DELETE" && key) return json({ ok: p.removeWatcher(key) });
        }
        // "The judge got this one wrong": the right value becomes an example it sees next time.
        if (sub === "events" && key && seg[4] === "correct" && method === "POST") { const b = await body(req); return ok(p.correct(key, String(b.trigger || ""), b.value)); }
        if (sub === "examples" && key && method === "DELETE") return json({ ok: p.forgetExample(Number(key)) });
        if (sub === "events" && method === "DELETE") {
          if (key) return json({ ok: p.removeEvent(key) });
          return json({ removed: p.clearEvents({ source: url.searchParams.get("source") || undefined, status: url.searchParams.get("status") || undefined }) });
        }
        break;
      }
      case "ideas": {
        if (method === "GET" && !id) return json(await hub.listIdeas());
        if (method === "POST" && !id) {
          if (!ideaLimiter.allow("ideas")) throw new HttpError(429, "The team just looked. Try again in a few minutes.");
          return json(await hub.thinkOfIdeas());
        }
        if (method === "POST" && id && seg[3] === "accept") { const r = await hub.acceptIdea(id); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        if (method === "POST" && id && seg[3] === "dismiss") return json({ ok: await hub.dismissIdea(id) });
        break;
      }
      case "people": {
        if (method === "GET" && !id) return json(await store.all<Person>("people"));
        if (method === "POST" && !id) { const r = await hub.upsertPerson(await body(req)); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        if (method === "PATCH" && id) {
          const p = await store.get<Person>("people", id);
          if (!p) break;
          const r = await hub.upsertPerson({ ...(await body(req)), name: p.name });
          return json(r.value);
        }
        if (method === "DELETE" && id) { const ok = await store.remove("people", id); hub.emit("people"); return json({ ok }); }
        break;
      }
      case "components": {
        if (method === "DELETE" && id) { const ok = await store.remove("components", id); hub.emit("skills"); return json({ ok }); }
        if (method === "PATCH" && id) {
          const c = await store.get<Component>("components", id);
          if (!c) break;
          const b = await body(req);
          await store.put<Component>("components", { ...c, description: typeof b.description === "string" ? b.description.slice(0, 300) : c.description });
          hub.emit("skills");
          return json({ ok: true });
        }
        break;
      }
      case "about": {
        const p = await hub.prefs();
        if (method === "GET") return json({ text: p.about || "", updatedAt: p.aboutUpdatedAt || null });
        if (method === "PUT") { await hub.setAbout(String((await body(req)).text || ""), true); return json({ ok: true }); }
        break;
      }
      case "memory": {
        if (method === "GET") {
          const all = await store.all<Fact>("memory");
          const q = url.searchParams.get("q") || "";
          return json({ facts: search(all.filter((f) => isActive(f)), q), history: all.filter((f) => !isActive(f)), notebooks: await store.all<Notebook>("notebooks") });
        }
        if (method === "POST") { const r = await hub.addFact(await body(req), "you"); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        if (method === "PATCH" && id) {
          const b = await body(req);
          const f = await store.get<Fact>("memory", id);
          if (!f) break;
          if (b.fact && b.fact !== f.fact) return json(await hub.updateFact(id, b));
          if ([1, 2, 3].includes(b.importance)) { const r = await store.put("memory", { ...f, importance: b.importance }); hub.emit("memory"); return json(r); }
          return json(f);
        }
        if (method === "DELETE" && id) return json({ ok: await hub.forgetFact(id) });
        break;
      }
      case "places": {
        if (method === "GET") return json(await store.all<Place>("places"));
        if (method === "POST") { const r = await hub.addPlace(await body(req)); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        if (method === "DELETE" && id) { const ok = await store.remove("places", id); hub.emit("places"); return json({ ok }); }
        break;
      }
      case "location": {
        if (method === "POST") { const b = await body(req); const r = await hub.recordLocation(Number(b.lat), Number(b.lon), Number(b.accuracy) || undefined, "app"); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        if (method === "DELETE") { await store.clear("locations"); await hub.log("location.cleared", "Location history cleared"); return json({ ok: true }); }
        break;
      }
      case "scripts": {
        if (method === "GET") return json((await hub.scripts.list()).map((s) => { const code = hub.scripts.code(s); return { ...s, code, codeSha256: sha256(code) }; }));
        if (method === "POST" && seg[3] === "approve") { const r = await hub.scripts.approve(id, String((await body(req)).sha256 || "")); if (r.error) throw new HttpError(409, r.error); await hub.log("script.approved", r.value!.name); await hub.scriptApproved(r.value!.name); hub.emit("scripts"); return json(r.value); }
        if (method === "POST" && seg[3] === "reject") { const r = await hub.scripts.reject(id); if (r.error) throw new HttpError(404, r.error); hub.emit("scripts"); return json(r.value); }
        if (method === "POST" && seg[3] === "run") { const s = await store.get<any>("scripts", id); if (!s) break; return json(await hub.scripts.run(s.name, [], { approvedRun: true })); } // tapping Test run is your approval for this run
        break;
      }
      case "prefs": {
        if (method !== "PATCH") break;
        const b = await body(req);
        const patch: Partial<Prefs> = {};
        if (typeof b.userName === "string") patch.userName = b.userName.trim().slice(0, 40);
        if (typeof b.tz === "string" && isValidTimeZone(b.tz)) patch.tz = b.tz;
        return json(publicPrefs(await hub.setPrefs(patch)));
      }
      case "devices": {
        const primaries = (await owners(store)).map((d) => d.id);
        // The hub itself, for the top of Connected devices: where it lives and the address it answers on.
        if (method === "GET" && id === "hub") {
          const address = process.env.HEARTH_PUBLIC_URL || pageOrigin || `http://${config.host}:${config.port}`;
          return json({ name: config.name, address: address.replace(/^https?:\/\//, ""), ip: await hubIp(address), host: hostname(),
            target: config.target, version: pkg.version, upSince: new Date(Date.now() - process.uptime() * 1000).toISOString(),
            tools: await toolStatus(), load: await hubLoad() });
        }
        if (method === "GET") return json((await store.all<Device>("devices")).map(({ tokenHash, passkey, ...d }) => ({
          ...d, primary: primaries.includes(d.id), passkey: !!passkey, current: d.id === device.id,
          ...(d.role === "computer" ? { link: computers.status(d.id, d.name, d.lastSeenAt), copy: d.copy || [],
            copiedAt: Object.fromEntries(Object.entries(computers.copied()).filter(([, v]) => v.from === d.id).map(([k, v]) => [k, v.at])) } : {}),
        })));
        // What a computer keeps copied up here, so the cloud can work while it's off. Only a server hub takes copies.
        if (method === "PUT" && id && seg[3] === "copy") {
          ownerOnly();
          const target = await store.get<Device>("devices", id);
          if (!target || target.role !== "computer") throw new HttpError(404, "No such computer.");
          if (config.target !== "lightsail") throw new HttpError(409, "Only a server hub (HEARTH_TARGET=lightsail) takes copies of logins.");
          const b = await body(req);
          const items = Object.keys(COPY_ITEMS).filter((k) => isCopyItem(k) && b[k] === true) as NonNullable<Device["copy"]>;
          await store.put<Device>("devices", { ...target, copy: items });
          computers.setWant(id, items);
          await hub.log("computer.copy", `${target.name} copies: ${items.map((i) => COPY_ITEMS[i].label).join(", ") || "nothing"}`);
          return json({ ok: true, copy: items, copied: computers.copied() });
        }
        // The Hearth Mac app links its own Mac as a computer, no approval: it's already one of your signed-in devices.
        // One computer per signed-in device; asking again (the app lost its link file) hands out a fresh key for the same one.
        if (method === "POST" && id === "link-self") {
          if (!pageOrigin && !process.env.HEARTH_PUBLIC_URL) throw new HttpError(400, "Open the hub's own address to link this computer.");
          const b = await body(req);
          const name = String(b.name || `${device.name} (computer)`).replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60) || "My Mac";
          const all = await store.all<Device>("devices");
          const mine = all.find((d) => d.role === "computer" && d.linkedBy === device.id && !d.machine);
          let token: string, deviceId: string;
          if (mine) {
            token = await rotateToken(store, mine.id);
            computers.drop(mine.id, "new key");
            deviceId = mine.id;
            if (mine.name !== name) await store.put<Device>("devices", { ...(await store.get<Device>("devices", mine.id))!, name });
          } else {
            const added = await addDevice(store, name, "computer");
            await store.put<Device>("devices", { ...added.device, linkedBy: device.id });
            token = added.token; deviceId = added.device.id;
            await recount();
          }
          await hub.log("device.paired", `${name} linked itself as a computer (from ${device.name})`);
          hub.emit("computers", {});
          return json({ hub: pageOrigin || new URL(process.env.HEARTH_PUBLIC_URL!).origin, token, deviceId, name });
        }
        // Any of your devices can hand out a code for a new one (same trust as approving a request).
        if (method === "POST" && id === "pair-code") {
          const r = await newPairingCode(store);
          const link = `${pageOrigin || process.env.HEARTH_PUBLIC_URL || ""}/#pair=${r.code}`;
          return json({ ...r, link, qr: await QRCode.toString(link, { type: "svg", margin: 1, errorCorrectionLevel: "M" }) });
        }
        // Hand the primary role to another device (you're moving to a new phone).
        if (method === "POST" && id && seg[3] === "primary") {
          ownerOnly();
          const target = await store.get<Device>("devices", id);
          if (!target) throw new HttpError(404, "No such device.");
          if (target.role === "computer") throw new HttpError(409, "A linked computer can't be the primary device.");
          await store.put<Device>("devices", { ...target, role: "owner" });
          for (const d of await store.all<Device>("devices")) if (d.id !== id && (d.role === "owner" || primaries.includes(d.id))) await store.put<Device>("devices", { ...d, role: "member" });
          await hub.log("device.primary", `${target.name} is now the primary device`);
          return json({ ok: true });
        }
        if (method === "DELETE" && id) {
          if (id !== device.id) ownerOnly();
          if (primaries.length === 1 && primaries[0] === id && (await store.all<Device>("devices")).length > 1) throw new HttpError(409, "Make another device primary first.");
          sessions.endDevice(id);
          const gone = await store.get<Device>("devices", id);
          if (gone?.role === "computer") { computers.drop(id, "signed out", 4001); for (const i of gone.copy || []) computers.removeCopy(i, id); }
          if (gone?.machine) await machines.deviceRemoved(id);
          const ok = await store.remove("devices", id);
          await recount();
          await hub.push?.unsubscribeDevice(id);
          for (const c of streams.get(id) || []) { try { c.close(); } catch {} }
          streams.delete(id);
          await hub.log("device.revoked", `A device was signed out`);
          return json({ ok });
        }
        break;
      }
      // Face ID lock for this device.
      case "passkey": {
        if (!pageOrigin) throw new HttpError(400, "Open the hub's own address to use Face ID.");
        if (id === "options" && method === "POST") {
          return json({ challenge: newChallenge(device.id), rp: { name: config.name, id: new URL(pageOrigin).hostname }, user: { id: Buffer.from(device.id).toString("base64url"), name: device.name } });
        }
        if (id === "register" && method === "POST") {
          if (device.passkey && !sessions.valid(req.headers.get("x-hearth-unlock"), device.id)) throw new HttpError(423, "Unlock first.");
          const pk = verifyPasskeyRegistration(await body(req), device.id, pageOrigin);
          if (!pk) throw new HttpError(400, "That passkey didn't check out. Try again.");
          await store.put<Device>("devices", { ...device, passkey: pk });
          await hub.log("device.passkey", `${device.name} turned on Face ID lock`);
          return json({ ok: true, unlock: sessions.create(device.id) });
        }
        if (method === "DELETE") {
          if (config.requirePasskey) throw new HttpError(409, "This hub requires Face ID on every device.");
          const { passkey, ...rest } = device;
          await store.put<Device>("devices", rest as Device);
          await hub.log("device.passkey", `${device.name} turned off Face ID lock`);
          return json({ ok: true });
        }
        break;
      }
      case "unlock": {
        if (!pageOrigin) throw new HttpError(400, "Open the hub's own address to use Face ID.");
        if (!device.passkey) throw new HttpError(409, "No passkey on this device yet.");
        if (id === "options" && method === "POST") return json({ challenge: newChallenge(device.id), rpId: new URL(pageOrigin).hostname, credId: device.passkey.credId });
        if (id === "verify" && method === "POST") {
          if (!verifyPasskeyAssertion(await body(req), device, pageOrigin)) { badToken.allow(ip); throw new HttpError(401, "Face ID didn't match."); }
          return json({ unlock: sessions.create(device.id) });
        }
        break;
      }
      // New devices asking to join. Any of your signed-in devices can approve (computer keys never reach /api).
      // Approving takes a fresh Face ID check when the approving device has one.
      case "access": {
        if (method === "GET") return json(access.pending().map(({ token, ...r }) => r));
        const r = id ? access.find(id) : null;
        if (!r || r.status !== "pending") throw new HttpError(404, "That request expired.");
        if (seg[3] === "deny" && method === "POST") { r.status = "denied"; hub.emit("access", { pending: access.pending().length }); return json({ ok: true }); }
        if (seg[3] === "approve" && method === "POST") {
          const b = await body(req);
          if (device.passkey && !(pageOrigin && verifyPasskeyAssertion(b.passkey, device, pageOrigin))) throw new HttpError(401, "Confirm with Face ID to let a device in.");
          const added = await addDevice(store, r.name, r.kind === "computer" ? "computer" : "member");
          r.status = "approved"; r.token = added.token; r.deviceId = added.device.id;
          await recount();
          await hub.log("device.paired", `${r.name} joined (approved from ${device.name})`);
          hub.emit("access", { pending: access.pending().length });
          return json({ ok: true });
        }
        break;
      }
      // Cloud computers: an E2B sandbox (your API key) or your own VM (address + SSH key). Primary device only.
      case "machines": {
        ownerOnly();
        const view = () => ({ e2bKey: machines.hasE2bKey(), logins: computers.loginsHeld(), hubUrl: process.env.HEARTH_PUBLIC_URL || null, machines: machines.list().map((m) => machines.view(m)) });
        if (method === "GET" && !id) return json(view());
        if (id === "e2b-key" && method === "POST") { const bad = await machines.setE2bKey(String((await body(req)).key || "")); if (bad) throw new HttpError(400, bad); await hub.log("machines.e2b", "E2B key connected"); return json(view()); }
        if (id === "e2b-key" && method === "DELETE") { machines.forgetE2bKey(); return json(view()); }
        if (!id && method === "POST") {
          const b = await body(req);
          const r = b.kind === "e2b" ? await machines.addE2b(b) : b.kind === "ssh" ? await machines.addSsh(b) : { error: "Pick E2B or your own VM." };
          if ("error" in r && r.error) throw new HttpError(400, r.error);
          await hub.log("machines.add", `${b.kind === "e2b" ? "E2B sandbox" : "VM"} ${(r as any).value?.name} added`);
          return json(view());
        }
        const m = id ? machines.get(id) : null;
        if (!m) throw new HttpError(404, "No such cloud computer.");
        if (seg[3] === "start" && method === "POST") { void machines.start(m.id); return json({ ok: true }); }
        if (seg[3] === "stop" && method === "POST") { await machines.stop(m.id); return json(view()); }
        if (method === "DELETE") { await machines.remove(m.id); await hub.log("machines.remove", `${m.name} removed`); return json(view()); }
        break;
      }
      case "push": {
        if (!hub.push) throw new HttpError(503, "Push is not available on this hub.");
        if (id === "key") return json({ publicKey: hub.push.publicKey });
        if (id === "subscribe" && method === "POST") { const r = await hub.push.subscribe(device.id, await body(req)); if (r.error) throw new HttpError(400, r.error); return json({ ok: true }); }
        if (id === "subscribe" && method === "DELETE") { await hub.push.unsubscribeDevice(device.id); return json({ ok: true }); }
        if (id === "test" && method === "POST") return json({ sent: await hub.push.send({ title: config.name, body: "Notifications work. I'll only use them when it matters.", url: "/#today" }) });
        break;
      }
      case "activity": return json((await store.recent("activity", 200)).reverse());
      case "conn-audit": { ownerOnly(); return json(await hub.connAudit()); }
      case "export": {
        const data = await hub.exportAll();
        return new Response(JSON.stringify(data, null, 2), { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="hearth-export-${new Date().toISOString().slice(0, 10)}.json"`, "Cache-Control": "no-store" } });
      }
      case "wipe": {
        if (method === "POST" && (await body(req)).confirm === "delete my data") { await hub.wipePersonal(); return json({ ok: true }); }
        throw new HttpError(400, 'Send {"confirm":"delete my data"}.');
      }
    }
    throw new HttpError(404, "Not found.");
  }

  type LiveData = { kind: "voice"; rate: number; relay?: ReturnType<typeof deepgramLive> };
  type ComputerData = { kind: "computer"; deviceId: string; name: string; want: NonNullable<Device["copy"]>; cloud: boolean };
  const server = Bun.serve<LiveData | ComputerData, never>({
    hostname: config.host,
    port: config.port,
    idleTimeout: 60,
    websocket: {
      maxPayloadLength: 1024 * 1024,
      open(ws) {
        if (ws.data.kind === "computer") { computers.attach(ws.data.deviceId, ws.data.name, ws, ws.data.want, ws.data.cloud); return; }
        const key = voice?.deepgramKey();
        if (!key) { ws.close(1011, "voice off"); return; }
        ws.data.relay = deepgramLive(key, ws.data.rate, { send: (d) => ws.send(d), close: () => ws.close() });
      },
      message(ws, msg) {
        if (ws.data.kind === "computer") { computers.message(ws.data.deviceId, String(msg)); return; }
        if (typeof msg === "string") { if (msg === "stop") ws.data.relay?.stop(); return; }
        ws.data.relay?.audio(msg);
      },
      close(ws) {
        if (ws.data.kind === "computer") {
          const { deviceId } = ws.data;
          computers.detach(deviceId, ws);
          // Remember when it left, so "last seen" survives a hub restart.
          store.get<Device>("devices", deviceId).then((d) => d && store.put<Device>("devices", { ...d, lastSeenAt: new Date().toISOString() })).catch(() => {});
        }
        else ws.data.relay?.abort();
      },
    },
    async fetch(req, server) {
      const url = new URL(req.url);
      const origin = req.headers.get("origin");
      const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
      const sameOrigin = !origin || (() => { try { return new URL(origin).host === host; } catch { return false; } })();
      // Live dictation socket: one-time ticket from POST /api/voice/live, same origin (or an allowed one) only.
      if (url.pathname === "/voice-live") {
        const t = url.searchParams.get("ticket") || "";
        const exp = liveTickets.get(t);
        liveTickets.delete(t);
        const rate = Number(url.searchParams.get("rate"));
        if (!exp || exp < Date.now()) return new Response("Ticket expired", { status: 401 });
        if (origin && !sameOrigin && !config.allowedOrigins.includes(origin)) return new Response("Origin not allowed", { status: 403 });
        if (!(rate >= 8000 && rate <= 96000)) return new Response("Bad sample rate", { status: 400 });
        if (server.upgrade(req, { data: { kind: "voice", rate: Math.round(rate) } })) return undefined as unknown as Response;
        return new Response("Expected a WebSocket", { status: 426 });
      }
      // A linked computer dials in here and keeps the line open; work comes down it. Its key goes in a header.
      if (url.pathname === "/computer" || url.pathname === "/computer/bundle" || url.pathname === "/computer/share-key") {
        const ip = clientIp(req, server);
        if (badToken.blocked(ip)) return new Response("Too many wrong keys. Wait 10 minutes.", { status: 429 });
        const d = await deviceForToken(store, req.headers.get("authorization"));
        if (!d || d.role !== "computer") { badToken.allow(ip); return new Response("Not linked.", { status: 401 }); }
        // Your Mac made a Claude token for shared links (bun run join / share-key): keep it in the vault.
        if (url.pathname === "/computer/share-key") {
          if (req.method !== "POST" || !shares || d.machine) return new Response("No.", { status: 403 }); // only your own computers, not cloud ones
          let b: any;
          try { b = await req.json(); } catch { return new Response("Bad JSON.", { status: 400 }); }
          if (!/^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/.test(String(b?.token))) return new Response("That isn't a setup-token.", { status: 400 });
          const r = await shares.saveSettings({ key: String(b.token) });
          if (r.error) return new Response(r.error, { status: 400 });
          await hub.log("share", `${d.name} set up the Claude key for shared links`);
          return new Response("ok");
        }
        // A cloud computer being set up downloads Hearth from its own hub, so the two always run the same code.
        if (url.pathname === "/computer/bundle") {
          const root = resolve(import.meta.dir, "..");
          const tar = Bun.spawn(["tar", "-czf", "-", "-C", root, "src", "scripts", "patches", "package.json", "bun.lock", "tsconfig.json"], { stdout: "pipe", stderr: "ignore" });
          return new Response(tar.stdout, { headers: { "Content-Type": "application/gzip", "Cache-Control": "no-store" } });
        }
        await store.put<Device>("devices", { ...d, lastSeenAt: new Date().toISOString(), ip: ip !== "?" ? ip : d.ip });
        if (server.upgrade(req, { data: { kind: "computer", deviceId: d.id, name: d.name, want: d.copy || [], cloud: !!d.machine } })) return undefined as unknown as Response;
        return new Response("This is the computer link; connect with a WebSocket.", { status: 426 });
      }
      const headers = security(origin, sameOrigin);
      // A response that brings its own CSP or frame rules (sandboxed downloads, mini apps) keeps them.
      const finish = (res: Response) => { for (const [k, v] of Object.entries(headers)) if (!((k === "Content-Security-Policy" || k === "X-Frame-Options") && res.headers.has(k))) res.headers.set(k, v); return res; };

      // A shared teammate: /t/<link>/. The page is ours; /api/* is forwarded to that link's sealed box as JSON only.
      const share = url.pathname.match(/^\/t\/([A-Za-z0-9_-]{16,64})(\/.*)?$/);
      if (share && shares) return finish(await visitor(req, url, server, share[1], share[2] || ""));
      if (url.pathname.startsWith("/api/")) {
        if (req.method === "OPTIONS") return finish(new Response(null, { status: 204 }));
        if (!sameOrigin && !config.allowedOrigins.includes(origin!)) return finish(json({ error: "Origin not allowed." }, 403));
        try { return finish(await api(req, url, server)); }
        catch (err: any) {
          if (err instanceof HttpError) return finish(json({ error: err.message }, err.status));
          console.error(err);
          return finish(json({ error: "Something went wrong on the hub." }, 500));
        }
      }
      if (req.method !== "GET" && req.method !== "HEAD") return finish(new Response("Method not allowed", { status: 405 }));
      // A mini app, by short-lived ticket: sandboxed (opaque origin), no network, framable only by the app itself.
      if (url.pathname.startsWith("/app-frame/")) {
        // The hub's own address, so an app may show its emoji and map pictures (and nothing else).
        const hubOrigin = config.behindProxy && req.headers.get("x-forwarded-host") ? `${req.headers.get("x-forwarded-proto") || "https"}://${req.headers.get("x-forwarded-host")}` : `${url.protocol}//${host}`;
        const page = await hub.apps.page(url.pathname.slice("/app-frame/".length), { origin: hubOrigin, tileKey });
        if (!page) return finish(new Response("This app link expired. Close it and open the app again.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } }));
        return finish(new Response(page, { headers: {
          "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "SAMEORIGIN",
          "Content-Security-Policy": appCsp(["'self'", ...config.allowedOrigins].join(" "), hubOrigin),
        } }));
      }
      // Pictures from the web for apps and artifacts (hearth.image): fetched by the hub, images only, cached on disk.
      // Same key as tiles; public hosts only (no localhost or private networks), so it can't be pointed inward.
      if (url.pathname === "/img") {
        if (url.searchParams.get("k") !== tileKey) return finish(new Response("Not found", { status: 404 }));
        const r = await webImage(url.searchParams.get("u") || "", config.dataDir, imgLimiter);
        if (!r) return finish(new Response("Can't show that picture", { status: 404 }));
        return finish(new Response(Bun.file(r.file), { headers: { "Content-Type": r.type, "Cache-Control": "private, max-age=86400", "Content-Security-Policy": "sandbox; default-src 'none'" } }));
      }
      // The user's own photos, videos and audio for an app (hearth.file): only with the app's live ticket, only files named
      // in that app's data, only media types, and with byte ranges so videos can seek.
      const af = url.pathname.match(/^\/app-file\/([\w-]+)\/([\w-]+)$/);
      if (af) {
        const app = await hub.apps.ticketApp(af[1]);
        const f = app && JSON.stringify(app.data ?? null).includes(af[2]) ? await store.get<StoredFile>("files", af[2]) : null;
        const bytes = f && /^(image\/(png|jpeg|gif|webp|avif)|video\/|audio\/)/.test(f.mime) ? hub.files.bytes(f.id) : null;
        if (!f || !bytes) return finish(new Response("Not found", { status: 404 }));
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") || "");
        const base = { "Content-Type": f.mime, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=600", "Content-Security-Policy": "sandbox; default-src 'none'" };
        if (range) {
          const start = range[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range[2]));
          const end = range[1] && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
          if (start > end || start >= bytes.length) return finish(new Response(null, { status: 416, headers: { "Content-Range": `bytes */${bytes.length}` } }));
          return finish(new Response(bytes.subarray(start, end + 1), { status: 206, headers: { ...base, "Content-Range": `bytes ${start}-${end}/${bytes.length}`, "Content-Length": String(end - start + 1) } }));
        }
        return finish(new Response(bytes, { headers: { ...base, "Content-Length": String(bytes.length) } }));
      }
      // Map tiles (OpenStreetMap by default, HEARTH_MAP_TILES to change): fetched by the hub (the phone never talks to the map service), cached on disk.
      // Needs the hub's tile key (in /api/state for paired devices) so the hub isn't an open proxy.
      const tm = url.pathname.match(/^\/tiles\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})\.png$/);
      if (tm) {
        const [z, x, y] = tm.slice(1).map(Number);
        if (url.searchParams.get("k") !== tileKey || z > 18 || x >= 2 ** z || y >= 2 ** z) return finish(new Response("Not found", { status: 404 }));
        const file = join(config.dataDir, "tiles", String(z), String(x), `${y}.png`);
        if (!existsSync(file)) {
          if (!tileLimiter.allow("tiles")) return finish(new Response("Slow down", { status: 429 }));
          const src = (process.env.HEARTH_MAP_TILES || "https://tile.openstreetmap.org/{z}/{x}/{y}.png").replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
          const res = await fetch(src, { headers: { "User-Agent": `Hearth/${pkg.version} (self-hosted personal assistant; tiles cached)` }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
          if (!res?.ok) return finish(new Response("Map unavailable", { status: 502 }));
          mkdirSync(dirname(file), { recursive: true });
          await Bun.write(file, await res.arrayBuffer());
        }
        return finish(new Response(Bun.file(file), { headers: { "Content-Type": "image/png", "Cache-Control": "private, max-age=604800" } }));
      }
      // 3D emoji (Microsoft Fluent Emoji 3D, MIT, via @lobehub/fluent-emoji-3d) served from the package: no calls out.
      if (url.pathname.startsWith("/emoji/")) {
        const file = emojiFile(url.pathname.slice("/emoji/".length).replace(/\.webp$/, ""));
        if (!file) return finish(new Response("Not found", { status: 404 }));
        return finish(new Response(Bun.file(file), { headers: { "Content-Type": "image/webp", "Cache-Control": "public, max-age=31536000, immutable" } }));
      }
      const asset = web.assets.get(url.pathname) || (url.pathname.includes(".") ? null : web.assets.get("/"));
      if (!asset) return finish(new Response("Not found", { status: 404 }));
      const cache = url.pathname === "/sw.js" || asset.type.startsWith("text/html") ? "no-cache" : "public, max-age=300";
      return finish(new Response(asset.body as BodyInit, { headers: { "Content-Type": asset.type, "Cache-Control": cache } }));
    },
  });
  return { server, build: web.build, computers, machines };
}

const EMOJI_DIR = (() => { try { return join(resolve(import.meta.dir, ".."), "node_modules/@lobehub/fluent-emoji-3d/assets"); } catch { return ""; } })();
/** The 3D image for an emoji's codepoints ("1f3cb-fe0f"), trying it with and without the variation selector. */
function emojiFile(name: string) {
  if (!EMOJI_DIR || !/^[0-9a-f]{2,6}(-[0-9a-f]{2,6}){0,9}$/.test(name)) return null;
  const bare = name.split("-").filter((c) => c !== "fe0f");
  const tries = [name, bare.join("-"), [bare[0], "fe0f", ...bare.slice(1)].join("-"), bare.map((c, i) => (i === 0 || c === "200d" || bare[i - 1] !== "200d" ? c : `${c}-fe0f`)).join("-"), `${bare.join("-")}-fe0f`];
  for (const t of tries) { const f = join(EMOJI_DIR, `${t}.webp`); if (existsSync(f)) return f; }
  return null;
}

/** Fetch a web picture for an app, once: public hosts only, images only, 8 MB max, cached by URL. */
async function webImage(raw: string, dataDir: string, limiter: RateLimiter) {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || raw.length > 2000) return null;
  const dir = join(dataDir, "imgcache");
  const key = sha256(raw);
  const file = join(dir, key), meta = `${file}.type`;
  if (existsSync(file) && existsSync(meta)) return { file, type: readFileSync(meta, "utf8") };
  if (!limiter.allow("img")) return null;
  try {
    const res = await fetchPublic(u.toString(), "image/*", 10_000);
    if (!res) return null;
    const type = (res.headers.get("content-type") || "").split(";")[0].trim();
    if (!res.ok || !/^image\/(png|jpeg|gif|webp|avif)$/.test(type) || Number(res.headers.get("content-length") || 0) > 8e6) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > 8e6) return null;
    mkdirSync(dir, { recursive: true });
    await Bun.write(file, buf);
    await Bun.write(meta, type);
    return { file, type };
  } catch { return null; }
}
