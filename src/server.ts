import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, extname, dirname } from "node:path";
type Server = Bun.Server<unknown>;
import { sha256, deviceForToken, newPairingCode, redeemPairingCode, RateLimiter, addDevice, owners, isOwner, newChallenge, verifyPasskeyRegistration, verifyPasskeyAssertion, Sessions, AccessRequests } from "./auth.ts";
import QRCode from "qrcode";
import type { Hub } from "./hub.ts";
import { deepgramLive, type VoiceSettings } from "./voice.ts";
import { randomBytes } from "node:crypto";
import { availableHarnesses } from "./brain.ts";
import { Computers, COPY_ITEMS, isCopyItem } from "./computers.ts";
import { homedir } from "node:os";
import { MAX_FILE_BYTES } from "./files.ts";
import { appCsp } from "./apps.ts";
import { isActive, search } from "./memory.ts";
import { isValidTimeZone } from "./time.ts";
import type { Component, Person, StoredFile, Approval, Device, Fact, Hook, LocationFix, MiniApp, Message, Notebook, Place, Prefs, Skill, Teammate, Workflow } from "./types.ts";
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
    if (!TYPES[ext]) continue;
    let body: Buffer | string = readFileSync(join(WEB, f));
    if (ext === ".html") body = body.toString().replaceAll("{{BUILD}}", build);
    assets.set(f === "index.html" ? "/" : `/${f}`, { body, type: TYPES[ext], immutable: false });
  }
  return { build, assets };
}

class HttpError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export async function startServer(hub: Hub, voice: VoiceSettings | null = null) {
  const voiceLimiter = new RateLimiter(5, 10 * 60_000);
  const liveTickets = new Map<string, number>();
  const tileKey = randomBytes(12).toString("base64url");
  const tileLimiter = new RateLimiter(600, 60_000);
  const imgLimiter = new RateLimiter(120, 60_000);
  const { config, store } = hub;
  const web = await buildWeb();
  const pairLimiter = new RateLimiter(5, 10 * 60_000);
  const pairGlobal = new RateLimiter(30, 10 * 60_000);
  const ideaLimiter = new RateLimiter(2, 10 * 60_000);
  // Wrong device tokens: 20 in 10 minutes and that address is shut out of the API for the rest of the window.
  const badToken = new RateLimiter(20, 10 * 60_000);
  // Access requests notify your primary phone, so strangers can't spam it.
  const askLimiter = new RateLimiter(3, 10 * 60_000);
  const askGlobal = new RateLimiter(10, 10 * 60_000);
  const sessions = new Sessions(config.unlockHours * 3600_000);
  const access = new AccessRequests();
  // Computers linked to this hub (your Mac): brain calls run there when one is online, here (the cloud) when none is.
  const computers = new Computers({ dataDir: config.dataDir, homeDir: homedir(), acceptCopies: config.target === "lightsail" });
  const linkedComputers = async () => (await store.all<Device>("devices")).filter((d) => d.role === "computer");
  const recount = async () => { computers.known = (await linkedComputers()).length; };
  await recount();
  hub.brain.remote = computers;
  computers.onChange = () => hub.emit("computers", {});
  computers.onOnline = () => { hub.resumeForComputer().catch((e) => console.error(e)); };
  computers.start();
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

  const clientIp = (req: Request, server: Server) =>
    (config.behindProxy && req.headers.get("x-forwarded-for")?.split(",").pop()!.trim()) || server.requestIP(req)?.address || "?";

  const publicPrefs = (p: Prefs) => ({ userName: p.userName, tz: p.tz, quietStart: p.quietStart, quietEnd: p.quietEnd, maxProactivePerDay: p.maxProactivePerDay, proactiveToday: p.proactiveToday });

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
    // A new device asks to join. Your primary phone gets a notification with the same short code to compare.
    if (path === "/api/access/request" && method === "POST") {
      if (!askLimiter.allow(ip) || !askGlobal.allow("all")) throw new HttpError(429, "Too many requests. Wait 10 minutes.");
      if ((await store.all<Device>("devices")).length === 0) throw new HttpError(409, "This hub isn't set up yet. Use the setup code from the server.");
      const b = await body(req);
      const { poll, request } = access.create(b.deviceName, ip, b.kind);
      hub.emit("access", { pending: access.pending().length });
      await hub.push?.send({ title: request.kind === "computer" ? "A computer wants to link" : "New device wants in", body: `${request.name} · code ${request.code}. Open Hearth to approve or deny.`, tag: "access", url: "/#access" }, (await owners(store)).map((d) => d.id));
      return json({ poll, code: request.code, expiresInMin: 10 });
    }
    if (path === "/api/access/poll" && method === "POST") {
      const r = access.poll((await body(req)).poll);
      if (!r) throw new HttpError(404, "That request expired. Ask again.");
      return json({ status: r.status, token: r.token, deviceId: r.deviceId, hub: { name: config.name, build: web.build } });
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
    const device = await deviceForToken(store, req.headers.get("authorization"));
    if (!device) { if (!badToken.allow(ip)) throw banned(); throw new HttpError(401, "Not paired."); }
    // A linked computer's key opens its link and nothing else: it can't read chats or memory through the API.
    if (device.role === "computer") throw new HttpError(403, "This key only links a computer to the hub.");
    // Face ID lock: a device with a passkey (or every device, with HEARTH_REQUIRE_PASSKEY=1) needs a recent unlock.
    // A copied device token alone then gets nothing but this lock screen.
    if ((device.passkey || config.requirePasskey) && !sessions.valid(req.headers.get("x-hearth-unlock"), device.id)) {
      const lockOk = seg[1] === "unlock" || (seg[1] === "passkey" && !device.passkey);
      if (!lockOk) return json({ error: "Locked.", locked: true, hasPasskey: !!device.passkey }, 423);
    }
    const owner = await isOwner(store, device);
    const ownerOnly = () => { if (!owner) throw new HttpError(403, "Only your primary device can do that."); };
    if (Date.now() - new Date(device.lastSeenAt).getTime() > 5 * 60_000) await store.put<Device>("devices", { ...device, lastSeenAt: new Date().toISOString() });
    const id = seg[2];

    switch (seg[1]) {
      case "state": {
        const prefs = await hub.prefs();
        return json({
          hub: { name: config.name, version: pkg.version, build: web.build, brain: hub.brain.label, storage: store.kind },
          device: { id: device.id, name: device.name, primary: owner, passkey: !!device.passkey }, requirePasskey: config.requirePasskey,
          pendingAccess: owner ? access.pending().length : 0, prefs: publicPrefs(prefs), thinking: hub.thinking,
          push: { available: !!hub.push, subscribed: hub.push ? await hub.push.hasDevice(device.id) : false },
          pendingScripts: (await hub.scripts.list()).filter((s) => s.status === "proposed").length,
          voice: voice?.current?.name ?? null,
          computers: await computerSummary(),
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
        const hooks = (await hub.listHooks()).filter((h) => h.status === "active" && h.source !== "system");
        const upcoming = hooks.filter((h) => h.nextAt && (h.trigger.type === "at" || h.trigger.type === "schedule") && new Date(h.nextAt).getTime() - now < 36 * 3.6e6).sort((a, b) => a.nextAt!.localeCompare(b.nextAt!));
        const watching = hooks.filter((h) => ["every", "place", "silence"].includes(h.trigger.type));
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
        if (method === "GET" && id) { const d = await hub.threadDetail(id); if (!d) break; return json({ ...d, approvals: (await store.all<Approval>("approvals")).filter((a) => a.threadId === id) }); }
        if (method === "POST" && (!id || seg[3] === "messages")) {
          const b = await body(req);
          const fileIds = Array.isArray(b.fileIds) ? b.fileIds.map(String).slice(0, 5) : [];
          const r = await hub.ramble(String(b.text || ""), id || undefined, fileIds);
          if (r.error) throw new HttpError(400, r.error);
          return json(r.value);
        }
        if (method === "DELETE" && id) return json({ ok: await hub.removeThread(id) });
        if (method === "PATCH" && id) { const r = await hub.renameThread(id, String((await body(req)).channel || "")); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
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
      case "approvals": {
        if (method === "GET") return json((await store.all<Approval>("approvals")).filter((a) => !url.searchParams.get("thread") || a.threadId === url.searchParams.get("thread")));
        if (method === "POST" && (seg[3] === "approve" || seg[3] === "reject")) {
          const r = await hub.decideApproval(id, seg[3] === "approve");
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
      case "jobs": {
        if (method === "POST" && seg[3] === "reply") { const r = await hub.replyToJob(id, String((await body(req)).text || "")); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        if (method === "POST" && seg[3] === "retry") { const r = await hub.retryJob(id); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        if (method === "POST" && seg[3] === "save-skill") { const r = await hub.saveJobAsSkill(id); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        break;
      }
      case "brains": {
        if (method === "GET") return json({ current: await hub.brains(), available: availableHarnesses(config), hybrid: (await hub.prefs()).hybrid !== false });
        if (method === "PATCH") { const r = await hub.setBrains(await body(req)); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        break;
      }
      case "roster": return json(await hub.roster());
      case "board": return json(await hub.board(url.searchParams.get("teammate") || undefined));
      case "inbox": return json(await hub.inbox());
      case "teammates": {
        if (method === "GET" && id) { const d = await hub.teammateDetail(id); if (!d) break; return json(d); }
        if (method === "POST" && id && seg[3] === "messages") { const r = await hub.askTeammate(id, String((await body(req)).text || "")); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        if (method === "GET") return json(await store.all<Teammate>("teammates"));
        if (method === "POST") { const r = await hub.addTeammate(await body(req)); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        if (method === "PATCH" && id) { const r = await hub.updateTeammate(id, await body(req)); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        if (method === "DELETE" && id) return json({ ok: await hub.removeTeammate(id) });
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
      case "hooks": {
        if (method === "GET" && !id) return json(await hub.listHooks());
        if (method === "POST" && !id) { const r = await hub.addHook(await body(req), "you"); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        if (method === "POST" && seg[3] === "run") { const h = await store.get<Hook>("hooks", id); if (!h) break; hub.fire({ ...h, cooldownMin: 0 }, "You tapped Run now"); return json({ ok: true }); }
        if (method === "PATCH" && id) { const h = await hub.updateHook(id, await body(req)); if (!h) throw new HttpError(400, "Couldn't update that hook."); return json(h); }
        if (method === "DELETE" && id) { const h = await store.get<Hook>("hooks", id); if (h?.source === "system") throw new HttpError(400, "Pause system hooks instead."); return json({ ok: await hub.removeHook(id) }); }
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
        const T = /^([01]\d|2[0-3]):[0-5]\d$/;
        if (typeof b.userName === "string") patch.userName = b.userName.trim().slice(0, 40);
        if (typeof b.tz === "string" && isValidTimeZone(b.tz)) patch.tz = b.tz;
        if (T.test(b.quietStart)) patch.quietStart = b.quietStart;
        if (T.test(b.quietEnd)) patch.quietEnd = b.quietEnd;
        if (Number.isInteger(b.maxProactivePerDay) && b.maxProactivePerDay >= 0 && b.maxProactivePerDay <= 50) patch.maxProactivePerDay = b.maxProactivePerDay;
        return json(publicPrefs(await hub.setPrefs(patch)));
      }
      case "devices": {
        const primaries = (await owners(store)).map((d) => d.id);
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
        if (method === "POST" && id === "pair-code") {
          ownerOnly();
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
      // New devices asking to join. Approving takes a fresh Face ID check when the primary has one.
      case "access": {
        ownerOnly();
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
      case "push": {
        if (!hub.push) throw new HttpError(503, "Push is not available on this hub.");
        if (id === "key") return json({ publicKey: hub.push.publicKey });
        if (id === "subscribe" && method === "POST") { const r = await hub.push.subscribe(device.id, await body(req)); if (r.error) throw new HttpError(400, r.error); return json({ ok: true }); }
        if (id === "subscribe" && method === "DELETE") { await hub.push.unsubscribeDevice(device.id); return json({ ok: true }); }
        if (id === "test" && method === "POST") return json({ sent: await hub.push.send({ title: config.name, body: "Notifications work. I'll only use them when it matters.", url: "/#today" }) });
        break;
      }
      case "activity": return json((await store.recent("activity", 200)).reverse());
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
  type ComputerData = { kind: "computer"; deviceId: string; name: string; want: NonNullable<Device["copy"]> };
  const server = Bun.serve<LiveData | ComputerData, never>({
    hostname: config.host,
    port: config.port,
    idleTimeout: 60,
    websocket: {
      maxPayloadLength: 1024 * 1024,
      open(ws) {
        if (ws.data.kind === "computer") { computers.attach(ws.data.deviceId, ws.data.name, ws, ws.data.want); return; }
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
      if (url.pathname === "/computer") {
        const ip = clientIp(req, server);
        if (badToken.blocked(ip)) return new Response("Too many wrong keys. Wait 10 minutes.", { status: 429 });
        const d = await deviceForToken(store, req.headers.get("authorization"));
        if (!d || d.role !== "computer") { badToken.allow(ip); return new Response("Not linked.", { status: 401 }); }
        await store.put<Device>("devices", { ...d, lastSeenAt: new Date().toISOString() });
        if (server.upgrade(req, { data: { kind: "computer", deviceId: d.id, name: d.name, want: d.copy || [] } })) return undefined as unknown as Response;
        return new Response("This is the computer link; connect with a WebSocket.", { status: 426 });
      }
      const headers = security(origin, sameOrigin);
      // A response that brings its own CSP or frame rules (sandboxed downloads, mini apps) keeps them.
      const finish = (res: Response) => { for (const [k, v] of Object.entries(headers)) if (!((k === "Content-Security-Policy" || k === "X-Frame-Options") && res.headers.has(k))) res.headers.set(k, v); return res; };

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
  return { server, build: web.build, computers };
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

/** A public address only: not localhost, not a private, link-local or reserved network (checked after DNS too). */
function publicIp(ip: string) {
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return false;
  if (/^(::1?|f[cd]|fe[89ab]|::ffff:(127|10|192\.168|169\.254)\.)/i.test(ip)) return false;
  return true;
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
    // Follow up to 3 redirects by hand, checking every hop's address.
    let res: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      if (!/^https?:$/.test(u.protocol)) return null;
      const addrs = await (await import("node:dns/promises")).lookup(u.hostname, { all: true });
      if (!addrs.length || !addrs.every((a) => publicIp(a.address))) return null;
      res = await fetch(u, { redirect: "manual", headers: { "User-Agent": `Hearth/${pkg.version} (self-hosted personal assistant)`, Accept: "image/*" }, signal: AbortSignal.timeout(10_000) });
      const next = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!next) break;
      u = new URL(next, u);
      res = null;
    }
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
