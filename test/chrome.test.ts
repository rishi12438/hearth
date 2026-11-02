import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { chromeLogins } from "../src/chrome.ts";

// A fake Chrome folder: two profiles, only "Work" logged in to LinkedIn. Detection reads cookie names, never values.
function fakeChrome() {
  const home = mkdtempSync(join(tmpdir(), "hearth-chrome-"));
  const root = join(home, "Library", "Application Support", "Google", "Chrome");
  const profile = (dir: string, cookies: [string, string][]) => {
    mkdirSync(join(root, dir), { recursive: true });
    const db = new Database(join(root, dir, "Cookies"));
    db.run("CREATE TABLE cookies (host_key TEXT, name TEXT, encrypted_value BLOB, path TEXT, is_secure INT, expires_utc INT)");
    for (const [host, name] of cookies) db.run("INSERT INTO cookies VALUES (?, ?, x'763130', '/', 1, 0)", [host, name]);
    db.close();
  };
  profile("Default", [[".instagram.com", "sessionid"]]);
  profile("Profile 2", [[".www.linkedin.com", "li_at"], [".linkedin.com", "JSESSIONID"]]);
  writeFileSync(join(root, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Personal" }, "Profile 2": { name: "Work", user_name: "me@work.com" } } } }));
  return home;
}

test.if(platform() === "darwin")("finds which Chrome profile is logged in to each site", () => {
  const r = chromeLogins([
    { id: "linkedin", domain: "linkedin.com", required: ["li_at"] },
    { id: "instagram", domain: "instagram.com", required: ["sessionid"] },
    { id: "x", domain: "x.com", required: ["auth_token", "ct0"] },
  ], fakeChrome());
  expect(r.chrome).toBe(true);
  expect(r.logins.linkedin).toEqual([{ id: "Profile 2", label: "Chrome · Work (me@work.com)" }]);
  expect(r.logins.instagram).toEqual([{ id: "Default", label: "Chrome · Personal" }]);
  expect(r.logins.x).toEqual([]);
});

test.if(platform() === "darwin")("no Chrome on this Mac", () => {
  expect(chromeLogins([{ id: "linkedin", domain: "linkedin.com", required: ["li_at"] }], mkdtempSync(join(tmpdir(), "hearth-nochrome-")))).toEqual({ chrome: false, logins: { linkedin: [] } });
});
