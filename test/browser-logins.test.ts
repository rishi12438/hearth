import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncBrowserLogins } from "../src/brains/browser-logins.ts";

const dir = () => mkdtempSync(join(tmpdir(), "hearth-logins-"));
const read = (f: string) => JSON.parse(readFileSync(f, "utf8"));

test("writes connected logins as DevTools cookies, owner-only", () => {
  const d = dir(), file = join(d, "chrome-logins.json"), managed = join(d, "managed.json");
  expect(syncBrowserLogins({ "aliexpress.com": [{ name: "x5sec", value: "v", domain: ".aliexpress.com", httpOnly: true, expires: 1900000000 }] }, managed, file)).toBe(true);
  expect(read(file)).toEqual([{ name: "x5sec", value: "v", url: "https://aliexpress.com/", domain: ".aliexpress.com", path: "/", secure: true, httpOnly: true, expires: 1900000000 }]);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  // Same logins again: nothing to write.
  expect(syncBrowserLogins({ "aliexpress.com": [{ name: "x5sec", value: "v", domain: ".aliexpress.com", httpOnly: true, expires: 1900000000 }] }, managed, file)).toBe(false);
});

test("replaces a site's old cookies, keeps other logins, drops disconnected sites", () => {
  const d = dir(), file = join(d, "chrome-logins.json"), managed = join(d, "managed.json");
  writeFileSync(file, JSON.stringify([
    { name: "old", value: "1", url: "https://www.aliexpress.com/", path: "/" },
    { name: "mine", value: "2", domain: ".reddit.com", path: "/" },
  ]));
  syncBrowserLogins({ "aliexpress.com": [{ name: "new", value: "3", domain: ".aliexpress.com" }], "x.com": [{ name: "auth", value: "4", domain: ".x.com" }] }, managed, file);
  expect(read(file).map((c: any) => c.name)).toEqual(["mine", "new", "auth"]);
  // x.com disconnected in Hearth: its cookies leave the browser; reddit (not Hearth's) stays.
  syncBrowserLogins({ "aliexpress.com": [{ name: "new", value: "3", domain: ".aliexpress.com" }] }, managed, file);
  expect(read(file).map((c: any) => c.name)).toEqual(["mine", "new"]);
});

test("leaves an empty file when nothing is connected, so the jail can hide it", () => {
  const d = dir(), file = join(d, "chrome-logins.json");
  syncBrowserLogins({}, join(d, "managed.json"), file);
  expect(read(file)).toEqual([]);
});
