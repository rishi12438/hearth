import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitNotes, tidyWorkspaces, trimNotes } from "../src/brains/archive.ts";
import { buildPrompt } from "../src/brain.ts";

const DAY = 86_400_000;
const put = (f: string, text: string, ageDays = 0, now = Date.now()) => {
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, text);
  const t = (now - ageDays * DAY) / 1000;
  utimesSync(f, t, t);
};

test("NOTES.md keeps its playbook and newest log sections; older ones move to archive/", () => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-ar-"));
  const day = (i: number) => `2026-10-${String(i).padStart(2, "0")}`;
  const sections = Array.from({ length: 12 }, (_, i) => `## ${day(i + 1)} check orders\n${"tracked shipments. ".repeat(80)}\n\n`);
  writeFileSync(join(dir, "NOTES.md"), `# Orders\n\n## Playbook\nRun scripts/track.py.\n\n${sections.join("")}`);
  expect(trimNotes(dir)).toBe(true);
  const kept = readFileSync(join(dir, "NOTES.md"), "utf8");
  expect(kept).toContain("## Playbook\nRun scripts/track.py.");
  expect(kept).toContain("archive/NOTES-old.md");
  const { sections: left } = splitNotes(kept);
  expect(left.map((s) => s.slice(3, 13))).toEqual([7, 8, 9, 10, 11, 12].map(day));
  const old = readFileSync(join(dir, "archive/NOTES-old.md"), "utf8");
  expect(old).toContain(`## ${day(1)}`);
  expect(old).not.toContain("## Playbook");
  // Small enough: left alone.
  writeFileSync(join(dir, "NOTES.md"), "## Playbook\nshort\n");
  expect(trimNotes(dir)).toBe(false);
});

test("the daily tidy gzips old data and results, never scripts, skills or notes, and packs a workspace nobody used", () => {
  const brain = mkdtempSync(join(tmpdir(), "hearth-ar-brain-"));
  const now = Date.now();
  const ws = join(brain, "projects/lego-zero/aliexpress-orders");
  put(join(ws, "data/orders-sept.json"), '{"orders":85}', 40, now);
  put(join(ws, "data/orders-today.json"), '{"orders":86}', 1, now);
  put(join(ws, "out/old/report.csv"), "a,b", 45, now);
  put(join(ws, "scripts/track.py"), "print(1)", 200, now);
  put(join(ws, "skills/track-orders.md"), "# Track orders", 200, now);
  put(join(ws, "NOTES.md"), "## Playbook\nrun it", 200, now);
  const stale = join(brain, "workspaces/japan-trip");
  for (const f of ["NOTES.md", "data/flights.json", "scripts/fares.py"]) put(join(stale, f), "x", 120, now);
  utimesSync(stale, (now - 120 * DAY) / 1000, (now - 120 * DAY) / 1000);
  for (const d of ["data", "scripts"]) utimesSync(join(stale, d), (now - 120 * DAY) / 1000, (now - 120 * DAY) / 1000);

  const r = tidyWorkspaces(brain, now);
  expect(r.files).toBe(2);
  expect(r.packed).toEqual(["workspaces/japan-trip"]);
  // Old data and results: gzipped into archive/<month>/, gone from data/ and out/ (and empty folders with them).
  const month = new Date(now - 40 * DAY).toISOString().slice(0, 7);
  expect(new TextDecoder().decode(Bun.gunzipSync(readFileSync(join(ws, "archive", month, "data/orders-sept.json.gz"))))).toBe('{"orders":85}');
  expect(existsSync(join(ws, "data/orders-sept.json"))).toBe(false);
  expect(existsSync(join(ws, "out/old"))).toBe(false);
  // Recent data, scripts, skills and notes stay where they are, however old.
  for (const f of ["data/orders-today.json", "scripts/track.py", "skills/track-orders.md", "NOTES.md"]) expect(existsSync(join(ws, f))).toBe(true);
  // The unused workspace is one tarball now.
  expect(existsSync(stale)).toBe(false);
  const tar = join(brain, "archive", `workspaces/japan-trip-${new Date(now).toISOString().slice(0, 10)}.tar.gz`);
  const list = Bun.spawnSync(["tar", "-tzf", tar]).stdout.toString();
  expect(list).toContain("japan-trip/scripts/fares.py");
  // Again the same day: nothing left to do.
  expect(tidyWorkspaces(brain, now)).toEqual({ notes: [], files: 0, packed: [] });
});

test("runs are told how to keep a playbook, write skills, and where the archive is", () => {
  const p = buildPrompt({ mode: "job", context: {}, input: "x" }, "claude", { workspace: "aliexpress-orders" });
  for (const s of ["## Playbook", "Rewrite it whenever you learn a better way", "skills/<name>.md", "skill.save", "archive/ holds what's old"]) expect(p).toContain(s);
});
