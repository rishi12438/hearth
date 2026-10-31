import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256 } from "./auth.ts";
import { ComputerGone, MODEL_RE, type BrainInput, type BrainProfile, type Meter, type Remote, type RemoteRunner } from "./brain.ts";

// Computers linked to this hub (a Mac at home, say). The hub has a public address and the computer doesn't, so the
// computer dials in over a WebSocket and keeps the line open; the hub sends work down it. Like Enkidu's Mac and cloud
// boxes, but the hub in the middle is your own server, not a third party.
//
// computer -> hub   hello {harnesses, platform}   alive   pong {ts}   step {id, text}   done {id, reply, costUsd?}
//                   error {id, message}   copy {item, data, hash}
// hub -> computer   ping {ts}   run {id, input, profile}   stop {id}   want {items, have}

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
type Link = {
  deviceId: string; name: string; ws: Socket; harnesses: string[]; platform: string;
  connectedAt: number; lastAlive: number; rttMs: number | null; running: Map<string, Pending>; want: CopyItem[];
};
export type ComputerStatus = {
  deviceId: string; name: string; state: "online" | "asleep" | "offline"; level: 0 | 1 | 2 | 3 | 4;
  rttMs: number | null; harnesses: string[]; platform: string; running: number; connectedAt: string | null; lastAliveAt: string | null;
};
type Copied = Record<string, { hash: string; at: string; from: string }>;

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
    const sig = JSON.stringify([...this.links.keys()].sort().map((id) => { const x = this.status(id, ""); return [id, x.state, x.level, x.running, x.harnesses]; }));
    if (sig !== this.shown) { this.shown = sig; this.onChange(); }
  }

  constructor(private opts: { dataDir: string; homeDir: string; acceptCopies: boolean; now?: () => number }) {}
  private now() { return this.opts.now ? this.opts.now() : Date.now(); }

  start() { this.timer ??= setInterval(() => this.tick(), 5000); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; for (const id of [...this.links.keys()]) this.drop(id, "hub stopping"); }

  /** A computer's socket opened. A second connection from the same computer replaces the first. */
  attach(deviceId: string, name: string, ws: Socket, want: CopyItem[] = []) {
    if (this.links.has(deviceId)) this.drop(deviceId, "replaced by a new connection");
    const t = this.now();
    this.links.set(deviceId, { deviceId, name, ws, harnesses: [], platform: "", connectedAt: t, lastAlive: t, rttMs: null, running: new Map(), want });
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
        this.changed();
        this.onOnline(deviceId);
        return;
      case "alive": return;
      case "pong":
        if (typeof m.ts === "number") { link.rttMs = Math.max(0, this.now() - m.ts); this.changed(); }
        return;
      case "step": link.running.get(m.id)?.meter?.onProgress?.(String(m.text || "").slice(0, 120)); return;
      case "done": case "error": {
        const p = link.running.get(m.id);
        if (!p) return;
        link.running.delete(m.id);
        if (p.meter) { if (typeof m.costUsd === "number" && m.costUsd >= 0) p.meter.costUsd += m.costUsd; else p.meter.unknown = true; }
        if (m.t === "done") p.resolve(String(m.reply ?? "")); else p.reject(new Error(String(m.message || "The computer couldn't run it.").slice(0, 300)));
        this.changed();
        return;
      }
      case "copy": this.receiveCopy(link, m); return;
    }
  }

  /** The socket closed (or went quiet). Calls in flight fail over to the cloud. A replaced socket closing changes nothing. */
  detach(deviceId: string, ws?: Socket) {
    const link = this.links.get(deviceId);
    if (!link || (ws && link.ws !== ws)) return;
    this.links.delete(deviceId);
    for (const p of link.running.values()) p.reject(new ComputerGone(`${link.name} went offline.`));
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

  // ---- what the app shows ----

  /** lastSeenAt: the device's stored last visit, for a computer that hasn't dialled in since this hub started. */
  status(deviceId: string, name: string, lastSeenAt?: string): ComputerStatus {
    const link = this.links.get(deviceId);
    const t = this.now();
    const last = this.seen.get(deviceId) ?? (lastSeenAt ? Date.parse(lastSeenAt) : null);
    const state = !link ? "offline" : t - link.lastAlive > ASLEEP_MS ? "asleep" : "online";
    return {
      deviceId, name: link?.name || name, state, level: levelFor(state, link?.rttMs ?? null), rttMs: link?.rttMs ?? null,
      harnesses: link?.harnesses || [], platform: link?.platform || "", running: link?.running.size || 0,
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

  private receiveCopy(link: Link, m: any) {
    // Only what the owner asked this computer for, only on a server hub, small and well-formed.
    const item: unknown = m.item;
    if (!this.opts.acceptCopies || !isCopyItem(item) || !link.want.includes(item)) return;
    const data = typeof m.data === "string" ? m.data : "";
    if (!data || data.length > MAX_COPY) return;
    try { JSON.parse(data); } catch { return; }
    const path = join(this.opts.homeDir, COPY_ITEMS[item].path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, data, { mode: 0o600 });
    chmodSync(path, 0o600);
    const c = this.copied();
    c[item] = { hash: sha256(data), at: new Date(this.now()).toISOString(), from: link.deviceId };
    this.saveCopied(c);
    this.onChange();
  }

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
