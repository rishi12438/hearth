#!/usr/bin/env bun
import { loadConfig } from "./config.ts";
import { createStore, redactUrl } from "./store/index.ts";
import { newPairingCode, owners } from "./auth.ts";
import QRCode from "qrcode";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { Brain } from "./brain.ts";
import { connect, hasLogin, joinHub, readLink } from "./computer.ts";
import { COPY_ITEMS, type CopyItem } from "./computers.ts";
import { Scripts } from "./scripts.ts";
import { Push } from "./push.ts";
import { Hub } from "./hub.ts";
import { startServer } from "./server.ts";
import { VoiceSettings } from "./voice.ts";
import { Vault, masterKeyPath } from "./vault.ts";
import { Library, createEmbeddings } from "./library.ts";
import type { Device, Hook } from "./types.ts";

const cmd = process.argv[2] || "start";
const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });

// The computer side (your Mac): it links to a hub and can copy its logins up. Nothing runs here, so it needs no database.
if (cmd === "join") {
  const args = process.argv.slice(3);
  const named = args.indexOf("--name");
  const name = named >= 0 ? args[named + 1] : undefined;
  const rest = named >= 0 ? args.filter((_, i) => i !== named && i !== named + 1) : args;
  const url = rest[0] || process.env.HEARTH_HUB_URL;
  if (!url) { console.log('usage: bun run join https://yournameassistant.com [--name "Studio"]'); process.exit(1); }
  try { await joinHub(url, config.dataDir, name || undefined); process.exit(0); } catch (e: any) { console.error(`  ${e.message}`); process.exit(1); }
}
if (cmd === "computer") {
  const link = readLink(config.dataDir);
  if (!link) { console.log("This computer isn't linked yet. Run: bun run join https://yournameassistant.com"); process.exit(1); }
  console.log(`hearth · ${link.name} · linking to ${link.hub}`);
  // Exits 0 when unlinked, so launchd and cron don't keep restarting a computer the hub no longer knows.
  const stop = connect({ link, onSignedOut: () => process.exit(0) });
  const quit = () => { stop(); process.exit(0); };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  await new Promise(() => {});
}

const store = await createStore(config.dbUrl, config.dataDir);
const publicUrl = process.env.HEARTH_PUBLIC_URL || `http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`;

async function printPair(code: string, minutes: number, what = "Set up your primary phone") {
  const link = `${publicUrl}/#pair=${code}`;
  console.log(`\n  ${what}: scan this with the phone's camera, or open ${link}`);
  console.log(await QRCode.toString(link, { type: "terminal", small: true }));
  console.log(`  Code ${code} · single use · expires in ${minutes} min.`);
  console.log(`  This phone becomes the primary device. Every other device joins through it, like a router's admin.\n`);
}

if (cmd === "setup" || cmd === "pair") {
  // The terminal only sets up the primary device. After that, devices join through it (Settings → Devices).
  if ((await store.all<Device>("devices")).length) {
    console.log("\n  This hub is already set up. Add devices from your primary phone: Settings → Devices.");
    console.log("  Lost your primary phone? Run `bun run recover` here (only someone with access to this server can).\n");
  } else {
    const { code, expiresInMin } = await newPairingCode(store, "owner");
    await printPair(code, expiresInMin);
  }
  await store.close();
} else if (cmd === "recover") {
  // The reset button on the router: whoever can log in to this box can make a new primary device.
  const { code, expiresInMin } = await newPairingCode(store, "owner");
  await printPair(code, expiresInMin, "Recover: pair a new primary device");
  console.log("  Then sign out the lost phone in Settings → Devices.\n");
  await store.close();
} else if (cmd === "doctor") {
  await doctor();
  await store.close();
} else if (cmd === "status") {
  const devices = await store.all<Device>("devices");
  const hooks = (await store.all<Hook>("hooks")).filter((h) => h.status === "active");
  console.log(`hub: ${config.name} (${config.target})\nstorage: ${store.kind} (${redactUrl(config.dbUrl)})\nbrain: ${config.agent}`);
  console.log(`devices: ${devices.length}\nactive hooks: ${hooks.length}`);
  for (const h of hooks) console.log(`  - ${h.title}  next: ${h.nextAt ?? "on event"}`);
  await store.close();
} else if (cmd === "start") {
  const scripts = new Scripts(store, config.dataDir);
  await scripts.syncRepo();
  const push = new Push(store, config.contact);
  try { await push.init(); } catch (e: any) { console.warn(`Push disabled: ${e.message}`); }
  const library = new Library(createEmbeddings());
  const hub = new Hub(config, store, new Brain(config), scripts, push.publicKey ? push : null, library);
  // API keys live encrypted in <data>/keys/vault.db; the master key is outside the data folder (vault.ts).
  const vault = new Vault(config.dataDir);
  const stt = new VoiceSettings(config.dataDir, process.env, vault);
  const { server, build } = await startServer(hub, stt, { vault });
  await hub.start();
  console.log(`hearth · ${config.name} · ${config.target} · build ${build}`);
  console.log(`listening on http://${server.hostname}:${server.port}  storage: ${store.kind}  brain: ${hub.brain.label}  voice: ${stt.current?.name ?? "off"}  library search: ${library.mode}`);
  if ((await store.all("devices")).length === 0) {
    const { code, expiresInMin } = await newPairingCode(store, "owner");
    await printPair(code, expiresInMin);
  }
  const shutdown = async () => { hub.stop(); server.stop(); await hub.idle(20_000); await store.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} else {
  console.log("usage: hearth [start|setup|recover|status|doctor]   on a computer: hearth [join <hub-url>|computer]");
  process.exit(1);
}

/** On a linked computer: is it linked, and can it reach the hub? */
async function doctorComputer(check: (ok: boolean, good: string, fix: string) => void, bad: () => number) {
  const link = readLink(config.dataDir);
  check(!!link, `Linked to ${link?.hub}`, "Not linked: run `bun run join https://yournameassistant.com`");
  if (link) {
    const r = await fetch(link.hub + "/computer", { headers: { Authorization: `Bearer ${link.token}` }, signal: AbortSignal.timeout(8000) }).catch(() => null);
    check(r?.status === 426, "The hub knows this computer", r ? (r.status === 401 ? "The hub signed this computer out: run join again" : `The hub answered ${r.status}`) : `Can't reach ${link.hub}`);
  }
  const logins = (Object.keys(COPY_ITEMS) as CopyItem[]).filter(hasLogin);
  console.log(`  · Logins here you can copy to the hub: ${logins.length ? logins.map((i) => COPY_ITEMS[i].label).join(", ") : "none"}`);
  console.log(bad() ? `\n  ${bad()} thing(s) to fix.\n` : "\n  All good.\n");
  if (bad()) process.exitCode = 1;
}

/** A security self-check for a hub on the internet. Exits non-zero if anything needs fixing. */
async function doctor() {
  let bad = 0;
  const check = (ok: boolean, good: string, fix: string) => { console.log(ok ? `  ✓ ${good}` : `  ✗ ${fix}`); if (!ok) bad++; };
  const mode = (p: string) => { try { return statSync(p).mode & 0o777; } catch { return -1; } };
  const local = ["127.0.0.1", "localhost", "::1"].includes(config.host);
  console.log(`\nhearth doctor · ${config.target}\n`);
  if (config.target === "mac") return doctorComputer(check, () => bad);
  check(local, "Hub listens only on this machine; Caddy is the way in", `HEARTH_HOST=${config.host} exposes the hub without HTTPS. Set HEARTH_HOST=127.0.0.1`);
  check(/^https:\/\//.test(process.env.HEARTH_PUBLIC_URL || ""), `Public address is HTTPS (${process.env.HEARTH_PUBLIC_URL})`, "Set HEARTH_PUBLIC_URL=https://your-domain in .env");
  check(config.behindProxy, "Behind a proxy (HSTS on, real client IPs for rate limits)", "Set HEARTH_BEHIND_PROXY=1 when Caddy is in front");
  const env = mode(".env");
  check(env === -1 || (env & 0o077) === 0, ".env is readable only by its owner", "Run: chmod 600 .env");
  check((mode(config.dataDir) & 0o077) === 0, "Data folder is private (700)", `Run: chmod 700 ${config.dataDir}`);
  // The vault: master key outside the data folder and private, the vault opens with it, and no API key left in a plain file.
  const keyPath = masterKeyPath();
  if (process.env.HEARTH_MASTER_KEY) check(true, "Master key comes from HEARTH_MASTER_KEY", "");
  else {
    check(existsSync(keyPath) && (mode(keyPath) & 0o077) === 0, `Master key is private (${keyPath})`, existsSync(keyPath) ? `Run: chmod 600 ${keyPath}` : `No master key at ${keyPath} yet; the hub makes one on first start`);
    check(!resolve(keyPath).startsWith(resolve(config.dataDir) + "/"), "Master key is outside the data folder, so a data backup can't open the vault", "Move the master key out of the data folder (HEARTH_MASTER_KEY_FILE)");
  }
  try { if (process.env.HEARTH_MASTER_KEY || existsSync(keyPath)) { const v = new Vault(config.dataDir); check(true, `API keys are encrypted at rest (${v.names().length} in the vault)`, ""); v.close(); } }
  catch (e: any) { check(false, "", e.message); }
  const plain = ["voice.json", "keys/secrets.json"].filter((f) => existsSync(join(config.dataDir, f)));
  check(plain.length === 0, "No API keys in plain files", `Plain key files left: ${plain.join(", ")}. Start the hub once to move them into the vault`);

  const devices = await store.all<Device>("devices");
  const primary = (await owners(store))[0];
  check(devices.length > 0, `Set up, ${devices.length} device(s)`, "Not set up yet: run `bun run setup` and scan the code with your phone");
  if (primary) check(!!primary.passkey, `Primary device (${primary.name}) has Face ID lock`, "Turn on Face ID lock on your primary phone: Settings → Face ID lock");
  check(config.requirePasskey, "Every device must unlock with Face ID", "Optional: HEARTH_REQUIRE_PASSKEY=1 so a copied key alone is useless");
  if (process.env.HEARTH_PUBLIC_URL) {
    try {
      const r = await fetch(new URL("/api/health", process.env.HEARTH_PUBLIC_URL), { signal: AbortSignal.timeout(8000) });
      check(r.ok && !!r.headers.get("strict-transport-security"), "Reachable over HTTPS with HSTS", `Public address answered ${r.status}${r.headers.get("strict-transport-security") ? "" : " without HSTS"}`);
      const plain = await fetch(new URL("/api/health", process.env.HEARTH_PUBLIC_URL.replace(/^https:/, "http:")), { redirect: "manual", signal: AbortSignal.timeout(8000) }).catch(() => null);
      check(!plain || (plain.status >= 300 && plain.status < 400), "Plain http:// redirects to HTTPS", "http:// serves content; let Caddy handle the domain");
    } catch (e: any) { check(false, "", `Can't reach ${process.env.HEARTH_PUBLIC_URL}: ${e.message}. Check DNS and that Caddy is running`); }
  }
  console.log(bad ? `\n  ${bad} thing(s) to fix.\n` : "\n  All good.\n");
  if (bad) process.exitCode = 1;
}
