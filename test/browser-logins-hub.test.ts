import { test, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, COLLECTIONS, type Store } from "../src/store/index.ts";
import { Hub } from "../src/hub.ts";
import { Brain } from "../src/brain.ts";
import { Scripts } from "../src/scripts.ts";
import { loadConfig } from "../src/config.ts";
import type { Activity } from "../src/types.ts";

// The hub hands your logins to the brain's browser before each job. When it can't (the live hub's systemd unit once
// kept ~/.enkidu read-only), it has to say so where you'll see it, once, and say again when it's fixed.
let dir: string, store: Store, hub: Hub, logins: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hearth-blogins-"));
  store = await createStore(process.env.TEST_DB || "sqlite::memory:", dir);
  for (const c of COLLECTIONS) await store.clear(c);
  const config = { ...loadConfig({}), dataDir: dir, agent: "echo" };
  hub = new Hub(config, store, new Brain(config), new Scripts(store, dir, join(dir, "none")), null);
  logins = join(dir, "enkidu");
  mkdirSync(logins);
  hub.browserLoginsFile = join(logins, "chrome-logins.json");
});
afterEach(() => { try { chmodSync(logins, 0o700); } catch {} rmSync(dir, { recursive: true, force: true }); });

const said = async () => (await store.all<Activity>("activity")).filter((a) => a.kind === "browser.logins").map((a) => a.text);
const settle = () => new Promise((r) => setTimeout(r, 20));

test("a logins file it can't write is reported once, and its fix once", async () => {
  chmodSync(logins, 0o500);
  expect(() => hub.giveBrowserLogins()).toThrow();
  expect(() => hub.giveBrowserLogins()).toThrow();
  await settle();
  const first = await said();
  expect(first.length).toBe(1);
  expect(first[0]).toContain("signed out of every site");

  chmodSync(logins, 0o700);
  hub.giveBrowserLogins();
  hub.giveBrowserLogins();
  await settle();
  const after = await said();
  expect(after.length).toBe(2);
  expect(after.some((t) => t.includes("signed in to your connected sites again"))).toBe(true);
  expect(JSON.parse(readFileSync(hub.browserLoginsFile!, "utf8"))).toEqual([]);
});

test("writing fine says nothing", async () => {
  hub.giveBrowserLogins();
  await settle();
  expect(await said()).toEqual([]);
});

test("a model is named the way the app shows it", async () => {
  const { brainName } = await import("../src/hub.ts");
  expect(brainName({ harness: "claude", model: "claude-opus-5-5" })).toBe("Claude opus-5-5");
  expect(brainName({ harness: "codex", model: "" })).toBe("Codex");
});
