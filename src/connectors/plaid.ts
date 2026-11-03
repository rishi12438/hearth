import type { Vault } from "../vault.ts";
import type { Source, Item } from "../sources/index.ts";
import type { Connector } from "./types.ts";
import { hint } from "./types.ts";

// Plaid: your bank accounts and credit cards (Chase, Discover…), read-only.
// 1. Your own Plaid keys (dashboard.plaid.com → Developers → Keys): client_id + the secret for Sandbox or Production.
//    A free Trial plan gets real Production data for 10 bank logins ("Items"). Removing one doesn't give the slot back.
// 2. "Add a bank": the hub asks Plaid for a Hosted Link page (Plaid draws the bank's own sign-in, OAuth included), you
//    finish it in your browser, and the hub picks the result up from /link/token/get — no webhook, no script in the app.
// 3. The access token for each bank stays in the vault. Balances come from /accounts/get, transactions from
//    /transactions/get, card details (statement balance, minimum due, APR) from /liabilities/get when Plaid allows it.

export type PlaidEnv = "sandbox" | "production";
type Creds = { clientId: string; secret: string; env: PlaidEnv };
type Account = { id: string; name: string; mask: string | null; type: string; subtype: string | null };
export type SavedItem = {
  itemId: string; accessToken: string; institution: { id: string | null; name: string }; accounts: Account[]; addedAt: string;
  /** Plaid's error code when it last failed (ITEM_LOGIN_REQUIRED means: reconnect it). */
  error?: string | null;
};

const BASE: Record<PlaidEnv, string> = { sandbox: "https://sandbox.plaid.com", production: "https://production.plaid.com" };
/** Plaid error codes that mean the bank wants you to sign in again (update mode fixes it, no new Item). */
const RELOGIN = new Set(["ITEM_LOGIN_REQUIRED", "PENDING_EXPIRATION", "PENDING_DISCONNECT", "ACCESS_NOT_GRANTED", "INSUFFICIENT_CREDENTIALS"]);

export class PlaidError extends Error {
  constructor(public code: string, message: string, public type = "") { super(message); }
}

const money = (n: number | null | undefined, cur?: string | null) =>
  n == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: cur || "USD" }).format(n);
const day = (d: Date) => d.toISOString().slice(0, 10);

export class Plaid {
  /** Link sessions this hub started, so a check only ever finishes our own (lost on restart; just add again). */
  private pending = new Map<string, { update: string | null; at: number }>();

  constructor(private vault: Vault | null, private fetcher: typeof fetch = fetch) {}

  creds(): Creds | null { try { const v = this.vault?.get("plaid"); return v ? JSON.parse(v) : null; } catch { return null; } }
  items(): SavedItem[] { try { return JSON.parse(this.vault?.get("plaid:items") || "[]"); } catch { return []; } }
  private saveItems(list: SavedItem[]) { this.vault!.set("plaid:items", JSON.stringify(list)); }
  connected() { return !!this.creds() && this.items().length > 0; }
  needsYou() { return this.items().filter((i) => i.error && RELOGIN.has(i.error)); }

  async call(path: string, body: Record<string, unknown>, c: Creds | null = this.creds()): Promise<any> {
    if (!c) throw new PlaidError("NOT_SET_UP", "Plaid isn't set up. Add your Plaid keys first.");
    let r: Response;
    try {
      r = await this.fetcher(`${BASE[c.env]}${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: c.clientId, secret: c.secret, ...body }), signal: AbortSignal.timeout(30_000),
      });
    } catch { throw new PlaidError("NETWORK", "Couldn't reach Plaid."); }
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || j.error_code) throw new PlaidError(String(j.error_code || `HTTP_${r.status}`), String(j.display_message || j.error_message || `Plaid answered ${r.status}.`), String(j.error_type || ""));
    return j;
  }

  /** Are these keys good? One small read that needs them. */
  async check(c: Creds): Promise<string | null> {
    try { await this.call("/institutions/get", { count: 1, offset: 0, country_codes: ["US"] }, c); return null; }
    catch (e: any) {
      if (e.code === "INVALID_API_KEYS") return `Plaid didn't accept those keys for ${c.env === "sandbox" ? "Sandbox" : "Production"}. Each environment has its own secret.`;
      return e.message;
    }
  }

  saveCreds(c: Creds) { this.vault!.set("plaid", JSON.stringify(c)); }

  /** A Plaid Hosted Link page to add a bank (or, with `update`, sign an existing one in again: no new Item). */
  async startLink(update: string | null = null): Promise<{ url: string; token: string; expiresAt: string }> {
    const item = update ? this.items().find((i) => i.itemId === update) : null;
    if (update && !item) throw new PlaidError("NOT_FOUND", "That bank isn't connected.");
    const base: Record<string, unknown> = {
      client_name: "Hearth", language: "en", country_codes: ["US"], user: { client_user_id: "hearth-owner" },
      hosted_link: { url_lifetime_seconds: 30 * 60 },
    };
    const create = (extra: Record<string, unknown>) => this.call("/link/token/create", { ...base, ...extra });
    let j: any;
    if (item) j = await create({ access_token: item.accessToken });
    else {
      // Card details if the plan allows them; plain transactions if it doesn't.
      try { j = await create({ products: ["transactions"], optional_products: ["liabilities"], transactions: { days_requested: 90 } }); }
      catch (e: any) {
        if (e.type !== "INVALID_REQUEST" && e.type !== "INVALID_INPUT" && !/PRODUCT/.test(e.code)) throw e;
        j = await create({ products: ["transactions"], transactions: { days_requested: 90 } });
      }
    }
    if (!j.hosted_link_url) throw new PlaidError("NO_HOSTED_LINK", "Plaid didn't give a Hosted Link page for this account.");
    this.pending.set(j.link_token, { update, at: Date.now() });
    for (const [t, p] of this.pending) if (Date.now() - p.at > 60 * 60_000) this.pending.delete(t);
    return { url: j.hosted_link_url, token: j.link_token, expiresAt: j.expiration };
  }

  /** Has the Hosted Link session finished? Then swap each public token for an access token and keep the bank. */
  async finishLink(token: string): Promise<{ done: boolean; exited?: boolean; added: { institution: string; accounts: number }[]; error?: string }> {
    const p = this.pending.get(token);
    if (!p) throw new PlaidError("UNKNOWN_LINK", "That link isn't one this hub started. Start again.");
    const j = await this.call("/link/token/get", { link_token: token });
    const sessions: any[] = j.link_sessions || [];
    const finished = sessions.filter((s) => s.finished_at);
    if (!finished.length) return { done: false, added: [] };
    const results = finished.flatMap((s) => s.results?.item_add_results || []);
    const exit = finished.find((s) => s.exit)?.exit;
    const added: { institution: string; accounts: number }[] = [];
    if (p.update) {
      // Update mode: the same Item, signed in again. Nothing to exchange.
      if (!exit || !exit.error) this.saveItems(this.items().map((i) => (i.itemId === p.update ? { ...i, error: null } : i)));
    } else {
      for (const r of results) {
        if (!r.public_token) continue;
        const x = await this.call("/item/public_token/exchange", { public_token: r.public_token });
        const item: SavedItem = {
          itemId: String(x.item_id), accessToken: String(x.access_token),
          institution: { id: r.institution?.institution_id ?? null, name: String(r.institution?.name || "Your bank") },
          accounts: (r.accounts || []).map((a: any) => ({ id: String(a.id), name: String(a.name || ""), mask: a.mask ?? null, type: String(a.type || ""), subtype: a.subtype ?? null })),
          addedAt: new Date().toISOString(), error: null,
        };
        this.saveItems([...this.items().filter((i) => i.itemId !== item.itemId), item]);
        added.push({ institution: item.institution.name, accounts: item.accounts.length });
      }
    }
    this.pending.delete(token);
    const error = exit?.error ? String(exit.error.display_message || exit.error.error_message || exit.error.error_code || "") : undefined;
    return { done: true, exited: !results.length && !p.update, added, ...(error ? { error } : {}) };
  }

  /** Remember a failure on an Item, so the tile can say "Needs you" and offer Reconnect. */
  private mark(itemId: string, code: string | null) {
    const list = this.items();
    const i = list.find((x) => x.itemId === itemId);
    if (i && (i.error ?? null) !== code) { i.error = code; this.saveItems(list); }
  }
  private async perItem<T>(fn: (i: SavedItem) => Promise<T>): Promise<{ item: SavedItem; value?: T; error?: PlaidError }[]> {
    return Promise.all(this.items().map(async (item) => {
      try { const value = await fn(item); this.mark(item.itemId, null); return { item, value }; }
      catch (e: any) {
        const err = e instanceof PlaidError ? e : new PlaidError("UNKNOWN", String(e?.message || e));
        if (RELOGIN.has(err.code)) this.mark(item.itemId, err.code);
        return { item, error: err };
      }
    }));
  }

  /** Every account with its balance (Plaid's last-known balance: /accounts/get is free; /accounts/balance/get isn't). */
  async accounts() {
    return this.perItem(async (item) => (await this.call("/accounts/get", { access_token: item.accessToken })).accounts.map((a: any) => ({
      id: String(a.account_id), name: String(a.name || a.official_name || ""), mask: a.mask ?? null, type: String(a.type || ""), subtype: a.subtype ?? null,
      current: a.balances?.current ?? null, available: a.balances?.available ?? null, limit: a.balances?.limit ?? null, currency: a.balances?.iso_currency_code ?? "USD",
    })));
  }

  /** Recent transactions across every bank, newest first. Positive amount = money out (Plaid's convention). */
  async transactions(days = 30, limit = 50) {
    const end = new Date(), start = new Date(Date.now() - days * 864e5);
    const all = await this.perItem(async (item) => {
      const j = await this.call("/transactions/get", { access_token: item.accessToken, start_date: day(start), end_date: day(end), options: { count: Math.min(limit, 500) } });
      const names = new Map<string, string>((j.accounts || []).map((a: any) => [String(a.account_id), `${a.name || "Account"}${a.mask ? ` ••${a.mask}` : ""}`]));
      return (j.transactions || []).map((t: any) => ({
        id: String(t.transaction_id), date: String(t.date), amount: Number(t.amount), currency: t.iso_currency_code || "USD",
        merchant: String(t.merchant_name || t.name || "Unknown"), pending: !!t.pending, category: t.personal_finance_category?.primary ?? null,
        account: `${item.institution.name} · ${names.get(String(t.account_id)) || "account"}`,
      }));
    });
    const list = all.flatMap((r) => r.value || []).sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
    return { list, errors: all.filter((r) => r.error).map((r) => ({ institution: r.item.institution.name, code: r.error!.code, message: r.error!.message })) };
  }

  /** Credit card details, where the plan and the bank allow Liabilities. Quietly empty otherwise. */
  async cards() {
    const all = await this.perItem(async (item) => {
      if (!item.accounts.some((a) => a.type === "credit")) return [];
      try {
        const j = await this.call("/liabilities/get", { access_token: item.accessToken });
        const accts = new Map<string, any>((j.accounts || []).map((a: any) => [String(a.account_id), a]));
        return (j.liabilities?.credit || []).map((c: any) => {
          const a = accts.get(String(c.account_id));
          return {
            account: `${item.institution.name} · ${a?.name || "Card"}${a?.mask ? ` ••${a.mask}` : ""}`,
            balance: a?.balances?.current ?? null, limit: a?.balances?.limit ?? null,
            statement: c.last_statement_balance ?? null, minimum: c.minimum_payment_amount ?? null, due: c.next_payment_due_date ?? null,
            apr: (c.aprs || []).find((x: any) => x.apr_type === "purchase_apr")?.apr_percentage ?? null, overdue: !!c.is_overdue,
          };
        });
      } catch (e: any) { if (RELOGIN.has(e.code)) throw e; return []; } // no Liabilities on this plan / for this bank
    });
    return all.flatMap((r) => r.value || []);
  }

  /** Proof it reads: each bank with its accounts and balances, a few recent transactions, card details if any. */
  async probe() {
    if (!this.creds()) return { ok: false, error: "Plaid isn't set up." };
    const [accts, tx, cards] = await Promise.all([this.accounts(), this.transactions(30, 8), this.cards()]);
    return {
      ok: true, env: this.creds()!.env,
      banks: accts.map((r) => ({
        itemId: r.item.itemId, institution: r.item.institution.name, addedAt: r.item.addedAt,
        needsLogin: !!r.error && RELOGIN.has(r.error.code), error: r.error ? (r.error.code === "PRODUCT_NOT_READY" ? null : r.error.message) : null,
        accounts: (r.value || []).map((a: any) => ({ ...a, line: `${a.name}${a.mask ? ` ••${a.mask}` : ""}`, balanceText: money(a.current, a.currency) })),
      })),
      recent: tx.list.map((t) => line(t)),
      cards: cards.map((c: any) => ({ ...c, text: `${c.account}: ${money(c.balance)} owed${c.statement != null ? ` · statement ${money(c.statement)}` : ""}${c.minimum != null ? ` · min ${money(c.minimum)}` : ""}${c.due ? ` due ${c.due}` : ""}${c.apr != null ? ` · ${c.apr}% APR` : ""}` })),
      txNote: tx.errors.some((e) => e.code === "PRODUCT_NOT_READY") ? "Plaid is still pulling transactions for a new bank. They show up within a few minutes." : null,
    };
  }

  /** Stop reading one bank: Plaid ends the Item (on a Trial plan this does NOT free its slot). */
  async removeItem(itemId: string) {
    const item = this.items().find((i) => i.itemId === itemId);
    if (!item) throw new PlaidError("NOT_FOUND", "That bank isn't connected.");
    await this.call("/item/remove", { access_token: item.accessToken }).catch((e) => { if (e.code !== "ITEM_NOT_FOUND" && e.code !== "INVALID_ACCESS_TOKEN") throw e; });
    this.saveItems(this.items().filter((i) => i.itemId !== itemId));
  }

  /** Forget the keys too. Banks stay connected at Plaid only if removing them failed. */
  async removeAll(): Promise<string | null> {
    for (const i of this.items()) await this.removeItem(i.itemId).catch(() => {});
    if (this.items().length) return "Plaid wouldn't let go of every bank. Try again.";
    this.vault?.delete("plaid"); this.vault?.delete("plaid:items");
    return null;
  }
}

type Tx = { date: string; amount: number; currency: string; merchant: string; pending: boolean; account: string };
/** "$12.34 at Starbucks" (money out) or "+$500.00 from Payroll" (money in). */
export const line = (t: Tx) => `${t.date} · ${t.amount >= 0 ? `${money(t.amount, t.currency)} at` : `+${money(-t.amount, t.currency)} from`} ${t.merchant}${t.pending ? " (pending)" : ""} · ${t.account}`;

/** Plaid as a trigger: new transactions, optionally only big ones. */
export function plaidSource(plaid: () => Plaid): Source<{ minAmount: number }> {
  return {
    id: "plaid", label: "Bank (Plaid)", needs: "plaid",
    doc: `New transactions on the owner's connected bank accounts and credit cards (Plaid). config {"minAmount":0} — only amounts at least this big (either direction). Minutes >= 60, default 240 (banks update a few times a day).`,
    validate: (c) => ({ minAmount: Math.max(0, Number(c?.minAmount) || 0) }),
    minutes: () => ({ min: 60, default: 240 }),
    describe: (c) => (c.minAmount ? `new bank transactions of ${money(c.minAmount)} or more` : "new bank transactions"),
    async items(c): Promise<Item[]> {
      const { list } = await plaid().transactions(14, 100);
      return list.filter((t) => !t.pending && Math.abs(t.amount) >= c.minAmount).map((t) => ({
        id: `plaid-${t.id}`, title: `${t.amount >= 0 ? money(t.amount, t.currency) : `+${money(-t.amount, t.currency)}`} ${t.amount >= 0 ? "at" : "from"} ${t.merchant}`,
        text: `${t.account}${t.category ? ` · ${t.category}` : ""}`, at: `${t.date}T12:00:00.000Z`,
      }));
    },
  };
}

/** client_id + secret + environment, from the sheet ({auth:{clientId,secret,env}}) or the CLI (--key "client_id:secret"). */
export function parseCreds(input: { key?: string; token?: string; auth?: unknown }): Creds | string {
  const a: any = input.auth && typeof input.auth === "object" ? input.auth : {};
  let clientId = String(a.clientId ?? "").trim(), secret = String(a.secret ?? "").trim();
  const raw = String(input.key ?? input.token ?? "").trim();
  if (!clientId && raw.includes(":")) [clientId, secret] = raw.split(":", 2).map((s) => s.trim());
  const env: PlaidEnv = a.env === "production" || /^prod/i.test(String(a.env ?? "")) ? "production" : "sandbox";
  if (!/^[a-z0-9]{20,40}$/i.test(clientId)) return "That doesn't look like a Plaid client_id (under Developers → Keys).";
  if (!/^[a-z0-9]{20,40}$/i.test(secret)) return "That doesn't look like a Plaid secret (under Developers → Keys).";
  return { clientId, secret, env };
}

export const plaid: Connector = {
  def: { id: "plaid", label: "Banks (Plaid)", kind: "account", how: "key", blurb: "Balances and transactions from your bank and cards.", getFrom: "https://dashboard.plaid.com/developers/keys" },
  status: ({ plaid }) => {
    const c = plaid.creds();
    if (!c) return { state: "off", detail: null };
    const items = plaid.items(), stale = plaid.needsYou();
    const where = c.env === "sandbox" ? " · Sandbox" : "";
    if (stale.length) return { state: "needs-you", detail: `${stale.map((i) => i.institution.name).join(", ")} needs you to sign in again${where}` };
    return { state: items.length ? "connected" : "needs-you", detail: items.length ? `${items.map((i) => i.institution.name).join(", ")}${where}` : `Keys saved (${hint(c.secret)}${where}). Add a bank.` };
  },
  async add({ plaid, vault }, input) {
    if (!vault) return "This hub has no key vault.";
    const c = parseCreds(input);
    if (typeof c === "string") return c;
    const old = plaid.creds();
    if (old && old.env !== c.env && plaid.items().length) return `Your banks were added in ${old.env === "sandbox" ? "Sandbox" : "Production"}. Disconnect Plaid first to switch.`;
    const bad = await plaid.check(c);
    if (bad) return bad;
    plaid.saveCreds(c);
    return null;
  },
  async remove({ plaid }) { return plaid.removeAll(); },
};
