#!/usr/bin/env bun
import { loadConfig } from "./config.ts";
import { createStore, redactUrl } from "./store/index.ts";
import { newPairingCode } from "./auth.ts";
import { Brain } from "./brain.ts";
import { Scripts } from "./scripts.ts";
import { Push } from "./push.ts";
import { Hub } from "./hub.ts";
import { startServer } from "./server.ts";
import { createSpeechToText } from "./voice.ts";
import { Library, createEmbeddings } from "./library.ts";
import type { Device, Hook } from "./types.ts";

const cmd = process.argv[2] || "start";
const config = loadConfig();
const store = await createStore(config.dbUrl, config.dataDir);
const publicUrl = process.env.HEARTH_PUBLIC_URL || `http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`;

function printPair(code: string, minutes: number) {
  console.log(`\n  Pair a phone: open ${publicUrl}/#pair=${code}`);
  console.log(`  or enter the code  ${code}  in the app. Single use, expires in ${minutes} min.\n`);
}

if (cmd === "pair") {
  const { code, expiresInMin } = await newPairingCode(store);
  printPair(code, expiresInMin);
  await store.close();
} else if (cmd === "status") {
  const devices = await store.all<Device>("devices");
  const hooks = (await store.all<Hook>("hooks")).filter((h) => h.status === "active");
  console.log(`hub: ${config.name}\nstorage: ${store.kind} (${redactUrl(config.dbUrl)})\nbrain: ${config.agent}`);
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
  const stt = createSpeechToText();
  const { server, build } = await startServer(hub, stt);
  await hub.start();
  console.log(`hearth · ${config.name} · build ${build}`);
  console.log(`listening on http://${server.hostname}:${server.port}  storage: ${store.kind}  brain: ${hub.brain.label}  voice: ${stt?.name ?? "off"}  library search: ${library.mode}`);
  if ((await store.all("devices")).length === 0) {
    const { code, expiresInMin } = await newPairingCode(store);
    printPair(code, expiresInMin);
  }
  const shutdown = async () => { hub.stop(); server.stop(); await hub.idle(20_000); await store.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} else {
  console.log("usage: hearth [start|pair|status]");
  process.exit(1);
}
