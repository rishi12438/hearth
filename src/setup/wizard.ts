import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { detectBrains, isBrainId, type BrainId } from "../brains/logins.ts";
import { srcDir, type Step } from "./steps.ts";
import { installLocal } from "./local.ts";
import { installRemote, validRemote } from "./remote.ts";
import { pickKeyFile, sshKeys } from "./keys.ts";

const flag = (a: string[], f: string) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
const brainsOf = (v?: string): BrainId[] => (v || "").split(",").map((s) => s.trim()).filter(isBrainId);

/**
 * The setup window: a small page on 127.0.0.1 (with a one-time key in its URL, so other apps on this Mac can't drive
 * it), and the same installer behind it. It prints its URL as `WIZARD <url>` for the Mac app to open.
 */
export async function wizard(a: string[]): Promise<number> {
  const key = randomBytes(18).toString("base64url");
  const page = readFileSync(join(srcDir(), "web", "setup.html"), "utf8");
  const runs = new Map<string, { steps: Step[]; done: boolean; waiters: Set<(s: Step) => void> }>();
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
      if (url.pathname === "/brains") return json({ brains: detectBrains() });
      if (url.pathname === "/keys") return json({ keys: sshKeys(), canPick: process.platform === "darwin" });
      if (url.pathname === "/pick-key" && req.method === "POST") return json({ path: await pickKeyFile() });
      if (url.pathname === "/check" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        return json({ error: b.where === "remote" ? validRemote({ ...b, brains: brainsOf(b.brains) }) : brainsOf(b.brains).length ? null : "Pick at least one brain." });
      }
      if (url.pathname === "/qr") return json({ svg: await QRCode.toString(String(url.searchParams.get("text") || ""), { type: "svg", margin: 1 }) });
      if (url.pathname === "/install" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        const id = randomBytes(6).toString("hex");
        const run = { steps: [] as Step[], done: false, waiters: new Set<(s: Step) => void>() };
        runs.set(id, run);
        const emit = (s: Step) => { run.steps.push(s); for (const w of run.waiters) w(s); };
        const brains = brainsOf(b.brains);
        const job = b.where === "remote"
          ? installRemote({ brains, host: String(b.host || ""), user: String(b.user || "ubuntu"), key: b.key ? String(b.key) : undefined, domain: String(b.domain || ""), email: b.email ? String(b.email) : undefined, skipDns: !!b.skipDns, claudeToken: b.claudeToken ? String(b.claudeToken) : undefined }, emit)
          : installLocal({ brains, lan: !!b.lan }, emit);
        job.catch(() => {}).finally(() => { run.done = true; emit({ step: "end", state: "log", text: "" }); });
        return json({ id });
      }
      const m = url.pathname.match(/^\/install\/([0-9a-f]{12})\/events$/);
      if (m) {
        const run = runs.get(m[1]);
        if (!run) return json({ error: "No such run." }, 404);
        let send: (s: Step) => void;
        const enc = new TextEncoder();
        return new Response(new ReadableStream({
          start(c) {
            send = (s) => { try { c.enqueue(enc.encode(`data: ${JSON.stringify(s)}\n\n`)); if (s.step === "end") c.close(); } catch {} };
            for (const s of run.steps) send(s);
            if (!run.done) run.waiters.add(send);
          },
          cancel() { run.waiters.delete(send); },
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

