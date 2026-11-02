import type { Vault } from "../vault.ts";
import type { Source, Item } from "../sources/index.ts";
import type { Connector } from "./types.ts";

// Slack through a token you make yourself (api.slack.com/apps → your app → OAuth & Permissions). A user token (xoxp-)
// reads your own DMs and mentions; a bot token (xoxb-) reads what the bot is in. The token stays in the vault.
// Scopes: im:history, im:read, users:read, search:read (user tokens, for mentions), chat:write (only to send, after Approve).

type Saved = { token: string; team: string; user: string; savedAt: string };

export class Slack {
  constructor(private vault: Vault | null, private fetcher: typeof fetch = fetch) {}

  private saved(): Saved | null { try { const v = this.vault?.get("slack"); return v ? JSON.parse(v) : null; } catch { return null; } }
  connected() { return !!this.saved()?.token; }
  status() { const s = this.saved(); return s ? { team: s.team, user: s.user, hint: `••••${s.token.slice(-4)}`, savedAt: s.savedAt } : null; }
  save(token: string, team: string, user: string) { this.vault!.set("slack", JSON.stringify({ token, team, user, savedAt: new Date().toISOString() } satisfies Saved)); }
  remove() { this.vault?.delete("slack"); }

  async call(method: string, params: Record<string, string> = {}, post = false): Promise<any> {
    const s = this.saved();
    if (!s) throw new Error("Slack isn't connected.");
    const url = `https://slack.com/api/${method}` + (post ? "" : `?${new URLSearchParams(params)}`);
    const r = await this.fetcher(url, {
      method: post ? "POST" : "GET",
      headers: { Authorization: `Bearer ${s.token}`, ...(post ? { "Content-Type": "application/json; charset=utf-8" } : {}) },
      ...(post ? { body: JSON.stringify(params) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const j: any = await r.json().catch(() => ({ ok: false, error: `http_${r.status}` }));
    if (!j.ok) throw new Error(j.error === "invalid_auth" || j.error === "token_revoked" ? "Slack signed this token out. Connect Slack again." : `Slack said: ${j.error}`);
    return j;
  }

  /** New messages in your DMs, newest first. */
  async dms(limit = 15): Promise<Item[]> {
    const ims = (await this.call("conversations.list", { types: "im", limit: "50" })).channels || [];
    const names = new Map<string, string>();
    const out: Item[] = [];
    for (const im of ims.slice(0, 15)) {
      const h = await this.call("conversations.history", { channel: im.id, limit: "5" }).catch(() => null);
      for (const m of h?.messages || []) {
        if (!m.text || m.subtype) continue;
        if (!names.has(m.user)) names.set(m.user, await this.call("users.info", { user: m.user }).then((u) => u.user?.real_name || u.user?.name || m.user).catch(() => m.user));
        out.push({ id: `slack-${im.id}-${m.ts}`, title: `DM from ${names.get(m.user)}`, text: m.text, at: new Date(Number(m.ts) * 1000).toISOString() });
      }
    }
    return out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
  }

  /** Messages that mention you (user tokens only: Slack's search). */
  async mentions(limit = 15): Promise<Item[]> {
    const s = this.saved();
    const j = await this.call("search.messages", { query: `<@${s?.user}>`, sort: "timestamp", count: String(limit) });
    return (j.messages?.matches || []).map((m: any) => ({ id: `slack-${m.channel?.id}-${m.ts}`, title: `${m.username || "Someone"} in #${m.channel?.name || "a channel"}`,
      text: m.text, at: new Date(Number(m.ts) * 1000).toISOString(), url: m.permalink }));
  }

  /** Only after the owner tapped Approve. */
  async send(channel: string, text: string) {
    const j = await this.call("chat.postMessage", { channel, text: text.slice(0, 4000) }, true);
    return String(j.ts || "");
  }
}

/** Slack as a trigger: new DMs or mentions. */
export function slackSource(slack: () => Slack): Source<{ what: "dms" | "mentions" }> {
  return {
    id: "slack", label: "Slack", needs: "slack",
    doc: `Slack through the user's token. config {"what":"dms"} (a new direct message) or {"what":"mentions"} (someone @-mentions them; user tokens only). Minutes >= 5, default 10.`,
    validate: (c) => ({ what: c?.what === "mentions" ? "mentions" : "dms" }),
    minutes: () => ({ min: 5, default: 10 }),
    describe: (c) => `new Slack ${c.what === "mentions" ? "mentions" : "DMs"}`,
    items: (c) => (c.what === "mentions" ? slack().mentions() : slack().dms()),
  };
}

/** A Slack bot (xoxb-) or user (xoxp-) token. auth.test says whose it is. */
export async function checkSlackToken(token: string, fetcher: typeof fetch = fetch): Promise<{ error: string } | { team: string; user: string }> {
  if (!/^xox[bpe]-[A-Za-z0-9-]{20,}$/.test(token)) return { error: "A Slack token starts with xoxb- (bot) or xoxp- (user)." };
  try {
    const r = await fetcher("https://slack.com/api/auth.test", { method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    const j: any = await r.json();
    if (!j.ok) return { error: j.error === "invalid_auth" ? "Slack didn't accept that token." : `Slack said: ${j.error}` };
    return { team: String(j.team || ""), user: String(j.user || "") };
  } catch { return { error: "Couldn't reach Slack." }; }
}

export const slack: Connector = {
  def: { id: "slack", label: "Slack", kind: "account", how: "token", blurb: "DMs and mentions from your workspace.", getFrom: "https://api.slack.com/apps" },
  status: ({ slack }) => { const s = slack.status(); return { state: s ? "connected" : "off", detail: s ? `${s.team} · ${s.user}` : null }; },
  async add({ slack, vault }, { token, key }) {
    if (!vault) return "This hub has no key vault.";
    const t = String(token ?? key ?? "").trim();
    const r = await checkSlackToken(t);
    if ("error" in r) return r.error;
    slack.save(t, r.team, r.user);
    return null;
  },
  async remove({ slack }) { slack.remove(); return null; },
};
