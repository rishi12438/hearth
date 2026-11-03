import { describe, expect, test } from "bun:test";
import { jailArgs, jailWorks } from "../src/brains/jail.ts";
import { buildPrompt, describeStep } from "../src/brain.ts";

const pairs = (args: string[], flag: string) => args.flatMap((a, i) => (a === flag ? [args.slice(i + 1, i + (flag === "--tmpfs" ? 2 : 3)).join(" ")] : []));

describe("brain jail", () => {
  const has = new Set(["/home/h/.hearth", "/opt/hearth/.env", "/keys/master.key"]);
  const args = jailArgs({ dataDir: "/opt/hearth/data", workDir: "/opt/hearth/data/brain", home: "/home/h",
    hideFiles: ["/opt/hearth/.env", "/keys/master.key", "/home/h/.hearth/master.key", "/missing"], exists: (p) => has.has(p) });

  test("empties the data folder but keeps the brain's own folder", () => {
    expect(pairs(args, "--tmpfs")).toContain("/opt/hearth/data");
    expect(pairs(args, "--bind")).toContain("/opt/hearth/data/brain /opt/hearth/data/brain");
    expect(args.indexOf("--tmpfs")).toBeLessThan(args.lastIndexOf("--bind"));
    expect(args.slice(-2)).toEqual(["--chdir", "/opt/hearth/data/brain"]);
  });

  test("hides ~/.hearth, the .env and a master key kept elsewhere; skips what isn't there", () => {
    expect(pairs(args, "--tmpfs")).toContain("/home/h/.hearth");
    expect(pairs(args, "--tmpfs")).not.toContain("/home/h/.ssh");
    expect(pairs(args, "--ro-bind")).toEqual(["/dev/null /opt/hearth/.env", "/dev/null /keys/master.key"]);
  });

  test("its own process list, so the hub's environment isn't readable", () => {
    expect(args).toContain("--unshare-pid");
    expect(pairs(args, "--proc").length).toBe(1);
  });

  test("off by request", () => {
    expect(jailWorks(args, { HEARTH_BRAIN_JAIL: "off" })).toBe(false);
  });
});

describe("working at scale", () => {
  const job = { mode: "job" as const, context: {}, input: "sector of every holding" };
  test("only calls that can run code are told to script it, and only Claude about the scout", () => {
    expect(buildPrompt(job)).not.toContain("WORKING AT SCALE");
    expect(buildPrompt(job, "codex")).toContain("WORKING AT SCALE");
    expect(buildPrompt(job, "codex")).not.toContain("scout");
    expect(buildPrompt({ ...job, mode: "legwork" }, "claude")).toContain("scout agent");
  });
  test("progress lines for code and helpers", () => {
    expect(describeStep("Agent", { description: "COST sector" })).toBe("Asking a helper: COST sector");
    expect(describeStep("Bash", { command: "python3 sectors.py", description: "Look up sectors" })).toBe("Running code: Look up sectors");
    expect(describeStep("Write", { file_path: "/x/sectors.py" })).toBe("Writing a script");
    expect(describeStep("Bash", { command: "ls" })).toBeNull();
  });
});
