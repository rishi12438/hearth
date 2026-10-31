import { randomBytes } from "node:crypto";
import type { Vault } from "./vault.ts";

// Your Google account, connected with your own OAuth client (no Hearth app, no middleman): you make a client in
// Google Cloud, paste its ID and secret, tap Connect, and Google hands this hub a refresh token. The client secret and
// the token live in the hub's encrypted vault (vault.ts) with every other key, and never reach the model, the app or
// an export. Read-only: Gmail and Calendar.

export const GOOGLE_SCOPES = [
  "openid", "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const STATE_TTL_MS = 10 * 60_000;

type Saved = { clientId?: string; clientSecret?: string; refreshToken?: string; email?: string; connectedAt?: string; scopes?: string[] };
export type Mail = { id: string; threadId: string; from: string; to: string; subject: string; date: string; snippet: string; text: string; labels: string[] };
export type CalEvent = { id: string; title: string; start: string; end: string; allDay: boolean; location: string; organizer: string; created: string; updated: string; status: string; myResponse: string; link: string; description: string };

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
  private access: { token: string; until: number } | null = null;
  private states = new Map<string, { redirectUri: string; until: number }>();
  /** Swapped in tests. */
  fetch: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init);

  /** No vault (a hub without one, as in some tests): nothing saved, and saving says why. */
  constructor(private vault: Vault | null, private env: Record<string, string | undefined> = process.env) {}

  private saved(): Saved { try { return JSON.parse(this.vault?.get("google") || "{}"); } catch { return {}; } }
  private save(s: Saved) {
    if (!this.vault) throw new Error("This hub has no key vault.");
    this.vault.set("google", JSON.stringify(s));
  }
  private client() {
    const s = this.saved();
    const id = this.env.HEARTH_GOOGLE_CLIENT_ID || s.clientId, secret = this.env.HEARTH_GOOGLE_CLIENT_SECRET || s.clientSecret;
    return id && secret ? { id, secret } : null;
  }

  get connected() { return !!this.saved().refreshToken && !!this.client(); }

  /** What the app may see: never the secret or a token. */
  status() {
    const s = this.saved(), c = this.client();
    return { hasClient: !!c, clientFromEnv: !!this.env.HEARTH_GOOGLE_CLIENT_ID, clientIdHint: c ? `${c.id.slice(0, 12)}…` : null,
      connected: this.connected, email: s.email || null, connectedAt: s.connectedAt || null, scopes: s.scopes || [] };
  }

  setClient(id: string, secret: string) {
    if (this.env.HEARTH_GOOGLE_CLIENT_ID) return { error: "This hub's Google client is set in its .env." };
    if (!this.vault) return { error: "This hub has no key vault." };
    const cid = String(id || "").trim(), cs = String(secret || "").trim();
    if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(cid)) return { error: "That doesn't look like a Google client ID (it ends in .apps.googleusercontent.com)." };
    if (cs.length < 10 || /\s/.test(cs)) return { error: "That doesn't look like a client secret." };
    const s = this.saved();
    // A new client can't use the old client's token.
    this.save(s.clientId === cid ? { ...s, clientSecret: cs } : { clientId: cid, clientSecret: cs });
    this.access = null;
    return { value: this.status() };
  }

  /** Step 1: where to send the browser. The state ties Google's answer to this request. */
  authUrl(redirectUri: string) {
    const c = this.client();
    if (!c) return { error: "Add your Google client ID and secret first." };
    const now = Date.now();
    for (const [k, v] of this.states) if (v.until < now) this.states.delete(k);
    const state = randomBytes(18).toString("base64url");
    this.states.set(state, { redirectUri, until: now + STATE_TTL_MS });
    const q = new URLSearchParams({ client_id: c.id, redirect_uri: redirectUri, response_type: "code", scope: GOOGLE_SCOPES.join(" "),
      access_type: "offline", prompt: "consent", include_granted_scopes: "true", state });
    return { value: `${AUTH_URL}?${q}` };
  }

  /** Step 2: Google sent the browser back with a code; trade it for tokens. */
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
    this.access = { token: j.access_token, until: Date.now() + (Number(j.expires_in) || 3600) * 1000 - 60_000 };
    const me: any = await (await this.fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${j.access_token}` } })).json().catch(() => ({}));
    this.save({ ...this.saved(), refreshToken: j.refresh_token, email: me.email || undefined, connectedAt: new Date().toISOString(), scopes: String(j.scope || "").split(" ").filter(Boolean) });
    return { value: this.status() };
  }

  async disconnect() {
    const s = this.saved();
    if (s.refreshToken) await this.fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(s.refreshToken)}`, { method: "POST" }).catch(() => {});
    this.access = null;
    if (this.env.HEARTH_GOOGLE_CLIENT_ID) this.vault?.delete("google");
    else this.save({ clientId: s.clientId, clientSecret: s.clientSecret });
    return this.status();
  }

  private async token() {
    if (this.access && this.access.until > Date.now()) return this.access.token;
    const s = this.saved(), c = this.client();
    if (!s.refreshToken || !c) throw new Error("Google isn't connected. Connect it in Menu → Connections.");
    const res = await this.fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, refresh_token: s.refreshToken, grant_type: "refresh_token" }) });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || !j.access_token) {
      // invalid_grant: revoked, or a Testing-mode client's 7-day token ran out.
      throw new Error(j.error === "invalid_grant" ? "Google signed Hearth out. Connect Google again in Menu → Connections." : `Google token refresh failed (${j.error || res.status}).`);
    }
    this.access = { token: j.access_token, until: Date.now() + (Number(j.expires_in) || 3600) * 1000 - 60_000 };
    return this.access.token;
  }

  private async get(url: string): Promise<any> {
    const res = await this.fetch(url, { headers: { Authorization: `Bearer ${await this.token()}` }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 401) this.access = null;
    if (!res.ok) throw new Error(`Google answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  /** Newest first. query is Gmail search syntax (from:school.org newer_than:2d…). */
  async searchMail(query: string, max = 10): Promise<Mail[]> {
    const q = new URLSearchParams({ q: query || "in:inbox", maxResults: String(Math.min(25, Math.max(1, max))) });
    const list = await this.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${q}`);
    const ids: string[] = (list.messages || []).map((m: any) => m.id);
    return Promise.all(ids.map((id) => this.mail(id)));
  }

  async mail(id: string): Promise<Mail> {
    const m = await this.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`);
    return { id: m.id, threadId: m.threadId, from: header(m, "from"), to: header(m, "to"), subject: header(m, "subject"), date: header(m, "date"),
      snippet: String(m.snippet || ""), text: mailText(m.payload), labels: m.labelIds || [] };
  }

  /** Events on your primary calendar between two times, in start order (repeating events expanded). */
  async events(timeMin: Date, timeMax: Date, max = 50): Promise<CalEvent[]> {
    const q = new URLSearchParams({ timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: String(Math.min(250, max)) });
    const j = await this.get(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`);
    return (j.items || []).filter((e: any) => e.status !== "cancelled").map((e: any): CalEvent => ({
      id: e.id, title: e.summary || "(no title)", start: e.start?.dateTime || e.start?.date || "", end: e.end?.dateTime || e.end?.date || "",
      allDay: !e.start?.dateTime, location: e.location || "", organizer: e.organizer?.email || "", created: e.created || "", updated: e.updated || "",
      status: e.status || "", myResponse: e.attendees?.find((a: any) => a.self)?.responseStatus || (e.organizer?.self ? "organizer" : ""),
      link: e.htmlLink || "", description: String(e.description || "").replace(/<[^>]+>/g, " ").slice(0, 800),
    }));
  }
}
