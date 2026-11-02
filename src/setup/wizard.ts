import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { detectBrains, isBrainId, type BrainId } from "../brains/logins.ts";
import { srcDir, type Step } from "./steps.ts";
import { installLocal } from "./local.ts";
import { cleanDomain, cleanHost, freshPairLink, installRemote, validRemote } from "./remote.ts";
import { clearDraft, clearFinished, readDraft, readFinished, saveKey, writeDraft, writeFinished } from "./keys.ts";

const flag = (a: string[], f: string) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
const brainsOf = (v?: string): BrainId[] => (v || "").split(",").map((s) => s.trim()).filter(isBrainId);

/**
 * The setup window: a small page on 127.0.0.1 (with a one-time key in its URL, so other apps on this Mac can't drive
 * it), and the same installer behind it. It prints its URL as `WIZARD <url>` for the Mac app to open.
 */
export async function wizard(a: string[]): Promise<number> {
  const key = randomBytes(18).toString("base64url");
  // "Run setup again" / "Set up a new hub" start from scratch; otherwise a finished setup goes straight to its hub.
  if (a.includes("--fresh")) clearFinished();
  let finishedNow = false;
  const page = readFileSync(join(srcDir(), "web", "setup.html"), "utf8");
  const runs = new Map<string, { steps: Step[]; done: boolean; waiters: Set<(s: Step) => void>; skip: Set<string> }>();
  const ok = (req: Request, url: URL) => url.searchParams.get("k") === key || req.headers.get("x-wizard-key") === key;
  const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(flag(a, "--port")) || 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!ok(req, url)) return new Response("Open this from the Hearth app.", { status: 403 });
      if (url.pathname === "/") return new Response(page.replace("__WIZARD_KEY__", key), { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:" } });
      if (url.pathname === "/finished") {
        const f = readFinished();
        if (!f) return json({ finished: null });
        // Not signed in on this Mac yet? A remote hub with no main device hands out a fresh code over SSH.
        const link = f.where === "remote" && f.remote ? await freshPairLink(f.remote).catch(() => null) : f.pair ?? null;
        return json({ finished: { url: f.url, pair: link } });
      }
      if (url.pathname === "/current") { const live = [...runs].filter(([, r]) => !r.done).pop(); return json({ id: live?.[0] ?? null }); }
      if (url.pathname === "/brains") return json({ brains: detectBrains() });
      if (url.pathname === "/whoami") {
        const name = process.platform === "darwin" ? Bun.spawnSync(["scutil", "--get", "ComputerName"]).stdout.toString().trim() : "";
        return json({ name: name || "This computer" });
      }
      if (url.pathname === "/key" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        return json(saveKey(String(b.name || "key"), String(b.text || "")));
      }
      if (url.pathname === "/draft") {
        if (req.method === "POST") { const d = await req.json().catch(() => ({})); if (!finishedNow) writeDraft(d); return json({ ok: true }); }
        return json({ draft: readDraft() });
      }
      if (url.pathname === "/check" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        return json({ error: b.where === "remote" ? validRemote({ ...b, brains: brainsOf(b.brains) }) : brainsOf(b.brains).length ? null : "Pick at least one brain." });
      }
      if (url.pathname === "/qr") return json({ svg: await QRCode.toString(String(url.searchParams.get("text") || ""), { type: "svg", margin: 1 }) });
      if (url.pathname === "/install" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        const id = randomBytes(6).toString("hex");
        const run = { steps: [] as Step[], done: false, waiters: new Set<(s: Step) => void>(), skip: new Set<string>() };
        runs.set(id, run);
        const emit = (s: Step) => {
          if (s.state === "done") {
            finishedNow = true; clearDraft();
            const d = (s.data || {}) as { url?: string; pair?: string | null };
            writeFinished({ where: b.where === "remote" ? "remote" : "local", url: String(d.url || ""), pair: d.pair ?? null, at: new Date().toISOString(),
              remote: b.where === "remote" ? { host: cleanHost(String(b.host || "")), user: String(b.user || "ubuntu"), key: b.key ? String(b.key) : undefined, domain: cleanDomain(String(b.domain || "")) } : undefined });
          }
          run.steps.push(s); for (const w of run.waiters) w(s);
        };
        const brains = brainsOf(b.brains);
        const job = b.where === "remote"
          ? installRemote({ brains, host: String(b.host || ""), user: String(b.user || "ubuntu"), key: b.key ? String(b.key) : undefined, domain: String(b.domain || ""), email: b.email ? String(b.email) : undefined, skipDns: !!b.skipDns, skip: run.skip, claudeToken: b.claudeToken ? String(b.claudeToken) : undefined }, emit)
          : installLocal({ brains, lan: !!b.lan }, emit);
        job.catch(() => {}).finally(() => { run.done = true; emit({ step: "end", state: "log", text: "" }); });
        return json({ id });
      }
      // "Skip for now" on a step setup is waiting on.
      const sk = url.pathname.match(/^\/install\/([0-9a-f]{12})\/skip$/);
      if (sk && req.method === "POST") { const b = await req.json().catch(() => ({})); runs.get(sk[1])?.skip.add(String(b.step || "")); return json({ ok: true }); }
      const m = url.pathname.match(/^\/install\/([0-9a-f]{12})\/events$/);
      if (m) {
        const run = runs.get(m[1]);
        if (!run) return json({ error: "No such run." }, 404);
        let send: (s: Step) => void;
        let ping: ReturnType<typeof setInterval>;
        const enc = new TextEncoder();
        return new Response(new ReadableStream({
          start(c) {
            send = (s) => { try { c.enqueue(enc.encode(`data: ${JSON.stringify(s)}\n\n`)); if (s.step === "end") { clearInterval(ping); c.close(); } } catch {} };
            // A comment every 15 s, so a long quiet wait (a firewall rule, a browser approval) doesn't look like a dead line.
            ping = setInterval(() => { try { c.enqueue(enc.encode(": ping\n\n")); } catch { clearInterval(ping); } }, 15_000);
            for (const s of run.steps) send(s);
            if (!run.done) run.waiters.add(send); else clearInterval(ping);
          },
          cancel() { clearInterval(ping); run.waiters.delete(send); },
        }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
      }
      return new Response("Not found", { status: 404 });
    },
  });
  const link = `http://127.0.0.1:${server.port}/?k=${key}`;
  console.log(`WIZARD ${link}`);
  if (!a.includes("--no-open") && process.platform === "darwin" && !process.env.HEARTH_APP) Bun.spawn(["open", link]);
  await new Promise(() => {});
  return 0;
}

