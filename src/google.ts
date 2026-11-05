import { randomBytes } from "node:crypto";
import type { Vault } from "./vault.ts";

// Your Google accounts, connected with your own OAuth client (no Hearth app, no middleman): you make a client in
// Google Cloud, paste its ID and secret, tap Connect, and Google hands this hub a refresh token. Connect again to add
// another account (personal and work Gmail…): one client, a token per account; reads cover all of them unless told one. The client secret and
// the tokens live in the hub's encrypted vault (vault.ts) with every other key, and never reach the model, the app or
// an export. Gmail (read, and send after your Approve), Calendar (read, and add events to your own calendar) and Drive
// (read everything; make new folders, Sheets and Docs, and change only the files Hearth made).

export const GOOGLE_SCOPES = [
  "openid", "email",
  "https://www.googleapis.com/auth/gmail.readonly",
  // Sending only ever happens after you tap Approve on the exact email (hub.requestMessage).
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.readonly",
  // Add, move and remove events on your calendars. Moving or removing one waits for your Approve (connectors/google-agent.ts).
  "https://www.googleapis.com/auth/calendar.events",
  // Find and read your files; nothing you made is changed, shared or deleted.
  "https://www.googleapis.com/auth/drive.readonly",
  // Make new files and folders, and change only those: Google itself keeps drive.file to the files this app created.
  // Replacing or trashing one of them waits for your Approve.
  "https://www.googleapis.com/auth/drive.file",
];
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const STATE_TTL_MS = 30 * 60_000;

type Account = { email: string; refreshToken: string; connectedAt: string; scopes: string[] };
// Before several accounts, one sign-in sat at the top level (refreshToken, email…); saved() lifts it into accounts.
type Saved = { clientId?: string; clientSecret?: string; accounts?: Account[]; refreshToken?: string; email?: string; connectedAt?: string; scopes?: string[] };
export type Mail = { id: string; threadId: string; account: string; from: string; to: string; subject: string; date: string; snippet: string; text: string; labels: string[] };
export type CalEvent = { id: string; account: string; title: string; start: string; end: string; allDay: boolean; location: string; organizer: string; created: string; updated: string; status: string; myResponse: string; link: string; description: string };
export type DriveFile = { id: string; account: string; name: string; mimeType: string; modified: string; owner: string; link: string; size: number };
const canSendWith = (scopes: string[]) => scopes.some((x) => x.endsWith("/gmail.send"));
const canDriveWith = (scopes: string[]) => scopes.some((x) => /\/auth\/drive(\.readonly)?$/.test(x));
const canDriveWriteWith = (scopes: string[]) => scopes.some((x) => /\/auth\/drive(\.file)?$/.test(x));
const canCalWriteWith = (scopes: string[]) => scopes.some((x) => /\/auth\/calendar(\.events)?$/.test(x));
/** Marks the events Hearth adds (shown in the Approve card: "an event Hearth added"). */
const MINE = "hearth";
export type NewEvent = { title: string; start: string; end: string; allDay?: boolean; location?: string; notes?: string };
// Google's own formats export to text; everything else is read only if it's text already.
const EXPORTS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain", "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};
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

/** fn over items, at most `n` running at once, results in order. */
async function inBatches<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

export class Google {
  /** Access tokens by account email (each lasts an hour). */
  private access = new Map<string, { token: string; until: number }>();
  /** The last error reading each account, so one signed-out account shows up instead of hiding behind the others. */
  private problems = new Map<string, string>();
  private states = new Map<string, { redirectUri: string; until: number }>();
  /** Swapped in tests. */
  fetch: (url: string, init?: RequestInit) => Promise<Response> = (url, init) => fetch(url, init);
  /** How long to wait before retrying a read Google turned away for going too fast (ms, doubled each try). Tests set 0. */
  retryMs = 1000;

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
      accounts: accounts.map((a) => ({ email: a.email, connectedAt: a.connectedAt, canSend: canSendWith(a.scopes), canDrive: canDriveWith(a.scopes), canDriveWrite: canDriveWriteWith(a.scopes), canCalendarWrite: canCalWriteWith(a.scopes), problem: this.problems.get(a.email) ?? null })) };
  }

  /** What the owner needs to fix, one line per account: signed out, or signed in before Hearth could send, read Drive,
   * save to Drive or add events (a sign-in only covers what Google showed on its consent screen then). */
  needs(): string[] {
    return this.status().accounts.flatMap((a) => {
      if (a.problem) return [a.problem];
      const missing = [!a.canSend && "sending email", !a.canDrive && "reading Drive", !a.canDriveWrite && "saving to Drive", !a.canCalendarWrite && "adding calendar events"].filter(Boolean);
      return missing.length ? [`Reconnect ${a.email} to allow ${missing.join(", ").replace(/, ([^,]*)$/, " and $1")}.`] : [];
    });
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

  /** A read. Google turns away too many at once for one user (429, or 403 rateLimitExceeded) even far under the daily
   * quota; those wait a moment and try again rather than failing the whole search. */
  private async get(a: Account, url: string): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(url, { headers: { Authorization: `Bearer ${await this.token(a)}` }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 401) this.access.delete(a.email);
      if (res.ok) return res.json();
      const text = await res.text();
      const tooFast = res.status === 429 || (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded|RATE_LIMIT_EXCEEDED/.test(text));
      if (tooFast && attempt < 3) {
        const after = Number(res.headers.get("retry-after"));
        await Bun.sleep(Math.min(after > 0 ? after * 1000 : this.retryMs * 2 ** attempt, 10_000));
        continue;
      }
      throw new Error(`Google answered ${res.status} for ${a.email}${tooFast ? " (too many requests at once; try again in a minute)" : ""}: ${text.slice(0, 200)}`);
    }
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

  /** Newest first, across every account (or just `account`). query is Gmail search syntax (from:school.org newer_than:2d…).
   * `bodies: false` fetches only headers and snippet (text comes back empty): lighter, for a list someone picks from.
   * Fetches a few emails at a time: all at once trips Gmail's per-user limit on requests in flight. */
  async searchMail(query: string, max = 10, account?: string, opts: { bodies?: boolean } = {}): Promise<Mail[]> {
    const q = new URLSearchParams({ q: query || "in:inbox", maxResults: String(Math.min(25, Math.max(1, max))) });
    const all = await this.each<Mail>(this.pick(account), async (a) => {
      const list = await this.get(a, `https://gmail.googleapis.com/gmail/v1/users/me/messages?${q}`);
      return inBatches((list.messages || []) as any[], 5, (m) => this.mailIn(a, m.id, opts.bodies !== false));
    });
    const when = (m: Mail) => Date.parse(m.date) || 0;
    return all.sort((x, y) => when(y) - when(x)).slice(0, Math.max(1, max));
  }

  /** One email by id, from `account` (default: the first account). */
  async mail(id: string, account?: string): Promise<Mail> { return this.mailIn(this.pick(account)[0], id); }

  private async mailIn(a: Account, id: string, body = true): Promise<Mail> {
    const how = body ? "format=full" : "format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date";
    const m = await this.get(a, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?${how}`);
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

  /** Accounts that allowed Drive (sign-ins from before Drive need a reconnect). Naming one without it is an error. */
  private driveAccounts(account?: string) {
    const picked = this.pick(account), ok = picked.filter((a) => canDriveWith(a.scopes));
    if (!ok.length) throw new Error(`Google Drive isn't allowed${account ? ` for ${account}` : ""} yet. Reconnect ${account || "your account"} in Connectors → Google and allow Drive.`);
    return ok;
  }
  canDrive(account?: string) { try { return this.driveAccounts(account).length > 0; } catch { return false; } }

  /** Files across every account that allowed Drive (or just `account`), most recently changed first. `search` is plain
   * words (matched in names and contents); `days` keeps only files changed that recently. Trashed files are left out. */
  async files(search: string, max = 10, account?: string, days?: number): Promise<DriveFile[]> {
    const terms = String(search || "").trim().slice(0, 200).replace(/\\/g, "").replace(/'/g, "\\'");
    const since = days ? new Date(Date.now() - days * 86_400_000).toISOString() : "";
    const q = ["trashed = false", terms && `(name contains '${terms}' or fullText contains '${terms}')`, since && `modifiedTime > '${since}'`].filter(Boolean).join(" and ");
    const n = Math.min(50, Math.max(1, max));
    const params = new URLSearchParams({ q, pageSize: String(n), fields: "files(id,name,mimeType,modifiedTime,owners(emailAddress),webViewLink,size)",
      // fullText search can't be sorted; Google ranks it by relevance then.
      ...(terms ? {} : { orderBy: "modifiedTime desc" }), includeItemsFromAllDrives: "true", supportsAllDrives: "true", corpora: "allDrives" });
    const all = await this.each<DriveFile>(this.driveAccounts(account), async (a) => {
      const j = await this.get(a, `https://www.googleapis.com/drive/v3/files?${params}`);
      return (j.files || []).map((f: any): DriveFile => ({ id: f.id, account: a.email, name: f.name || "(untitled)", mimeType: f.mimeType || "",
        modified: f.modifiedTime || "", owner: f.owners?.[0]?.emailAddress || "", link: f.webViewLink || "", size: Number(f.size) || 0 }));
    });
    const at = (f: DriveFile) => Date.parse(f.modified) || 0;
    const seen = new Set<string>();
    return all.sort((x, y) => at(y) - at(x)).filter((f) => !seen.has(f.id) && !!seen.add(f.id)).slice(0, n);
  }

  /** A file's text (Docs as text, Sheets as CSV, text files as they are), capped; "" for things that aren't text. */
  async fileText(f: Pick<DriveFile, "id" | "mimeType" | "account" | "size">, max = 4000): Promise<string> {
    const a = this.driveAccounts(f.account)[0];
    const exp = EXPORTS[f.mimeType];
    const isText = /^text\/|^application\/(json|xml|csv)/.test(f.mimeType);
    if (!exp && !(isText && f.size <= 2_000_000)) return "";
    const url = exp ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(f.id)}/export?mimeType=${encodeURIComponent(exp)}`
      : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(f.id)}?alt=media&supportsAllDrives=true`;
    const res = await this.fetch(url, { headers: { Authorization: `Bearer ${await this.token(a)}` }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 401) this.access.delete(a.email);
    if (!res.ok) return "";
    return (await res.text()).replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
  }

  // ---------- for the agent's Gmail, Drive and Calendar commands (connectors/google-agent.ts) ----------

  private async call(a: Account, url: string, init: RequestInit = {}): Promise<any> {
    const res = await this.fetch(url, { ...init, headers: { Authorization: `Bearer ${await this.token(a)}`, ...(init.headers as any) }, signal: AbortSignal.timeout(60_000) });
    if (res.status === 401) this.access.delete(a.email);
    if (!res.ok) {
      const text = await res.text();
      // The owner's Google Cloud project has this API switched off (each API is off until turned on there).
      if (res.status === 403 && /SERVICE_DISABLED|has not been used in project|is disabled/.test(text)) {
        const u = new URL(url);
        const [api, name] = u.host.startsWith("sheets") ? ["sheets", "Sheets API"] : u.host.startsWith("gmail") ? ["gmail", "Gmail API"] : u.pathname.includes("/calendar/") ? ["calendar-json", "Calendar API"] : ["drive", "Drive API"];
        const project = text.match(/project[ =](\d+)/)?.[1];
        throw new Error(`The ${name} is switched off in the owner's Google Cloud project. They turn it on once at https://console.cloud.google.com/apis/library/${api}.googleapis.com${project ? `?project=${project}` : ""}, wait a minute, then ask again.`);
      }
      throw new Error(`Google answered ${res.status} for ${a.email}: ${text.slice(0, 300)}`);
    }
    return res.status === 204 ? {} : res.json().catch(() => ({}));
  }

  /** The first account (or the named one) whose sign-in allows `ok`; else an error that says to reconnect and allow it. */
  private writer(account: string | undefined, ok: (scopes: string[]) => boolean, what: string): Account {
    const a = this.pick(account).find((x) => ok(x.scopes));
    if (!a) throw new Error(`Google doesn't let Hearth ${what}${account ? ` for ${account}` : ""} yet. The owner reconnects ${account || "the account"} in Connectors → Google and allows it.`);
    return a;
  }

  /** Every email in a conversation, oldest first. */
  async thread(threadId: string, account?: string): Promise<Mail[]> {
    const a = this.pick(account)[0];
    const t = await this.get(a, `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=full`);
    return (t.messages || []).map((m: any): Mail => ({ id: m.id, threadId: m.threadId, account: a.email, from: header(m, "from"), to: header(m, "to"), subject: header(m, "subject"),
      date: header(m, "date"), snippet: String(m.snippet || ""), text: mailText(m.payload, 8000), labels: m.labelIds || [] }));
  }

  /** One file's details by id, from whichever account can see it. */
  async file(id: string, account?: string): Promise<DriveFile> {
    const fields = "id,name,mimeType,modifiedTime,owners(emailAddress),webViewLink,size";
    let last: unknown = null;
    for (const a of this.driveAccounts(account)) {
      try {
        const f = await this.get(a, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=${fields}&supportsAllDrives=true`);
        return { id: f.id, account: a.email, name: f.name || "(untitled)", mimeType: f.mimeType || "", modified: f.modifiedTime || "", owner: f.owners?.[0]?.emailAddress || "", link: f.webViewLink || "", size: Number(f.size) || 0 };
      } catch (e) { last = e; }
    }
    throw last instanceof Error ? last : new Error(`No connected account can see file ${id}.`);
  }

  /** A new file in Drive (in `folder`, else My Drive). `as` turns the content into a Google Sheet (from CSV) or Doc (from
   * text); without it the content is saved as it is. A folder when mimeType is a folder and there's no content. */
  async createFile(o: { name: string; content?: string | Uint8Array; contentType?: string; as?: "sheet" | "doc" | "folder"; folder?: string; account?: string }): Promise<DriveFile> {
    const a = this.writer(o.account, canDriveWriteWith, "save to Drive");
    const target = o.as === "sheet" ? "application/vnd.google-apps.spreadsheet" : o.as === "doc" ? "application/vnd.google-apps.document" : o.as === "folder" ? "application/vnd.google-apps.folder" : undefined;
    const meta = { name: o.name, ...(target ? { mimeType: target } : {}), ...(o.folder ? { parents: [o.folder] } : {}) };
    const fields = "id,name,mimeType,modifiedTime,owners(emailAddress),webViewLink,size";
    let f: any;
    if (o.as === "folder") {
      f = await this.call(a, `https://www.googleapis.com/drive/v3/files?fields=${fields}&supportsAllDrives=true`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(meta) });
    } else {
      const boundary = `hearth${randomBytes(12).toString("hex")}`;
      const type = o.contentType || (o.as === "sheet" ? "text/csv" : "text/plain");
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: ${type}\r\n\r\n`),
        Buffer.from(o.content ?? ""), Buffer.from(`\r\n--${boundary}--`)]);
      f = await this.call(a, `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=${fields}&supportsAllDrives=true`,
        { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body });
    }
    return { id: f.id, account: a.email, name: f.name || o.name, mimeType: f.mimeType || "", modified: f.modifiedTime || "", owner: f.owners?.[0]?.emailAddress || "", link: f.webViewLink || "", size: Number(f.size) || 0 };
  }

  /** Replace a file's content (one Hearth made: Google refuses the rest). A Sheet takes CSV, a Doc takes text. */
  async replaceFile(id: string, content: string, account?: string): Promise<DriveFile> {
    const a = this.writer(account, canDriveWriteWith, "change files in Drive");
    const cur = await this.file(id, a.email);
    const type = cur.mimeType === "application/vnd.google-apps.spreadsheet" ? "text/csv" : cur.mimeType.startsWith("application/vnd.google-apps.") ? "text/plain" : cur.mimeType || "text/plain";
    await this.call(a, `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(id)}?uploadType=media&supportsAllDrives=true`, { method: "PATCH", headers: { "Content-Type": type }, body: content });
    return this.file(id, a.email);
  }

  /** Add rows to the end of a Google Sheet's first tab (or `tab`). Values are read as if typed (numbers, dates). */
  async appendRows(id: string, rows: string[][], tab?: string, account?: string): Promise<{ updatedRange: string; rows: number }> {
    const a = this.writer(account, canDriveWriteWith, "change files in Drive");
    const range = encodeURIComponent(tab ? `'${tab.replace(/'/g, "''")}'!A1` : "A1");
    const j = await this.call(a, `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values: rows }) });
    return { updatedRange: String(j.updates?.updatedRange || ""), rows: Number(j.updates?.updatedRows) || rows.length };
  }

  /** Add an event to the owner's own calendar. No guests: inviting people emails them, which the owner approves themselves. */
  async addEvent(e: NewEvent, account?: string): Promise<CalEvent> {
    const a = this.writer(account, canCalWriteWith, "add calendar events");
    const when = (v: string) => (e.allDay ? { date: v.slice(0, 10) } : { dateTime: new Date(v).toISOString() });
    const body = { summary: e.title, start: when(e.start), end: when(e.end), ...(e.location ? { location: e.location } : {}), ...(e.notes ? { description: e.notes } : {}),
      extendedProperties: { private: { [MINE]: "1" } } };
    const j = await this.call(a, "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return this.calEvent(a, j);
  }

  /** One event on the primary calendar, with what an Approve card needs to say: other guests, who organizes it, Hearth's or not. */
  async event(id: string, account?: string): Promise<CalEvent & { guests: number; organizerSelf: boolean; hearths: boolean }> {
    const a = this.writer(account, canCalWriteWith, "change calendar events");
    const e = await this.call(a, `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`);
    return { ...this.calEvent(a, e), guests: (e.attendees || []).filter((x: any) => !x.self && !x.resource).length, organizerSelf: !!e.organizer?.self || !e.organizer, hearths: e.extendedProperties?.private?.[MINE] === "1" };
  }

  /** Move, rename or remove an event (only after the owner's Approve; see google-agent.ts). When the owner organizes a
   * meeting with guests, Google emails them the change, so their calendars aren't changed silently. Removing a meeting
   * someone else organizes takes it off the owner's calendar (Google tells the organizer they declined). */
  async changeEvent(id: string, change: Partial<NewEvent> | "delete", account?: string): Promise<CalEvent | { deleted: string }> {
    const a = this.writer(account, canCalWriteWith, "change calendar events");
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`;
    const cur = await this.call(a, url);
    const notify = (cur.attendees || []).some((x: any) => !x.self && !x.resource) && (cur.organizer?.self ?? true) ? "all" : "none";
    if (change === "delete") { await this.call(a, `${url}?sendUpdates=${notify}`, { method: "DELETE" }); return { deleted: id }; }
    const allDay = change.allDay ?? !cur.start?.dateTime;
    const when = (v: string) => (allDay ? { date: v.slice(0, 10) } : { dateTime: new Date(v).toISOString() });
    const patch = { ...(change.title ? { summary: change.title } : {}), ...(change.start ? { start: when(change.start) } : {}), ...(change.end ? { end: when(change.end) } : {}),
      ...(change.location !== undefined ? { location: change.location } : {}), ...(change.notes !== undefined ? { description: change.notes } : {}) };
    const j = await this.call(a, `${url}?sendUpdates=${notify}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    return this.calEvent(a, j);
  }

  /** Move a file Hearth made to Drive's trash (the owner can restore it there for 30 days). Others' files: Google refuses. */
  async trashFile(id: string, account?: string): Promise<{ trashed: string }> {
    const a = this.writer(account, canDriveWriteWith, "change files in Drive");
    try {
      await this.call(a, `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) });
    } catch (e: any) {
      if (/answered (403|404)/.test(String(e?.message))) throw new Error("Hearth can only trash files it made. The owner can trash this one in Drive.");
      throw e;
    }
    return { trashed: id };
  }

  private calEvent(a: Account, e: any): CalEvent {
    return { id: e.id, account: a.email, title: e.summary || "(no title)", start: e.start?.dateTime || e.start?.date || "", end: e.end?.dateTime || e.end?.date || "",
      allDay: !e.start?.dateTime, location: e.location || "", organizer: e.organizer?.email || "", created: e.created || "", updated: e.updated || "", status: e.status || "",
      myResponse: e.organizer?.self ? "organizer" : "", link: e.htmlLink || "", description: String(e.description || "").slice(0, 800) };
  }
}
