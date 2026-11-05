import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeSkillStep, hubSkills as allSkills, installSkills, skillCatalog, skillFlags } from "../src/brains/skills.ts";
// hearth-lead, hearth-mcp, hearth-trigger-port and install-skills are registered by any hub another test started (a global registry, like the hub's): left out of these lists.
const HUB_ADDED = ["hearth-lead", "hearth-mcp", "hearth-trigger-port", "install-skills"];
const hubSkills = (...a: Parameters<typeof allSkills>) => allSkills(...a).filter((s) => !HUB_ADDED.includes(s.name));

/** A home with fake enkidu-browser / enkidu-cua that print a skill, and a data dir with one skill of your own. */
function hub() {
  const home = mkdtempSync(join(tmpdir(), "hearth-sk-"));
  const bin = join(home, ".enkidu", "bin");
  mkdirSync(bin, { recursive: true });
  for (const [name, text] of [["enkidu-browser", "# Enkidu browser (CLI)\nsession use <id> open {\"url\":...}"], ["enkidu-cua", "# Enkidu CUA\nget_window_state list_windows"]]) {
    writeFileSync(join(bin, name), `#!/bin/sh\n[ "$1" = skill ] && cat <<'S'\n---\nname: ${name}\n---\n${text}\nS\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const data = join(home, "data");
  mkdirSync(join(data, "skills", "weekly-report"), { recursive: true });
  writeFileSync(join(data, "skills", "weekly-report", "SKILL.md"), "---\nname: weekly-report\ndescription: Write the Friday weekly report from the week's jobs\n---\nList what got done.");
  return { home, data, work: join(home, "work") };
}

test("the hub's skills: Enkidu's tools with Hearth's rules on top, then your own", () => {
  const { home, data } = hub();
  const skills = hubSkills(data, {}, home);
  expect(skills.map((s) => s.name)).toEqual(["enkidu-browser", "enkidu-cua", "automate-repetitive-work", "build-workflows", "learn-from-mistakes", "send-files", "write-trigger-judges", "weekly-report"]);
  const browser = skills[0];
  expect(browser.body).toContain("# Enkidu browser (CLI)");
  expect(browser.body).not.toContain("name: enkidu-browser");
  expect(browser.body).toContain("so the user can Approve it");
  expect(skills[1].commands).toEqual(["enkidu-cua", "hearth-open"]);
  expect(skills[2].commands).toEqual([]);
  expect(hubSkills(data, { HEARTH_CUA: "off" }, home).map((s) => s.name)).toEqual(["enkidu-browser", "automate-repetitive-work", "build-workflows", "learn-from-mistakes", "send-files", "write-trigger-judges", "weekly-report"]);
  expect(hubSkills(data, { HEARTH_SKILLS: "off" }, home)).toEqual([]);
});

test("the catalog names the common skills and how to search; flags allow only their commands", () => {
  const { home, data } = hub();
  const skills = hubSkills(data, {}, home);
  const cat = skillCatalog(skills);
  expect(cat).toContain("hearth-skill search");
  expect(cat).toContain("- enkidu-browser: Use Chrome");
  expect(cat).toContain("- enkidu-cua: Control a desktop app");
  expect(cat).not.toContain("weekly-report");
  expect(cat).toContain("- automate-repetitive-work: Doing the same thing many times");
  expect(cat).toContain("8 skill(s)");
  expect(cat).toContain("- send-files: Making something the user should open");
  expect(cat).toContain("- build-workflows: Building an automation");
  expect(cat).not.toContain("write-trigger-judges"); // not common: found by search
  const f = skillFlags(skills);
  expect(f.tools).toEqual(["Skill", "Bash", "Read"]);
  expect(f.allowed).toEqual(["Skill", "Bash(hearth-skill:*)", "Bash(enkidu-browser:*)", "Bash(enkidu-cua:*)", "Bash(hearth-open:*)", `Read(/${join(home, ".enkidu", "evidence")}/**)`]);
  expect(skillCatalog([])).toBe("");
  expect(skillFlags([])).toEqual({ tools: [], allowed: [] });
});

test("installed skills are where Claude Code looks, and hearth-skill searches and shows them", () => {
  const { home, data, work } = hub();
  const bin = installSkills(work, hubSkills(data, {}, home));
  expect(readFileSync(join(work, ".claude", "skills", "enkidu-cua", "SKILL.md"), "utf8")).toStartWith("---\nname: enkidu-cua\ndescription: \"Control a desktop app");
  const run = (...a: string[]) => { const r = Bun.spawnSync([join(bin, "hearth-skill"), ...a], { stdout: "pipe", stderr: "pipe" }); return { ok: r.success, out: r.stdout.toString() + r.stderr.toString() }; };
  expect(run("search", "chrome").out.split("\n")[0]).toStartWith("enkidu-browser:");
  expect(run("search", "record", "a", "video").out.split("\n")[0]).toStartWith("enkidu-cua:");
  expect(run("search", "Friday", "report").out.split("\n")[0]).toStartWith("weekly-report:");
  expect(run("search", "zzzqqq").out).toContain("No skill matches");
  expect(run("show", "weekly-report").out).toContain("List what got done.");
  expect(run("show", "../etc").ok).toBe(false);
  expect(run("list").out.trim().split("\n")).toHaveLength(8);
  expect(run("search", "webhook", "trigger").out.split("\n")[0]).toStartWith("build-workflows:");
  expect(run("search", "judge", "urgent").out.split("\n")[0]).toStartWith("write-trigger-judges:");
  expect(run("search", "automate", "repetitive").out.split("\n")[0]).toStartWith("automate-repetitive-work:");
  expect(run("show", "automate-repetitive-work").out).toContain("Spot-check by hand");
  expect(run("search", "video", "send").out.split("\n")[0]).toStartWith("send-files:");
  // A re-install drops skills that are gone.
  installSkills(work, []);
  expect(existsSync(join(work, ".claude", "skills", "enkidu-cua"))).toBe(false);
  expect(existsSync(join(bin, "hearth-open"))).toBe(true);
});

test("skill steps read as plain progress lines", () => {
  expect(describeSkillStep(`enkidu-browser session use hearth-x open '{"url":"https://www.linkedin.com/in/a"}'`)).toBe("Browsing linkedin.com");
  expect(describeSkillStep("enkidu-browser session use hearth-x screenshot")).toBe("Looking at the page");
  expect(describeSkillStep(`enkidu-cua session use t get_window_state '{"pid":1}'`)).toBe("Looking at the screen");
  expect(describeSkillStep(`enkidu-cua session use t click '{"x":1,"y":2}'`)).toBe("Using the app");
  expect(describeSkillStep("hearth-open chrome https://x.com")).toBe("Opening an app");
  expect(describeSkillStep("hearth-skill search record screen")).toBe("Looking for a skill: record screen");
  expect(describeSkillStep("hearth-skill show enkidu-cua")).toBe("Reading the enkidu-cua skill");
  expect(describeSkillStep(`enkidu-browser session use hearth-a open '{\"url\":\"https://www.aliexpress.com/p/order/index.html\"}'`)).toBe("Browsing aliexpress.com");
  expect(describeSkillStep(`S=hearth-a; enkidu-browser session new $S '{"recordName":"x"}'`)).toBe("Opening the browser");
  expect(describeSkillStep("enkidu-browser session close hearth-a")).toBe("Closing the browser");
  expect(describeSkillStep("ls -la")).toBeNull();
});

test("Codex gets rules for the skills' commands only, and the catalog without the Skill tool", async () => {
  const { codexRules, installCodexRules } = await import("../src/brains/skills.ts");
  const { home, data } = hub();
  const skills = hubSkills(data, {}, home);
  expect(codexRules(skills)).toContain('prefix_rule(pattern=["enkidu-browser"], decision="allow")');
  expect(codexRules(skills)).toContain('prefix_rule(pattern=["hearth-open"], decision="allow")');
  expect(codexRules(skills)).not.toContain("hearth-skill");
  expect(codexRules([])).toBe("");
  expect(skillCatalog(skills, "codex")).not.toContain("Skill tool");
  const codexHome = join(home, "codex");
  installCodexRules(codexHome, skills);
  expect(readFileSync(join(codexHome, "rules", "hearth.rules"), "utf8")).toContain("enkidu-cua");
  installCodexRules(codexHome, []);
  expect(existsSync(join(codexHome, "rules", "hearth.rules"))).toBe(false);
});

test("the automation guide is always there (even with no tools installed), and your own file of that name replaces it", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const data = mkdtempSync(join(tmpdir(), "hearth-guide-"));
  const home = mkdtempSync(join(tmpdir(), "hearth-guide-home-"));
  const g = hubSkills(data, { PATH: "/nonexistent" }, home).find((s) => s.name === "automate-repetitive-work")!;
  expect(g.common).toBe(true);
  for (const s of ["Do ONE item fully by hand first", "Count everything", "Never automate what changes things"]) expect(g.body).toContain(s);
  mkdirSync(join(data, "skills/automate-repetitive-work"), { recursive: true });
  writeFileSync(join(data, "skills/automate-repetitive-work/SKILL.md"), "---\ndescription: my own way\n---\nmine");
  const mine = hubSkills(data, { PATH: "/nonexistent" }, home).filter((s) => s.name === "automate-repetitive-work");
  expect(mine).toHaveLength(1);
  expect(mine[0].body).toBe("mine");
});
