import { createHash, timingSafeEqual } from "node:crypto";
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
  /** The webhook URL Plaid has for this Item, so it's only updated when the hub's address changes. */
  webhook?: string | null;
  /** Added as a bank (transactions first) or an investment account (holdings first: Robinhood, Fidelity…). */
  kind?: LinkKind;
};
export type LinkKind = "bank" | "investments";

const BASE: Record<PlaidEnv, string> = { sandbox: "https://sandbox.plaid.com", production: "https://production.plaid.com" };
/** Plaid error codes that mean the bank wants you to sign in again (update mode fixes it, no new Item). */
/** "This bank / this login doesn't offer that": not a problem to show, just nothing to read. */
const NOT_OFFERED = new Set(["PRODUCTS_NOT_SUPPORTED", "PRODUCT_NOT_ENABLED", "ADDITIONAL_CONSENT_REQUIRED", "INVALID_PRODUCT", "NO_INVESTMENT_ACCOUNTS",
  "NO_INVESTMENT_AUTH_ACCOUNTS", "NO_LIABILITY_ACCOUNTS", "PRODUCT_NOT_READY", "NO_ACCOUNTS", "INVALID_PRODUCTS"]);
const RELOGIN = new Set(["ITEM_LOGIN_REQUIRED", "PENDING_EXPIRATION", "PENDING_DISCONNECT", "ACCESS_NOT_GRANTED", "INSUFFICIENT_CREDENTIALS"]);

export class PlaidError extends Error {
  constructor(public code: string, message: string, public type = "") { super(message); }
}

const money = (n: number | null | undefined, cur?: string | null) =>
  n == null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: cur || "USD" }).format(n);
const day = (d: Date) => d.toISOString().slice(0, 10);
const b64url = (x: string) => Buffer.from(x.replace(/-/g, "+").replace(/_/g, "/"), "base64");
/** Plaid only calls public https addresses. */
export const webhookOk = (url: string | null | undefined): url is string => {
  try { const u = new URL(String(url)); return u.protocol === "https:" && !/^(localhost|127\.|10\.|192\.168\.|\[?::1)/.test(u.hostname); } catch { return false; }
};

export class Plaid {
  /** Link sessions this hub started, so a check only ever finishes our own (lost on restart; just add again). */
  private pending = new Map<string, { update: string | null; at: number; webhook: string | null; kind: LinkKind }>();
  /** Plaid's webhook signing keys, by key id. */
  private keys = new Map<string, { key: CryptoKey; expiredAt: number | null }>();
  /** Called when a webhook says a bank has new transactions (the hub checks its Plaid triggers right away). */
  onNews: (institution: string) => void = () => {};
  /** Called when a bank's state changed (signed out, repaired), so the app redraws its tile. */
  onChange: () => void = () => {};

  constructor(private vault: Vault | null, private fetcher: typeof fetch = fetch) {}

  creds(): Creds | null { try { const v = this.vault?.get("plaid"); return v ? JSON.parse(v) : null; } catch { return null; } }
  items(): SavedItem[] { try { return JSON.parse(this.vault?.get("plaid:items") || "[]"); } catch { return []; } }
  private saveItems(list: SavedItem[]) {
    const had = this.items().length;
    this.vault!.set("plaid:items", JSON.stringify(list));
    if (!had !== !list.length) this.onItems(); // first bank in, or last one out: the agent's skill comes or goes
  }
  /** Called when the agent's hearth-plaid skill should appear or go (first bank added, last one removed). */
  onItems: () => void = () => {};
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
  async startLink(update: string | null = null, webhook: string | null = null, kind: LinkKind = "bank"): Promise<{ url: string; token: string; expiresAt: string }> {
    const item = update ? this.items().find((i) => i.itemId === update) : null;
    if (update && !item) throw new PlaidError("NOT_FOUND", "That bank isn't connected.");
    const base: Record<string, unknown> = {
      client_name: "Hearth", language: "en", country_codes: ["US"], user: { client_user_id: "hearth-owner" },
      hosted_link: { url_lifetime_seconds: 30 * 60 },
      ...(webhook ? { webhook } : {}),
    };
    const create = (extra: Record<string, unknown>) => this.call("/link/token/create", { ...base, ...extra });
    let j: any;
    if (item) j = await create({ access_token: item.accessToken });
    else {
      // Plaid only lists institutions that offer every product in `products`, so a bank asks for transactions (cards and
      // investments if it has them) and a brokerage asks for investments (transactions if it has them). If the plan turns
      // an optional product down, try once without the extras.
      const want = kind === "investments"
        ? { products: ["investments"], optional_products: ["transactions"] }
        : { products: ["transactions"], optional_products: ["liabilities", "investments"] };
      const days = { transactions: { days_requested: 90 } };
      try { j = await create({ ...want, ...days }); }
      catch (e: any) {
        if (e.type !== "INVALID_REQUEST" && e.type !== "INVALID_INPUT" && !/PRODUCT/.test(e.code)) throw e;
        j = await create({ products: want.products, ...(kind === "bank" ? days : {}) });
      }
    }
    if (!j.hosted_link_url) throw new PlaidError("NO_HOSTED_LINK", "Plaid didn't give a Hosted Link page for this account.");
    this.pending.set(j.link_token, { update, at: Date.now(), webhook, kind });
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
          addedAt: new Date().toISOString(), error: null, webhook: p.webhook, kind: p.kind,
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

  /** When Plaid last pulled each bank (Item status; free). */
  private async lastPulled(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    await Promise.all(this.items().map(async (i) => {
      try {
        const j = await this.call("/item/get", { access_token: i.accessToken });
        const t = j.status?.transactions?.last_successful_update || j.status?.last_webhook?.sent_at;
        if (t) out.set(i.itemId, String(t));
      } catch {}
    }));
    return out;
  }

  /** Every account with its balance (Plaid's last-known balance: /accounts/get is free; /accounts/balance/get isn't). */
  async accounts() {
    return this.perItem(async (item) => (await this.call("/accounts/get", { access_token: item.accessToken })).accounts.map((a: any) => ({
      id: String(a.account_id), name: String(a.name || a.official_name || ""), mask: a.mask ?? null, type: String(a.type || ""), subtype: a.subtype ?? null,
      current: a.balances?.current ?? null, available: a.balances?.available ?? null, limit: a.balances?.limit ?? null, currency: a.balances?.iso_currency_code ?? "USD",
      updatedAt: a.balances?.last_updated_datetime ?? null,
    })));
  }

  /** Recent transactions across every bank, newest first. Positive amount = money out (Plaid's convention). */
  async transactions(days = 30, limit = 50, only?: (i: SavedItem) => boolean) {
    const end = new Date(), start = new Date(Date.now() - days * 864e5);
    const all = await this.perItem(async (item) => {
      if (only && !only(item)) return [];
      // Plaid pages at 500; a long window (spending over 90 days) can need a few pages. Capped at 2,000 per bank.
      let j: any = null, got: any[] = [];
      do {
        j = await this.call("/transactions/get", { access_token: item.accessToken, start_date: day(start), end_date: day(end), options: { count: Math.min(limit, 500), offset: got.length } });
        got = got.concat(j.transactions || []);
      } while (got.length < Math.min(limit, 2000) && got.length < Number(j.total_transactions || 0) && (j.transactions || []).length);
      const names = new Map<string, string>((j.accounts || []).map((a: any) => [String(a.account_id), `${a.name || "Account"}${a.mask ? ` ••${a.mask}` : ""}`]));
      return got.map((t: any) => ({
        id: String(t.transaction_id), date: String(t.date), amount: Number(t.amount), currency: t.iso_currency_code || "USD",
        merchant: String(t.merchant_name || t.name || "Unknown"), pending: !!t.pending, category: t.personal_finance_category?.primary ?? null,
        account: `${item.institution.name} · ${names.get(String(t.account_id)) || "account"}`, bank: item.institution.name,
      }));
    });
    const list = all.flatMap((r) => r.value || []).sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
    return { list, errors: all.filter((r) => r.error && (!NOT_OFFERED.has(r.error.code) || r.error.code === "PRODUCT_NOT_READY")).map((r) => ({ institution: r.item.institution.name, code: r.error!.code, message: r.error!.message })) };
  }

  /** Investment positions (Robinhood, Fidelity, a bank's brokerage account): each holding with its security. Prices are
   *  Plaid's (about once a day), not live quotes. Banks without investments are quietly skipped. */
  async holdings(only?: (i: SavedItem) => boolean) {
    const all = await this.perItem(async (item) => {
      if (only && !only(item)) return [];
      try {
        const j = await this.call("/investments/holdings/get", { access_token: item.accessToken });
        const sec = new Map<string, any>((j.securities || []).map((x: any) => [String(x.security_id), x]));
        const acc = new Map<string, any>((j.accounts || []).map((a: any) => [String(a.account_id), a]));
        const rows = (j.holdings || []).map((h: any) => {
          const x = sec.get(String(h.security_id)) || {}, a = acc.get(String(h.account_id));
          const value = h.institution_value ?? (h.quantity != null && h.institution_price != null ? h.quantity * h.institution_price : null);
          const cost = h.cost_basis ?? null;
          return { bank: item.institution.name, account: `${a?.name || "Investments"}${a?.mask ? ` ••${a.mask}` : ""}`,
            symbol: x.ticker_symbol || null, name: String(x.name || x.ticker_symbol || "Holding"), type: x.type || null,
            quantity: h.quantity ?? null, price: h.institution_price ?? null, priceAsOf: h.institution_price_as_of ?? null,
            value, costBasis: cost, gain: value != null && cost != null ? Math.round((value - cost) * 100) / 100 : null, currency: h.iso_currency_code || "USD" };
        });
        const cash = [...acc.values()].filter((a) => a.type === "investment").map((a) => ({ bank: item.institution.name, account: `${a.name || "Investments"}${a.mask ? ` ••${a.mask}` : ""}`, total: a.balances?.current ?? null, cash: a.balances?.available ?? null }));
        return { rows, accounts: cash };
      } catch (e: any) { if (NOT_OFFERED.has(e.code)) return { rows: [], accounts: [] }; throw e; }
    });
    return { rows: all.flatMap((r: any) => r.value?.rows || []), accounts: all.flatMap((r: any) => r.value?.accounts || []),
      errors: all.filter((r) => r.error).map((r) => ({ bank: r.item.institution.name, code: r.error!.code, message: r.error!.message })) };
  }

  /** Buys, sells, dividends, deposits in investment accounts. amount > 0 = money out of the account (a buy). */
  async investmentTx(days = 30, only?: (i: SavedItem) => boolean) {
    const end = new Date(), start = new Date(Date.now() - days * 864e5);
    const all = await this.perItem(async (item) => {
      if (only && !only(item)) return [];
      try {
        const j = await this.call("/investments/transactions/get", { access_token: item.accessToken, start_date: day(start), end_date: day(end), options: { count: 500 } });
        const sec = new Map<string, any>((j.securities || []).map((x: any) => [String(x.security_id), x]));
        return (j.investment_transactions || []).map((t: any) => ({ date: String(t.date), bank: item.institution.name, type: t.type, subtype: t.subtype,
          symbol: sec.get(String(t.security_id))?.ticker_symbol ?? null, name: String(t.name || ""), quantity: t.quantity ?? null, price: t.price ?? null, amount: t.amount ?? null, currency: t.iso_currency_code || "USD" }));
      } catch (e: any) { if (NOT_OFFERED.has(e.code)) return []; throw e; }
    });
    return { list: all.flatMap((r) => r.value || []).sort((a: any, b: any) => b.date.localeCompare(a.date)),
      errors: all.filter((r) => r.error).map((r) => ({ bank: r.item.institution.name, code: r.error!.code, message: r.error!.message })) };
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
    const [accts, tx, cards, inv] = await Promise.all([this.accounts(), this.transactions(30, 8), this.cards(), this.holdings()]);
    return {
      ok: true, env: this.creds()!.env,
      banks: accts.map((r) => ({
        itemId: r.item.itemId, institution: r.item.institution.name, addedAt: r.item.addedAt,
        needsLogin: !!r.error && RELOGIN.has(r.error.code), error: r.error ? (r.error.code === "PRODUCT_NOT_READY" ? null : r.error.message) : null,
        accounts: (r.value || []).map((a: any) => ({ ...a, line: `${a.name}${a.mask ? ` ••${a.mask}` : ""}`, balanceText: money(a.current, a.currency) })),
      })),
      recent: tx.list.map((t) => line(t)),
      cards: cards.map((c: any) => ({ ...c, text: `${c.account}: ${money(c.balance)} owed${c.statement != null ? ` · statement ${money(c.statement)}` : ""}${c.minimum != null ? ` · min ${money(c.minimum)}` : ""}${c.due ? ` due ${c.due}` : ""}${c.apr != null ? ` · ${c.apr}% APR` : ""}` })),
      holdings: inv.rows.sort((a: any, b: any) => (b.value ?? 0) - (a.value ?? 0)).slice(0, 10).map((h: any) =>
        `${h.symbol || h.name}${h.quantity != null ? ` · ${+Number(h.quantity).toFixed(4)} ${h.type === "cash" ? "" : "sh"}` : ""} · ${money(h.value, h.currency)}${h.gain != null ? ` (${h.gain >= 0 ? "+" : ""}${money(h.gain, h.currency)})` : ""} · ${h.bank}`),
      txNote: tx.errors.some((e) => e.code === "PRODUCT_NOT_READY") ? "Plaid is still pulling transactions for a new bank. They show up within a few minutes." : null,
    };
  }

  // ---------- for the agent (hearth-plaid) ----------

  /** What `hearth-plaid <command> [flags]` asks. Read-only, JSON out; nothing here can move money. */
  async agent(argv: string[]): Promise<unknown> {
    if (!this.connected()) throw new PlaidError("NOT_CONNECTED", "No bank is connected. The owner adds one in Hearth: Connectors → Banks (Plaid).");
    const [cmd, ...rest] = argv;
    const flag = (f: string) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : undefined; };
    const num = (f: string, def: number, max: number) => Math.min(max, Math.max(1, Math.floor(Number(flag(f) ?? def)) || def));
    const bank = flag("--bank")?.toLowerCase();
    const onBank = (i: SavedItem) => !bank || i.institution.name.toLowerCase().includes(bank);
    if (bank && !this.items().some(onBank)) throw new PlaidError("NO_BANK", `No connected bank matches "${bank}". Connected: ${this.items().map((i) => i.institution.name).join(", ")}.`);
    const problems = (rs: { item: SavedItem; error?: PlaidError }[]) => rs.filter((r) => r.error && r.error.code !== "PRODUCT_NOT_READY").map((r) => ({
      bank: r.item.institution.name, problem: RELOGIN.has(r.error!.code) ? "The bank signed Hearth out: the owner reconnects it in Hearth (Connectors → Banks)." : r.error!.message }));
    switch (cmd) {
      case "balances": {
        const rs = (await this.accounts()).filter((r) => onBank(r.item));
        const pulled = await this.lastPulled();
        return { accounts: rs.flatMap((r) => (r.value || []).map((a: any) => ({ bank: r.item.institution.name, account: `${a.name}${a.mask ? ` ••${a.mask}` : ""}`, type: a.subtype || a.type,
          balance: a.current, available: a.available, limit: a.limit, currency: a.currency,
          updatedAt: a.updatedAt || pulled.get(r.item.itemId) || null,
          ...(a.type === "credit" ? { note: "credit: balance is what's owed" } : a.available == null ? { note: "no spendable amount (e.g. a CD)" } : {}) }))), problems: problems(rs),
          words: "balance = everything in the account; available = what can be spent now (after pending charges and holds). updatedAt = when Plaid last pulled from the bank (UTC); show it in the owner's time zone, once, not on every account. If it's null, leave the time out rather than saying it's unavailable. `hearth-plaid refresh` gets newer data." };
      }
      case "transactions": {
        const days = num("--days", 30, 730), limit = num("--limit", 50, 500), min = Number(flag("--min") ?? 0) || 0;
        const q = flag("--search")?.toLowerCase(), acct = flag("--account")?.toLowerCase();
        const { list, errors } = await this.transactions(days, 2000, onBank);
        const hits = list.filter((t) => Math.abs(t.amount) >= min && (!q || `${t.merchant} ${t.category ?? ""}`.toLowerCase().includes(q)) && (!acct || t.account.toLowerCase().includes(acct)));
        return { days, count: hits.length, shown: Math.min(limit, hits.length),
          transactions: hits.slice(0, limit).map((t) => ({ date: t.date, amount: t.amount, currency: t.currency, merchant: t.merchant, category: t.category, account: t.account, pending: t.pending })),
          sign: "amount > 0 is money out (a purchase); < 0 is money in (a deposit, refund or card payment)",
          problems: errors.filter((e) => e.code !== "PRODUCT_NOT_READY").map((e) => ({ bank: e.institution, problem: e.message })) };
      }
      case "holdings": {
        const r = await this.holdings(onBank);
        const total = r.rows.reduce((n: number, h: any) => n + (h.value ?? 0), 0);
        return { holdings: r.rows.sort((a: any, b: any) => (b.value ?? 0) - (a.value ?? 0)), accounts: r.accounts, totalValue: Math.round(total * 100) / 100,
          words: "value = quantity × Plaid's price (about once a day, see priceAsOf), not a live quote. gain = value − costBasis (null if the broker didn't say).",
          problems: r.errors.map((e) => ({ bank: e.bank, problem: RELOGIN.has(e.code) ? "The bank signed Hearth out: the owner reconnects it in Hearth (Connectors → Banks)." : e.message })),
          ...(r.rows.length ? {} : { note: "No investment accounts connected. The owner adds one in Hearth → Connectors → Banks (Plaid) → Add an investment account." }) };
      }
      case "investments": {
        const days = num("--days", 30, 730);
        const r = await this.investmentTx(days, onBank);
        return { days, count: r.list.length, transactions: r.list.slice(0, num("--limit", 50, 500)),
          sign: "amount > 0 is money out of the account (a buy); < 0 is money in (a sale, dividend)", problems: r.errors.map((e) => ({ bank: e.bank, problem: e.message })) };
      }
      case "cards": return { cards: (await this.cards()).filter((c: any) => !bank || c.account.toLowerCase().startsWith(bank) || c.account.toLowerCase().includes(bank)) };
      case "spending": {
        const days = num("--days", 30, 730);
        const { list } = await this.transactions(days, 2000, onBank);
        const NOT_SPEND = new Set(["TRANSFER_IN", "TRANSFER_OUT", "LOAN_PAYMENTS", "INCOME"]);
        const by = new Map<string, { total: number; count: number }>();
        let spent = 0, income = 0;
        for (const t of list) {
          if (t.pending) continue;
          if (t.category === "INCOME" || (t.amount < 0 && t.category === "TRANSFER_IN")) { income += -t.amount; continue; }
          if (NOT_SPEND.has(t.category ?? "") || t.amount <= 0) continue;
          const k = t.category || "OTHER", v = by.get(k) || { total: 0, count: 0 };
          v.total += t.amount; v.count++; by.set(k, v); spent += t.amount;
        }
        const r2 = (n: number) => Math.round(n * 100) / 100;
        return { days, spent: r2(spent), income: r2(income),
          byCategory: [...by].sort((a, b) => b[1].total - a[1].total).map(([category, v]) => ({ category, total: r2(v.total), count: v.count })),
          note: "Posted transactions only. Card payments and transfers between your own accounts aren't counted as spending." };
      }
      case "refresh": {
        const rs = await this.perItem(async (i) => { if (onBank(i)) await this.call("/transactions/refresh", { access_token: i.accessToken }); return onBank(i); });
        return { asked: rs.filter((r) => r.value).map((r) => r.item.institution.name), problems: problems(rs),
          note: "Plaid is pulling from the bank now; new transactions arrive within a few minutes (the webhook checks triggers)." };
      }
      default:
        throw new PlaidError("USAGE", "usage: hearth-plaid balances | transactions [--days N] [--bank B] [--min N] [--search W] [--account A] [--limit N] | cards | spending [--days N] [--bank B] | holdings [--bank B] | investments [--days N] [--bank B] | refresh [--bank B]");
    }
  }

  // ---------- webhooks ----------

  /** Point every bank's webhook at this hub (only those that aren't already). Plaid only calls public https URLs. */
  async ensureWebhook(url: string) {
    if (!webhookOk(url) || !this.creds()) return;
    for (const item of this.items()) {
      if (item.webhook === url) continue;
      try {
        await this.call("/item/webhook/update", { access_token: item.accessToken, webhook: url });
        this.saveItems(this.items().map((i) => (i.itemId === item.itemId ? { ...i, webhook: url } : i)));
      } catch { /* tried again next time the hub learns its address */ }
    }
  }

  /** Is this really from Plaid? The Plaid-Verification JWT (ES256), signed by a key Plaid hands out, carries the
   *  body's SHA-256 and is at most 5 minutes old. */
  async verify(raw: string, jwt: string | null, now = Date.now()): Promise<boolean> {
    if (!jwt || !this.creds()) return false;
    const parts = jwt.split(".");
    if (parts.length !== 3) return false;
    let head: any, claims: any;
    try { head = JSON.parse(b64url(parts[0]).toString("utf8")); claims = JSON.parse(b64url(parts[1]).toString("utf8")); } catch { return false; }
    if (head.alg !== "ES256" || typeof head.kid !== "string" || !/^[\w-]{1,100}$/.test(head.kid)) return false;
    let k = this.keys.get(head.kid);
    if (!k) {
      try {
        const j = await this.call("/webhook_verification_key/get", { key_id: head.kid });
        const jwk = j.key;
        const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
        k = { key, expiredAt: jwk.expired_at ? Number(jwk.expired_at) * 1000 : null };
        this.keys.set(head.kid, k);
      } catch { return false; }
    }
    if (k.expiredAt && k.expiredAt <= now) return false;
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k.key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`)).catch(() => false);
    if (!ok) return false;
    if (typeof claims.iat !== "number" || Math.abs(now / 1000 - claims.iat) > 5 * 60) return false;
    const want = Buffer.from(String(claims.request_body_sha256 || ""), "utf8");
    const got = Buffer.from(createHash("sha256").update(raw, "utf8").digest("hex"), "utf8");
    return want.length === got.length && timingSafeEqual(want, got);
  }

  /** A verified webhook: new transactions → check now; a bank signed out or came back → update its tile. */
  handle(body: any): string {
    const item = this.items().find((i) => i.itemId === body?.item_id);
    if (!item) return "unknown item";
    const type = String(body.webhook_type || ""), code = String(body.webhook_code || "");
    if (type === "TRANSACTIONS" && ["DEFAULT_UPDATE", "SYNC_UPDATES_AVAILABLE", "INITIAL_UPDATE", "HISTORICAL_UPDATE"].includes(code)) {
      if (code !== "DEFAULT_UPDATE" || Number(body.new_transactions ?? 1) > 0) this.onNews(item.institution.name);
      return "transactions";
    }
    if (type === "ITEM") {
      if (code === "ERROR" && body.error?.error_code) { this.mark(item.itemId, String(body.error.error_code)); this.onChange(); return "error"; }
      if (code === "PENDING_DISCONNECT" || code === "PENDING_EXPIRATION") { this.mark(item.itemId, code); this.onChange(); return "pending"; }
      if (code === "LOGIN_REPAIRED") { this.mark(item.itemId, null); this.onChange(); return "repaired"; }
    }
    return "ignored";
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
    this.onItems();
    return null;
  }
}

type Tx = { date: string; amount: number; currency: string; merchant: string; pending: boolean; account: string };
/** "$12.34 at Starbucks" (money out) or "+$500.00 from Payroll" (money in). */
export const line = (t: Tx) => `${t.date} · ${t.amount >= 0 ? `${money(t.amount, t.currency)} at` : `+${money(-t.amount, t.currency)} from`} ${t.merchant}${t.pending ? " (pending)" : ""} · ${t.account}`;

/**
 * The port the hub keeps while Plaid is connected: every verified Plaid webhook lands here as an event, so triggers
 * can act on it right away (a script fetches the new transactions and publishes them). Plaid calls the hub's own
 * /api/plaid/webhook, so there's no URL to hand out.
 */
export const PLAID_PORT = {
  name: "plaid", publisher: "plaid",
  reason: "Plaid's updates about your banks: new transactions, new accounts, sign-outs (comes with the Plaid connection)",
  description: "Every verified webhook from Plaid. It only says what changed; a trigger's script fetches the details (needs: plaid).",
  variables: [
    { name: "type", description: "webhook_type: TRANSACTIONS, ITEM, HOLDINGS…" },
    { name: "code", description: "webhook_code: SYNC_UPDATES_AVAILABLE, NEW_ACCOUNTS_AVAILABLE, ERROR, LOGIN_REPAIRED…" },
    { name: "bank", description: "the bank's name" },
    { name: "item_id", description: "Plaid's id for that bank connection" },
  ],
  mapping: { type: "webhook_type", code: "webhook_code" },
};

/** Plaid as a trigger: new transactions, optionally only big ones. */
export function plaidSource(plaid: () => Plaid): Source<{ minAmount: number }> {
  return {
    id: "plaid", label: "Bank (Plaid)", needs: "plaid",
    doc: `New posted transactions on the owner's connected bank accounts and credit cards (Plaid). Each item says only which account (no amount or merchant, on purpose); look it up with \`hearth-plaid transactions\` if you have that skill, else tell the owner to open Banks (Plaid) in Hearth. Checked as soon as Plaid's webhook says there's news, and on the timer as a fallback. config {"minAmount":0} — only amounts at least this big (either direction). Minutes >= 60, default 240 (banks update a few times a day).`,
    validate: (c) => ({ minAmount: Math.max(0, Number(c?.minAmount) || 0) }),
    minutes: () => ({ min: 60, default: 240 }),
    describe: (c) => (c.minAmount ? `new bank transactions of ${money(c.minAmount)} or more` : "new bank transactions"),
    async items(c): Promise<Item[]> {
      const { list } = await plaid().transactions(14, 100);
      // Which account, never the amount or merchant: what a trigger finds ends up in the hub's store and in front of
      // the brain, so bank details stay out of both. The app shows the transaction live from Plaid when you open it.
      return list.filter((t) => !t.pending && Math.abs(t.amount) >= c.minAmount).map((t) => ({
        id: `plaid-${t.id}`, title: `New ${t.amount >= 0 ? "charge" : "deposit or payment"} on ${t.account}`,
        text: "The amount and merchant aren't shared or kept. Open Banks (Plaid) in Hearth to see it.", at: `${t.date}T12:00:00.000Z`, url: "#connector/plaid",
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

/** The agent's skill for this: one command, `hearth-plaid`, that asks this hub (on its own machine) with a key that
 *  only opens these read-only questions. Only present while a bank is connected. */
export function plaidSkill(hubUrl: string, key: string) {
  const script = `#!/usr/bin/env bash
# hearth-plaid <command> [flags]: the owner's bank accounts and cards, read-only (Hearth asks Plaid). JSON out.
set -uo pipefail
args=(); for a in "$@"; do args+=(--data-urlencode "a=$a"); done
exec curl -sS -m 90 -G -H "X-Hearth-Agent: ${key}" "${hubUrl}/api/agent/plaid" "\${args[@]}"
`;
  return {
    name: "hearth-plaid", common: true, commands: ["hearth-plaid"], reads: [], scripts: { "hearth-plaid": script },
    description: "The owner's money: bank and card balances, transactions, spending by category, card due dates and APR, investment holdings and trades (Chase, Discover, Robinhood… via Plaid). Read-only.",
    body: `# Your owner's bank accounts and credit cards (read-only)

Run \`hearth-plaid <command>\`. It prints JSON. Nothing here can move money, pay a bill or change anything.

| Command | What it gives |
|---|---|
| \`hearth-plaid balances [--bank chase]\` | Every account: balance, available, limit. For a credit card, balance = what's owed. |
| \`hearth-plaid transactions [--days 30] [--bank discover] [--min 50] [--search uber] [--account sapphire] [--limit 50]\` | Recent transactions, newest first. amount > 0 = money out, < 0 = money in. |
| \`hearth-plaid cards [--bank chase]\` | Each card: owed, statement balance, minimum due, due date, purchase APR, overdue. |
| \`hearth-plaid spending [--days 30] [--bank chase]\` | Total spent and income, by category (card payments and own-account transfers left out). |
| \`hearth-plaid holdings [--bank robinhood]\` | Investment positions: symbol, quantity, price, value, cost basis, gain; total value. Prices are once a day, not live. |
| \`hearth-plaid investments [--days 30] [--bank robinhood]\` | Buys, sells, dividends and deposits in investment accounts. |
| \`hearth-plaid refresh [--bank chase]\` | Ask the bank for fresh data now. Only when the owner wants up-to-the-minute numbers: banks update 1–4 times a day by themselves. |

- Pick the smallest command that answers the question (spending for "how much did I spend", not every transaction).
- Numbers are as of Plaid's last pull from the bank. Say so if it matters ("as of this morning").
- A \`problems\` entry means a bank needs the owner: tell them to reconnect it in Hearth → Connectors → Banks (Plaid).
- A "New charge on …" alert from the Plaid trigger has no amount on purpose: look it up with \`hearth-plaid transactions --days 3 --account <name>\`.
- Money is private: give the owner what they asked for; don't repeat full account lists or numbers in places other people see.
- Buying or selling, moving money, paying a card, disputing a charge: not possible here. Say what the owner would do in their bank's app.`,
  };
}
