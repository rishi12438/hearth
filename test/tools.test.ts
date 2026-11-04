import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkTools, cleanToolStatus } from "../src/brains/tools.ts";
import { Computers } from "../src/computers.ts";

/** A home with both tools in ~/.enkidu/bin (their status is faked by `run`). */
function home() {
  const h = mkdtempSync(join(tmpdir(), "hearth-tools-"));
  mkdirSync(join(h, ".enkidu", "bin"), { recursive: true });
  for (const t of ["enkidu-browser", "enkidu-cua"]) writeFileSync(join(h, ".enkidu", "bin", t), "");
  return h;
}
const alive = JSON.stringify({ alive: true, daemonVersion: "0.1.0", components: ["browser", "cua"], message: "ok" });

test("ready when the daemon answers and has the tool", async () => {
  const r = await checkTools({}, home(), async () => ({ code: 0, out: alive }), () => "/chrome");
  expect(r.map((t) => [t.id, t.state, t.detail])).toEqual([["enkidu-browser", "ok", "Ready · v0.1.0"], ["enkidu-cua", "ok", "Ready · v0.1.0"]]);
});

test("says what's wrong: daemon down, not registered, no Chrome, off, not installed", async () => {
  const down = await checkTools({}, home(), async () => ({ code: 1, out: "enkidu-browser: daemon not running (socket missing)" }), () => "/chrome");
  expect(down.map((t) => [t.state, t.detail])).toEqual([["down", "enkidu-browser: daemon not running (socket missing)"], ["down", "enkidu-browser: daemon not running (socket missing)"]]);
  const noCua = await checkTools({}, home(), async () => ({ code: 0, out: JSON.stringify({ alive: true, components: ["browser"] }) }), () => null);
  expect(noCua.map((t) => [t.state, t.detail])).toEqual([["down", "No Chrome found on this machine"], ["down", "Installed, but not registered with its service"]]);
  const off = await checkTools({ HEARTH_CUA: "off" }, mkdtempSync(join(tmpdir(), "hearth-none-")), async () => ({ code: 0, out: alive }), () => "/chrome");
  expect(off.map((t) => t.state)).toEqual([expect.stringMatching(/missing|ok/), "off"]);
});

test("a computer's report is checked, kept, and shown with its status", () => {
  expect(cleanToolStatus([{ id: "enkidu-browser", state: "ok", detail: "Ready" }, { id: "rm -rf", state: "ok" }, { id: "enkidu-cua", state: "weird" }]))
    .toEqual([{ id: "enkidu-browser", label: "Browser", state: "ok", detail: "Ready" }]);
  const dir = mkdtempSync(join(tmpdir(), "hearth-cmp-"));
  const c = new Computers({ dataDir: dir, homeDir: join(dir, "home"), acceptCopies: true, now: () => 1_000_000 } as any);
  let changes = 0;
  c.onChange = () => { changes++; };
  c.attach("mac1", "Studio (Mac)", { send() {}, close() {} });
  c.message("mac1", JSON.stringify({ t: "hello", harnesses: ["claude"], platform: "darwin" }));
  const before = changes;
  c.message("mac1", JSON.stringify({ t: "tools", tools: [{ id: "enkidu-browser", state: "down", detail: "daemon not running" }] }));
  expect(c.status("mac1", "").tools).toEqual([{ id: "enkidu-browser", label: "Browser", state: "down", detail: "daemon not running" }]);
  expect(changes).toBe(before + 1);
});
