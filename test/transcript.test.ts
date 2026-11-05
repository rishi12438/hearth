import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneTranscripts, startTranscript } from "../src/brains/transcript.ts";

test("a run's transcript keeps the prompt, every event and how it ended", () => {
  const root = mkdtempSync(join(tmpdir(), "hearth-tx-"));
  const t = startTranscript(root, { harness: "codex", model: "", mode: "work", owner: "hearth-run-1", prompt: "check my orders",
    cmd: ["bwrap", "--ro-bind", "/", "/", "codex", "exec", "--json", "-"] }, new Date(2026, 10, 3, 19, 26, 11));
  t.line(`{"type":"item.completed","item":{"type":"command_execution","exit_code":1,"aggregated_output":"timed out"}}\n`);
  t.line("plain text from a custom harness");
  t.line("   ");
  t.end({ code: 0, stderr: "warn" });
  t.line(`{"type":"late"}`); // after end: ignored

  expect(t.file.startsWith(join(root, "2026-11-03", "192611-work-codex-"))).toBe(true);
  expect(statSync(t.file).mode & 0o777).toBe(0o600);
  const lines = readFileSync(t.file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.map((l) => l.type)).toEqual(["hearth.run", "item.completed", "hearth.text", "hearth.end"]);
  expect(lines[0]).toMatchObject({ harness: "codex", mode: "work", owner: "hearth-run-1", prompt: "check my orders", cmd: ["codex", "exec", "--json", "-"] });
  expect(lines[1].item.aggregated_output).toBe("timed out");
  expect(lines[3]).toMatchObject({ code: 0, stderr: "warn", timedOut: false, aborted: false });
});

test("a transcript that can't be written doesn't stop the run", () => {
  const t = startTranscript("/dev/null/nope", { harness: "claude", mode: "work", prompt: "x", cmd: ["claude"] });
  expect(t.file).toBe("");
  t.line("{}"); t.end({ code: 0 });
});

test("old days are pruned, recent ones kept", () => {
  const root = mkdtempSync(join(tmpdir(), "hearth-tx-"));
  for (const d of ["2026-10-01", "2026-11-02", "notes"]) mkdirSync(join(root, d));
  const old = new Date(2026, 9, 1);
  utimesSync(join(root, "2026-10-01"), old, old);
  utimesSync(join(root, "notes"), old, old);
  pruneTranscripts(root, 14, new Date(2026, 10, 3).getTime());
  expect(readdirSync(root).sort()).toEqual(["2026-11-02", "notes"]);
});
