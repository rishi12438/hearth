/**
 * Live view: while a job works, the latest picture of the browser page or app window it's using, so the user can watch.
 *
 * Each run gets its own Enkidu owner (ENKIDU_OWNER), so its browser and computer-use sessions are findable from outside.
 * Every few seconds this lists that owner's live sessions and:
 *   - a web page: takes a fresh screenshot (harmless to the job, and live even when the job only reads the page as text);
 *   - an app window: shows the newest picture the job took itself. Asking computer use for one would reset the job's
 *     view of the window (its element tokens), so we never do.
 * Pictures stay in memory (the hub keeps only the latest per job) and are never stored.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { findTool } from "./skills.ts";

export const FRAME_EVERY_MS = 3000;
// Under the hub's 1 MB websocket message once base64'd (a Mac sends frames up its link).
export const MAX_FRAME_BYTES = 700_000;
export type Frame = { data: Uint8Array; mime: string };

/** A fresh owner for one run's sessions. */
export function liveOwner() {
  return `hearth-run-${randomBytes(4).toString("hex")}`;
}

async function ask(cmd: string[], owner: string, timeoutMs = 8000): Promise<any> {
  const p = Bun.spawn(cmd, { env: { ...process.env, ENKIDU_OWNER: owner }, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const t = setTimeout(() => p.kill(), timeoutMs);
  try { const out = await new Response(p.stdout).text(); await p.exited; return JSON.parse(out); }
  catch { return null; }
  finally { clearTimeout(t); }
}

/** A screenshot made small for a phone: a ~960px JPEG on a Mac (sips), else the PNG as it is. */
export async function shrink(png: Uint8Array): Promise<Frame> {
  const sips = platform() === "darwin" ? Bun.which("sips") : null;
  if (!sips) return { data: png, mime: "image/png" };
  const dir = mkdtempSync(join(tmpdir(), "hearth-frame-"));
  try {
    const src = join(dir, "in.png"), out = join(dir, "out.jpg");
    await Bun.write(src, png);
    const p = Bun.spawn([sips, "-s", "format", "jpeg", "-s", "formatOptions", "65", "--resampleWidth", "960", src, "--out", out], { stdout: "ignore", stderr: "ignore" });
    if ((await p.exited) !== 0) return { data: png, mime: "image/png" };
    return { data: readFileSync(out), mime: "image/jpeg" };
  } catch { return { data: png, mime: "image/png" }; }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

export type LiveOpts = { browser?: string | null; cua?: string | null; evidenceDir?: string; everyMs?: number };

/** Starts watching; returns stop(). Does nothing if neither tool is on this machine. */
export function watchLive(owner: string, onFrame: (f: Frame) => void, opts: LiveOpts & { shrink?: (png: Uint8Array) => Promise<Frame> } = {}): () => void {
  const browser = opts.browser !== undefined ? opts.browser : findTool("enkidu-browser");
  const cua = opts.cua !== undefined ? opts.cua : findTool("enkidu-cua");
  if (!browser && !cua) return () => {};
  const evidence = resolve(opts.evidenceDir ?? join(homedir(), ".enkidu", "evidence"));
  let stopped = false, busy = false, lastHash = "", lastSeen = 0;

  const send = async (png: Uint8Array) => {
    if (stopped || png.length < 100) return;
    const h = createHash("sha1").update(png).digest("hex");
    if (h === lastHash) return; // the page hasn't changed
    lastHash = h;
    const f = await (opts.shrink ?? shrink)(png);
    if (!stopped && f.data.length <= MAX_FRAME_BYTES) onFrame(f);
  };

  const tick = async () => {
    const sessions: { tool: "browser" | "cua"; id: string }[] = [];
    for (const [tool, path] of [["browser", browser], ["cua", cua]] as const) {
      if (!path) continue;
      const j = await ask([path, "session", "list"], owner);
      for (const s of j?.sessions || []) if (s?.state === "running" && typeof s.id === "string" && /^[\w.-]{1,120}$/.test(s.id)) sessions.push({ tool, id: s.id });
    }
    if (stopped || !sessions.length) return;
    const web = sessions.find((s) => s.tool === "browser");
    if (web && browser) {
      const j = await ask([browser, "session", "use", web.id, "screenshot"], owner);
      const file = typeof j?.result?.file === "string" ? resolve(j.result.file) : "";
      if (file.startsWith(evidence + "/")) {
        let png: Uint8Array | null = null;
        try { png = readFileSync(file); } catch {}
        rmSync(file, { force: true }); // ours, not the job's: don't let them pile up
        if (png) await send(png);
        return;
      }
    }
    let newest: { file: string; at: number } | null = null;
    for (const s of sessions) {
      const dir = join(evidence, s.id, "screens");
      let names: string[] = [];
      try { names = readdirSync(dir); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith(".png")) continue;
        try { const at = statSync(join(dir, n)).mtimeMs; if (!newest || at > newest.at) newest = { file: join(dir, n), at }; } catch {}
      }
    }
    if (newest && newest.at > lastSeen) { lastSeen = newest.at; let png: Uint8Array | null = null; try { png = readFileSync(newest.file); } catch {} if (png) await send(png); }
  };

  const timer = setInterval(() => {
    if (stopped || busy) return;
    busy = true;
    tick().catch(() => {}).finally(() => { busy = false; });
  }, opts.everyMs ?? FRAME_EVERY_MS);
  return () => { stopped = true; clearInterval(timer); };
}
