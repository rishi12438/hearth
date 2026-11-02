import { Database } from "bun:sqlite";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import type { Cookie, Fingerprint } from "./browser.ts";

// Chrome only for now (not Brave, Edge, Safari or Firefox), so the app can say plainly "logged in on Chrome".
// Read the user's own browser login so a connector (LinkedIn, X) works without pasting cookies by hand, the way
// Enkidu does: the one secret that needs the OS is the "Safe Storage" key in the login Keychain, read by a small
// signed helper (macOS shows one "Always Allow" prompt). With that key, the browser's own Cookies file is decrypted
// locally and only the asked-for site's cookies are kept. This is the user's machine and their own logins; the
// cookies go straight into the hub's encrypted vault and are never printed. First-party only: this never touches a
// cookie store it wasn't pointed at, and reads cookies only, never saved passwords.

type Browser = { name: string; dir: string; keychain: string; account: string };
const BROWSERS: Browser[] = [
  { name: "Chrome", dir: "Google/Chrome", keychain: "Chrome Safe Storage", account: "Chrome" },
];

export type BrowserProfile = { browser: string; profile: string; label: string; cookiesDb: string };

const supportDir = (home: string) => join(home, "Library", "Application Support");
const cookiesPath = (profileDir: string) =>
  [join(profileDir, "Network", "Cookies"), join(profileDir, "Cookies")].find((p) => existsSync(p)) || null;

/** The names you gave your Chrome profiles ("Work", "Personal"), from Chrome's Local State. */
function profileNames(root: string): Record<string, string> {
  try {
    const cache = JSON.parse(readFileSync(join(root, "Local State"), "utf8"))?.profile?.info_cache || {};
    // "Person 1 (you@gmail.com)" when Chrome knows the Google account, so a generic name still says whose it is.
    return Object.fromEntries(Object.entries(cache).map(([dir, v]: [string, any]) => {
      const name = String(v?.name || "").trim(), user = String(v?.user_name || "").trim();
      return [dir, name && user && name !== user ? `${name} (${user})` : name || user];
    }).filter(([, n]) => n));
  } catch { return {}; }
}

/** Every Chrome profile on this Mac that has a cookie store. macOS only; elsewhere, paste cookies instead. */
export function browserProfiles(home = homedir()): BrowserProfile[] {
  if (platform() !== "darwin") return [];
  const out: BrowserProfile[] = [];
  for (const b of BROWSERS) {
    const root = join(supportDir(home), b.dir);
    if (!existsSync(root)) continue;
    const names = profileNames(root);
    const dirs = ["Default", ...readdirSync(root).filter((d) => /^Profile \d+$/.test(d))];
    for (const name of dirs) {
      const db = cookiesPath(join(root, name));
      if (!db) continue;
      // One profile: just "Chrome". Several: "Chrome · Work" (the name you gave it), so you can tell them apart.
      const label = dirs.length === 1 ? b.name : `${b.name} · ${names[name] || name}`;
      out.push({ browser: b.name, profile: name, label, cookiesDb: db });
    }
  }
  return out;
}

/** Which Chrome profiles are logged in to each site. Reads cookie names only, never values, so macOS doesn't ask. */
export function chromeLogins(sites: { id: string; domain: string; required: string[] }[], home = homedir()) {
  const profiles = browserProfiles(home);
  const logins: Record<string, { id: string; label: string }[]> = {};
  for (const s of sites) logins[s.id] = profiles.filter((p) => profileHasSite(p.cookiesDb, s.domain, s.required)).map((p) => ({ id: p.profile, label: p.label }));
  return { chrome: profiles.length > 0, logins };
}

/** The host names a profile is logged into for this site (plaintext in the DB; values stay encrypted). */
export function profileHasSite(cookiesDb: string, domain: string, required: string[]): boolean {
  const tmp = copyToTemp(cookiesDb);
  try {
    const db = new Database(tmp, { readonly: true });
    const q = (required.length
      ? db.query(`SELECT name FROM cookies WHERE host_key LIKE ? AND name IN (${required.map(() => "?").join(",")})`).all(`%${domain}`, ...required)
      : db.query("SELECT name FROM cookies WHERE host_key LIKE ? LIMIT 1").all(`%${domain}`)) as { name: string }[];
    db.close();
    return required.length ? required.every((n) => q.some((r) => r.name === n)) : q.length > 0;
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
    const rows = db.query("SELECT host_key, name, encrypted_value, path, is_secure, expires_utc FROM cookies WHERE host_key LIKE ?").all(`%${domain}`) as any[];
    db.close();
    // Chrome stores expiry as microseconds since 1601-01-01; convert to unix seconds (0 = session cookie).
    const toUnix = (us: number) => (us > 0 ? Math.round(us / 1e6 - 11_644_473_600) : undefined);
    return rows.map((r) => ({ name: r.name, value: decryptValue(key, r.encrypted_value), domain: r.host_key, path: r.path || "/", secure: !!r.is_secure, expires: toUnix(Number(r.expires_utc)) }))
      .filter((c) => c.value);
  } catch { return []; } finally { rmSync(tmp, { force: true }); }
}

/** The first local browser profile logged into a site, with its decrypted cookies — for copying up to a hub. */
export function readSiteCookiesAnywhere(domain: string, required: string[], env: Record<string, string | undefined> = process.env): { profile: string; cookies: Cookie[] } | null {
  for (const p of browserProfiles()) {
    if (!profileHasSite(p.cookiesDb, domain, required)) continue;
    const cookies = readSiteCookies(p, domain, env);
    if (cookies.length && required.every((n) => cookies.some((c) => c.name === n && c.value))) return { profile: p.label, cookies };
  }
  return null;
}

/** Is a silent read possible at all (macOS, a browser present, and a Keychain helper)? */
export function canReadBrowser(env: Record<string, string | undefined> = process.env) {
  if (platform() !== "darwin") return false;
  const helper = env.HEARTH_KEYCHAIN_HELPER || join(homedir(), ".enkidu/bin/enkidu-chrome-key-extractor");
  return existsSync(helper) || !!Bun.which("security");
}

/**
 * This Mac's Chrome as a site sees it: user agent, client hints, languages, time zone. Sent to the hub with the
 * cookies, so the hub reads as this same browser (a different one makes LinkedIn end the session; see Fingerprint).
 */
export function chromeFingerprint(home = homedir(), profile = "Default"): Fingerprint | null {
  if (platform() !== "darwin") return null;
  const run = (cmd: string[]) => { try { const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "ignore" }); return p.success ? new TextDecoder().decode(p.stdout).trim() : ""; } catch { return ""; } };
  const full = run(["defaults", "read", "/Applications/Google Chrome.app/Contents/Info", "CFBundleShortVersionString"]);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(full)) return null;
  const major = full.split(".")[0];
  const mac = run(["sw_vers", "-productVersion"]) || "14.0";
  const arm = run(["uname", "-m"]) === "arm64";
  let langs = "en-US,en";
  try {
    const prefs = JSON.parse(readFileSync(join(supportDir(home), "Google/Chrome", profile, "Preferences"), "utf8"));
    langs = String(prefs?.intl?.selected_languages || prefs?.intl?.accept_languages || langs);
  } catch {}
  // Chrome's Accept-Language: the first as is, then q=0.9, 0.8… ("en-GB,en-US;q=0.9,en;q=0.8").
  const acceptLanguage = langs.split(",").map((l) => l.trim()).filter(Boolean).slice(0, 8).map((l, i) => (i ? `${l};q=${Math.max(0.1, 1 - i / 10).toFixed(1)}` : l)).join(",");
  let timezone: string | undefined;
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
  const brands = [{ brand: "Google Chrome", version: major }, { brand: "Chromium", version: major }, { brand: "Not_A Brand", version: "24" }];
  const [mj, mn = "0", pt = "0"] = mac.split(".");
  return {
    // Chrome freezes the macOS part of its user agent at 10_15_7 and the version at MAJOR.0.0.0.
    userAgent: `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    acceptLanguage, platform: "MacIntel", timezone,
    metadata: { brands, fullVersionList: brands.map((b) => ({ brand: b.brand, version: b.brand === "Not_A Brand" ? "24.0.0.0" : full })), fullVersion: full,
      platform: "macOS", platformVersion: `${mj}.${mn}.${pt}`, architecture: arm ? "arm" : "x86", model: "", mobile: false, bitness: "64", wow64: false },
  };
}
