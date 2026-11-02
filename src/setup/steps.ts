import { join, resolve } from "node:path";

// Setting up a hub, as steps that report as they go. `hearth install` prints them; the setup window draws them.
//
//   local   this Mac is the hub: nothing is copied, it uses the logins already here. Starts at login (LaunchAgent).
//   remote  a server you own (domain + IP + SSH key): ship Hearth over SSH, run deploy/setup-lightsail.sh there,
//           install the brains you picked, then copy long-lived logins up the same SSH line (a `claude setup-token`
//           made here, and Codex's auth.json), pick the brains, and hand back the phone's pairing link.

/** One line of progress: `hearth install` prints it, the setup window draws it, --json sends it as is. */
export type Step = { step: string; state: "start" | "wait" | "ok" | "warn" | "fail" | "log" | "done"; text: string; data?: Record<string, unknown> };
export type Emit = (s: Step) => void;

/** Where Hearth's own files are (this checkout, or the copy inside the Mac app via HEARTH_SRC). */
export const srcDir = (src?: string) => resolve(src || process.env.HEARTH_SRC || join(import.meta.dir, "..", ".."));

/** The pairing link a hub prints for the primary phone (…/#pair=ABCD-EFGH). */
export const pairLink = (text: string) => text.match(/https?:\/\/\S+#pair=[A-Z0-9-]+/)?.[0] ?? null;

export async function waitFor(url: string, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return true; } catch {}
    await Bun.sleep(500);
  }
  return false;
}
