import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type CodexScenario = { events?: { method: string; params: unknown }[]; answer?: string; fail?: string; log?: string; state?: string };

/** Puts a fake `codex` in dir that runs fake-codex-app.ts (a stand-in app-server) with this scenario. */
export function fakeCodex(dir: string, sc: CodexScenario) {
  const file = join(dir, "codex-scenario.json");
  writeFileSync(file, JSON.stringify(sc));
  writeFileSync(join(dir, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fake-codex-app.ts")}" "${file}"\n`);
  chmodSync(join(dir, "codex"), 0o755);
}
