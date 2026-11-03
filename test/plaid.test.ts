import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Vault } from "../src/vault.ts";
import { createHash } from "node:crypto";
import { Plaid, parseCreds, plaidSource, plaid as plaidConnector, webhookOk } from "../src/connectors/plaid.ts";

const CID = "a".repeat(24), SEC = "b".repeat(30);
const creds = { clientId: CID, secret: SEC, env: "sandbox" as const };

// A pretend Plaid: keys are checked on every call; Hosted Link finishes when `state.finished` is set.
function fakePlaid(state: { finished?: boolean; exit?: any; loginRequired?: Set<string>; liabilities?: boolean; jwk?: any; seen: any[] } = { seen: [] }) {
  let n = 0;
  return (async (url: string, init: any = {}) => {
    const b = JSON.parse(init.body || "{}");
    const path = url.replace("https://sandbox.plaid.com", "");
    state.seen.push({ path, body: b });
    const err = (code: string, type = "INVALID_REQUEST", status = 400) => Response.json({ error_code: code, error_type: type, error_message: code, display_message: null }, { status });
    if (b.client_id !== CID || b.secret !== SEC) return err("INVALID_API_KEYS", "INVALID_INPUT");
    if (path !== "/link/token/create" && state.loginRequired?.has(b.access_token)) return err("ITEM_LOGIN_REQUIRED", "ITEM_ERROR");
    switch (path) {
      case "/institutions/get": return Response.json({ institutions: [] });
      case "/link/token/create":
        if (b.optional_products && state.liabilities === false) return err("INVALID_PRODUCT");
        return Response.json({ link_token: `link-sandbox-${++n}`, hosted_link_url: `https://secure.plaid.com/hl/${n}`, expiration: "2026-11-03T00:00:00Z" });
      case "/link/token/get":
        return Response.json({ link_sessions: state.finished ? [{ finished_at: "now", exit: state.exit ?? null, results: { item_add_results: state.exit ? [] : [
          { public_token: "public-1", institution: { institution_id: "ins_56", name: "Chase" }, accounts: [{ id: "acc-chk", name: "Checking", mask: "1111", type: "depository", subtype: "checking" }, { id: "acc-cc", name: "Sapphire", mask: "2222", type: "credit", subtype: "credit card" }] },
        ] } }] : [{ finished_at: null }] });
      case "/item/public_token/exchange": return Response.json({ item_id: "item-chase", access_token: "access-chase" });
      case "/accounts/get": return Response.json({ accounts: [
        { account_id: "acc-chk", name: "Checking", mask: "1111", type: "depository", balances: { current: 1200.5, available: 1100, iso_currency_code: "USD" } },
        { account_id: "acc-cc", name: "Sapphire", mask: "2222", type: "credit", balances: { current: 340, limit: 5000, iso_currency_code: "USD" } }] });
      case "/transactions/get": return Response.json({ accounts: [{ account_id: "acc-cc", name: "Sapphire", mask: "2222" }], transactions: [
        { transaction_id: "t1", account_id: "acc-cc", amount: 12.34, date: "2026-11-01", merchant_name: "Starbucks", pending: false, personal_finance_category: { primary: "FOOD_AND_DRINK" } },
        { transaction_id: "t2", account_id: "acc-cc", amount: -500, date: "2026-11-02", name: "Payment", pending: false, personal_finance_category: { primary: "LOAN_PAYMENTS" } },
        { transaction_id: "t3", account_id: "acc-cc", amount: 3, date: "2026-11-02", merchant_name: "Coffee", pending: true }] });
      case "/liabilities/get": return Response.json({ accounts: [{ account_id: "acc-cc", name: "Sapphire", mask: "2222", balances: { current: 340, limit: 5000 } }],
        liabilities: { credit: [{ account_id: "acc-cc", last_statement_balance: 300, minimum_payment_amount: 35, next_payment_due_date: "2026-11-20", is_overdue: false, aprs: [{ apr_type: "purchase_apr", apr_percentage: 24.99 }] }] } });
      case "/item/remove": return Response.json({ request_id: "r" });
      case "/item/get": return Response.json({ item: { item_id: "item-chase" }, status: { transactions: { last_successful_update: "2026-11-03T14:14:00Z" } } });
      case "/investments/holdings/get":
        if (!state.investments) return err("PRODUCTS_NOT_SUPPORTED", "ITEM_ERROR");
        return Response.json({ accounts: [{ account_id: "acc-inv", name: "Individual", mask: "9999", type: "investment", balances: { current: 2350, available: 50 } }],
          securities: [{ security_id: "s-aapl", ticker_symbol: "AAPL", name: "Apple Inc.", type: "equity" }, { security_id: "s-cash", ticker_symbol: "CUR:USD", name: "US Dollar", type: "cash" }],
          holdings: [{ account_id: "acc-inv", security_id: "s-aapl", quantity: 10, institution_price: 230, institution_price_as_of: "2026-11-02", institution_value: 2300, cost_basis: 1800, iso_currency_code: "USD" },
            { account_id: "acc-inv", security_id: "s-cash", quantity: 50, institution_price: 1, institution_value: 50, cost_basis: null, iso_currency_code: "USD" }] });
      case "/investments/transactions/get":
        if (!state.investments) return err("PRODUCTS_NOT_SUPPORTED", "ITEM_ERROR");
        return Response.json({ securities: [{ security_id: "s-aapl", ticker_symbol: "AAPL" }], investment_transactions: [
          { date: "2026-10-20", type: "buy", subtype: "buy", security_id: "s-aapl", name: "BUY AAPL", quantity: 2, price: 225, amount: 450 },
          { date: "2026-10-28", type: "cash", subtype: "dividend", security_id: "s-aapl", name: "AAPL dividend", quantity: 0, price: 0, amount: -2.5 }] });
      case "/transactions/refresh": return Response.json({ request_id: "r" });
      case "/item/webhook/update": return Response.json({ item: { webhook: b.webhook } });
      case "/webhook_verification_key/get": return state.jwk ? Response.json({ key: { ...state.jwk, kid: b.key_id, alg: "ES256", use: "sig", created_at: 1, expired_at: null } }) : err("INVALID_KEY");
    }
    return err("NOT_FOUND", "API_ERROR", 404);
  }) as unknown as typeof fetch;
}
const newVault = () => new Vault(mkdtempSync(join(tmpdir(), "hearth-plaid-")), { masterKey: randomBytes(32) });

test("parses keys from the sheet and the CLI, and rejects junk", () => {
  expect(parseCreds({ auth: { clientId: CID, secret: SEC, env: "production" } })).toEqual({ clientId: CID, secret: SEC, env: "production" });
  expect(parseCreds({ key: `${CID}:${SEC}`, auth: { env: "sandbox" } })).toEqual(creds);
  expect(typeof parseCreds({ key: "nope" })).toBe("string");
});

test("checks the keys with Plaid", async () => {
  const p = new Plaid(newVault(), fakePlaid());
  expect(await p.check(creds)).toBeNull();
  expect(await p.check({ ...creds, secret: "c".repeat(30) })).toContain("didn't accept");
});

test("adds a bank through Hosted Link, then reads balances, transactions and card details", async () => {
  const vault = newVault(), state: any = { seen: [] };
  const p = new Plaid(vault, fakePlaid(state));
  p.saveCreds(creds);
  const link = await p.startLink();
  expect(link.url).toStartWith("https://secure.plaid.com/hl/");
  const create = state.seen.find((s: any) => s.path === "/link/token/create").body;
  expect(create.hosted_link).toBeDefined();
  expect(create.optional_products).toEqual(["liabilities", "investments"]);
  expect(await p.finishLink(link.token)).toMatchObject({ done: false });
  state.finished = true;
  expect(await p.finishLink(link.token)).toMatchObject({ done: true, added: [{ institution: "Chase", accounts: 2 }] });
  await expect(p.finishLink(link.token)).rejects.toThrow("isn't one this hub started");
  expect(p.connected()).toBe(true);
  expect(JSON.parse(vault.get("plaid:items")!)[0].accessToken).toBe("access-chase");

  const r: any = await p.probe();
  expect(r.ok).toBe(true);
  expect(r.banks[0].accounts.map((a: any) => a.balanceText)).toEqual(["$1,200.50", "$340.00"]);
  expect(r.recent[0]).toContain("+$500.00 from Payment");
  expect(r.cards[0].text).toContain("min $35.00 due 2026-11-20");
  expect(r.cards[0].apr).toBe(24.99);

  const items = await plaidSource(() => p).items({ minAmount: 10 } as any, {} as any);
  // pending + small skipped; and no amount or merchant leaves the connector
  expect(items.map((i) => i.title)).toEqual(["New deposit or payment on Chase · Sapphire ••2222", "New charge on Chase · Sapphire ••2222"]);
  expect(JSON.stringify(items)).not.toMatch(/Starbucks|12\.34|500/);
});

test("falls back to plain transactions when the plan has no Liabilities", async () => {
  const state: any = { seen: [], liabilities: false };
  const p = new Plaid(newVault(), fakePlaid(state));
  p.saveCreds(creds);
  await p.startLink();
  const creates = state.seen.filter((s: any) => s.path === "/link/token/create");
  expect(creates.length).toBe(2);
  expect(creates[1].body.optional_products).toBeUndefined();
});

test("a signed-out bank shows Needs you, and update mode signs it in again without a new Item", async () => {
  const vault = newVault(), state: any = { seen: [], loginRequired: new Set(["access-chase"]) };
  const p = new Plaid(vault, fakePlaid(state));
  p.saveCreds(creds);
  vault.set("plaid:items", JSON.stringify([{ itemId: "item-chase", accessToken: "access-chase", institution: { id: "ins_56", name: "Chase" }, accounts: [], addedAt: "x" }]));
  const r: any = await p.probe();
  expect(r.banks[0].needsLogin).toBe(true);
  const ctx: any = { plaid: p, vault };
  expect(await plaidConnector.status(ctx)).toMatchObject({ state: "needs-you" });

  const link = await p.startLink("item-chase");
  expect(state.seen.filter((s: any) => s.path === "/link/token/create").pop().body.access_token).toBe("access-chase");
  state.loginRequired.clear(); state.finished = true;
  expect(await p.finishLink(link.token)).toMatchObject({ done: true, added: [] });
  expect(state.seen.some((s: any) => s.path === "/item/public_token/exchange")).toBe(false);
  expect(p.items().length).toBe(1);
  expect(await plaidConnector.status(ctx)).toMatchObject({ state: "connected" });
});

test("removing a bank ends it at Plaid; disconnect forgets the keys", async () => {
  const vault = newVault(), state: any = { seen: [], finished: true };
  const p = new Plaid(vault, fakePlaid(state));
  p.saveCreds(creds);
  await p.finishLink((await p.startLink()).token);
  expect(await p.removeAll()).toBeNull();
  expect(state.seen.some((s: any) => s.path === "/item/remove" && s.body.access_token === "access-chase")).toBe(true);
  expect(vault.get("plaid")).toBeNull();
});

// Sign a webhook the way Plaid does: ES256 JWT whose claims carry the body's SHA-256.
async function signer() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const enc = (o: any) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const sign = async (body: string, iat = Math.floor(Date.now() / 1000), alg = "ES256") => {
    const head = enc({ alg, kid: "kid-1", typ: "JWT" });
    const claims = enc({ iat, request_body_sha256: createHash("sha256").update(body).digest("hex") });
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(`${head}.${claims}`));
    return `${head}.${claims}.${Buffer.from(sig).toString("base64url")}`;
  };
  return { jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, sign };
}

test("only webhooks Plaid signed, for this exact body, in the last 5 minutes, count", async () => {
  const { jwk, sign } = await signer();
  const state: any = { seen: [], jwk };
  const p = new Plaid(newVault(), fakePlaid(state));
  p.saveCreds(creds);
  const body = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "DEFAULT_UPDATE", item_id: "item-chase", new_transactions: 2 }, null, 2);
  expect(await p.verify(body, await sign(body))).toBe(true);
  expect(await p.verify(body.replace("2", "3"), await sign(body))).toBe(false); // body changed
  expect(await p.verify(body, await sign(body, Math.floor(Date.now() / 1000) - 600))).toBe(false); // too old
  expect(await p.verify(body, await sign(body, undefined, "HS256"))).toBe(false); // wrong alg
  expect(await p.verify(body, null)).toBe(false);
  expect(await p.verify(body, "a.b.c")).toBe(false);
  expect(state.seen.filter((s: any) => s.path === "/webhook_verification_key/get").length).toBe(1); // key cached
});

test("a webhook checks for new transactions now, and flags a signed-out bank", async () => {
  const vault = newVault(), state: any = { seen: [], finished: true };
  const p = new Plaid(vault, fakePlaid(state));
  p.saveCreds(creds);
  await p.finishLink((await p.startLink(null, "https://hub.example.com/api/plaid/webhook")).token);
  expect(state.seen.find((s: any) => s.path === "/link/token/create").body.webhook).toBe("https://hub.example.com/api/plaid/webhook");
  const news: string[] = [];
  p.onNews = (b) => news.push(b);
  expect(p.handle({ webhook_type: "TRANSACTIONS", webhook_code: "DEFAULT_UPDATE", item_id: "item-chase", new_transactions: 1 })).toBe("transactions");
  expect(p.handle({ webhook_type: "TRANSACTIONS", webhook_code: "DEFAULT_UPDATE", item_id: "item-chase", new_transactions: 0 })).toBe("transactions");
  expect(news).toEqual(["Chase"]);
  expect(p.handle({ webhook_type: "TRANSACTIONS", webhook_code: "DEFAULT_UPDATE", item_id: "someone-else" })).toBe("unknown item");
  p.handle({ webhook_type: "ITEM", webhook_code: "ERROR", item_id: "item-chase", error: { error_code: "ITEM_LOGIN_REQUIRED" } });
  expect(await plaidConnector.status({ plaid: p, vault } as any)).toMatchObject({ state: "needs-you" });
  p.handle({ webhook_type: "ITEM", webhook_code: "LOGIN_REPAIRED", item_id: "item-chase" });
  expect(await plaidConnector.status({ plaid: p, vault } as any)).toMatchObject({ state: "connected" });
});

test("points older banks at the hub's webhook once, and only for public https", async () => {
  const vault = newVault(), state: any = { seen: [], finished: true };
  const p = new Plaid(vault, fakePlaid(state));
  p.saveCreds(creds);
  await p.finishLink((await p.startLink()).token); // added before the hub knew its address
  await p.ensureWebhook("http://127.0.0.1:8790/api/plaid/webhook");
  expect(state.seen.some((s: any) => s.path === "/item/webhook/update")).toBe(false);
  await p.ensureWebhook("https://hub.example.com/api/plaid/webhook");
  await p.ensureWebhook("https://hub.example.com/api/plaid/webhook");
  expect(state.seen.filter((s: any) => s.path === "/item/webhook/update").length).toBe(1);
  expect(webhookOk("https://localhost/x")).toBe(false);
});

test("hearth-plaid answers balances, transactions, spending, cards and refresh", async () => {
  const state: any = { seen: [], finished: true };
  const p = new Plaid(newVault(), fakePlaid(state));
  p.saveCreds(creds);
  await expect(p.agent(["balances"])).rejects.toThrow("No bank is connected");
  await p.finishLink((await p.startLink()).token);
  const bal: any = await p.agent(["balances"]);
  expect(bal.accounts).toEqual([
    expect.objectContaining({ bank: "Chase", account: "Checking ••1111", balance: 1200.5, updatedAt: "2026-11-03T14:14:00Z" }),
    expect.objectContaining({ account: "Sapphire ••2222", balance: 340, limit: 5000, note: expect.stringContaining("owed") }),
  ]);
  const tx: any = await p.agent(["transactions", "--search", "star"]);
  expect(tx.transactions).toEqual([expect.objectContaining({ merchant: "Starbucks", amount: 12.34 })]);
  expect((await p.agent(["transactions", "--min", "100"]) as any).transactions.map((t: any) => t.amount)).toEqual([-500]);
  const sp: any = await p.agent(["spending", "--days", "30"]);
  expect(sp.byCategory).toEqual([{ category: "FOOD_AND_DRINK", total: 12.34, count: 1 }]); // pending + payment left out
  expect((await p.agent(["cards"]) as any).cards[0].minimum).toBe(35);
  await expect(p.agent(["balances", "--bank", "wells"])).rejects.toThrow("Connected: Chase");
  state.seen.length = 0;
  await p.agent(["refresh", "--bank", "chase"]);
  expect(state.seen.map((s: any) => s.path)).toContain("/transactions/refresh");
  await expect(p.agent(["pay"])).rejects.toThrow("usage");
});

test("the hearth-plaid script passes its words to the hub with the key", async () => {
  const { plaidSkill } = await import("../src/connectors/plaid.ts");
  let got: any = null;
  const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { const u = new URL(req.url); got = { path: u.pathname, a: u.searchParams.getAll("a"), key: req.headers.get("x-hearth-agent") }; return Response.json({ ok: true }); } });
  const sk = plaidSkill(`http://127.0.0.1:${srv.port}`, "k3y");
  const dir = mkdtempSync(join(tmpdir(), "hearth-pl-bin-"));
  const f = join(dir, "hearth-plaid");
  await Bun.write(f, sk.scripts!["hearth-plaid"]);
  const proc = Bun.spawn(["bash", f, "transactions", "--search", "uber eats & co"], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  srv.stop(true);
  expect(out).toContain('"ok":true');
  expect(got).toEqual({ path: "/api/agent/plaid", a: ["transactions", "--search", "uber eats & co"], key: "k3y" });
  expect(sk.body).toContain("hearth-plaid spending");
});

test("the skill reaches the brain: catalog, its command on PATH, and permission to run only that", async () => {
  const { registerSkills, hubSkills, installSkills, skillFlags, codexRules, skillCatalog } = await import("../src/brains/skills.ts");
  const { plaidSkill } = await import("../src/connectors/plaid.ts");
  let on = false;
  registerSkills(() => (on ? [plaidSkill("http://127.0.0.1:1", "k")] : []));
  const data = mkdtempSync(join(tmpdir(), "hearth-pl-sk-"));
  const env = { HEARTH_BROWSER: "off", HEARTH_CUA: "off" };
  expect(hubSkills(data, env).some((s) => s.name === "hearth-plaid")).toBe(false);
  on = true;
  const skills = hubSkills(data, env);
  expect(skillCatalog(skills)).toContain("- hearth-plaid: The owner's money");
  expect(skillFlags(skills).allowed).toContain("Bash(hearth-plaid:*)");
  expect(codexRules(skills)).toContain('pattern=["hearth-plaid"]');
  const bin = installSkills(join(data, "brain"), skills);
  const { statSync } = await import("node:fs");
  expect(statSync(join(bin, "hearth-plaid")).mode & 0o777).toBe(0o700);
});

test("adding the first bank (and removing the last) tells the brain to look at its skills again", async () => {
  const state: any = { seen: [], finished: true };
  const p = new Plaid(newVault(), fakePlaid(state));
  p.saveCreds(creds);
  let n = 0;
  p.onItems = () => n++;
  await p.finishLink((await p.startLink()).token);
  expect(n).toBe(1);
  await p.removeAll();
  expect(n).toBeGreaterThanOrEqual(2);
});

test("investments: a broker link asks for holdings first; holdings and trades come back; banks without them stay quiet", async () => {
  const state: any = { seen: [], finished: true };
  const p = new Plaid(newVault(), fakePlaid(state));
  p.saveCreds(creds);
  await p.finishLink((await p.startLink()).token);
  // A plain bank: no investments, and no "problem" for it either.
  const none: any = await p.agent(["holdings"]);
  expect(none.holdings).toEqual([]);
  expect(none.problems).toEqual([]);
  expect(none.note).toContain("Add an investment account");

  await p.startLink(null, null, "investments");
  const create = state.seen.filter((x: any) => x.path === "/link/token/create").pop().body;
  expect(create.products).toEqual(["investments"]);
  expect(create.optional_products).toEqual(["transactions"]);

  state.investments = true;
  const h: any = await p.agent(["holdings"]);
  expect(h.totalValue).toBe(2350);
  expect(h.holdings[0]).toMatchObject({ symbol: "AAPL", quantity: 10, value: 2300, costBasis: 1800, gain: 500, priceAsOf: "2026-11-02" });
  const t: any = await p.agent(["investments", "--days", "30"]);
  expect(t.transactions.map((x: any) => [x.date, x.subtype, x.symbol])).toEqual([["2026-10-28", "dividend", "AAPL"], ["2026-10-20", "buy", "AAPL"]]);
  const probe: any = await p.probe();
  expect(probe.holdings[0]).toContain("AAPL · 10 sh · $2,300.00 (+$500.00)");
});
