import { sendInPage } from "../browser.ts";
import { webSender } from "./web-senders.ts";
import type { Hub } from "../hub.ts";
import type { Vault } from "../vault.ts";
import type { VoiceSettings } from "../voice.ts";
import type { Connector, Ctx, Tile, AddInput } from "./types.ts";
import { WhatsApp, whatsapp, type IgnoreRules } from "./whatsapp.ts";
import { Slack, slack, slackSource } from "./slack.ts";
import { serper, serperKey } from "./serper.ts";
import { deepgram } from "./deepgram.ts";
import { instagram, linkedin } from "./cookies.ts";
import { google } from "./google.ts";
import { claude, codex, takeLogin } from "./brains.ts";
import { whatsappSource } from "./whatsapp-source.ts";
import { registerSource } from "../sources/index.ts";
import { isBrainId, removeLogin } from "../brains/logins.ts";

// The connector grid. Each connector is its own module (serper.ts, whatsapp.ts…) with the same small interface
// (types.ts); this file only lists them, in the order the grid shows them, and runs the shared parts: the ban-risk
// gate, the log line, and telling the app something changed. To add a connector: write its module, add it here.

export const CONNECTORS: Connector[] = [claude, codex, serper, deepgram, whatsapp, slack, instagram, linkedin, google];
export const connectorById = (id: string) => CONNECTORS.find((c) => c.def.id === id) ?? null;
export type { Tile } from "./types.ts";

type Result<T> = { value: T; error?: undefined } | { error: string; value?: undefined };

/** The owner accepted a connector's ban risk. Kept in the vault next to its login, so a data export doesn't carry it. */
export const riskAccepted = (vault: Vault | null, id: string) => !!vault?.get(`risk:${id}`);

export class Connect {
  readonly whatsapp: WhatsApp;
  readonly slack: Slack;
  private ctx: Ctx;

  constructor(private hub: Hub, private vault: Vault | null, voice: VoiceSettings | null) {
    this.whatsapp = new WhatsApp(hub.config.dataDir, hub.store, () => riskAccepted(vault, "whatsapp"));
    this.slack = new Slack(vault);
    this.ctx = { hub, vault, voice, whatsapp: this.whatsapp, slack: this.slack };
    this.whatsapp.onChange = () => hub.emit("connections");
    // What the rest of the hub reaches through here: senders for message.send, "is it connected" for triggers,
    // the Serper key for scripts that ask for it, and WhatsApp and Slack as trigger sources.
    hub.senders.whatsapp = { connected: () => this.whatsapp.connected(), send: (to, text) => this.whatsapp.send(to, text) };
    hub.senders.slack = { connected: () => this.slack.connected(), send: (to, text) => this.slack.send(to, text) };
    hub.senders.gmail = { connected: () => hub.google.canSend(), send: (to, text, x) => hub.google.sendMail(to, x?.subject || "(no subject)", text, x?.threadId, x?.from) };
    for (const ch of ["instagram", "linkedin", "x"] as const)
      hub.senders[ch] = webSender(ch, (d) => hub.connections.cookies(d), (url, text, o) => sendInPage(url, text, { fingerprint: hub.connections.fingerprintFor(url), ...o }));
    hub.connections.extra = { whatsapp: () => this.whatsapp.connected() || this.whatsapp.linked(), slack: () => this.slack.connected() };
    hub.scripts.keys = (name) => (name === "serper" ? serperKey(vault) : null);
    registerSource(slackSource(() => this.slack));
    registerSource(whatsappSource(this.whatsapp));
  }

  /** Let each connector pick up where it left off (WhatsApp keeps its link across restarts). */
  async start() { for (const c of CONNECTORS) await c.start?.(this.ctx).catch(() => {}); }

  async tiles(): Promise<Tile[]> {
    return Promise.all(CONNECTORS.map(async (c) => ({
      ...c.def, ...(await c.status(this.ctx)), ...(c.def.risk ? { riskAccepted: riskAccepted(this.vault, c.def.id) } : {}),
    })));
  }
  private async tile(id: string) { return (await this.tiles()).find((t) => t.id === id)!; }

  async acceptRisk(id: string, by: string): Promise<Result<true>> {
    const c = connectorById(id);
    if (!c?.def.risk) return { error: `${c?.def.label ?? id} has no risk to accept.` };
    if (!this.vault) return { error: "This hub has no key vault." };
    this.vault.set(`risk:${id}`, JSON.stringify({ at: new Date().toISOString(), by }));
    await this.hub.log("connector.risk", `${c.def.label}: ban risk accepted by ${by}`);
    return { value: true };
  }

  /** Add or replace one. Unofficial ones need the risk accepted first (or acceptRisk in the same call). */
  async add(id: string, input: AddInput, by: string): Promise<Result<Tile>> {
    const c = connectorById(id);
    if (!c) return { error: `No connector called ${id}.` };
    if (c.def.risk && !riskAccepted(this.vault, id)) {
      if (!input.acceptRisk) return { error: `${c.def.risk} Accept it first (in the app, or --accept-risk).` };
      const r = await this.acceptRisk(id, by);
      if (r.error) return { error: r.error };
    }
    const bad = await c.add(this.ctx, input);
    if (bad) return { error: bad };
    await this.hub.log("connector.added", `${c.def.label} connected by ${by}`);
    this.hub.emit("connections");
    return { value: await this.tile(id) };
  }

  async remove(id: string, by: string): Promise<Result<Tile>> {
    const c = connectorById(id);
    if (!c) return { error: `No connector called ${id}.` };
    const bad = await c.remove(this.ctx);
    if (bad) return { error: bad };
    await this.hub.log("connector.removed", `${c.def.label} disconnected by ${by}`);
    this.hub.emit("connections");
    return { value: await this.tile(id) };
  }

  /** A brain's long-lived login copied up to this hub (a Claude setup-token, or Codex's auth.json). */
  brainLogin(id: string, input: { token?: string; auth?: unknown }): Result<true> {
    if (!isBrainId(id)) return { error: "Brains are claude or codex." };
    if (id === "claude" && !input.token) return { error: "Give the Claude token." };
    if (id === "codex" && !input.auth) return { error: "Give Codex's auth.json." };
    const bad = takeLogin(id, input);
    return bad ? { error: bad } : { value: true };
  }
  brainLogout(id: string): Result<true> {
    if (!isBrainId(id)) return { error: "Brains are claude or codex." };
    removeLogin(id);
    return { value: true };
  }

  async whatsappView() {
    // Each chat with a one-line preview of its latest message Hearth kept (ignored chats have none: nothing is kept).
    const last = new Map<string, string>();
    for (const m of await this.whatsapp.recent(400)) if (!last.has(m.jid)) last.set(m.jid, `${m.fromMe ? "You: " : ""}${m.text}`.slice(0, 120));
    const chats = this.whatsapp.chatList().map((c) => ({ ...c, last: last.get(c.jid) ?? null }));
    return { ...(await this.whatsapp.status()), rules: await this.whatsapp.rules(), chats };
  }
  setIgnore(patch: Partial<IgnoreRules>) { return this.whatsapp.setRules(patch); }
}
