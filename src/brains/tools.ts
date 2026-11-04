import { homedir } from "node:os";
import { chromePath } from "../browser.ts";
import { findTool } from "./skills.ts";

// Whether the brain's tools (enkidu-browser, enkidu-cua) work on this machine right now, for Settings: the hub checks
// its own, a linked computer checks its own and says so in its hello. Each tool answers `<tool> status` with its daemon's
// health (JSON: alive, daemonVersion, components); nothing else of the tool is run.

export type ToolId = "enkidu-browser" | "enkidu-cua";
export type ToolStatus = {
  id: ToolId; label: string;
  /** ok: ready · off: turned off for Hearth here · down: installed but not answering · missing: not installed */
  state: "ok" | "off" | "down" | "missing";
  detail: string | null;
};

const TOOLS: { id: ToolId; label: string; off: string; component: string }[] = [
  { id: "enkidu-browser", label: "Browser", off: "HEARTH_BROWSER", component: "browser" },
  { id: "enkidu-cua", label: "Computer use", off: "HEARTH_CUA", component: "cua" },
];

const STATES = new Set(["ok", "off", "down", "missing"]);
/** A tool status from outside (a linked computer's hello), checked field by field. */
export function cleanToolStatus(x: any): ToolStatus[] {
  if (!Array.isArray(x)) return [];
  return x.slice(0, 4).flatMap((t) => {
    const known = TOOLS.find((k) => k.id === t?.id);
    if (!known || !STATES.has(t.state)) return [];
    return [{ id: known.id, label: known.label, state: t.state, detail: typeof t.detail === "string" ? t.detail.slice(0, 160) : null }];
  });
}

type Run = (bin: string) => Promise<{ code: number; out: string }>;
const runStatus: Run = async (bin) => {
  const p = Bun.spawn([bin, "status"], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), 8_000);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  return { code, out: out || err };
};

/** One look at each tool here. */
export async function checkTools(env: Record<string, string | undefined> = process.env, home = homedir(), run: Run = runStatus, chrome = () => chromePath(env)): Promise<ToolStatus[]> {
  if (env.HEARTH_SKILLS === "off") return TOOLS.map((t) => ({ id: t.id, label: t.label, state: "off", detail: "Skills are off on this machine (HEARTH_SKILLS=off)" }));
  return Promise.all(TOOLS.map(async (t): Promise<ToolStatus> => {
    const base = { id: t.id, label: t.label };
    if (env[t.off] === "off") return { ...base, state: "off", detail: `Turned off here (${t.off}=off)` };
    const bin = findTool(t.id, home);
    if (!bin) return { ...base, state: "missing", detail: "Not installed on this machine" };
    let r: { code: number; out: string };
    try { r = await run(bin); } catch (e: any) { return { ...base, state: "down", detail: `Couldn't run it: ${String(e?.message || e).slice(0, 120)}` }; }
    let s: any = null;
    try { s = JSON.parse(r.out); } catch {}
    if (r.code !== 0 || !s?.alive) return { ...base, state: "down", detail: (s?.message || r.out.trim().split("\n").pop() || "Its service isn't answering").slice(0, 160) };
    if (Array.isArray(s.components) && !s.components.includes(t.component)) return { ...base, state: "down", detail: "Installed, but not registered with its service" };
    if (t.id === "enkidu-browser" && !env.CHROME_PATH && !chrome()) return { ...base, state: "down", detail: "No Chrome found on this machine" };
    return { ...base, state: "ok", detail: s.daemonVersion ? `Ready · v${s.daemonVersion}` : "Ready" };
  }));
}

let cached: { at: number; value: Promise<ToolStatus[]> } | null = null;
/** checkTools, looked at most once a minute (Settings may ask often). */
export function toolStatus(): Promise<ToolStatus[]> {
  if (!cached || Date.now() - cached.at > 60_000) cached = { at: Date.now(), value: checkTools().catch(() => []) };
  return cached.value;
}
