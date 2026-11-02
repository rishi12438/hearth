import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createStore, COLLECTIONS, type Store } from "../src/store/index.ts";
import { Hub } from "../src/hub.ts";
import { Brain } from "../src/brain.ts";
import { Scripts } from "../src/scripts.ts";
import { loadConfig } from "../src/config.ts";
import { Vault } from "../src/vault.ts";
import { Connect, CONNECTORS } from "../src/connectors/index.ts";
import { cleanRules, ignoredBecause, messageText, NO_RULES } from "../src/connectors/whatsapp.ts";
import { checkSerperKey } from "../src/connectors/serper.ts";
import { checkSlackToken } from "../src/connectors/slack.ts";
import { isAdminRequest } from "../src/admin.ts";
import { validRemote } from "../src/setup/remote.ts";
import { pairLink } from "../src/setup/steps.ts";
import { saveKey, tightenKey } from "../src/setup/keys.ts";
import { writeFileSync, statSync } from "node:fs";
import type { Approval } from "../src/types.ts";

describe("WhatsApp ignore rules", () => {
  const msg = (o: Partial<{ jid: string; from: string; text: string; group: boolean }>) => ({ jid: "15550100@s.whatsapp.net", from: "15550100@s.whatsapp.net", text: "hi", group: false, ...o });

  test("contacts by number or id, groups (one or all), keywords, archived and muted chats", () => {
    const r = cleanRules({ contacts: ["+1 (555) 0100", "MOM@s.whatsapp.net"], groups: ["123@g.us", "not-a-group"], keywords: ["OTP"], archived: true, muted: true });
    expect(r.contacts).toEqual(["15550100", "mom@s.whatsapp.net"]);
    expect(r.groups).toEqual(["123@g.us"]);
    expect(ignoredBecause(msg({}), r)).toBe("contact");
    expect(ignoredBecause(msg({ jid: "mom@s.whatsapp.net", from: "mom@s.whatsapp.net" }), r)).toBe("contact");
    expect(ignoredBecause(msg({ jid: "123@g.us", from: "999@s.whatsapp.net", group: true }), r)).toBe("group");
    // A contact on the list is ignored inside a group too.
    expect(ignoredBecause(msg({ jid: "777@g.us", from: "15550100@s.whatsapp.net", group: true }), r)).toBe("contact");
    expect(ignoredBecause(msg({ jid: "1@s.whatsapp.net", from: "1@s.whatsapp.net", text: "Your OTP is 1234" }), r)).toBe("keyword");
    const other = msg({ jid: "2@s.whatsapp.net", from: "2@s.whatsapp.net" });
    expect(ignoredBecause(other, r, { jid: other.jid, name: "x", group: false, archived: true })).toBe("archived");
    expect(ignoredBecause(other, r, { jid: other.jid, name: "x", group: false, mutedUntil: Date.now() + 60_000 })).toBe("muted");
    expect(ignoredBecause(other, r, { jid: other.jid, name: "x", group: false, mutedUntil: Date.now() - 60_000 })).toBeNull();
    expect(ignoredBecause(msg({ jid: "777@g.us", from: "3@s.whatsapp.net", group: true }), { ...NO_RULES, allGroups: true })).toBe("group");
    expect(ignoredBecause(other, NO_RULES)).toBeNull();
  });

  test("reads text from any message kind", () => {
    expect(messageText({ message: { conversation: "plain" } })).toBe("plain");
    expect(messageText({ message: { extendedTextMessage: { text: "reply" } } })).toBe("reply");
    expect(messageText({ message: { ephemeralMessage: { message: { imageMessage: { caption: "pic" } } } } })).toBe("pic");
  });
});

describe("key checks", () => {
  const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  test("Serper and Slack ask the provider before keeping anything", async () => {
    expect(await checkSerperKey("short")).toContain("doesn't look like");
    expect(await checkSerperKey("a".repeat(40), answer(403, {}))).toContain("didn't accept");
    expect(await checkSerperKey("a".repeat(40), answer(200, { organic: [] }))).toBeNull();
    expect(await checkSlackToken("nope")).toEqual({ error: expect.stringContaining("xoxb-") });
    expect(await checkSlackToken("xoxp-" + "1".repeat(30), answer(200, { ok: false, error: "invalid_auth" }))).toEqual({ error: "Slack didn't accept that token." });
    expect(await checkSlackToken("xoxp-" + "1".repeat(30), answer(200, { ok: true, team: "Acme", user: "rishi" }))).toEqual({ team: "Acme", user: "rishi" });
  });
});

describe("the grid", () => {
  let dir: string, store: Store, hub: Hub, connect: Connect;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "hearth-conn-"));
    store = await createStore(process.env.TEST_DB || "sqlite::memory:", dir);
    for (const c of COLLECTIONS) await store.clear(c);
    const config = { ...loadConfig({}), dataDir: dir, agent: "echo" };
    hub = new Hub(config, store, new Brain(config), new Scripts(store, dir, join(dir, "none")), null);
    hub.vault = new Vault(dir, { masterKey: randomBytes(32) });
    connect = new Connect(hub, hub.vault, null);
  });
  afterEach(async () => { hub.stop(); await hub.idle(5_000); await store.close(); });

  test("every connector has a tile; unofficial ones need the risk accepted first", async () => {
    const tiles = await connect.tiles();
    expect(tiles.map((t) => t.id)).toEqual(CONNECTORS.map((c) => c.def.id));
    expect(tiles.filter((t) => t.risk).map((t) => t.id)).toEqual(["whatsapp", "instagram", "linkedin"]);
    const r = await connect.add("linkedin", { cookies: "li_at=SECRET" }, "test");
    expect(r.error).toContain("breaks LinkedIn's terms");
    const ok = await connect.add("linkedin", { cookies: "li_at=SECRET", acceptRisk: true }, "test");
    expect(ok.value).toMatchObject({ id: "linkedin", state: "connected", riskAccepted: true });
    expect(JSON.stringify(await connect.tiles())).not.toContain("SECRET");
    expect((await connect.remove("linkedin", "test")).value?.state).toBe("off");
  });

  test("a drafted WhatsApp message waits for Approve, then goes out", async () => {
    const out: string[] = [];
    hub.senders.whatsapp = { connected: () => true, send: async (to, text) => { out.push(`${to}: ${text}`); return "id"; } };
    const ap = (await hub.requestMessage({ channel: "whatsapp", to: "15550100", text: "Running late" }, {})).value!;
    expect(ap.status).toBe("pending");
    expect(out).toEqual([]);
    const done = (await hub.decideApproval(ap.id, true)).value as Approval;
    expect(done.status).toBe("done");
    expect(out).toEqual(["15550100: Running late"]);
    expect((await hub.requestMessage({ channel: "slack", to: "C1", text: "x" }, {})).error).toContain("isn't connected");
  });

  test("\"Always allow\" on one chat sends its next messages without asking; other chats still ask", async () => {
    const out: string[] = [];
    hub.senders.whatsapp = { connected: () => true, send: async (to, text) => { out.push(`${to}: ${text}`); return "id"; } };
    const first = (await hub.requestMessage({ channel: "whatsapp", to: "15550111", text: "On my way" }, {})).value!;
    await hub.decideApproval(first.id, true, true);
    expect(await hub.alwaysAllowed()).toContain("whatsapp:15550111");
    const next = (await hub.requestMessage({ channel: "whatsapp", to: "15550111", text: "Here" }, {})).value!;
    expect(next).toMatchObject({ status: "done", auto: true });
    expect(out).toEqual(["15550111: On my way", "15550111: Here"]);
    const other = (await hub.requestMessage({ channel: "whatsapp", to: "15550222", text: "Hi" }, {})).value!;
    expect(other.status).toBe("pending");
    await hub.setAlwaysAllowed([]);
    expect((await hub.requestMessage({ channel: "whatsapp", to: "15550111", text: "Again" }, {})).value!.status).toBe("pending");
  });

  test("Gmail sends to an email address after Approve, with its subject; a reply stays in its thread", async () => {
    const out: any[] = [];
    hub.senders.gmail = { connected: () => true, send: async (to, text, x) => { out.push({ to, text, ...x }); return "id"; } };
    expect((await hub.requestMessage({ channel: "gmail", to: "Sam", text: "hi" }, {})).error).toContain("email address");
    const ap = (await hub.requestMessage({ channel: "gmail", to: "sam@example.com", subject: "Tuesday", text: "Tuesday works.", threadId: "t1" }, {})).value!;
    expect(ap.status).toBe("pending");
    await hub.decideApproval(ap.id, true);
    expect(out).toEqual([{ to: "sam@example.com", text: "Tuesday works.", subject: "Tuesday", threadId: "t1" }]);
    hub.senders.gmail = { connected: () => false, send: async () => "" };
    expect((await hub.requestMessage({ channel: "gmail", to: "sam@example.com", text: "x" }, {})).error).toBeTruthy();
    expect((await hub.requestMessage({ channel: "fax", to: "1", text: "x" }, {})).error).toContain("channel is one of");
  });

  test("picking brains moves every role onto a picked one", async () => {
    await hub.setPrefs({ brainPool: ["echo"] as any });
    expect((await hub.setBrainPool(["nope"])).error).toBeTruthy();
    expect((await hub.setBrainPool([])).error).toContain("at least one");
  });
});

describe("setup", () => {
  test("the CLI's admin key only works on a direct localhost call", () => {
    const req = (h: Record<string, string>) => new Request("http://127.0.0.1/api/connectors", { headers: h });
    expect(isAdminRequest(req({ authorization: "Admin k1" }), "127.0.0.1", "k1")).toBe(true);
    expect(isAdminRequest(req({ authorization: "Admin k1" }), "10.0.0.2", "k1")).toBe(false);
    expect(isAdminRequest(req({ authorization: "Admin k1", "x-forwarded-for": "1.2.3.4" }), "127.0.0.1", "k1")).toBe(false);
    expect(isAdminRequest(req({ authorization: "Admin k2" }), "127.0.0.1", "k1")).toBe(false);
  });

  test("a remote setup says exactly what's missing", () => {
    const base = { host: "203.0.113.10", user: "ubuntu", domain: "assistant.example.com", email: "me@example.com", brains: ["claude" as const] };
    expect(validRemote(base)).toBeNull();
    expect(validRemote({ ...base, domain: "nope" })).toContain("domain");
    expect(validRemote({ ...base, brains: [] })).toContain("brain");
    expect(validRemote({ ...base, key: "/no/such/key" })).toContain("No SSH key");
    expect(validRemote({ ...base, email: undefined })).toBeNull(); // the email is optional
    expect(validRemote({ ...base, email: "nope" })).toContain("email");
    expect(pairLink("open https://assistant.example.com/#pair=ABCD-EFGH now")).toBe("https://assistant.example.com/#pair=ABCD-EFGH");
  });

  test("an uploaded key is kept owner-only; a public key or other file is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "hearth-keys-"));
    const r = saveKey("../Lightsail Default.pem", "-----BEGIN RSA PRIVATE KEY-----\nabc", join(dir, "ssh")) as { path: string };
    expect(r.path).toBe(join(dir, "ssh", "Lightsail_Default.pem"));
    expect(statSync(r.path).mode & 0o777).toBe(0o600);
    expect(saveKey("id.pub", "ssh-ed25519 AAAA me", dir)).toEqual({ error: expect.stringContaining("public key") });
    expect(saveKey("notes.txt", "hello", dir)).toEqual({ error: expect.stringContaining("isn't an SSH private key") });
    const loose = join(dir, "loose.pem"); writeFileSync(loose, "x", { mode: 0o644 });
    expect(tightenKey(loose)).toBe(true);
    expect(statSync(loose).mode & 0o777).toBe(0o600);
  });
});

describe("WhatsApp link", () => {
  test("reconnects after WhatsApp drops the socket right after a QR scan", async () => {
    const { WhatsApp } = await import("../src/connectors/whatsapp.ts");
    const socks: any[] = [];
    const configs: any[] = [];
    const fake = {
      default: (cfg: any) => {
        configs.push(cfg);
        const handlers: Record<string, ((u: any) => void)[]> = {};
        const sock = { ev: { on: (e: string, f: any) => (handlers[e] ||= []).push(f) }, emit: (e: string, u: any) => (handlers[e] || []).forEach((f) => f(u)), end() {}, user: { id: "15550100:1@s.whatsapp.net" } };
        socks.push(sock);
        return sock;
      },
      useMultiFileAuthState: async () => ({ state: {}, saveCreds: () => {} }),
      fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
      Browsers: { macOS: (b: string) => ["Mac OS", b, "14.4.1"] },
      DisconnectReason: { loggedOut: 401, restartRequired: 515 },
      proto: { Message: { HistorySyncNotification: { HistorySyncType: { INITIAL_BOOTSTRAP: 0, FULL: 2, RECENT: 3 } } } },
    };
    const store = { get: async () => null, put: async () => {}, all: async () => [], clear: async () => {}, remove: async () => {} } as any;
    const wa = new WhatsApp(mkdtempSync(join(tmpdir(), "hearth-wa-")), store, () => true, async () => fake);
    await wa.start();
    expect(socks.length).toBe(1);
    // The recent-chats sync WhatsApp sends at link time is taken; the full archive isn't.
    expect(configs[0].shouldSyncHistoryMessage({ syncType: 0 })).toBe(true);
    expect(configs[0].shouldSyncHistoryMessage({ syncType: 3 })).toBe(true);
    expect(configs[0].shouldSyncHistoryMessage({ syncType: 2 })).toBe(false);
    socks[0].emit("connection.update", { qr: "code" });
    // The scan pairs, then WhatsApp closes and asks for a restart.
    socks[0].emit("connection.update", { connection: "close", lastDisconnect: { error: { output: { statusCode: 515 } } } });
    await Bun.sleep(1300);
    expect(socks.length).toBe(2);
    socks[1].emit("connection.update", { connection: "open" });
    expect(wa.connected()).toBe(true);
    wa.stop();
  });
});
