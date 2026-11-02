import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainUsage, claudeEventWindows, parseClaudeUsage, parseCodexRateLimits, pickBrain, score, type Reading } from "../src/brain-usage.ts";
import { detectBrains, lastRefresh, readClaudeToken, redactTokens, saveClaudeToken, saveCodexAuth, tokenInTranscript } from "../src/brain-logins.ts";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const ok = (harness: string, ...pcts: [number, number | null][]): Reading =>
  ({ harness, status: "ok", at: NOW, windows: pcts.map(([p, r], i) => ({ usedPercent: p, windowMinutes: i ? 10_080 : 300, resetsAt: r })) });

describe("live usage", () => {
  test("Claude's usage reply and its stream event", () => {
    const r = parseClaudeUsage({ five_hour: { utilization: 41, resets_at: "2026-11-01T14:00:00Z" }, seven_day: { utilization: 17, resets_at: null }, seven_day_opus: null,
      limits: [{ kind: "weekly_scoped", percent: 60, resets_at: null, scope: { model: { display_name: "Fable" } } }] }, NOW);
    expect(r.windows.map((w) => [w.usedPercent, w.windowMinutes, w.scope])).toEqual([[41, 300, undefined], [17, 10_080, undefined], [60, 10_080, "Fable"]]);
    expect(score(r, NOW)).toBe(60);
    // The real event shape, from `claude -p --output-format stream-json --verbose` (2026-11-01).
    const ws = claudeEventWindows({ status: "allowed", resetsAt: 1793901600, rateLimitType: "seven_day", unifiedWindows: { seven_day: { utilization: 0.17, resetsAt: 1793901600, status: "allowed" } } });
    expect(ws).toEqual([{ usedPercent: 17, windowMinutes: 10_080, resetsAt: 1793901600_000 }]);
  });

  test("Codex's account/rateLimits/read", () => {
    const g = { limitId: "codex", primary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1793776506 }, secondary: null, planType: "pro", rateLimitReachedType: null };
    const r = parseCodexRateLimits({ rateLimits: g, rateLimitsByLimitId: { codex: g } }, NOW);
    expect(r).toMatchObject({ status: "ok", plan: "pro", windows: [{ usedPercent: 4, windowMinutes: 10080, resetsAt: 1793776506_000 }] });
    expect(r.fullUntil).toBeUndefined();
    const hit = parseCodexRateLimits({ rateLimits: { ...g, rateLimitReachedType: "primary" } }, NOW);
    expect(hit.fullUntil).toBeGreaterThan(NOW);
  });

  test("a window past its reset counts as empty", () => {
    expect(score(ok("claude", [95, NOW - 1]), NOW)).toBe(0);
    expect(score(ok("claude", [95, NOW + 1]), NOW)).toBe(95);
  });

  test("the brain with the most room gets the job; near the limit, it moves; all full, it parks", () => {
    const quiet = ok("codex", [10, null]), busy = ok("claude", [60, null]);
    expect(pickBrain(["claude", "codex"], { claude: busy, codex: quiet }, NOW)).toEqual({ harness: "codex", percent: 10 });
    // The brain the role is on keeps it while it's close to the emptiest (no flip-flopping on every percent)...
    expect(pickBrain(["claude", "codex"], { claude: ok("claude", [20, null]), codex: quiet }, NOW, "claude")).toEqual({ harness: "claude", percent: 20 });
    // ...but not once the gap is real, or once it's near its limit.
    expect(pickBrain(["claude", "codex"], { claude: busy, codex: quiet }, NOW, "claude")).toMatchObject({ harness: "codex" });
    expect(pickBrain(["claude", "codex"], { claude: ok("claude", [92, null]), codex: ok("codex", [65, null]) }, NOW, "claude")).toMatchObject({ harness: "codex" });
    const until = NOW + 3_600_000;
    expect(pickBrain(["claude", "codex"], { claude: ok("claude", [95, until]), codex: ok("codex", [99, until + 5]) }, NOW)).toEqual({ park: true, until });
  });

  test("a refusal marks the brain full; a failed read keeps the last good numbers", async () => {
    let n = 0;
    const u = new BrainUsage({ claude: async () => (n++ ? { harness: "claude", status: "error", windows: [], at: NOW, detail: "down" } : ok("claude", [30, null])), codex: async () => ok("codex", [50, null]) }, () => NOW);
    await u.refresh("claude");
    expect((await u.refresh("claude", true))?.windows[0].usedPercent).toBe(30);
    expect(await u.pick(["claude", "codex"])).toMatchObject({ harness: "claude" });
    u.noteRefused("claude", NOW + 60_000);
    expect(await u.pick(["claude", "codex"])).toMatchObject({ harness: "codex" });
    u.noteClaudeEvent({ unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: 1793901600 } } });
    expect(u.get("claude")?.windows.length).toBe(2);
  });
});

describe("brain logins", () => {
  const home = () => mkdtempSync(join(tmpdir(), "hearth-home-"));

  test("detects what's installed and signed in, without reading secrets", () => {
    const h = home();
    mkdirSync(join(h, ".codex"));
    writeFileSync(join(h, ".codex", "auth.json"), JSON.stringify({ tokens: { refresh_token: "r" } }));
    const d = detectBrains({ home: h, env: {}, which: (c) => (c === "codex" ? "/bin/codex" : null), version: () => "0.166.0" });
    expect(d).toEqual([
      { id: "claude", label: "Claude Code", installed: false, path: null, version: null, loggedIn: false, how: null },
      { id: "codex", label: "Codex", installed: true, path: "/bin/codex", version: "0.166.0", loggedIn: true, how: "ChatGPT login" },
    ]);
  });

  test("catches the setup-token from its output and never shows it", () => {
    const tok = "sk-ant-oat01-" + "A1b2C3d4_".repeat(10);
    const out = `\x1b[32m✓ Long-lived authentication token created successfully!\x1b[0m\r\n\r\nYour OAuth token (valid for 1 year):\r\n\r\n${tok}\r\n\r\nStore this token securely.`;
    expect(tokenInTranscript(out)).toBe(tok);
    expect(redactTokens(out)).not.toContain("sk-ant-oat01-A1b2");
    const h = home();
    saveClaudeToken(tok, h);
    expect(readClaudeToken(h)).toBe(tok);
    expect(statSync(join(h, ".hearth", "claude-token.json")).mode & 0o777).toBe(0o600);
    expect(() => saveClaudeToken("not-a-token", h)).toThrow();
  });

  test("Codex auth.json: the newest renewal wins", () => {
    const h = home();
    const older = JSON.stringify({ tokens: { refresh_token: "old" }, last_refresh: "2026-10-01T00:00:00Z" });
    const newer = JSON.stringify({ tokens: { refresh_token: "new" }, last_refresh: "2026-10-30T00:00:00Z" });
    expect(saveCodexAuth(newer, h, {})).toBe("saved");
    expect(saveCodexAuth(older, h, {})).toBe("kept-newer");
    expect(JSON.parse(readFileSync(join(h, ".codex", "auth.json"), "utf8")).tokens.refresh_token).toBe("new");
    expect(lastRefresh(newer)).toBe(Date.parse("2026-10-30T00:00:00Z"));
    expect(() => saveCodexAuth("{}", h, {})).toThrow();
  });
});
