import { mkdirSync, rmSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "../store/index.ts";
import type { Connector } from "./types.ts";
import { RISK } from "./types.ts";
import { parsePhoneNumberFromString } from "libphonenumber-js";

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
export type ChatInfo = { jid: string; name: string; group: boolean; archived?: boolean; mutedUntil?: number; /** ms of the latest message */ lastAt?: number; /** name came from your address book (beats their own WhatsApp name) */ saved?: boolean; /** ms of the latest call seen (WhatsApp doesn't share past call logs, so from linking on) */ lastCallAt?: number };
/** "+65 9199 7824" from a WhatsApp number (digits with the country code). */
export const prettyNumber = (digitsOnly: string) => parsePhoneNumberFromString(`+${digitsOnly}`)?.formatInternational() ?? `+${digitsOnly}`;
/** Official WhatsApp accounts that aren't in anyone's address book. */
const KNOWN: Record<string, string> = { "0": "WhatsApp", "13135550002": "Meta AI" };
/** Baileys timestamps are seconds, sometimes as a protobuf Long. */
const seconds = (t: any) => { const n = typeof t === "object" && t?.toNumber ? t.toNumber() : Number(t); return Number.isFinite(n) && n > 0 ? n : 0; };
export type WaStatus = { state: "off" | "starting" | "qr" | "connected" | "signed-out" | "error"; qr?: string | null; me?: string | null; detail?: string | null; riskAccepted: boolean; /** a new link's chats are still arriving */ syncing?: boolean };

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

/** Kinds of message a person actually sent (not system notices, reactions, receipts or key exchanges). */
const REAL = ["conversation", "extendedTextMessage", "imageMessage", "videoMessage", "ptvMessage", "audioMessage", "documentMessage",
  "documentWithCaptionMessage", "stickerMessage", "contactMessage", "contactsArrayMessage", "locationMessage", "liveLocationMessage",
  "pollCreationMessage", "pollCreationMessageV2", "pollCreationMessageV3", "groupInviteMessage"];
/** Did someone (you or them) really say something? WhatsApp's own "last active" moves for joins, leaves, setting changes
 * and security notices, which made year-old chats look recent. */
export function isRealMessage(msg: any): boolean {
  if (!msg?.message || msg.messageStubType) return false;
  const m = msg.message.ephemeralMessage?.message ?? msg.message.viewOnceMessage?.message ?? msg.message.viewOnceMessageV2?.message ?? msg.message;
  return REAL.some((k) => m?.[k]);
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
  /** Names by id, apart from chats: your address book has far more people than you talk to. */
  private names = new Map<string, { name: string; saved: boolean }>();
  /** WhatsApp addresses one person by phone number (…@s.whatsapp.net) or by a private id (…@lid); each maps to the other. */
  private alias = new Map<string, string>();
  /** The linked device the chat list was built from: a new link (new device) starts a fresh list. */
  private device: string | null = null;
  /** While a new link's history arrives: until this time (ms), pushed back by each batch, capped from the start. */
  private syncUntil = 0;
  private syncCap = 0;
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
    return { state: this.st, qr: this.st === "qr" ? this.qr : null, me: this.me, detail: this.detail, riskAccepted: await this.riskAccepted(), syncing: this.st === "connected" && Date.now() < this.syncUntil };
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

  /** Chats this link knows, for picking what to ignore: one row per person (a phone-number chat and its @lid twin are
   * merged), named from your address book, then their own WhatsApp name, then their number. */
  chatList(): ChatInfo[] {
    const out = new Map<string, ChatInfo>();
    for (const raw of this.chats.values()) {
      // A 1:1 chat nobody has written in (WhatsApp keeps empty ones for people from groups and communities) isn't listed.
      if (!raw.group && !raw.lastAt) continue;
      const twin = raw.group ? undefined : this.alias.get(raw.jid);
      // Prefer the phone-number form as the row's id when both exist.
      const key = twin && raw.jid.endsWith("@lid") && this.chats.has(twin) ? twin : raw.jid;
      const prev = out.get(key);
      const row: ChatInfo = { ...(prev ?? this.chats.get(key) ?? raw), jid: key };
      row.lastAt = Math.max(prev?.lastAt || 0, raw.lastAt || 0, this.chats.get(key)?.lastAt || 0) || undefined;
      row.lastCallAt = Math.max(prev?.lastCallAt || 0, raw.lastCallAt || 0, this.chats.get(key)?.lastCallAt || 0) || undefined;
      if (!row.group) { const n = this.displayName(key); row.name = n.name; row.saved = n.saved || undefined; }
      out.set(key, row);
    }
    return [...out.values()].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0) || a.name.localeCompare(b.name)).slice(0, 1000);
  }

  /** The name to show for a 1:1 chat. */
  private displayName(jid: string): { name: string; saved: boolean } {
    const twin = this.alias.get(jid);
    const a = this.names.get(jid), b = twin ? this.names.get(twin) : undefined;
    const best = a?.saved ? a : b?.saved ? b : a ?? b;
    if (best) return best;
    const pn = jid.endsWith("@s.whatsapp.net") ? jid : twin?.endsWith("@s.whatsapp.net") ? twin : null;
    if (pn && KNOWN[pn.split("@")[0]]) return { name: KNOWN[pn.split("@")[0]], saved: false };
    if (pn) return { name: prettyNumber(pn.split("@")[0]), saved: false };
    // Only WhatsApp's private id is known: the person hides their number (e.g. met in a community) and isn't saved.
    return { name: "Hidden number", saved: false };
  }

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
      void this.store.put("settings", { id: "whatsapp-chats", createdAt: "1970-01-01T00:00:00.000Z", chats: [...this.chats.values()],
        device: this.device, names: [...this.names].slice(0, 5000), alias: [...this.alias].slice(0, 10000) }).catch(() => {});
    }, 3000);
    (this.keepTimer as any).unref?.();
  }
  private async loadChats() {
    if (this.chats.size) return;
    const kept = await this.store.get<any>("settings", "whatsapp-chats").catch(() => null);
    this.device = typeof kept?.device === "string" ? kept.device : null;
    for (const [k, v] of kept?.names || []) if (typeof k === "string" && v?.name) this.names.set(k, { name: String(v.name), saved: !!v.saved });
    for (const [k, v] of kept?.alias || []) if (typeof k === "string" && typeof v === "string") this.alias.set(k, v);
    for (const c of kept?.chats || []) {
      if (!c?.jid || this.chats.has(c.jid)) continue;
      // Older versions saved every address-book contact as a chat and kept names on chats: keep only real
      // conversations, and move a saved name into the name book.
      if (!c.group && c.saved && c.name && !this.names.get(c.jid)?.saved) this.names.set(c.jid, { name: c.name, saved: true });
      if (!c.group && !c.lastAt) continue;
      this.chats.set(c.jid, c);
    }
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
    const sock: Sock = makeWASocket({ ...(version ? { version } : {}), auth: state, printQRInTerminal: false, logger: silent,
      // [label, platform, version]. The platform must be one WhatsApp knows (Chrome, like web.whatsapp.com): a made-up
      // one was refused ("can't link new devices"). The label is free text, so Linked devices shows "Chrome (Hearth)".
      browser: ["Hearth", "Chrome", "14.4.1"],
      markOnlineOnConnect: false, syncFullHistory: false,
      // Baileys turns syncFullHistory: false into "skip every history message", which drops the recent-chats list WhatsApp
      // sends once at link time. Take the recent sync (only names and times are kept, see messaging-history.set); still
      // decline the full archive.
      shouldSyncHistoryMessage: (m: any) => m?.syncType !== B.proto?.Message?.HistorySyncNotification?.HistorySyncType?.FULL });
    this.sock = sock;
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", (u: any) => {
      if (u.qr) { this.qr = u.qr; this.set("qr"); }
      if (u.connection === "open") {
        this.retries = 0; this.qr = null;
        this.me = String(sock.user?.id || "").split(":")[0].split("@")[0] || null;
        // A new link: drop the old list so its dates and names can't mix with what this link's history brings.
        const device = String(sock.user?.id || "") || null;
        if (device && device !== this.device) {
          this.chats.clear(); this.names.clear(); this.alias.clear(); this.device = device; this.keepChats();
          // WhatsApp starts sending this link's chats now; show "Loading" until the batches stop (or 2 minutes).
          this.syncCap = Date.now() + 120_000; this.syncUntil = Date.now() + 45_000;
        }
        this.set("connected");
        sock.groupFetchAllParticipating?.().then((gs: any) => { for (const g of Object.values(gs || {}) as any[]) this.chat(g.id, g.subject); }).catch(() => {});
        this.syncNames(sock, B);
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
    sock.ev.on("contacts.upsert", (cs: any[]) => { for (const c of cs || []) this.contact(c); });
    sock.ev.on("contacts.update", (cs: any[]) => { for (const c of cs || []) this.contact(c); });
    // The recent-chats list WhatsApp sends right after linking (and on reconnect): names, and when each was last active.
    sock.ev.on("messaging-history.set", ({ chats, contacts, messages }: any) => {
      // Another batch: keep "Loading" up until none has come for 10 seconds (never past the cap).
      if (Date.now() < this.syncCap) this.syncUntil = Math.min(this.syncCap, Date.now() + 10_000);
      for (const c of contacts || []) this.contact(c);
      for (const c of chats || []) {
        this.link(c.id, c.lidJid || c.pnJid);
        if (isGroupJid(c.id)) this.chat(c.id, c.name, c);
        else {
          if (c.name) this.contact({ id: c.id, name: c.name });
          // The name WhatsApp shows for someone not saved (their own name, or their username): helps hidden numbers.
          else if (c.displayName || c.username) this.contact({ id: c.id, notify: c.displayName || c.username });
          this.chat(c.id, undefined, c);
        }
      }
      // Only the time of each recent real message (to order the list like your phone does); history text isn't kept.
      for (const m of messages || []) {
        if (m?.key?.remoteJid && m.messageTimestamp && isRealMessage(m)) this.chat(m.key.remoteJid, undefined, { activeAt: m.messageTimestamp });
        this.learn(m);
      }
    });
    // Calls: someone you're talking to by phone is as recent as a message. Only metadata (who, when) is kept.
    sock.ev.on("call", (calls: any[]) => {
      for (const c of calls || []) this.called(c?.groupJid || c?.chatId || c?.from, c?.date ? new Date(c.date).getTime() : Date.now());
    });
    // Your call log, calls you made too (WhatsApp shares it with linked devices that ask; patches/baileys adds the ask
    // and this event): the past log arrives with the link-time history, then each new call as it happens.
    // Private-id <-> phone-number pairs from the link-time history (patches/baileys surfaces them): names hidden numbers.
    sock.ev.on("lid-mapping.set", ({ mappings }: any) => {
      for (const m of mappings || []) this.link(m?.lidJid, m?.pnJid);
      const hidden = [...this.chats.values()].filter((c) => !c.group && c.lastAt && c.jid.endsWith("@lid") && !this.alias.has(c.jid)).length;
      console.log(`whatsapp: ${mappings?.length || 0} number pairs from history; ${hidden} recent chats still without a number`);
    });
    sock.ev.on("call-log.set", ({ records }: any) => {
      const mine = (j?: string) => !!j && !!this.me && j.split(/[:@]/)[0] === this.me;
      for (const r of records || []) {
        const others = (r?.participants || []).map((p: any) => p?.userJid).filter((j: any) => typeof j === "string" && !mine(j));
        const peer = r?.groupJid || (r?.isIncoming ? r?.callCreatorJid : others[0]) || (!mine(r?.callCreatorJid) ? r?.callCreatorJid : undefined);
        const t = seconds(r?.startTime);
        this.called(peer, t > 1e12 ? t : t * 1000);
      }
    });
    sock.ev.on("groups.update", (gs: any[]) => { for (const g of gs || []) this.chat(g.id, g.subject); });
    sock.ev.on("messages.upsert", ({ messages, type }: any) => { for (const m of messages || []) {
      this.learn(m);
      if (m?.key?.remoteJid && isRealMessage(m)) this.chat(m.key.remoteJid, undefined, { activeAt: m.messageTimestamp || Math.floor(Date.now() / 1000) });
      if (type === "notify") void this.take(m);
    } });
  }

  /** Your address book's names (and people's own WhatsApp names, which never replace a saved one) live in WhatsApp's
   * settings sync. Baileys runs that sync the moment history lands, often before its keys arrive, and doesn't retry, so
   * run it ourselves once the link is open (and again later if that fails). It's a snapshot, so a relink isn't needed. */
  private syncNames(sock: Sock, B: any, wait = 8000, triesLeft = 2) {
    setTimeout(async () => {
      if (this.sock !== sock || !(sock as any).resyncAppState) return;
      try { await (sock as any).resyncAppState(B.ALL_WA_PATCH_NAMES ?? ["critical_block", "critical_unblock_low", "regular_high", "regular_low", "regular"], true); }
      catch { if (triesLeft > 1) this.syncNames(sock, B, 30_000, triesLeft - 1); return; }
      await this.resolveSaved(sock);
    }, wait).unref?.();
  }

  /** A contact from the address book sync (a saved name) or someone's own WhatsApp name (never replaces a saved one).
   * Goes in the name book, not the chat list; its phone-number and @lid ids are linked. */
  private contact(c: any) {
    const saved = c?.name ? String(c.name).slice(0, 100) : "";
    const theirs = c?.notify || c?.verifiedName ? String(c.notify || c.verifiedName).slice(0, 100) : "";
    const ids = [c?.id, c?.lid, c?.jid].filter((j): j is string => typeof j === "string" && !!j && !isGroupJid(j));
    for (let i = 1; i < ids.length; i++) this.link(ids[0], ids[i]);
    for (const jid of ids) {
      if (saved) this.names.set(jid, { name: saved, saved: true });
      else if (theirs && !this.names.get(jid)?.saved) this.names.set(jid, { name: theirs, saved: false });
    }
    if (saved || theirs) this.keepChats();
  }

  /** Some chats come only under WhatsApp's private @lid id. WhatsApp answers number -> private id (not the reverse),
   * so ask it for the saved contacts we can't pair yet, a few at a time, once per connection. */
  private async resolveSaved(sock: Sock) {
    const lookup = (sock as any).onWhatsApp;
    if (!lookup) return;
    const todo = [...this.names].filter(([j, n]) => n.saved && j.endsWith("@s.whatsapp.net") && !this.alias.has(j)).map(([j]) => j);
    for (let i = 0; i < todo.length && this.sock === sock; i += 50) {
      try { for (const r of (await lookup(...todo.slice(i, i + 50))) || []) this.link(r?.jid, r?.lid); } catch { return; }
      await Bun.sleep(1500);
    }
  }

  /** A call with someone: as recent as a message. Only who and when are kept. */
  private called(jid: string | undefined, at: number) {
    if (!jid || typeof jid !== "string" || !Number.isFinite(at) || at <= 0) return;
    this.chat(jid, undefined, { activeAt: Math.floor(at / 1000) });
    const cur = this.chats.get(jid)!; cur.lastCallAt = Math.max(cur.lastCallAt || 0, at);
  }

  /** Tie a phone-number id to its @lid twin. */
  private link(a?: string, b?: string) {
    if (!a || !b || a === b) return;
    const lid = [a, b].find((j) => j.endsWith("@lid")), pn = [a, b].find((j) => j.endsWith("@s.whatsapp.net"));
    if (!lid || !pn || this.alias.get(lid) === pn) return;
    this.alias.set(lid, pn); this.alias.set(pn, lid);
    this.keepChats();
  }

  /** What every message says about who sent it: their phone number next to a private @lid id, and the name they set
   * for themselves (your phone shows it as "~Name"). */
  private learn(m: any) {
    const k = m?.key;
    if (!k?.remoteJid) return;
    const group = isGroupJid(k.remoteJid);
    const sender = group ? k.participant : k.remoteJid;
    if (group) { this.link(k.participant, k.participantPn); this.link(k.participant, k.participantLid); }
    else { this.link(k.remoteJid, k.senderPn); this.link(k.remoteJid, k.senderLid); }
    if (!k.fromMe && m.pushName && sender) this.contact({ id: sender, notify: m.pushName });
  }

  private chat(jid: string | undefined, name?: string, c?: any) {
    if (!jid || jid === "status@broadcast") return;
    const cur = this.chats.get(jid) ?? { jid, name: jid.split("@")[0], group: isGroupJid(jid) };
    if (name) cur.name = String(name).slice(0, 100);
    if (c && "archived" in c) cur.archived = !!c.archived;
    if (c && "muteEndTime" in c) cur.mutedUntil = Number(c.muteEndTime) || 0;
    // Only real activity (a message or a call) moves a chat up; WhatsApp's conversationTimestamp also moves for notices.
    if (c?.activeAt) cur.lastAt = Math.max(cur.lastAt || 0, seconds(c.activeAt) * 1000);
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
    // When it was last active, even if it's ignored (only the time: the text of an ignored chat is never kept).
    this.chat(jid, undefined, { activeAt: raw.messageTimestamp || Math.floor(Date.now() / 1000) });
    const m = { jid, from, text, group };
    // Rules may name either id for the same person, so check the message under its twin ids too.
    const rules = await this.rules(), chatInfo = this.chats.get(jid) ?? this.chats.get(this.alias.get(jid) || "");
    const twin = (j: string) => this.alias.get(j) || j;
    if (ignoredBecause(m, rules, chatInfo) || ignoredBecause({ ...m, jid: group ? jid : twin(jid), from: twin(from) }, rules, chatInfo)) return null;
    const at = new Date(Number(raw.messageTimestamp || 0) * 1000 || Date.now()).toISOString();
    const msg: WaMessage = { id: `wa-${String(raw.key.id || crypto.randomUUID()).slice(0, 80)}`, createdAt: at, jid, from, fromMe: !!raw.key.fromMe, group,
      chat: group ? this.chats.get(jid)?.name || jid.split("@")[0] : this.displayName(jid).name, text: text.slice(0, 4000), at };
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
    this.chats.clear(); this.names.clear(); this.alias.clear(); this.device = null;
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
