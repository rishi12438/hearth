import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamLine, installTeam, openMailbox } from "../src/brains/team.ts";

const run = (bin: string, dir: string, args: string[], stdin = "") => {
  const p = Bun.spawnSync([join(bin, "hearth-team"), ...args], { env: { ...process.env, HEARTH_TEAM_DIR: dir }, stdin: new Blob([stdin]) });
  return { code: p.exitCode, out: new TextDecoder().decode(p.stdout), err: new TextDecoder().decode(p.stderr) };
};

test("hearth-team: who, send, inbox and the Claude hook, through a run's mailbox", async () => {
  const work = mkdtempSync(join(tmpdir(), "hearth-team-"));
  const bin = installTeam(work);
  expect(JSON.parse(readFileSync(join(work, ".claude", "settings.json"), "utf8")).hooks.PostToolUse[0].hooks[0].command).toBe(`${join(bin, "hearth-team")} hook`);
  const sent: [string, string][] = [];
  const reads: number[] = [];
  const line = new TeamLine((to, text) => sent.push([to, text]), (n) => reads.push(n));
  line.setRoster("You are hearth-ab12.\nWorking alongside you:\n- scout-cd34: Scout, on \"Returns\"\n");
  const box = openMailbox(work, "r1", line);
  expect(run(bin, box.dir, ["who"]).out).toContain("scout-cd34");
  expect(run(bin, box.dir, ["inbox"]).out.trim()).toBe("No new messages.");
  expect(run(bin, box.dir, ["hook"], "{}").code).toBe(0); // nothing new: silent
  line.deliver("Orders (hearth-ab12)", "only October");
  const hook = run(bin, box.dir, ["hook"], "{}");
  expect([hook.code, hook.err]).toEqual([2, expect.stringContaining("From Orders (hearth-ab12):\nonly October")]);
  expect(run(bin, box.dir, ["inbox"]).out.trim()).toBe("No new messages."); // the hook marked it read
  line.deliver("Scout (scout-cd34)", "returns are 90 days");
  const s = run(bin, box.dir, ["send", "--to", "scout-cd34", "got the orders, 43 of them"]);
  expect(s.out).toContain("Sent to scout-cd34.");
  expect(s.out).toContain("returns are 90 days"); // what came in meanwhile rides along
  await Bun.sleep(700);
  expect(sent).toEqual([["scout-cd34", "got the orders, 43 of them"]]);
  expect(line.read).toBe(2);
  box.close();
  expect(existsSync(box.dir)).toBe(false);
  // Outside a team run the hook does nothing and the command says so.
  expect(run(bin, "", ["hook"], "{}").code).toBe(0);
  expect(run(bin, "", ["who"]).out).toContain("Nobody else");
});

