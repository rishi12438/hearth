import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, COLLECTIONS, type Store } from "../src/store/index.ts";
import { Hub } from "../src/hub.ts";
import { Brain } from "../src/brain.ts";
import { Scripts, langOf, detectEffects, describeScript } from "../src/scripts.ts";
import { loadConfig } from "../src/config.ts";
import { portsAgent, parseFlags } from "../src/events/ports.ts";
import type { Message } from "../src/types.ts";

// Trigger ports: an agent claims a callback URL with a reason, an outside service calls it, and a trigger's script
// (any language) works on the event object and publishes clean events that other triggers' formulas test.

let dir: string, store: Store, hub: Hub, scripts: Scripts;
const who = { by: "Bills", jobId: "job-12345678", threadId: "thread-1", teammateId: "mate-1" };
const BASE = "https://hub.example";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hearth-ports-"));
  const repo = join(dir, "repo-scripts");
  mkdirSync(repo);
  // A raw "item X has updates" ping in, the transactions it stands for out: one JSON object per line.
  writeFileSync(join(repo, "plaid-expand.py"), [
    "#!/usr/bin/env python3",
    "# description: turn a Plaid ping into one event per new transaction",
    "import json, os, sys",
    "ev = json.load(sys.stdin)",
    "assert json.loads(os.environ['HEARTH_EVENT'])['id'] == ev['id']",
    "item = ev['payload']['item_id']",
    "for amt, m in [(12.5, 'Starbucks'), (480, 'Delta')]:",
    "    print(json.dumps({'item': item, 'amount': amt, 'merchant': m, 'kind': 'transaction'}))",
    "print('done')",
  ].join("\n"));
  writeFileSync(join(repo, "echo-code.sh"), "#!/usr/bin/env bash\n# description: say the webhook code\necho \"code: $(cat | sed -E 's/.*\"webhook_code\":\"([A-Z_]+)\".*/\\1/')\"\n");
  store = await createStore(process.env.TEST_DB || "sqlite::memory:", dir);
  for (const c of COLLECTIONS) await store.clear(c);
  const config = { ...loadConfig({}), dataDir: dir, agent: "echo" };
  scripts = new Scripts(store, dir, repo);
  await scripts.syncRepo();
  hub = new Hub(config, store, new Brain(config), scripts, null);
});

afterEach(async () => { hub.stop(); await hub.idle(20_000); await store.close(); });

const sent = async () => (await store.all<Message>("messages")).filter((m) => m.proactive);
const urlOf = (out: string) => out.match(/https:\/\/hub\.example\/api\/events\/([\w-]+)\/([\w-]+)/)!;

test("flags parse; a claim needs a reason and who will call it", () => {
  expect(parseFlags(["--reason", "big charges", "--source=plaid", "x", "--var", "amount=data.amount"])).toEqual({ flags: { reason: ["big charges"], source: ["plaid"], var: ["amount=data.amount"] }, rest: ["x"] });
  const p = hub.pipeline;
  expect(portsAgent(p, ["claim", "--source", "plaid"], who, BASE)).toContain("Say what the port is for");
  expect(portsAgent(p, ["claim", "--reason", "bank pings"], who, BASE)).toContain("Say what will call it");
  expect(p.ports()).toEqual([]);
});

test("claiming a port records who took it, from which job, and why; release kills the URL but keeps the record", () => {
  const p = hub.pipeline;
  const out = portsAgent(p, ["claim", "--reason", "new card transactions", "--source", "plaid", "--name", "bank-pings"], who, BASE);
  const [, name, secret] = urlOf(out);
  expect(name).toBe("bank-pings");
  const s = p.findSource("bank-pings")!;
  expect(s.claim).toMatchObject({ reason: "new card transactions", publisher: "plaid", by: "Bills", jobId: "job-12345678", threadId: "thread-1", teammateId: "mate-1" });
  expect(s.variables.map((v) => v.name)).toEqual(["text"]);
  // It takes calls, and the listing says what it's for and who took it (never the secret).
  expect(p.push("bank-pings", secret, JSON.stringify({ item_id: "it1" }))!.value).toBeTruthy();
  const list = portsAgent(p, ["list"], who, BASE);
  expect(list).toContain("for: new card transactions");
  expect(list).toContain("claimed by Bills in job job-12345678");
  expect(list).not.toContain(secret);
  // A second port for the same publisher is allowed, but the claim points at the live one.
  expect(portsAgent(p, ["claim", "--reason", "another", "--source", "plaid"], who, BASE)).toContain("Already live for plaid: bank-pings");
  // Released: the URL stops working at once; the record says when, by whom and why.
  expect(portsAgent(p, ["release", "bank-pings", "--reason", "moved to Teller"], { ...who, by: "you" }, BASE)).toContain("no longer works");
  expect(p.push("bank-pings", secret, "{}")).toBeNull();
  expect(p.findSource("bank-pings")!.claim).toMatchObject({ releasedBy: "you", releaseReason: "moved to Teller" });
  expect(p.rotateSecret("bank-pings").error).toContain("claim a new port");
  expect(portsAgent(p, ["list"], who, BASE)).not.toContain("bank-pings");
  expect(portsAgent(p, ["list", "--all"], who, BASE)).toContain("released");
});

test("scripts can be python or shell, and their effects and description are read from the code", () => {
  expect(langOf("#!/usr/bin/env python3\nprint(1)")).toBe("py");
  expect(langOf("#!/bin/bash\necho")).toBe("sh");
  expect(langOf("console.log(1)")).toBe("ts");
  expect(langOf("print(1)", "python")).toBe("py");
  expect(detectEffects("#!/usr/bin/env python3\nimport requests\nrequests.post('https://x', json={})")).toBe("external");
  expect(detectEffects("#!/usr/bin/env python3\nimport requests\nprint(requests.get('https://x').text)")).toBe("read");
  expect(detectEffects("#!/bin/bash\ncurl -s https://x | jq .")).toBe("read");
  expect(detectEffects("#!/bin/bash\ncurl -s -X POST https://x")).toBe("external");
  expect(detectEffects("#!/bin/bash\necho hi > out.txt")).toBe("external");
  expect(detectEffects("// a TS script that mentions rm and mv\nconsole.log(1 > 0)")).toBe("read");
  expect(describeScript("#!/usr/bin/env python3\n# fetch the price\nprint(1)")).toBe("fetch the price");
});

test("a proposed python script is saved as .py and runs with python once approved", async () => {
  const r = await scripts.propose({ name: "hello-py", code: "#!/usr/bin/env python3\n# say hi\nimport sys\nprint('hi', sys.argv[1])" });
  expect(r.value!.lang).toBe("py");
  expect(scripts.fileFor(r.value!)).toEndWith("hello-py.py");
  expect((await scripts.run("hello-py", ["there"])).output).toContain("waiting for your approval");
  await scripts.approve(r.value!.id, r.value!.sha256);
  expect(await scripts.run("hello-py", ["there"])).toEqual({ ok: true, output: "hi there" });
});

test("ping → port → script on the event object → clean events → a formula on the real fields", async () => {
  const p = hub.pipeline;
  const [, name, secret] = urlOf(portsAgent(p, ["claim", "--reason", "card charges over $200", "--source", "plaid"], who, BASE));
  // Where the clean events go, and the rule the user cares about.
  p.createSource({ name: "bank-txns", description: "one event per transaction", variables: [{ name: "amount" }, { name: "merchant" }, { name: "kind" }] }, "Bills");
  expect((await p.addTrigger({ name: "big-charges", source: "bank-txns", formula: "amount > 200", action: { type: "notify", text: "Big charge: ${{amount}} at {{merchant}}" } }, "Bills")).error).toBeUndefined();
  // publish needs a real destination.
  expect((await p.addTrigger({ name: "expand", source: name, formula: "true", action: { type: "script", script: "plaid-expand", then: "publish", into: "nope" } }, "Bills")).error).toContain("no source called");
  expect((await p.addTrigger({ name: "expand", source: name, formula: "payload.webhook_code == \"SYNC_UPDATES_AVAILABLE\"", action: { type: "script", script: "plaid-expand", then: "publish", into: "bank-txns" } }, "Bills")).error).toBeUndefined();

  const ping = p.push(name, secret, JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-9" }))!.value!;
  await p.drain();
  const e = p.getEvent(ping.id)!;
  expect(e.log!.map((l) => l.detail).join("\n")).toContain("plaid-expand published 2 events into bank-txns");
  const txns = p.events({ source: "bank-txns", log: false });
  expect(txns.map((t) => t.variables.merchant).sort()).toEqual(["Delta", "Starbucks"]);
  expect(txns[0].depth).toBe(1);
  expect((await sent()).map((m) => m.text)).toEqual(["Big charge: $480 at Delta"]);
});

test("a shell script gets the event on stdin and its output is the message", async () => {
  const p = hub.pipeline;
  const [, name, secret] = urlOf(portsAgent(p, ["claim", "--reason", "say what came", "--source", "plaid"], who, BASE));
  await p.addTrigger({ name: "say", source: name, formula: "true", action: { type: "script", script: "echo-code", then: "notify" } }, "Bills");
  p.push(name, secret, JSON.stringify({ webhook_code: "NEW_ACCOUNTS_AVAILABLE" }));
  await p.drain();
  expect((await sent()).map((m) => m.text)).toEqual(["code: NEW_ACCOUNTS_AVAILABLE"]);
});

test("a webhook the hub receives itself (Plaid's) is passed on to the live ports claimed for it, and only those", () => {
  const p = hub.pipeline;
  const [, a] = urlOf(portsAgent(p, ["claim", "--reason", "bank pings", "--source", "plaid"], who, BASE));
  const [, b] = urlOf(portsAgent(p, ["claim", "--reason", "old one", "--source", "plaid"], who, BASE));
  urlOf(portsAgent(p, ["claim", "--reason", "payments", "--source", "stripe"], who, BASE));
  p.releasePort(b, "you");
  expect(p.forwardToPorts("plaid", { webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "i1" })).toBe(1);
  expect(p.events({ source: a, log: false }).map((e) => (e.payload as any).item_id)).toEqual(["i1"]);
  expect(p.events({ source: b, log: false })).toEqual([]);
});

test("a script that says `needs: plaid` gets the hub's address and a Plaid-only key, nothing else", async () => {
  scripts.keys = (n) => (n === "plaid" ? "plaid-key" : n === "serper" ? "serper-key" : null);
  scripts.hubUrl = "http://127.0.0.1:9";
  const r = await scripts.propose({ name: "env-py", code: "#!/usr/bin/env python3\n# needs: plaid\nimport os\nprint(os.environ.get('HEARTH_PLAID_KEY'), os.environ.get('HEARTH_HUB'), os.environ.get('SERPER_API_KEY'))" });
  await scripts.approve(r.value!.id, r.value!.sha256);
  expect((await scripts.run("env-py")).output).toBe("plaid-key http://127.0.0.1:9 None");
});
