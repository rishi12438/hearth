import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, extname } from "node:path";
type Server = Bun.Server<unknown>;
import { sha256, deviceForToken, newPairingCode, redeemPairingCode, RateLimiter } from "./auth.ts";
import type { Hub } from "./hub.ts";
import type { SpeechToText } from "./voice.ts";
import { availableHarnesses } from "./brain.ts";
import { MAX_FILE_BYTES } from "./files.ts";
import { isActive, search } from "./memory.ts";
import { isValidTimeZone } from "./time.ts";
import type { StoredFile, Approval, Device, Fact, Hook, LocationFix, Message, Notebook, Place, Prefs, Skill, Teammate, Workflow } from "./types.ts";
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

export async function startServer(hub: Hub, stt: SpeechToText | null = null) {
  const { config, store } = hub;
  const web = await buildWeb();
  const pairLimiter = new RateLimiter(5, 10 * 60_000);
  const pairGlobal = new RateLimiter(30, 10 * 60_000);
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
        "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:", "media-src 'self' blob:",
        `connect-src 'self' ${config.allowedOrigins.join(" ")}`.trim(), "manifest-src 'self'", "worker-src 'self'",
        "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'", "object-src 'none'",
      ].join("; "),
    };
    if (config.behindProxy) h["Strict-Transport-Security"] = "max-age=31536000";
    // Other hubs you own can call this one from the same app, but only if you list them.
    if (origin && !sameOrigin && config.allowedOrigins.includes(origin)) {
      h["Access-Control-Allow-Origin"] = origin;
      h["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
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
    (config.behindProxy && req.headers.get("x-forwarded-for")?.split(",")[0].trim()) || server.requestIP(req)?.address || "?";

  const publicPrefs = (p: Prefs) => ({ userName: p.userName, tz: p.tz, quietStart: p.quietStart, quietEnd: p.quietEnd, maxProactivePerDay: p.maxProactivePerDay, proactiveToday: p.proactiveToday });

  async function api(req: Request, url: URL, server: Server): Promise<Response> {
    const path = url.pathname;
    const method = req.method;
    const seg = path.split("/").filter(Boolean); // ["api", resource, id?, verb?]

    // ---- public ----
    if (path === "/api/health") return json({ name: config.name, version: pkg.version, build: web.build });
    if (path === "/api/pair" && method === "POST") {
      if (!pairLimiter.allow(clientIp(req, server)) || !pairGlobal.allow("all")) throw new HttpError(429, "Too many attempts. Wait 10 minutes.");
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
    if (!device) throw new HttpError(401, "Not paired.");
    if (Date.now() - new Date(device.lastSeenAt).getTime() > 5 * 60_000) await store.put<Device>("devices", { ...device, lastSeenAt: new Date().toISOString() });
    const id = seg[2];

    switch (seg[1]) {
      case "state": {
        const prefs = await hub.prefs();
        return json({
          hub: { name: config.name, version: pkg.version, build: web.build, brain: hub.brain.label, storage: store.kind },
          device: { id: device.id, name: device.name }, prefs: publicPrefs(prefs), thinking: hub.thinking,
          push: { available: !!hub.push, subscribed: hub.push ? await hub.push.hasDevice(device.id) : false },
          pendingScripts: (await hub.scripts.list()).filter((s) => s.status === "proposed").length,
          voice: stt ? stt.name : null,
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
          const inlineOk = url.searchParams.get("inline") === "1" && /^(image\/(png|jpeg|gif|webp|heic)|application\/pdf|text\/(plain|markdown|csv|calendar)|application\/json|audio\/|video\/)/.test(f.mime);
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
          const [skills, workflows] = await Promise.all([store.all<Skill>("skills"), store.all<Workflow>("workflows")]);
          return json({ skills, workflows, search: hub.library.mode });
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
      case "jobs": {
        if (method === "POST" && seg[3] === "reply") { const r = await hub.replyToJob(id, String((await body(req)).text || "")); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        if (method === "POST" && seg[3] === "retry") { const r = await hub.retryJob(id); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        if (method === "POST" && seg[3] === "save-skill") { const r = await hub.saveJobAsSkill(id); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        break;
      }
      case "brains": {
        if (method === "GET") return json({ current: await hub.brains(), available: availableHarnesses(config) });
        if (method === "PATCH") { const r = await hub.setBrains(await body(req)); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        break;
      }
      case "roster": return json(await hub.roster());
      case "inbox": return json(await hub.inbox());
      case "teammates": {
        if (method === "GET" && id) { const d = await hub.teammateDetail(id); if (!d) break; return json(d); }
        if (method === "POST" && id && seg[3] === "messages") { const r = await hub.askTeammate(id, String((await body(req)).text || "")); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        if (method === "GET") return json(await store.all<Teammate>("teammates"));
        if (method === "POST") { const r = await hub.addTeammate(await body(req)); if (r.error) throw new HttpError(400, r.error); return json(r.value); }
        if (method === "DELETE" && id) return json({ ok: await hub.removeTeammate(id) });
        break;
      }
      case "transcribe": {
        if (method !== "POST") break;
        if (!stt) throw new HttpError(503, "Voice isn't set up on this hub. Add HEARTH_DEEPGRAM_API_KEY to its .env.");
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
        if (method === "GET") return json((await store.all<Device>("devices")).map(({ tokenHash, ...d }) => ({ ...d, current: d.id === device.id })));
        if (method === "POST" && id === "pair-code") return json(await newPairingCode(store));
        if (method === "DELETE" && id) {
          const ok = await store.remove("devices", id);
          await hub.push?.unsubscribeDevice(id);
          for (const c of streams.get(id) || []) { try { c.close(); } catch {} }
          streams.delete(id);
          await hub.log("device.revoked", `A device was signed out`);
          return json({ ok });
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

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: 60,
    async fetch(req, server) {
      const url = new URL(req.url);
      const origin = req.headers.get("origin");
      const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
      const sameOrigin = !origin || (() => { try { return new URL(origin).host === host; } catch { return false; } })();
      const headers = security(origin, sameOrigin);
      // A response that brings its own CSP (file downloads: sandboxed) keeps it.
      const finish = (res: Response) => { for (const [k, v] of Object.entries(headers)) if (!(k === "Content-Security-Policy" && res.headers.has(k))) res.headers.set(k, v); return res; };

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
      const asset = web.assets.get(url.pathname) || (url.pathname.includes(".") ? null : web.assets.get("/"));
      if (!asset) return finish(new Response("Not found", { status: 404 }));
      const cache = url.pathname === "/sw.js" || asset.type.startsWith("text/html") ? "no-cache" : "public, max-age=300";
      return finish(new Response(asset.body as BodyInit, { headers: { "Content-Type": asset.type, "Cache-Control": cache } }));
    },
  });
  return { server, build: web.build };
}
