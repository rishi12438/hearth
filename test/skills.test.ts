import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeSkillStep, hubSkills, installSkills, skillCatalog, skillFlags } from "../src/brains/skills.ts";

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
  expect(skills.map((s) => s.name)).toEqual(["enkidu-browser", "enkidu-cua", "weekly-report"]);
  const browser = skills[0];
  expect(browser.body).toContain("# Enkidu browser (CLI)");
  expect(browser.body).not.toContain("name: enkidu-browser");
  expect(browser.body).toContain("so the user can Approve it");
  expect(skills[1].commands).toEqual(["enkidu-cua", "hearth-open"]);
  expect(skills[2].commands).toEqual([]);
  expect(hubSkills(data, { HEARTH_CUA: "off" }, home).map((s) => s.name)).toEqual(["enkidu-browser", "weekly-report"]);
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
  expect(cat).toContain("3 skill(s)");
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
  expect(run("list").out.trim().split("\n")).toHaveLength(3);
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
  expect(describeSkillStep("ls -la")).toBeNull();
});
