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
        { transaction_id: "t2", account_id: "acc-cc", amount: -500, date: "2026-11-02", name: "Payment", pending: false },
        { transaction_id: "t3", account_id: "acc-cc", amount: 3, date: "2026-11-02", merchant_name: "Coffee", pending: true }] });
      case "/liabilities/get": return Response.json({ accounts: [{ account_id: "acc-cc", name: "Sapphire", mask: "2222", balances: { current: 340, limit: 5000 } }],
        liabilities: { credit: [{ account_id: "acc-cc", last_statement_balance: 300, minimum_payment_amount: 35, next_payment_due_date: "2026-11-20", is_overdue: false, aprs: [{ apr_type: "purchase_apr", apr_percentage: 24.99 }] }] } });
      case "/item/remove": return Response.json({ request_id: "r" });
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
  expect(create.optional_products).toEqual(["liabilities"]);
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
