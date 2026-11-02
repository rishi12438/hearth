import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserTool, describeBrowserStep, findBrowserTool } from "../src/brains/browser.ts";

function fakeHome(skill = "---\nname: enkidu-browser\n---\n\n# Enkidu browser (CLI)\nsession new <id>") {
  const home = mkdtempSync(join(tmpdir(), "hearth-bt-"));
  mkdirSync(join(home, ".enkidu", "bin"), { recursive: true });
  const bin = join(home, ".enkidu", "bin", "enkidu-browser");
  writeFileSync(bin, `#!/bin/sh\n[ "$1" = skill ] && cat <<'S'\n${skill}\nS\n`);
  chmodSync(bin, 0o755);
  return { home, bin };
}

test("the hub's browser tool brings its skill, without the front matter, under Hearth's approve rules", () => {
  const { home, bin } = fakeHome();
  const t = browserTool({}, home)!;
  expect(t.bin).toBe(bin);
  expect(t.skill).toContain("# Enkidu browser (CLI)");
  expect(t.skill).not.toContain("name: enkidu-browser");
  expect(t.skill).toContain("so the user can Approve it");
  expect(t.evidence).toBe(join(home, ".enkidu", "evidence"));
});

test("HEARTH_BROWSER=off, or no tool installed, means no browser", () => {
  const { home } = fakeHome();
  expect(findBrowserTool({ HEARTH_BROWSER: "off" }, home)).toBeNull();
  const empty = mkdtempSync(join(tmpdir(), "hearth-bt-"));
  if (!Bun.which("enkidu-browser")) expect(browserTool({}, empty)).toBeNull();
});

test("browser steps read as plain progress lines", () => {
  expect(describeBrowserStep(`enkidu-browser session use hearth-x open '{"url":"https://www.linkedin.com/in/a"}'`)).toBe("Browsing linkedin.com");
  expect(describeBrowserStep("enkidu-browser session use hearth-x screenshot")).toBe("Looking at the page");
  expect(describeBrowserStep(`enkidu-browser session use hearth-x click '{"ref":"e3"}'`)).toBe("Using the page");
  expect(describeBrowserStep("ls -la")).toBeNull();
});
