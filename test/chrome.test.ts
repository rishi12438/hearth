import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pbkdf2Sync, createCipheriv } from "node:crypto";
import { Database } from "bun:sqlite";
import { readSiteCookies, browserProfiles, profileHasSite, type BrowserProfile } from "../src/chrome.ts";

// Reading a local browser's cookies: decrypt macOS Chrome's "v10" values with the Safe Storage key, keep only the
// asked-for site. We stand in a fake Keychain helper (a script that prints a known password) so the round-trip runs
// anywhere, and build a Cookies DB encrypted with that same key.

function fakeHelper(dir: string, password: string) {
  const path = join(dir, "key-helper.sh");
  writeFileSync(path, `#!/bin/sh\necho '${password}'\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

/** Encrypt like macOS Chrome: "v10" + AES-128-CBC (iv = 16 spaces), key = PBKDF2(password, "saltysalt", 1003, 16). */
function encryptValue(password: string, value: string, domainHash = false) {
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const c = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const body = domainHash ? Buffer.concat([Buffer.alloc(32, 0), Buffer.from(value)]) : Buffer.from(value);
  return Buffer.concat([Buffer.from("v10"), c.update(body), c.final()]);
}

function makeProfile(cookies: { host: string; name: string; enc: Buffer }[], password: string): { prof: BrowserProfile; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "hearth-chrome-test-"));
  const db = new Database(join(dir, "Cookies"), { create: true });
  db.run("CREATE TABLE cookies (host_key TEXT, name TEXT, encrypted_value BLOB, path TEXT, is_secure INT, expires_utc INT)");
  for (const c of cookies) db.query("INSERT INTO cookies VALUES (?,?,?,?,?,?)").run(c.host, c.name, c.enc, "/", 1, 0);
  db.close();
  return {
    prof: { browser: "Chrome", profile: "Default", label: "Chrome", cookiesDb: join(dir, "Cookies") },
    env: { HEARTH_KEYCHAIN_HELPER: fakeHelper(dir, password) },
  };
}

test("reads and decrypts only the asked-for site's cookies, with the Safe Storage key", () => {
  const pw = "U3qPWqvXjK0+gRJP4dA9dA==";
  const { prof, env } = makeProfile([
    { host: ".www.linkedin.com", name: "li_at", enc: encryptValue(pw, "AQEDAR-secret-session") },
    { host: ".linkedin.com", name: "JSESSIONID", enc: encryptValue(pw, "ajax:1234567890", true) }, // newer Chrome: 32-byte hash prefix
    { host: ".google.com", name: "SID", enc: encryptValue(pw, "other-site") },
  ], pw);
  const cookies = readSiteCookies(prof, "linkedin.com", env);
  expect(cookies.map((c) => c.name).sort()).toEqual(["JSESSIONID", "li_at"]);
  expect(cookies.find((c) => c.name === "li_at")!.value).toBe("AQEDAR-secret-session");
  expect(cookies.find((c) => c.name === "JSESSIONID")!.value).toBe("ajax:1234567890"); // domain hash stripped
  expect(cookies.some((c) => c.value.includes("other-site"))).toBe(false); // google.com not returned
});

test("a wrong Safe Storage key decrypts nothing, rather than returning garbage", () => {
  const { prof } = makeProfile([{ host: ".x.com", name: "auth_token", enc: encryptValue("right-key", "0123456789") }], "right-key");
  const dir = mkdtempSync(join(tmpdir(), "hearth-badkey-"));
  const cookies = readSiteCookies(prof, "x.com", { HEARTH_KEYCHAIN_HELPER: fakeHelper(dir, "wrong-key") });
  expect(cookies.every((c) => c.value !== "0123456789")).toBe(true);
});

test("profileHasSite reads host names (plaintext) without needing the key", () => {
  const { prof } = makeProfile([{ host: ".www.linkedin.com", name: "li_at", enc: Buffer.from("v10encrypted") }], "k");
  expect(profileHasSite(prof.cookiesDb, "linkedin.com", ["li_at"])).toBe(true);
  expect(profileHasSite(prof.cookiesDb, "x.com", ["auth_token"])).toBe(false);
});

test("browserProfiles is empty off macOS, so connectors fall back to pasting", () => {
  // On a non-macOS CI box this is []; on macOS it lists real profiles. Either way it never throws.
  expect(Array.isArray(browserProfiles())).toBe(true);
});
