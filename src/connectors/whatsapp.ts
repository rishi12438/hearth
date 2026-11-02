import { mkdirSync, rmSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../store/index.ts";
import type { Connector } from "./types.ts";
import { RISK } from "./types.ts";

// WhatsApp on your own number, linked like WhatsApp Web: scan a QR code from the phone (Settings → Linked devices).
// Unofficial (Baileys): it breaks WhatsApp's terms and the number could be banned, so the owner accepts that once
// before it starts. The link's keys stay on the hub (<data>/keys/whatsapp, 0700). Messages from anything on the ignore
// list (contacts, groups, keywords, archived or muted chats) are dropped before they're stored or seen by a model.
// Sending only ever happens after the owner taps Approve.

export type IgnoreRules = {
  /** Chat ids (1555…@s.whatsapp.net) or bare phone numbers. */
  contacts: string[];
  /** Group ids (…@g.us). */
  groups: string[];
  allGroups: boolean;
  /** Case-insensitive words or phrases. */
  keywords: string[];
  archived: boolean;
  muted: boolean;
};
export const NO_RULES: IgnoreRules = { contacts: [], groups: [], allGroups: false, keywords: [], archived: false, muted: false };

export type WaMessage = { id: string; createdAt: string; jid: string; chat: string; from: string; fromMe: boolean; group: boolean; text: string; at: string };
export type ChatInfo = { jid: string; name: string; group: boolean; archived?: boolean; mutedUntil?: number; /** ms of the latest message */ lastAt?: number };
/** Baileys timestamps are seconds, sometimes as a protobuf Long. */
const seconds = (t: any) => { const n = typeof t === "object" && t?.toNumber ? t.toNumber() : Number(t); return Number.isFinite(n) && n > 0 ? n : 0; };
export type WaStatus = { state: "off" | "starting" | "qr" | "connected" | "signed-out" | "error"; qr?: string | null; me?: string | null; detail?: string | null; riskAccepted: boolean };

const digits = (s: string) => s.replace(/\D/g, "");
export const isGroupJid = (jid: string) => jid.endsWith("@g.us");

/** Tidy a rule list: trimmed, unique, capped. Phone numbers keep only their digits. */
export function cleanRules(r: any): IgnoreRules {
  const list = (v: unknown, max = 500) => [...new Set((Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean))].slice(0, max);
  const contact = (c: string) => (c.includes("@") ? c.toLowerCase() : digits(c));
  return {
    contacts: list(r?.contacts).map(contact).filter(Boolean),
    groups: list(r?.groups).filter((g) => isGroupJid(g)),
    allGroups: r?.allGroups === true,
    keywords: list(r?.keywords, 200).map((k) => k.toLowerCase().slice(0, 100)),
    archived: r?.archived === true,
    muted: r?.muted === true,
  };
}

/** Why a message is ignored, or null if it gets through. */
export function ignoredBecause(m: { jid: string; from: string; text: string; group: boolean }, rules: IgnoreRules, chat?: ChatInfo, now = Date.now()): string | null {
  const jid = m.jid.toLowerCase();
  const sameContact = (c: string) => (c.includes("@") ? c === jid || c === m.from.toLowerCase() : !!c && (digits(jid.split("@")[0]) === c || digits(m.from.split("@")[0]) === c));
  if (rules.contacts.some(sameContact)) return "contact";
  if (m.group && (rules.allGroups || rules.groups.includes(m.jid))) return "group";
  const text = m.text.toLowerCase();
  if (rules.keywords.some((k) => text.includes(k))) return "keyword";
  if (rules.archived && chat?.archived) return "archived";
  if (rules.muted && chat?.mutedUntil && (chat.mutedUntil < 0 || chat.mutedUntil > now)) return "muted";
  return null;
}

/** The text of a Baileys message, whatever kind it is (plain, reply, caption). */
export function messageText(msg: any): string {
  const m = msg?.message?.ephemeralMessage?.message ?? msg?.message?.viewOnceMessage?.message ?? msg?.message;
  return String(m?.conversation ?? m?.extendedTextMessage?.text ?? m?.imageMessage?.caption ?? m?.videoMessage?.caption ?? m?.documentMessage?.caption ?? "").trim();
}

type Sock = any;
const KEEP = 2000;

export class WhatsApp {
  private sock: Sock | null = null;
  private st: WaStatus["state"] = "off";
  private qr: string | null = null;
  private me: string | null = null;
  private detail: string | null = null;
  private chats = new Map<string, ChatInfo>();
  private stopping = false;
  private retries = 0;
  private booting = false;
  readonly dir: string;
  onChange: () => void = () => {};
  onMessage: (m: WaMessage) => void = () => {};

  constructor(dataDir: string, private store: Store, private risk: () => boolean, private load: () => Promise<any> = () => import("baileys")) {
    this.dir = join(dataDir, "keys", "whatsapp");
  }

  async riskAccepted() { return this.risk(); }
  linked() { return existsSync(join(this.dir, "creds.json")); }
  connected() { return this.st === "connected"; }

  async status(): Promise<WaStatus> {
    return { state: this.st, qr: this.st === "qr" ? this.qr : null, me: this.me, detail: this.detail, riskAccepted: await this.riskAccepted() };
  }

  async rules(): Promise<IgnoreRules> { return { ...NO_RULES, ...cleanRules((await this.store.get<any>("settings", "whatsapp-ignore")) || {}) }; }
  async setRules(patch: Partial<IgnoreRules>) {
    const next = cleanRules({ ...(await this.rules()), ...patch });
    await this.store.put("settings", { id: "whatsapp-ignore", createdAt: "1970-01-01T00:00:00.000Z", ...next });
    return next;
  }
  /** Add or take one entry off a rule list: kind contact|group|keyword. */
  async editRule(kind: "contact" | "group" | "keyword", value: string, remove = false) {
    const r = await this.rules();
    const key = kind === "contact" ? "contacts" : kind === "group" ? "groups" : "keywords";
    const v = kind === "keyword" ? value.trim().toLowerCase() : value.includes("@") ? value.trim().toLowerCase() : digits(value);
    if (!v) throw new Error(`Give a ${kind}.`);
    if (kind === "group" && !isGroupJid(v)) throw new Error("A group is its id, like 1203630…@g.us. `hearth whatsapp chats` lists them.");
    const list = remove ? r[key].filter((x) => x !== v) : [...r[key], v];
    return this.setRules({ [key]: list });
  }

  /** Chats this link knows, for picking what to ignore. */
  chatList(): ChatInfo[] { return [...this.chats.values()].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0) || a.name.localeCompare(b.name)).slice(0, 1000); }

  /** Recent messages that got through the ignore list, newest first. */
  async recent(limit = 50, jid?: string): Promise<WaMessage[]> {
    const all = await this.store.all<WaMessage>("whatsapp");
    return all.filter((m) => !jid || m.jid === jid).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  }

  /** Start (or resume) the link. The first time, this shows a QR code to scan. */
  // The chat list (names, groups, last-active times; no message text) is kept on the hub, so it's there after a restart.
  private keepTimer: ReturnType<typeof setTimeout> | null = null;
  private keepChats() {
    if (this.keepTimer) return;
    this.keepTimer = setTimeout(() => {
      this.keepTimer = null;
      void this.store.put("settings", { id: "whatsapp-chats", createdAt: "1970-01-01T00:00:00.000Z", chats: this.chatList() }).catch(() => {});
    }, 3000);
    (this.keepTimer as any).unref?.();
  }
  private async loadChats() {
    if (this.chats.size) return;
    const kept = await this.store.get<any>("settings", "whatsapp-chats").catch(() => null);
    for (const c of kept?.chats || []) if (c?.jid && !this.chats.has(c.jid)) this.chats.set(c.jid, c);
  }

  async start() {
    // Guard on a start actually in flight, not on the "starting" state: a reconnect sets that state before calling
    // start(), and WhatsApp drops the socket right after every QR scan, so that guard left new links never reconnecting.
    if (this.sock || this.booting) return;
    this.booting = true;
    try { await this.boot(); } finally { this.booting = false; }
  }

  private async boot() {
    await this.loadChats();
    if (!(await this.riskAccepted())) throw new Error("Accept the WhatsApp ban-risk warning first.");
    this.stopping = false;
    this.set("starting");
    const B: any = await this.load();
    const makeWASocket = B.default?.default ?? B.default ?? B.makeWASocket;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const { state, saveCreds } = await B.useMultiFileAuthState(this.dir);
    // WhatsApp closes the socket on an old client version, so ask for the current one (fall back to the built-in).
    const version = await B.fetchLatestBaileysVersion?.().then((v: any) => v?.version).catch(() => undefined);
    const silent: any = { level: "silent", child: () => silent, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
    const sock: Sock = makeWASocket({ ...(version ? { version } : {}), auth: state, printQRInTerminal: false, logger: silent, // WhatsApp refuses to link a browser it doesn't recognise ("can't link new devices"), so present as Chrome on a Mac,
      // the same identity web.whatsapp.com uses. Linked devices lists it as "Chrome (Mac OS)".
      browser: B.Browsers?.macOS?.("Chrome") ?? ["Mac OS", "Chrome", "14.4.1"],
      markOnlineOnConnect: false, syncFullHistory: false });
    this.sock = sock;
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", (u: any) => {
      if (u.qr) { this.qr = u.qr; this.set("qr"); }
      if (u.connection === "open") {
        this.retries = 0; this.qr = null;
        this.me = String(sock.user?.id || "").split(":")[0].split("@")[0] || null;
        this.set("connected");
        sock.groupFetchAllParticipating?.().then((gs: any) => { for (const g of Object.values(gs || {}) as any[]) this.chat(g.id, g.subject); }).catch(() => {});
      }
      if (u.connection === "close") {
        if (this.sock && this.sock !== sock) return; // an old socket closing after a relink: not ours to handle
        this.sock = null;
        const code = u.lastDisconnect?.error?.output?.statusCode;
        if (code === B.DisconnectReason?.loggedOut) { this.detail = "WhatsApp signed this link out. Link it again."; this.set("signed-out"); rmSync(this.dir, { recursive: true, force: true }); return; }
        if (this.stopping) { this.set("off"); return; }
        // Dropped: back off and reconnect (WhatsApp asks for a restart right after the first scan, too).
        const wait = Math.min(60_000, 1000 * 2 ** this.retries++);
        this.set("starting");
        setTimeout(() => { if (!this.stopping) this.start().catch((e) => { this.detail = e.message; this.set("error"); }); }, wait).unref?.();
      }
    });
    const chatUpdate = (cs: any[]) => { for (const c of cs || []) this.chat(c.id, c.name, c); };
    sock.ev.on("chats.upsert", chatUpdate);
    sock.ev.on("chats.update", chatUpdate);
    sock.ev.on("contacts.upsert", (cs: any[]) => { for (const c of cs || []) this.chat(c.id, c.name || c.notify); });
    // The recent-chats list WhatsApp sends right after linking (and on reconnect): names, and when each was last active.
    sock.ev.on("messaging-history.set", ({ chats, contacts, messages }: any) => {
      for (const c of contacts || []) this.chat(c.id, c.name || c.notify);
      for (const c of chats || []) this.chat(c.id, c.name, c);
      // Only the time of each recent message (to order the list like your phone does); history text isn't kept.
      for (const m of messages || []) if (m?.key?.remoteJid && m.messageTimestamp) this.chat(m.key.remoteJid, undefined, { conversationTimestamp: m.messageTimestamp });
    });
    sock.ev.on("groups.update", (gs: any[]) => { for (const g of gs || []) this.chat(g.id, g.subject); });
    sock.ev.on("messages.upsert", ({ messages, type }: any) => { if (type === "notify") for (const m of messages || []) void this.take(m); });
  }

  private chat(jid: string | undefined, name?: string, c?: any) {
    if (!jid || jid === "status@broadcast") return;
    const cur = this.chats.get(jid) ?? { jid, name: jid.split("@")[0], group: isGroupJid(jid) };
    if (name) cur.name = String(name).slice(0, 100);
    if (c && "archived" in c) cur.archived = !!c.archived;
    if (c && "muteEndTime" in c) cur.mutedUntil = Number(c.muteEndTime) || 0;
    if (c?.conversationTimestamp) cur.lastAt = Math.max(cur.lastAt || 0, seconds(c.conversationTimestamp) * 1000);
    this.chats.set(jid, cur);
    this.keepChats();
  }

  /** One incoming message: ignore list first, then stored. */
  async take(raw: any) {
    const jid = String(raw?.key?.remoteJid || "");
    const text = messageText(raw);
    if (!jid || jid === "status@broadcast" || jid.endsWith("@newsletter") || !text) return null;
    const group = isGroupJid(jid);
    const from = String(group ? raw.key.participant || "" : jid);
    if (raw.pushName && !group) this.chat(jid, raw.pushName);
    // When it was last active, even if it's ignored (only the time: the text of an ignored chat is never kept).
    this.chat(jid, undefined, { conversationTimestamp: raw.messageTimestamp || Math.floor(Date.now() / 1000) });
    const m = { jid, from, text, group };
    if (ignoredBecause(m, await this.rules(), this.chats.get(jid))) return null;
    const at = new Date(Number(raw.messageTimestamp || 0) * 1000 || Date.now()).toISOString();
    const msg: WaMessage = { id: `wa-${String(raw.key.id || crypto.randomUUID()).slice(0, 80)}`, createdAt: at, jid, from, fromMe: !!raw.key.fromMe, group,
      chat: this.chats.get(jid)?.name || jid.split("@")[0], text: text.slice(0, 4000), at };
    await this.store.put("whatsapp", msg);
    const all = await this.store.all<WaMessage>("whatsapp");
    if (all.length > KEEP) for (const old of all.sort((a, b) => a.at.localeCompare(b.at)).slice(0, all.length - KEEP)) await this.store.remove("whatsapp", old.id);
    this.onMessage(msg);
    return msg;
  }

  /** Send a text. Only the hub's approval path calls this, after the owner tapped Approve. */
  async send(to: string, text: string) {
    if (!this.sock || this.st !== "connected") throw new Error("WhatsApp isn't connected.");
    const jid = to.includes("@") ? to : `${digits(to)}@s.whatsapp.net`;
    const r = await this.sock.sendMessage(jid, { text: text.slice(0, 4000) });
    return String(r?.key?.id || "");
  }

  stop() { this.stopping = true; try { this.sock?.end?.(undefined); } catch {} this.sock = null; this.set("off"); }

  /** A fresh code: drop the half-made link (new keys) and ask WhatsApp for a new QR. Never touches a working link. */
  async relink() {
    if (this.st === "connected") return;
    this.stop();
    rmSync(this.dir, { recursive: true, force: true });
    this.qr = null; this.detail = null; this.retries = 0;
    await this.start();
  }

  /** Unlink: sign out on WhatsApp's side, drop the keys and the stored messages. */
  async logout() {
    this.stopping = true;
    try { await this.sock?.logout?.(); } catch {}
    this.sock = null;
    rmSync(this.dir, { recursive: true, force: true });
    await this.store.clear("whatsapp");
    this.chats.clear();
    await this.store.remove("settings", "whatsapp-chats").catch(() => {});
    this.me = null; this.qr = null;
    this.set("off");
  }

  private set(s: WaStatus["state"]) { this.st = s; if (s !== "error" && s !== "signed-out") this.detail = s === "connected" ? null : this.detail; this.onChange(); }
}

/** WhatsApp as a tile: linked or not, the QR code while linking, and starting the link again when the hub starts. */
export const whatsapp: Connector = {
  def: { id: "whatsapp", label: "WhatsApp", kind: "account", how: "qr", blurb: "Your chats, with contacts and groups you choose to ignore.", risk: RISK("WhatsApp") },
  async status({ whatsapp: wa }) {
    const s = await wa.status();
    return {
      state: s.state === "connected" ? "connected" : s.state === "qr" || s.state === "signed-out" || wa.linked() ? "needs-you" : "off",
      detail: s.state === "connected" ? (s.me ? `+${s.me}` : "Linked") : s.state === "qr" ? "Scan the QR code" : s.detail ?? (s.state === "starting" ? "Connecting…" : null),
    };
  },
  async add({ whatsapp: wa }) { try { await wa.start(); return null; } catch (e: any) { return e.message; } },
  async remove({ whatsapp: wa }) { await wa.logout(); return null; },
  async start({ whatsapp: wa }) { if (wa.linked() && (await wa.riskAccepted())) await wa.start().catch(() => {}); },
};
