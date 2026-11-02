import type { Vault } from "../vault.ts";
import type { Source, Item } from "../sources/index.ts";
import type { Connector } from "./types.ts";
import { cleanFingerprint, type Fingerprint } from "../browser.ts";

// Slack, two ways:
// 1. Your Chrome login (the Mac app reads Slack's `d` cookie from Chrome). With it the hub opens the workspace the way
//    Slack's own web client does and gets its session token (xoxc-); API calls send both. No app to create, no admin.
// 2. A token you make yourself (api.slack.com/apps → your app → OAuth & Permissions). A user token (xoxp-) reads your
//    own DMs and mentions; a bot token (xoxb-) reads what the bot is in.
//    Scopes: im:history, im:read, users:read, search:read (user tokens, for mentions), chat:write (only to send, after Approve).
// Either way it stays in the vault.

type Saved = { token: string; team: string; user: string; savedAt: string;
  /** Chrome login: the `d` cookie, the workspace's host ("acme.slack.com") and the Mac Chrome it came from. */
  cookie?: string; domain?: string; fingerprint?: Fingerprint | null };

export class Slack {
  constructor(private vault: Vault | null, private fetcher: typeof fetch = fetch) {}

  private saved(): Saved | null { try { const v = this.vault?.get("slack"); return v ? JSON.parse(v) : null; } catch { return null; } }
  connected() { return !!this.saved()?.token; }
  status() { const s = this.saved(); return s ? { team: s.team, user: s.user, hint: `••••${s.token.slice(-4)}`, savedAt: s.savedAt, via: s.cookie ? "chrome" as const : "token" as const } : null; }
  save(token: string, team: string, user: string, chrome?: { cookie: string; domain: string; fingerprint: Fingerprint | null }) {
    this.vault!.set("slack", JSON.stringify({ token, team, user, savedAt: new Date().toISOString(), ...chrome } satisfies Saved));
  }
  remove() { this.vault?.delete("slack"); }

  async call(method: string, params: Record<string, string> = {}, post = false, retried = false): Promise<any> {
    const s = this.saved();
    if (!s) throw new Error("Slack isn't connected.");
    const url = `https://slack.com/api/${method}` + (post ? "" : `?${new URLSearchParams(params)}`);
    const r = await this.fetcher(url, {
      method: post ? "POST" : "GET",
      headers: { Authorization: `Bearer ${s.token}`, ...(s.cookie ? webHeaders(s.cookie, s.fingerprint) : {}), ...(post ? { "Content-Type": "application/json; charset=utf-8" } : {}) },
      ...(post ? { body: JSON.stringify(params) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const j: any = await r.json().catch(() => ({ ok: false, error: `http_${r.status}` }));
    const signedOut = j.error === "invalid_auth" || j.error === "token_revoked" || j.error === "not_authed";
    // A Chrome login's session token can turn over while the cookie still works: get a fresh one once, then retry.
    if (!j.ok && signedOut && s.cookie && s.domain && !retried) {
      const fresh = await workspaceToken(s.domain, s.cookie, s.fingerprint ?? null, this.fetcher).catch(() => null);
      if (fresh && fresh !== s.token) { this.vault!.set("slack", JSON.stringify({ ...s, token: fresh })); return this.call(method, params, post, true); }
    }
    if (!j.ok) throw new Error(signedOut ? (s.cookie ? "Slack signed this login out. Sign in to Slack in Chrome, then connect again." : "Slack signed this token out. Connect Slack again.") : `Slack said: ${j.error}`);
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

// ---------- your Chrome login ----------

/** Headers that make the hub's requests look like the Chrome the login came from (same User-Agent). Note: Slack's
 * homepage serves an empty page when it gets an Accept-Language header, which hides the workspace list, so we don't
 * send one — the User-Agent alone is enough, and the API calls don't care either way. */
function webHeaders(d: string, fp: Fingerprint | null | undefined): Record<string, string> {
  return { Cookie: `d=${d}`, ...(fp ? { "User-Agent": fp.userAgent } : {}) };
}

/** The `d` cookie from what the Mac app sent: {cookies:[{name,value}]} JSON, a bare array, or "d=xoxd-…". */
export function slackCookie(raw: unknown): string | null {
  let list: any = raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    try { list = JSON.parse(t); } catch { const m = t.match(/(?:^|;\s*)d=(xoxd-[^;\s]+)/) || t.match(/^(xoxd-\S+)$/); return m ? m[1] : null; }
  }
  if (list && !Array.isArray(list)) list = list.cookies;
  const d = Array.isArray(list) ? list.find((c: any) => c?.name === "d" && typeof c.value === "string") : null;
  return d && /^xoxd-[^;\s]+$/.test(d.value) && d.value.length < 2000 ? d.value : null;
}

const HOST_RE = /^[a-z0-9][a-z0-9-]{0,60}\.slack\.com$/;

/** The workspaces this login is signed in to: their hosts, from Slack's own home page (the "Launch" list). */
export async function slackWorkspaceHosts(d: string, fp: Fingerprint | null, fetcher: typeof fetch = fetch): Promise<string[]> {
  const hosts = new Set<string>();
  const r = await fetcher("https://app.slack.com/", { headers: webHeaders(d, fp), signal: AbortSignal.timeout(15_000) });
  for (const m of (await r.text()).matchAll(/https:\/\/([a-z0-9][a-z0-9-]{0,60})\.slack\.com\/ssb\/redirect/g)) hosts.add(`${m[1]}.slack.com`);
  if (!hosts.size) {
    // my.slack.com sends you on to the workspace you used last.
    const last = await fetcher("https://my.slack.com/", { headers: webHeaders(d, fp), signal: AbortSignal.timeout(15_000) }).catch(() => null);
    const host = last ? new URL(last.url).hostname : "";
    if (HOST_RE.test(host) && host !== "my.slack.com" && host !== "app.slack.com") hosts.add(host);
  }
  return [...hosts].slice(0, 20);
}

/** The session token Slack's web client uses for one workspace (in its page's boot data). */
export async function workspaceToken(host: string, d: string, fp: Fingerprint | null, fetcher: typeof fetch = fetch): Promise<string | null> {
  if (!HOST_RE.test(host)) return null;
  const r = await fetcher(`https://${host}/customize/emoji`, { headers: webHeaders(d, fp), signal: AbortSignal.timeout(15_000) });
  const m = (await r.text()).match(/"api_token":"(xoxc-[A-Za-z0-9-]+)"/);
  return m ? m[1] : null;
}

export type SlackWorkspace = { domain: string; team: string; user: string };

/** Every workspace this Chrome login can open, checked with Slack (auth.test). Tokens stay on the hub. */
export async function chromeWorkspaces(d: string, fp: Fingerprint | null, fetcher: typeof fetch = fetch): Promise<(SlackWorkspace & { token: string })[]> {
  const out: (SlackWorkspace & { token: string })[] = [];
  for (const domain of await slackWorkspaceHosts(d, fp, fetcher)) {
    const token = await workspaceToken(domain, d, fp, fetcher).catch(() => null);
    if (!token) continue;
    const a: any = await fetcher("https://slack.com/api/auth.test", { method: "POST", headers: { Authorization: `Bearer ${token}`, ...webHeaders(d, fp) }, signal: AbortSignal.timeout(10_000) })
      .then((r) => r.json()).catch(() => null);
    if (a?.ok) out.push({ domain, team: String(a.team || domain), user: String(a.user || ""), token });
  }
  return out;
}

/** Bring a Chrome login: one workspace (asked for, or the only one). Returns an error, or null when saved. */
export async function addFromChrome(slack: Slack, raw: unknown, auth: any, fetcher: typeof fetch = fetch): Promise<string | null> {
  const d = slackCookie(raw);
  if (!d) return "That isn't a Slack login. Sign in to Slack in Chrome, then try again.";
  const fp = cleanFingerprint(auth?.fingerprint);
  const all = await chromeWorkspaces(d, fp, fetcher).catch(() => null);
  if (!all) return "Couldn't reach Slack.";
  if (!all.length) return "Chrome's Slack login didn't open any workspace. Open app.slack.com in Chrome, sign in, then try again.";
  const want = typeof auth?.workspace === "string" ? auth.workspace : null;
  const w = want ? all.find((x) => x.domain === want) : all.length === 1 ? all[0] : null;
  if (!w) return want ? `This login isn't signed in to ${want}.` : "Pick a workspace.";
  slack.save(w.token, w.team, w.user, { cookie: d, domain: w.domain, fingerprint: fp });
  return null;
}

export const slack: Connector = {
  def: { id: "slack", label: "Slack", kind: "account", how: "token", blurb: "DMs and mentions from your workspace.", getFrom: "https://api.slack.com/apps" },
  status: ({ slack }) => { const s = slack.status(); return { state: s ? "connected" : "off", detail: s ? `${s.team} · ${s.user}${s.via === "chrome" ? " · from Chrome" : ""}` : null }; },
  async add({ slack, vault }, { token, key, cookies, auth }) {
    if (!vault) return "This hub has no key vault.";
    if (cookies) return addFromChrome(slack, cookies, auth);
    const t = String(token ?? key ?? "").trim();
    const r = await checkSlackToken(t);
    if ("error" in r) return r.error;
    slack.save(t, r.team, r.user);
    return null;
  },
  async remove({ slack }) { slack.remove(); return null; },
};
