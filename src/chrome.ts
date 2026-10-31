import { Database } from "bun:sqlite";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import type { Cookie } from "./browser.ts";

// Read the user's own browser login so a connector (LinkedIn, X) works without pasting cookies by hand, the way
// Enkidu does: the one secret that needs the OS is the "Safe Storage" key in the login Keychain, read by a small
// signed helper (macOS shows one "Always Allow" prompt). With that key, the browser's own Cookies file is decrypted
// locally and only the asked-for site's cookies are kept. This is the user's machine and their own logins; the
// cookies go straight into the hub's encrypted vault and are never printed. First-party only: this never touches a
// cookie store it wasn't pointed at, and reads cookies only, never saved passwords.

type Browser = { name: string; dir: string; keychain: string; account: string };
const BROWSERS: Browser[] = [
  { name: "Chrome", dir: "Google/Chrome", keychain: "Chrome Safe Storage", account: "Chrome" },
  { name: "Brave", dir: "BraveSoftware/Brave-Browser", keychain: "Brave Safe Storage", account: "Brave" },
  { name: "Edge", dir: "Microsoft Edge", keychain: "Microsoft Edge Safe Storage", account: "Microsoft Edge" },
];

export type BrowserProfile = { browser: string; profile: string; label: string; cookiesDb: string };

const supportDir = (home: string) => join(home, "Library", "Application Support");
const cookiesPath = (profileDir: string) =>
  [join(profileDir, "Network", "Cookies"), join(profileDir, "Cookies")].find((p) => existsSync(p)) || null;

/** Every browser profile on this Mac that has a cookie store. macOS only; elsewhere, paste cookies instead. */
export function browserProfiles(home = homedir()): BrowserProfile[] {
  if (platform() !== "darwin") return [];
  const out: BrowserProfile[] = [];
  for (const b of BROWSERS) {
    const root = join(supportDir(home), b.dir);
    if (!existsSync(root)) continue;
    for (const name of ["Default", ...readdirSync(root).filter((d) => /^Profile \d+$/.test(d))]) {
      const db = cookiesPath(join(root, name));
      if (db) out.push({ browser: b.name, profile: name, label: name === "Default" ? b.name : `${b.name} · ${name}`, cookiesDb: db });
    }
  }
  return out;
}

/** The host names a profile is logged into for this site (plaintext in the DB; values stay encrypted). */
export function profileHasSite(cookiesDb: string, domain: string, required: string[]): boolean {
  const tmp = copyToTemp(cookiesDb);
  try {
    const db = new Database(tmp, { readonly: true });
    const q = db.query(`SELECT name FROM cookies WHERE host_key LIKE ? AND name IN (${required.map(() => "?").join(",")})`).all(`%${domain}`, ...required) as { name: string }[];
    db.close();
    return required.every((n) => q.some((r) => r.name === n));
  } catch { return false; } finally { rmSync(tmp, { force: true }); }
}

function copyToTemp(src: string) {
  const dir = mkdtempSync(join(tmpdir(), "hearth-ck-"));
  const dst = join(dir, "Cookies");
  copyFileSync(src, dst); // copy so a live browser's lock/WAL doesn't block the read
  return dst;
}

/**
 * The browser's "Safe Storage" key from the login Keychain. We don't reach into the Keychain ourselves: we run a
 * small signed helper that asks macOS for exactly this item, so the OS shows its own approval prompt. Enkidu ships
 * one (enkidu-chrome-key-extractor); HEARTH_KEYCHAIN_HELPER can point at another. Without a helper, there's no
 * silent path, and the connector falls back to pasting cookies.
 */
function safeStorageKey(browser: Browser, env: Record<string, string | undefined>): Buffer | null {
  const helper = env.HEARTH_KEYCHAIN_HELPER || join(homedir(), ".enkidu", "bin", "enkidu-chrome-key-extractor");
  const run = (cmd: string[]) => {
    try {
      const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" });
      const out = p.success ? new TextDecoder().decode(p.stdout).trim() : "";
      return out || null;
    } catch { return null; }
  };
  // Prefer a dedicated helper; else the OS `security` tool, which prompts the same way.
  const pass = (existsSync(helper) && browser.name === "Chrome" && run([helper]))
    || run(["security", "find-generic-password", "-wa", browser.account, "-s", browser.keychain]);
  if (!pass) return null;
  return pbkdf2Sync(pass, "saltysalt", 1003, 16, "sha1");
}

function decryptValue(key: Buffer, blob: Uint8Array): string {
  if (blob.length < 4 || blob[0] !== 0x76) return ""; // "v10"/"v11" prefix only
  try {
    const d = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    let out = Buffer.concat([d.update(Buffer.from(blob.subarray(3))), d.final()]);
    // Chrome 130+ on macOS prepends a 32-byte domain hash before the value.
    if (out.length > 32 && out.subarray(0, 32).some((b) => b < 0x09 || b > 0x7e)) out = out.subarray(32);
    return out.toString("utf8");
  } catch { return ""; }
}

/** This site's cookies from the chosen profile, decrypted. Empty if there's no Keychain helper or nothing's stored. */
export function readSiteCookies(prof: BrowserProfile, domain: string, env: Record<string, string | undefined> = process.env): Cookie[] {
  const browser = BROWSERS.find((b) => b.name === prof.browser)!;
  const key = safeStorageKey(browser, env);
  if (!key) return [];
  const tmp = copyToTemp(prof.cookiesDb);
  try {
    const db = new Database(tmp, { readonly: true });
    const rows = db.query("SELECT host_key, name, encrypted_value, path, is_secure FROM cookies WHERE host_key LIKE ?").all(`%${domain}`) as any[];
    db.close();
    return rows.map((r) => ({ name: r.name, value: decryptValue(key, r.encrypted_value), domain: r.host_key, path: r.path || "/", secure: !!r.is_secure }))
      .filter((c) => c.value);
  } catch { return []; } finally { rmSync(tmp, { force: true }); }
}

/** Is a silent read possible at all (macOS, a browser present, and a Keychain helper)? */
export function canReadBrowser(env: Record<string, string | undefined> = process.env) {
  if (platform() !== "darwin") return false;
  const helper = env.HEARTH_KEYCHAIN_HELPER || join(homedir(), ".enkidu/bin/enkidu-chrome-key-extractor");
  return existsSync(helper) || !!Bun.which("security");
}
