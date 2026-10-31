#!/usr/bin/env bun
import { loadConfig } from "./config.ts";
import { createStore, redactUrl } from "./store/index.ts";
import { newPairingCode, owners } from "./auth.ts";
import QRCode from "qrcode";
import { statSync } from "node:fs";
import { Brain } from "./brain.ts";
import { Scripts } from "./scripts.ts";
import { Push } from "./push.ts";
import { Hub } from "./hub.ts";
import { startServer } from "./server.ts";
import { VoiceSettings } from "./voice.ts";
import { Library, createEmbeddings } from "./library.ts";
import { Shares, DockerRunner, LocalRunner, type BoxRunner } from "./shares.ts";
import { join } from "node:path";
import type { Device, Hook, Share, Teammate } from "./types.ts";

const cmd = process.argv[2] || "start";
const config = loadConfig();
const store = await createStore(config.dbUrl, config.dataDir);
const publicUrl = process.env.HEARTH_PUBLIC_URL || `http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`;

function boxRunner(): BoxRunner | null {
  if (config.boxRunner === "docker") return new DockerRunner(join(config.dataDir, "boxctl"), config.boxesRoot);
  if (config.boxRunner === "local") return new LocalRunner(join(config.dataDir, "boxes"), process.env.HEARTH_BOX_API_KEY);
  return null;
}

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
  console.log(`hub: ${config.name}\nstorage: ${store.kind} (${redactUrl(config.dbUrl)})\nbrain: ${config.agent}`);
  console.log(`devices: ${devices.length}\nactive hooks: ${hooks.length}`);
  for (const h of hooks) console.log(`  - ${h.title}  next: ${h.nextAt ?? "on event"}`);
  await store.close();
} else if (cmd === "share" || cmd === "shares" || cmd === "unshare") {
  // Share a teammate from the server's terminal. The running hub starts the box within a few seconds.
  const args = process.argv.slice(3);
  const flag = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));
  const hub = new Hub(config, store, new Brain(config), new Scripts(store, config.dataDir), null);
  const shares = new Shares(hub, boxRunner());
  if (cmd === "shares") {
    for (const s of await shares.list()) console.log(`${s.id}  ${s.status.padEnd(7)} ${s.kind.padEnd(6)} ${publicUrl}/t/${s.link}/  chats:${s.stats.chats} refused:${s.stats.refused} $${s.stats.costUsd}`);
  } else if (cmd === "unshare") {
    console.log((await shares.revoke(args[0] || "")) ? "Turned off. The hub stops its box within a few seconds." : "No such link.");
  } else {
    const t = (await store.all<Teammate>("teammates")).find((x) => x.name.toLowerCase() === (args[0] || "").toLowerCase());
    if (!t) { console.log(`usage: hearth share <teammate> [--guest NAME] [--owner NAME] [--does TEXT] [--example TEXT]... [--not TEXT]...
                    [--notebook NAME]... [--note TEXT]... [--folder PATH] [--edit GLOB]... [--read GLOB]... [--hidden GLOB]...
                    [--cap-usd N] [--auto-apply]`); process.exit(1); }
    const folder = flag("folder")[0];
    const r = await shares.create({
      teammateId: t.id, kind: flag("guest").length ? "guest" : "public", label: flag("guest")[0], ownerName: flag("owner")[0],
      scope: { does: flag("does")[0], examples: flag("example"), not: flag("not") }, notebooks: flag("notebook"), notes: flag("note"),
      ...(folder ? { folder: { path: folder, rules: { edit: flag("edit"), read: flag("read").length ? flag("read") : ["**"], hidden: flag("hidden") } } } : {}),
      ...(flag("cap-usd").length ? { limits: { costCapDayUsd: Number(flag("cap-usd")[0]) } } : {}),
      autoApply: args.includes("--auto-apply"),
    }, { start: false });
    if (r.error) { console.log(r.error); process.exit(1); }
    const s = r.value as Share;
    console.log(`Shared ${t.name}: ${publicUrl}/t/${s.link}/`);
    if (s.folder?.excluded.length) console.log(`Left out of the copy:\n${s.folder.excluded.map((x) => `  ${x.path} (${x.why})`).join("\n")}`);
    if (!shares.runner?.sealed) console.log("Note: HEARTH_BOX_RUNNER isn't docker, so this box is NOT sealed. Use docker on a server.");
  }
  await store.close();
} else if (cmd === "start") {
  const scripts = new Scripts(store, config.dataDir);
  await scripts.syncRepo();
  const push = new Push(store, config.contact);
  try { await push.init(); } catch (e: any) { console.warn(`Push disabled: ${e.message}`); }
  const library = new Library(createEmbeddings());
  const hub = new Hub(config, store, new Brain(config), scripts, push.publicKey ? push : null, library);
  const stt = new VoiceSettings(config.dataDir);
  const runner = boxRunner();
  const shares = new Shares(hub, runner);
  if (runner && !runner.sealed) console.warn("Shared links use the local runner: boxes are plain subprocesses, NOT sealed. Use HEARTH_BOX_RUNNER=docker on a server.");
  const { server, build } = await startServer(hub, stt, shares);
  await hub.start();
  shares.start();
  console.log(`hearth · ${config.name} · build ${build}`);
  console.log(`listening on http://${server.hostname}:${server.port}  storage: ${store.kind}  brain: ${hub.brain.label}  voice: ${stt.current?.name ?? "off"}  library search: ${library.mode}`);
  if ((await store.all("devices")).length === 0) {
    const { code, expiresInMin } = await newPairingCode(store, "owner");
    await printPair(code, expiresInMin);
  }
  const shutdown = async () => { hub.stop(); shares.stop(); server.stop(); await hub.idle(20_000); await store.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} else {
  console.log("usage: hearth [start|setup|recover|status|doctor|share|shares|unshare]");
  process.exit(1);
}

/** A security self-check for a hub on the internet. Exits non-zero if anything needs fixing. */
async function doctor() {
  let bad = 0;
  const check = (ok: boolean, good: string, fix: string) => { console.log(ok ? `  ✓ ${good}` : `  ✗ ${fix}`); if (!ok) bad++; };
  const mode = (p: string) => { try { return statSync(p).mode & 0o777; } catch { return -1; } };
  const local = ["127.0.0.1", "localhost", "::1"].includes(config.host);
  console.log("\nhearth doctor\n");
  check(local, "Hub listens only on this machine; Caddy is the way in", `HEARTH_HOST=${config.host} exposes the hub without HTTPS. Set HEARTH_HOST=127.0.0.1`);
  check(/^https:\/\//.test(process.env.HEARTH_PUBLIC_URL || ""), `Public address is HTTPS (${process.env.HEARTH_PUBLIC_URL})`, "Set HEARTH_PUBLIC_URL=https://your-domain in .env");
  check(config.behindProxy, "Behind a proxy (HSTS on, real client IPs for rate limits)", "Set HEARTH_BEHIND_PROXY=1 when Caddy is in front");
  const env = mode(".env");
  check(env === -1 || (env & 0o077) === 0, ".env is readable only by its owner", "Run: chmod 600 .env");
  check((mode(config.dataDir) & 0o077) === 0, "Data folder is private (700)", `Run: chmod 700 ${config.dataDir}`);
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
