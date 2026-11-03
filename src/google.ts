import { randomBytes } from "node:crypto";
import type { Vault } from "./vault.ts";

// Your Google accounts, connected with your own OAuth client (no Hearth app, no middleman): you make a client in
// Google Cloud, paste its ID and secret, tap Connect, and Google hands this hub a refresh token. Connect again to add
// another account (personal and work Gmail…): one client, a token per account; reads cover all of them unless told one. The client secret and
// the tokens live in the hub's encrypted vault (vault.ts) with every other key, and never reach the model, the app or
// an export. Gmail (read, and send after your Approve) and Calendar (read).

export const GOOGLE_SCOPES = [
  "openid", "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  // Sending only ever happens after you tap Approve on the exact email (hub.requestMessage).
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.readonly",
];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const STATE_TTL_MS = 30 * 60_000;

type Account = { email: string; refreshToken: string; connectedAt: string; scopes: string[] };
// Before several accounts, one sign-in sat at the top level (refreshToken, email…); saved() lifts it into accounts.
type Saved = { clientId?: string; clientSecret?: string; accounts?: Account[]; refreshToken?: string; email?: string; connectedAt?: string; scopes?: string[] };
export type Mail = { id: string; threadId: string; account: string; from: string; to: string; subject: string; date: string; snippet: string; text: string; labels: string[] };
export type CalEvent = { id: string; account: string; title: string; start: string; end: string; allDay: boolean; location: string; organizer: string; created: string; updated: string; status: string; myResponse: string; link: string; description: string };
const canSendWith = (scopes: string[]) => scopes.some((x) => x.endsWith("/gmail.send"));
const header = (msg: any, name: string) => String(msg?.payload?.headers?.find((h: any) => h.name?.toLowerCase() === name)?.value || "");
const b64 = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

/** The plain text of an email: the text/plain part if there is one, else the HTML with tags stripped. */
export function mailText(payload: any, max = 4000): string {
  const parts: any[] = [];
  const walk = (p: any) => { if (!p) return; parts.push(p); for (const c of p.parts || []) walk(c); };
  walk(payload);
  const plain = parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
  if (plain) return b64(plain.body.data).replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
  const html = parts.find((p) => p.mimeType === "text/html" && p.body?.data);
  if (!html) return "";
  return b64(html.body.data).replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim().slice(0, max);
}

export class Google {
  /** Access tokens by account email (each lasts an hour). */
  private access = new Map<string, { token: string; until: number }>();
  /** The last error reading each account, so one signed-out account shows up instead of hiding behind the others. */
  private problems = new Map<string, string>();
  private states = new Map<string, { redirectUri: string; until: number }>();
  /** Swapped in tests. */
  fetch: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init);

  /** No vault (a hub without one, as in some tests): nothing saved, and saving says why. */
  constructor(private vault: Vault | null, private env: Record<string, string | undefined> = process.env) {}

  private saved(): Saved {
    let s: Saved;
    try { s = JSON.parse(this.vault?.get("google") || "{}"); } catch { s = {}; }
    if (!s.accounts) s.accounts = s.refreshToken ? [{ email: s.email || "", refreshToken: s.refreshToken, connectedAt: s.connectedAt || "", scopes: s.scopes || [] }] : [];
    delete s.refreshToken; delete s.email; delete s.connectedAt; delete s.scopes;
    return s;
  }
  private save(s: Saved) {
    if (!this.vault) throw new Error("This hub has no key vault.");
    this.vault.set("google", JSON.stringify(s));
  }
  private client() {
    const s = this.saved();
    const id = this.env.HEARTH_GOOGLE_CLIENT_ID || s.clientId, secret = this.env.HEARTH_GOOGLE_CLIENT_SECRET || s.clientSecret;
    return id && secret ? { id, secret } : null;
  }

  /** Every signed-in account, in the order you added them (the first is the default for sending). */
  accounts(): Account[] { return this.client() ? this.saved().accounts! : []; }
  get connected() { return this.accounts().length > 0; }

  /** One account by email (case-insensitive), or every account when none is named. Naming one you don't have is an error. */
  private pick(account?: string): Account[] {
    const all = this.accounts();
    if (!all.length) throw new Error("Google isn't connected. Connect it in Menu → Connections.");
    const want = String(account || "").trim().toLowerCase();
    if (!want) return all;
    const a = all.find((x) => x.email.toLowerCase() === want);
    if (!a) throw new Error(`No Google account ${account} is connected (connected: ${all.map((x) => x.email).join(", ")}).`);
    return [a];
  }

  /** What the app may see: never the secret or a token. email/scopes are the first account's, for older callers. */
  status() {
    const c = this.client(), accounts = this.accounts();
    return { hasClient: !!c, clientFromEnv: !!this.env.HEARTH_GOOGLE_CLIENT_ID, clientIdHint: c ? `${c.id.slice(0, 12)}…` : null,
      connected: accounts.length > 0, email: accounts[0]?.email || null, connectedAt: accounts[0]?.connectedAt || null, scopes: accounts[0]?.scopes || [],
      accounts: accounts.map((a) => ({ email: a.email, connectedAt: a.connectedAt, canSend: canSendWith(a.scopes), problem: this.problems.get(a.email) ?? null })) };
  }

  setClient(id: string, secret: string) {
    if (this.env.HEARTH_GOOGLE_CLIENT_ID) return { error: "This hub's Google client is set in its .env." };
    if (!this.vault) return { error: "This hub has no key vault." };
    const cid = String(id || "").trim(), cs = String(secret || "").trim();
    if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(cid)) return { error: "That doesn't look like a Google client ID (it ends in .apps.googleusercontent.com)." };
    if (cs.length < 10 || /\s/.test(cs)) return { error: "That doesn't look like a client secret." };
    const s = this.saved();
    // A new client can't use the old client's tokens.
    this.save(s.clientId === cid ? { ...s, clientSecret: cs } : { clientId: cid, clientSecret: cs, accounts: [] });
    this.access.clear();
    return { value: this.status() };
  }

  /** Step 1: where to send the browser. The state ties Google's answer to this request. Google always asks which
   * account, so the same button adds a second one. `hint` (an email) preselects it, for reconnecting that account. */
  authUrl(redirectUri: string, hint?: string) {
    const c = this.client();
    if (!c) return { error: "Add your Google client ID and secret first." };
    const now = Date.now();
    for (const [k, v] of this.states) if (v.until < now) this.states.delete(k);
    const state = randomBytes(18).toString("base64url");
    this.states.set(state, { redirectUri, until: now + STATE_TTL_MS });
    const q = new URLSearchParams({ client_id: c.id, redirect_uri: redirectUri, response_type: "code", scope: GOOGLE_SCOPES.join(" "),
      access_type: "offline", prompt: "select_account consent", include_granted_scopes: "true", state, ...(hint ? { login_hint: hint } : {}) });
    return { value: `${AUTH_URL}?${q}` };
  }

  /** Step 2: Google sent the browser back with a code; trade it for tokens. Adds the account, or replaces it if it's already here. */
  async finish(code: string, state: string) {
    const st = this.states.get(state);
    this.states.delete(state);
    if (!st || st.until < Date.now()) return { error: "That sign-in expired. Try Connect again." };
    const c = this.client();
    if (!c) return { error: "The Google client was removed." };
    const res = await this.fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: c.id, client_secret: c.secret, redirect_uri: st.redirectUri, grant_type: "authorization_code" }) });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) return { error: `Google said: ${j.error_description || j.error || res.status}` };
    if (!j.refresh_token) return { error: "Google didn't give a long-lived token. Remove Hearth at myaccount.google.com/permissions and connect again." };
    const me: any = await (await this.fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${j.access_token}` } })).json().catch(() => ({}));
    const email = String(me.email || "").trim();
    if (!email) return { error: "Google didn't say which account that was. Try Connect again and allow seeing your email address." };
    const s = this.saved();
    const acct: Account = { email, refreshToken: j.refresh_token, connectedAt: new Date().toISOString(), scopes: String(j.scope || "").split(" ").filter(Boolean) };
    const i = s.accounts!.findIndex((a) => a.email.toLowerCase() === email.toLowerCase());
    if (i >= 0) s.accounts![i] = acct; else s.accounts!.push(acct);
    this.save(s);
    this.access.set(email, { token: j.access_token, until: Date.now() + (Number(j.expires_in) || 3600) * 1000 - 60_000 });
    this.problems.delete(email);
    return { value: { ...this.status(), added: email } };
  }

  /** Sign out of one account, or all of them when none is named. The client stays. */
  async disconnect(account?: string) {
    const s = this.saved();
    const gone = account ? s.accounts!.filter((a) => a.email.toLowerCase() === account.trim().toLowerCase()) : s.accounts!;
    for (const a of gone) {
      await this.fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(a.refreshToken)}`, { method: "POST" }).catch(() => {});
      this.access.delete(a.email); this.problems.delete(a.email);
    }
    const left = s.accounts!.filter((a) => !gone.includes(a));
    if (this.env.HEARTH_GOOGLE_CLIENT_ID && !left.length) this.vault?.delete("google");
    else this.save({ clientId: s.clientId, clientSecret: s.clientSecret, accounts: left });
    return this.status();
  }

  private async token(a: Account) {
    const cached = this.access.get(a.email);
    if (cached && cached.until > Date.now()) return cached.token;
    const c = this.client();
    if (!c) throw new Error("Google isn't connected. Connect it in Menu → Connections.");
    const res = await this.fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, refresh_token: a.refreshToken, grant_type: "refresh_token" }) });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) {
      // invalid_grant: revoked, or a Testing-mode client's 7-day token ran out.
      const msg = j.error === "invalid_grant" ? `Google signed Hearth out of ${a.email}. Reconnect it in Menu → Connections → Google.` : `Google token refresh failed for ${a.email} (${j.error || res.status}).`;
      this.problems.set(a.email, msg);
      throw new Error(msg);
    }
    this.access.set(a.email, { token: j.access_token, until: Date.now() + (Number(j.expires_in) || 3600) * 1000 - 60_000 });
    return j.access_token as string;
  }

  private async get(a: Account, url: string): Promise<any> {
    const res = await this.fetch(url, { headers: { Authorization: `Bearer ${await this.token(a)}` }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 401) this.access.delete(a.email);
    if (!res.ok) throw new Error(`Google answered ${res.status} for ${a.email}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  /** Run a read on each account. One account failing doesn't hide the others; it only throws when every one failed. */
  private async each<T>(accounts: Account[], fn: (a: Account) => Promise<T[]>): Promise<T[]> {
    const got = await Promise.allSettled(accounts.map(async (a) => { const r = await fn(a); this.problems.delete(a.email); return r; }));
    const ok = got.filter((r): r is PromiseFulfilledResult<T[]> => r.status === "fulfilled");
    if (!ok.length) throw (got[0] as PromiseRejectedResult).reason;
    for (const r of got) if (r.status === "rejected") console.warn(`google: ${r.reason?.message || r.reason}`);
    return ok.flatMap((r) => r.value);
  }

  /** Connected with permission to send, from that account (or any account). Older sign-ins need a reconnect. */
  canSend(account?: string) {
    try { return this.pick(account).some((a) => canSendWith(a.scopes)); } catch { return false; }
  }

  /** Send a plain-text email. `from` picks the account (default: the first that may send); `threadId` keeps a reply
   * in its conversation, and only means something in the account the mail came to. */
  async sendMail(to: string, subject: string, text: string, threadId?: string, from?: string) {
    const a = this.pick(from).find((x) => canSendWith(x.scopes));
    if (!a) throw new Error(`Google didn't allow sending${from ? ` from ${from}` : ""}. Reconnect it (Connectors → Google) and allow sending email.`);
    const enc = (v: string) => /[^\x20-\x7e]/.test(v) ? `=?UTF-8?B?${Buffer.from(v).toString("base64")}?=` : v;
    const raw = [`To: ${to}`, `Subject: ${enc(subject)}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit", "", text].join("\r\n");
    const res = await this.fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST", headers: { Authorization: `Bearer ${await this.token(a)}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ raw: Buffer.from(raw).toString("base64url"), ...(threadId ? { threadId } : {}) }),
    });
    if (res.status === 401) this.access.delete(a.email);
    if (res.status === 403) throw new Error(`Google didn't allow sending from ${a.email}. Reconnect it (Connectors → Google) and allow sending email.`);
    if (!res.ok) throw new Error(`Gmail answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return String((await res.json()).id || "");
  }

  /** Newest first, across every account (or just `account`). query is Gmail search syntax (from:school.org newer_than:2d…). */
  async searchMail(query: string, max = 10, account?: string): Promise<Mail[]> {
    const q = new URLSearchParams({ q: query || "in:inbox", maxResults: String(Math.min(25, Math.max(1, max))) });
    const all = await this.each<Mail>(this.pick(account), async (a) => {
      const list = await this.get(a, `https://gmail.googleapis.com/gmail/v1/users/me/messages?${q}`);
      return Promise.all((list.messages || []).map((m: any) => this.mailIn(a, m.id)));
    });
    const when = (m: Mail) => Date.parse(m.date) || 0;
    return all.sort((x, y) => when(y) - when(x)).slice(0, Math.max(1, max));
  }

  /** One email by id, from `account` (default: the first account). */
  async mail(id: string, account?: string): Promise<Mail> { return this.mailIn(this.pick(account)[0], id); }

  private async mailIn(a: Account, id: string): Promise<Mail> {
    const m = await this.get(a, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`);
    return { id: m.id, threadId: m.threadId, account: a.email, from: header(m, "from"), to: header(m, "to"), subject: header(m, "subject"), date: header(m, "date"),
      snippet: String(m.snippet || ""), text: mailText(m.payload), labels: m.labelIds || [] };
  }

  /** Events on each account's primary calendar (or just `account`'s) between two times, in start order (repeating
   * events expanded). A meeting on two of your calendars shows once. */
  async events(timeMin: Date, timeMax: Date, max = 50, account?: string): Promise<CalEvent[]> {
    const q = new URLSearchParams({ timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: String(Math.min(250, max)) });
    const all = await this.each<CalEvent>(this.pick(account), async (a) => {
      const j = await this.get(a, `https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`);
      return (j.items || []).filter((e: any) => e.status !== "cancelled").map((e: any): CalEvent => ({
        id: e.id, account: a.email, title: e.summary || "(no title)", start: e.start?.dateTime || e.start?.date || "", end: e.end?.dateTime || e.end?.date || "",
        allDay: !e.start?.dateTime, location: e.location || "", organizer: e.organizer?.email || "", created: e.created || "", updated: e.updated || "",
        status: e.status || "", myResponse: e.attendees?.find((a: any) => a.self)?.responseStatus || (e.organizer?.self ? "organizer" : ""),
        link: e.htmlLink || "", description: String(e.description || "").replace(/<[^>]+>/g, " ").slice(0, 800),
      }));
    });
    const seen = new Set<string>();
    const at = (e: CalEvent) => Date.parse(e.start) || 0;
    return all.sort((x, y) => at(x) - at(y)).filter((e) => !seen.has(e.id) && !!seen.add(e.id)).slice(0, max);
  }
}
