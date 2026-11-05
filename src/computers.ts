import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256 } from "./auth.ts";
import { lastRefresh } from "./brains/logins.ts";
import { cleanToolStatus, type ToolStatus } from "./brains/tools.ts";
import { MAX_FRAME_BYTES } from "./brains/live-view.ts";
import { ComputerGone, MODEL_RE, type BrainInput, type BrainProfile, type Meter, type Remote, type RemoteRunner } from "./brain.ts";

// Computers linked to this hub (a Mac at home, say). The hub has a public address and the computer doesn't, so the
// computer dials in over a WebSocket and keeps the line open; the hub sends work down it. Like Enkidu's Mac and cloud
// boxes, but the hub in the middle is your own server, not a third party.
//
// computer -> hub   hello {harnesses, platform}   tools {tools}   alive   pong {ts}   step {id, text}   done {id, reply, costUsd?}
//                   error {id, message}   copy {item, data, hash}
// hub -> computer   ping {ts}   run {id, input, profile}   stop {id}   want {items, have}   wantCookies {sites, have}
// computer -> hub   cookies {site, data, hash}   (browser cookies the owner asked this Mac to copy up)
//                   noCookies {site, why}   (asked for a site fresh — wantCookies {fresh} — and its Chrome has no login)
//                   logins {items}   (only to computers the hub set up itself, never to your Mac)
// hub -> Mac        browse {id, sid, action, params}   (a job's hearth-browser command, after you approved it; other-browser.ts)
// Mac -> hub        browsed {id, ok, out?, png?}       (enkidu-browser's answer there; a screenshot comes back as base64)

/** What a computer can copy up so the cloud can work while it's off. Each is a login file the harness reads. */
export const COPY_ITEMS = {
  claude: { label: "Claude login", path: ".claude/.credentials.json" },
  codex: { label: "Codex login", path: ".codex/auth.json" },
} as const;
export type CopyItem = keyof typeof COPY_ITEMS;
export const isCopyItem = (x: unknown): x is CopyItem => typeof x === "string" && Object.hasOwn(COPY_ITEMS, x);

export const ALIVE_EVERY_MS = 10_000;
/** No alive for this long: asleep (shown amber). Twice that: gone, and the line is dropped. */
const ASLEEP_MS = 15_000;
const GONE_MS = 30_000;
const MAX_COPY = 64 * 1024;

type Socket = { send(data: string): unknown; close(code?: number, reason?: string): unknown };
type Pending = { resolve: (s: string) => void; reject: (e: Error) => void; meter?: Meter };
/** What the Mac's browser said to one hearth-browser command. */
export type Browsed = { text: string } | { png: Uint8Array; mime?: "image/png" | "image/jpeg" };
/** A screenshot fits in one message on the line (the hub takes up to 1 MB): the Mac shrinks bigger ones. */
export const MAX_SHOT = 700_000;
type Link = {
  deviceId: string; name: string; ws: Socket; harnesses: string[]; platform: string; tools: ToolStatus[];
  connectedAt: number; lastAlive: number; rttMs: number | null; running: Map<string, Pending>; want: CopyItem[];
  /** hearth-browser commands waiting for this Mac's answer. */
  browsing: Map<string, { done: (r: Browsed | Error) => void }>;
  /** The hub set this computer up (a sandbox or your VM), so it gets the hub's logins. */
  cloud: boolean;
  /** Opens the agent's Google commands for jobs this computer runs; made fresh for each connection, dead when it closes. */
  agentKey: string;
};
export type ComputerStatus = {
  deviceId: string; name: string; state: "online" | "asleep" | "offline"; level: 0 | 1 | 2 | 3 | 4;
  rttMs: number | null; harnesses: string[]; platform: string; tools: ToolStatus[]; running: number; connectedAt: string | null; lastAliveAt: string | null;
};
type Copied = Record<string, { hash: string; at: string; from: string }>;
/** What asking your Mac for a site's login came to (see freshLogin). */
export type FreshLogin = { state: "fresh" | "missing" | "offline" | "timeout"; why?: "signed-out" | "same" | "unreadable"; from?: string };

/** Signal bars from round-trip time, like a phone's: 4 is a good line, 1 is barely there. */
export function levelFor(state: ComputerStatus["state"], rttMs: number | null): ComputerStatus["level"] {
  if (state === "offline") return 0;
  if (state === "asleep" || rttMs === null) return 1;
  return rttMs < 100 ? 4 : rttMs < 250 ? 3 : rttMs < 600 ? 2 : 1;
}

export class Computers implements Remote {
  private links = new Map<string, Link>();
  /** Last time each computer was seen, so an offline one can still say "seen 2 h ago". */
  private seen = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** How many computers are linked to this hub (online or not); the server keeps it current. */
  known = 0;
  onChange: () => void = () => {};
  /** A computer came online: resume jobs that were waiting for one. */
  onOnline: (deviceId: string) => void = () => {};

  /** Tell the app only when something it shows changed (state, bars, jobs running), not on every ping. */
  private shown = "";
  private changed() {
    const sig = JSON.stringify([...this.links.keys()].sort().map((id) => { const x = this.status(id, ""); return [id, x.state, x.level, x.running, x.harnesses, x.tools]; }));
    if (sig !== this.shown) { this.shown = sig; this.onChange(); }
  }

  /** readLogin reads a login's secret (only when handing it to a cloud computer); hasLogin just checks it's there. */
  constructor(private opts: { dataDir: string; homeDir: string; acceptCopies: boolean; now?: () => number; readLogin?: (item: CopyItem) => string | null; hasLogin?: (item: CopyItem) => boolean;
    /** Which browser logins (cookie sites) the hub wants Macs to copy up, the hash it already has, and where they go. */
    cookieSites?: () => string[]; cookieHave?: (site: string) => string | undefined; onCookies?: (site: string, data: string) => void;
    /** Which of the hub's agent skills a computer's jobs get (Google while it's connected). */
    agentSkills?: () => { google: boolean } }) {}
  private now() { return this.opts.now ? this.opts.now() : Date.now(); }

  start() { this.timer ??= setInterval(() => this.tick(), 5000); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; for (const id of [...this.links.keys()]) this.drop(id, "hub stopping"); }

  /** A computer's socket opened. A second connection from the same computer replaces the first. */
  attach(deviceId: string, name: string, ws: Socket, want: CopyItem[] = [], cloud = false) {
    if (this.links.has(deviceId)) this.drop(deviceId, "replaced by a new connection");
    const t = this.now();
    this.links.set(deviceId, { deviceId, name, ws, harnesses: [], platform: "", tools: [], connectedAt: t, lastAlive: t, rttMs: null, running: new Map(), browsing: new Map(), want, cloud, agentKey: randomBytes(24).toString("hex") });
    this.seen.set(deviceId, t);
    this.send(deviceId, { t: "ping", ts: t });
  }

  message(deviceId: string, raw: string) {
    const link = this.links.get(deviceId);
    if (!link) return;
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    link.lastAlive = this.now();
    this.seen.set(deviceId, link.lastAlive);
    switch (m?.t) {
      case "hello":
        link.harnesses = Array.isArray(m.harnesses) ? m.harnesses.filter((h: unknown) => typeof h === "string").slice(0, 8) : [];
        link.platform = String(m.platform || "").slice(0, 20);
        this.sendWant(link);
        this.sendCookieWant(link);
        this.sendSkills(link);
        if (link.cloud) this.sendLogins(link);
        this.changed();
        this.onOnline(deviceId);
        return;
      case "tools":
        link.tools = cleanToolStatus(m.tools);
        this.changed();
        return;
      case "alive": return;
      case "pong":
        if (typeof m.ts === "number") { link.rttMs = Math.max(0, this.now() - m.ts); this.changed(); }
        return;
      case "step": link.running.get(m.id)?.meter?.onProgress?.(String(m.text || "").slice(0, 120)); return;
      case "act": link.running.get(m.id)?.meter?.onAction?.(String(m.text || "").slice(0, 300)); return;
      case "frame": {
        const meter = link.running.get(m.id)?.meter;
        if (!meter?.onFrame || typeof m.data !== "string" || m.data.length > MAX_FRAME_BYTES * 1.4) return;
        meter.onFrame({ data: new Uint8Array(Buffer.from(m.data, "base64")), mime: m.mime === "image/jpeg" ? "image/jpeg" : "image/png" });
        return;
      }
      case "done": case "error": {
        const p = link.running.get(m.id);
        if (!p) return;
        link.running.delete(m.id);
        if (p.meter) { if (typeof m.costUsd === "number" && m.costUsd >= 0) p.meter.costUsd += m.costUsd; else p.meter.unknown = true; }
        if (m.t === "done") p.resolve(String(m.reply ?? "")); else p.reject(new Error(String(m.message || "The computer couldn't run it.").slice(0, 300)));
        this.changed();
        return;
      }
      case "browsed": {
        const w = typeof m.id === "string" ? link.browsing.get(m.id) : undefined;
        if (!w) return;
        link.browsing.delete(m.id);
        if (m.ok && typeof m.png === "string" && m.png.length <= MAX_SHOT * 1.4) w.done({ png: new Uint8Array(Buffer.from(m.png, "base64")), mime: m.mime === "image/jpeg" ? "image/jpeg" : "image/png" });
        else if (m.ok) w.done({ text: String(m.out ?? "").slice(0, 60_000) });
        else w.done(new Error(String(m.out || "The Mac's browser couldn't do it.").slice(0, 600)));
        return;
      }
      case "copy": this.receiveCopy(link, m); return;
      case "cookies": this.receiveCookies(link, m); return;
      case "noCookies": this.receiveNoCookies(link, m); return;
    }
  }

  /** The socket closed (or went quiet). Calls in flight fail over to the cloud. A replaced socket closing changes nothing. */
  detach(deviceId: string, ws?: Socket) {
    const link = this.links.get(deviceId);
    if (!link || (ws && link.ws !== ws)) return;
    this.links.delete(deviceId);
    for (const p of link.running.values()) p.reject(new ComputerGone(`${link.name} went offline.`));
    for (const b of link.browsing.values()) b.done(new Error(`${link.name} went offline.`));
    this.changed();
  }

  /** Close a computer's line on purpose (signed out, gone quiet). */
  drop(deviceId: string, reason: string, code = 4000) {
    const link = this.links.get(deviceId);
    if (!link) return;
    try { link.ws.close(code, reason); } catch {}
    this.detach(deviceId);
  }

  tick() {
    const t = this.now();
    for (const link of [...this.links.values()]) {
      if (t - link.lastAlive > GONE_MS) { this.drop(link.deviceId, "went quiet"); continue; }
      this.send(link.deviceId, { t: "ping", ts: t });
    }
    this.changed();
  }

  // ---- Remote, for Brain ----

  linked() { return this.links.size > 0 || this.known > 0; }

  /** The least busy online computer that has this harness. */
  pick(p: BrainProfile): RemoteRunner | null {
    const t = this.now();
    const ok = [...this.links.values()].filter((l) => t - l.lastAlive <= ASLEEP_MS && l.harnesses.includes(p.harness));
    const link = ok.sort((a, b) => a.running.size - b.running.size)[0];
    return link ? { name: link.name, run: (b, prof, meter) => this.run(link.deviceId, b, prof, meter) } : null;
  }

  private run(deviceId: string, input: BrainInput, profile: BrainProfile, meter?: Meter) {
    const link = this.links.get(deviceId);
    if (!link) return Promise.reject(new ComputerGone("The computer went offline."));
    const id = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const stop = () => this.send(deviceId, { t: "stop", id });
      meter?.signal?.addEventListener("abort", stop, { once: true });
      const done = (f: () => void) => { meter?.signal?.removeEventListener("abort", stop); f(); };
      link.running.set(id, { resolve: (s) => done(() => resolve(s)), reject: (e) => done(() => reject(e)), meter });
      this.send(deviceId, { t: "run", id, input, profile: { harness: profile.harness, model: MODEL_RE.test(profile.model) ? profile.model : "" } });
      this.changed();
    });
  }

  // ---- your Mac's browser, for hearth-browser (other-browser.ts) ----

  /** Your own Mac that's online now (never a cloud box: they have no browser of yours). */
  private macLink() {
    const t = this.now();
    return [...this.links.values()].find((l) => !l.cloud && t - l.lastAlive <= ASLEEP_MS && l.platform === "darwin") ?? null;
  }
  macName() { return this.macLink()?.name ?? null; }

  /** One command in the Mac's browser, in its session sid. An older Mac app doesn't answer, so this gives up after ms. */
  browse(sid: string, action: string, params: Record<string, unknown>, ms = 150_000): Promise<Browsed> {
    const link = this.macLink();
    if (!link) return Promise.reject(new Error("The Mac went offline."));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { link.browsing.delete(id); reject(new Error(`${link.name} didn't answer. If this keeps happening, its Hearth app may be too old for this: update it.`)); }, ms);
      (timer as any).unref?.();
      link.browsing.set(id, { done: (r) => { clearTimeout(timer); if (r instanceof Error) reject(r); else resolve(r); } });
      this.send(link.deviceId, { t: "browse", id, sid, action, params });
    });
  }

  // ---- what the app shows ----

  /** lastSeenAt: the device's stored last visit, for a computer that hasn't dialled in since this hub started. */
  status(deviceId: string, name: string, lastSeenAt?: string): ComputerStatus {
    const link = this.links.get(deviceId);
    const t = this.now();
    const last = this.seen.get(deviceId) ?? (lastSeenAt ? Date.parse(lastSeenAt) : null);
    const state = !link ? "offline" : t - link.lastAlive > ASLEEP_MS ? "asleep" : "online";
    return {
      deviceId, name: link?.name || name, state, level: levelFor(state, link?.rttMs ?? null), rttMs: link?.rttMs ?? null,
      harnesses: link?.harnesses || [], platform: link?.platform || "", tools: link?.tools || [], running: link?.running.size || 0,
      connectedAt: link ? new Date(link.connectedAt).toISOString() : null, lastAliveAt: last ? new Date(last).toISOString() : null,
    };
  }
  online() { return [...this.links.keys()].filter((id) => this.status(id, "").state === "online"); }
  isOnline(deviceId: string) { return this.links.has(deviceId); }

  // ---- copying logins up to the cloud ----

  /** The owner changed what this computer copies. Turning an item off removes the cloud's copy (if it's still ours). */
  setWant(deviceId: string, items: CopyItem[]) {
    const link = this.links.get(deviceId);
    const was = link?.want || [];
    for (const item of was.filter((i) => !items.includes(i))) this.removeCopy(item, deviceId);
    if (link) { link.want = items; this.sendWant(link); }
  }

  copied(): Copied {
    try { return JSON.parse(readFileSync(join(this.opts.dataDir, "copied.json"), "utf8")); } catch { return {}; }
  }
  private saveCopied(c: Copied) {
    writeFileSync(join(this.opts.dataDir, "copied.json"), JSON.stringify(c, null, 2), { mode: 0o600 });
  }

  private sendWant(link: Link) {
    const c = this.copied();
    const have: Record<string, string> = {};
    for (const i of link.want) if (c[i]?.from === link.deviceId) have[i] = c[i].hash;
    this.send(link.deviceId, { t: "want", items: this.opts.acceptCopies ? link.want : [], have });
  }

  /** Tell a computer which of the hub's agent skills its jobs get, and the key they use. Again whenever that changes. */
  private sendSkills(link: Link) {
    this.send(link.deviceId, { t: "skills", key: link.agentKey, ...(this.opts.agentSkills?.() || { google: false }) });
  }
  skillsChanged() { for (const link of this.links.values()) this.sendSkills(link); }

  /** The name of the connected computer this agent key belongs to, or null. */
  agentKeyOwner(key: string | null): string | null {
    const k = Buffer.from(String(key || ""));
    for (const link of this.links.values()) {
      const b = Buffer.from(link.agentKey);
      if (k.length === b.length && timingSafeEqual(k, b)) return link.name;
    }
    return null;
  }

  /** Tell a Mac which browser logins to copy up, and the hash the hub already holds (so it only re-sends on change). */
  private sendCookieWant(link: Link) {
    if (link.cloud) return; // cloud boxes have no browser; only your own Mac copies cookies up
    const sites = this.opts.acceptCopies ? (this.opts.cookieSites?.() || []) : [];
    const have: Record<string, string> = {};
    for (const site of sites) { const h = this.opts.cookieHave?.(site); if (h) have[site] = h; }
    this.send(link.deviceId, { t: "wantCookies", sites, have });
  }

  /** Ask every online Mac to copy these logins up now (a fresh "want", so a changed login is re-sent). Returns how many it asked. */
  refreshCookies(site?: string) {
    let asked = 0;
    for (const link of this.links.values()) {
      if (link.cloud) continue;
      const sites = this.opts.acceptCopies ? (this.opts.cookieSites?.() || []) : [];
      const have: Record<string, string> = {};
      // Drop the hash for the site we want fresh, so the Mac re-reads and re-sends even if it thinks it's unchanged.
      for (const s of sites) { if (s === site) continue; const h = this.opts.cookieHave?.(s); if (h) have[s] = h; }
      this.send(link.deviceId, { t: "wantCookies", sites, have, ...(site && sites.includes(site) ? { fresh: site } : {}) });
      asked++;
    }
    return asked;
  }

  /** Who's waiting on a fresh login per site, and how many Macs still owe an answer. */
  private waiting = new Map<string, { left: number; done: (r: FreshLogin) => void }[]>();

  /**
   * Ask your Mac(s) for a site's login and wait for the answer: "fresh" (a new login came up), "missing" (its Chrome isn't
   * signed in either, or has the same dead login), "offline" (no Mac online to ask) or "timeout" (an older Mac app that
   * doesn't answer when it has nothing). The site must already be one the Macs are asked for (Connections.wantFromMac).
   */
  freshLogin(site: string, ms = 25_000): Promise<FreshLogin> {
    if (!this.canCopyCookies()) return Promise.resolve({ state: "offline" });
    const asked = this.refreshCookies(site);
    if (!asked) return Promise.resolve({ state: "offline" });
    return new Promise((resolve) => {
      const list = this.waiting.get(site) || [];
      const w = { left: asked, done: (r: FreshLogin) => { clearTimeout(timer); this.waiting.set(site, (this.waiting.get(site) || []).filter((x) => x !== w)); resolve(r); } };
      const timer = setTimeout(() => w.done({ state: "timeout" }), ms);
      (timer as any).unref?.();
      list.push(w);
      this.waiting.set(site, list);
    });
  }
  /** One Mac answered for a site: a fresh login settles everyone waiting; "missing" only once every Mac asked said so. */
  private answer(site: string, r: FreshLogin) {
    for (const w of [...(this.waiting.get(site) || [])]) {
      if (r.state === "fresh") w.done(r);
      else if (--w.left <= 0) w.done(r);
    }
  }

  /** A Mac can copy cookies up, and it's online. */
  canCopyCookies() { return this.online().some((id) => { const l = this.links.get(id); return l && !l.cloud; }); }

  private receiveCookies(link: Link, m: any) {
    if (!this.opts.acceptCopies || link.cloud) return;
    const site: unknown = m.site;
    if (typeof site !== "string" || !(this.opts.cookieSites?.() || []).includes(site)) return;
    const data = typeof m.data === "string" ? m.data : "";
    if (!data || data.length > MAX_COPY) return;
    try { const j = JSON.parse(data); if (!Array.isArray(j.cookies)) return; } catch { return; }
    const hash = sha256(data), before = this.opts.cookieHave?.(site);
    this.opts.onCookies?.(site, data);
    // Kept only if it had the cookies the site needs. The same login the hub already had is the one that just died.
    const kept = this.opts.cookieHave ? this.opts.cookieHave(site) === hash : true;
    this.answer(site, !kept ? { state: "missing", why: "signed-out" } : before === hash ? { state: "missing", why: "same" } : { state: "fresh", from: link.name });
  }

  /** A Mac had nothing for a site it was asked for fresh (its Chrome isn't signed in, or can't be read). */
  private receiveNoCookies(link: Link, m: any) {
    if (link.cloud || typeof m.site !== "string") return;
    this.answer(m.site, { state: "missing", why: m.why === "unreadable" ? "unreadable" : "signed-out", from: link.name });
  }

  private receiveCopy(link: Link, m: any) {
    // Only what the owner asked this computer for, only on a server hub, small and well-formed.
    const item: unknown = m.item;
    if (!this.opts.acceptCopies || !isCopyItem(item) || !link.want.includes(item)) return;
    const data = typeof m.data === "string" ? m.data : "";
    if (!data || data.length > MAX_COPY) return;
    try { JSON.parse(data); } catch { return; }
    const path = join(this.opts.homeDir, COPY_ITEMS[item].path);
    // Codex renews its own login and rotates the refresh token: never replace a newer one with an older copy.
    if (item === "codex" && existsSync(path)) { try { if (lastRefresh(readFileSync(path, "utf8")) > lastRefresh(data)) return; } catch {} }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, data, { mode: 0o600 });
    chmodSync(path, 0o600);
    const c = this.copied();
    c[item] = { hash: sha256(data), at: new Date(this.now()).toISOString(), from: link.deviceId };
    this.saveCopied(c);
    // A fresher login just came up from your Mac: pass it on to the cloud computers.
    for (const l of this.links.values()) if (l.cloud) this.sendLogins(l);
    this.onChange();
  }

  /** Hand a computer the hub set up the logins this hub holds, so its brains work without you logging in there. */
  private sendLogins(link: Link) {
    const items: Record<string, string> = {};
    for (const item of Object.keys(COPY_ITEMS) as CopyItem[]) {
      const data = this.opts.readLogin?.(item);
      if (data && data.length <= MAX_COPY) items[item] = data;
    }
    if (Object.keys(items).length) this.send(link.deviceId, { t: "logins", items });
  }
  /** Which logins a cloud computer would get from this hub. */
  loginsHeld() { return (Object.keys(COPY_ITEMS) as CopyItem[]).filter((i) => (this.opts.hasLogin ? this.opts.hasLogin(i) : !!this.opts.readLogin?.(i))); }

  /** Delete the cloud's copy, but only if it's the one we wrote: never a login someone set up by hand. */
  removeCopy(item: CopyItem, fromDeviceId?: string) {
    const c = this.copied();
    const rec = c[item];
    if (!rec || (fromDeviceId && rec.from !== fromDeviceId)) return;
    const path = join(this.opts.homeDir, COPY_ITEMS[item].path);
    try { if (existsSync(path) && sha256(readFileSync(path, "utf8")) === rec.hash) rmSync(path); } catch {}
    delete c[item];
    this.saveCopied(c);
    this.onChange();
  }

  private send(deviceId: string, m: unknown) {
    try { this.links.get(deviceId)?.ws.send(JSON.stringify(m)); } catch {}
  }
}
