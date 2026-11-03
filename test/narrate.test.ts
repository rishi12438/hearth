import { expect, test } from "bun:test";
import { Narrator, cleanNarration, narratePrompt, NARRATE } from "../src/brains/narrate.ts";

const setup = (reply = "Checking Spin Art's November times.") => {
  let t = 0;
  const asked: string[] = [], shown: string[] = [];
  const n = new Narrator({ task: "Spray painting in Phoenix", everyMs: 0, staleMs: 10_000, maxCalls: 3, now: () => t,
    ask: async (p) => { asked.push(p); return reply; }, show: (s) => shown.push(s) });
  return { n, asked, shown, at: (ms: number) => { t = ms; } };
};

test("a generic label that sits a while gets narrated from the latest actions", async () => {
  const { n, asked, shown, at } = setup();
  n.step("Working it out");
  n.action("shell: /bin/zsh -lc 'curl -s https://spinart.com/phoenix/calendar'");
  at(5_000); await n.tick();
  expect(asked).toHaveLength(0); // not stale yet
  at(11_000); await n.tick();
  expect(shown).toEqual(["Checking Spin Art's November times"]);
  expect(asked[0].startsWith(NARRATE)).toBe(true); // fixed instructions first, so the prefix caches
  expect(asked[0]).toContain("spinart.com/phoenix/calendar");
  // Nothing new happened: no second call.
  at(30_000); await n.tick();
  expect(asked).toHaveLength(1);
});

test("specific labels are left alone, and the per-job cap holds", async () => {
  const { n, asked, at } = setup();
  n.step("Searching: graffiti class Phoenix"); n.action("web search: graffiti class Phoenix");
  at(60_000); await n.tick();
  expect(asked).toHaveLength(0);
  for (let i = 0; i < 6; i++) { n.step("Working it out"); n.action(`shell: step ${i}`); at(100_000 * (i + 1)); await n.tick(); }
  expect(asked).toHaveLength(3);
});

test("a newer label that arrives while it thinks wins, and stop() silences it", async () => {
  let release!: (s: string) => void;
  let t = 0; const shown: string[] = [];
  const n = new Narrator({ task: "x", everyMs: 0, now: () => t, ask: () => new Promise((r) => (release = r)), show: (s) => shown.push(s) });
  n.step("Working it out"); n.action("shell: python3 a.py"); t = 20_000;
  const p = n.tick();
  n.step("Searching: spray paint class");
  release("Comparing class prices"); await p;
  expect(shown).toEqual([]);
  n.stop(); n.step("Working it out"); n.action("shell: b"); t = 99_000; await n.tick();
  expect(shown).toEqual([]);
});

test("only short, clean status lines get through", () => {
  expect(cleanNarration('"Comparing workshop prices."\n')).toBe("Comparing workshop prices");
  expect(cleanNarration("ok")).toBeNull();
  expect(cleanNarration("Reading https://x.com")).toBeNull();
  expect(cleanNarration("x".repeat(90))).toBeNull();
  expect(narratePrompt("t", ["a", "b"])).toContain("- a\n- b");
});

test("Codex's real browser commands get plain labels", async () => {
  const { describeCommand } = await import("../src/brain.ts");
  expect(describeCommand(`/bin/bash -lc "enkidu-browser session use hearth-aliexpress-xqkm open '{\\"url\\":\\"https://www.aliexpress.com/p/order/index.html\\"}'"`)).toBe("Browsing aliexpress.com");
  expect(describeCommand(`/bin/bash -lc "enkidu-browser session new hearth-aliexpress-xqkm '{\\"recordName\\":\\"Check AliExpress orders\\"}'"`)).toBe("Opening the browser");
  expect(describeCommand(`/bin/bash -lc 'enkidu-browser session use hearth-aliexpress-xqkm observe'`)).toBe("Looking at the page");
  expect(describeCommand(`/bin/bash -lc 'enkidu-browser session close hearth-aliexpress-xqkm'`)).toBe("Closing the browser");
});
