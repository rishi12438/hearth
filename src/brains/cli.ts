import type { Config } from "../config.ts";
import { BRAIN_LABELS, detectBrains, isBrainId, mintClaudeToken, readCodexAuth, removeLogin, saveClaudeToken, saveCodexAuth } from "./logins.ts";
import { flag, has, io, positional, stdin } from "../cli-common.ts";

// `hearth brains …`
//   hearth brains detect                       which of Claude Code / Codex are installed and signed in here
//   hearth brains pick claude,codex            the brains the hub uses (two or more share work by live usage)
//   hearth brains usage [--fresh]              each picked brain's live plan usage
//   hearth brains token claude                 make a long-lived Claude login (claude setup-token) and print it once
//   hearth brains export codex                 print this computer's Codex login (auth.json) once, for a hub to take
//   hearth brains login claude --stdin         put a Claude setup-token on this hub (from stdin)
//   hearth brains login codex [--stdin]        put Codex's auth.json on this hub (stdin, or ~/.codex/auth.json here)
//   hearth brains logout claude|codex          take a copied login off this hub

export async function brainsCli(config: Config, args: string[]): Promise<number> {
  const { out, fail, hub, json } = io(config, args);
  const [sub, ...rest] = positional(args);
    if (sub === "detect" || !sub) {
      const d = detectBrains();
      out({ brains: d }, d.map((b) => `  ${b.installed ? (b.loggedIn ? "✓" : "!") : "·"} ${b.label.padEnd(12)} ${b.installed ? `${b.version ?? ""}  ${b.loggedIn ? b.how : "not signed in"}` : "not installed"}`).join("\n"));
      return 0;
    }
    if (sub === "pick") {
      const pool = (rest[0] || "").split(",").map((s) => s.trim()).filter(Boolean);
      if (!pool.length || !pool.every(isBrainId)) return fail("usage: hearth brains pick claude,codex", 2);
      const r = await hub("/api/brains/pool", { method: "PUT", body: { pool } });
      if ("error" in r) return fail(r.error!, r.code);
      out(r.data, `  Brains: ${pool.map((p) => BRAIN_LABELS[p as "claude"]).join(", ")}${pool.length > 1 ? " (the one with the most room on its plan takes each job)" : ""}`);
      return 0;
    }
    if (sub === "usage") {
      const r = await hub(`/api/brains/usage${has(args, "--fresh") ? "?fresh=1" : ""}`);
      if ("error" in r) return fail(r.error!, r.code);
      out(r.data, (r.data.usage as any[]).map((u) => `  ${u.harness.padEnd(7)} ${u.full ? "FULL" : `${u.percent}%`}  ${u.windows.map((w: any) => `${w.label} ${w.usedPercent}%${w.resetsAt ? ` (resets ${new Date(w.resetsAt).toLocaleString()})` : ""}`).join(" · ") || u.detail || "no reading yet"}`).join("\n"));
      return 0;
    }
    if (sub === "token") {
      if (rest[0] !== "claude") return fail("usage: hearth brains token claude   (Codex needs no token: its auth.json is copied)", 2);
      // The token goes to stdout once (for a pipe into `hearth brains login claude --stdin` on the hub); progress to stderr.
      const t = await mintClaudeToken((s) => process.stderr.write(s)).catch((e) => { fail(e.message); return null; });
      if (!t) return fail("Couldn't catch a token from `claude setup-token`. Run it yourself and paste the token into `hearth brains login claude --stdin`.");
      console.log(json ? JSON.stringify({ token: t }) : t);
      return 0;
    }
    if (sub === "export") {
      if (rest[0] !== "codex") return fail("usage: hearth brains export codex   (Claude uses `hearth brains token claude`)", 2);
      const data = readCodexAuth();
      if (!data) return fail("Codex isn't signed in on this computer. Run `codex login` first.");
      console.log(json ? JSON.stringify({ auth: data }) : data);
      return 0;
    }
    if (sub === "login") {
      const id = rest[0];
      if (!isBrainId(id)) return fail("usage: hearth brains login claude|codex [--stdin]", 2);
      try {
        if (id === "claude") {
          const t = has(args, "--stdin") ? await stdin() : flag(args, "--token");
          if (!t) return fail("Give the token on stdin (--stdin) or with --token. Make one with `hearth brains token claude` on your Mac.", 2);
          saveClaudeToken(t);
          out({ ok: true, brains: detectBrains() }, "  Claude is signed in on this hub with your long-lived token.");
        } else {
          const data = has(args, "--stdin") ? await stdin() : readCodexAuth();
          if (!data) return fail("No Codex login: pipe its auth.json in with --stdin, or run `codex login` here.", 2);
          const r = saveCodexAuth(data);
          out({ ok: true, result: r, brains: detectBrains() }, r === "saved" ? "  Codex is signed in on this hub." : "  The hub's Codex login is newer than that one, so it was kept.");
        }
        return 0;
      } catch (e: any) { return fail(e.message); }
    }
    if (sub === "logout") {
      if (!isBrainId(rest[0])) return fail("usage: hearth brains logout claude|codex", 2);
      removeLogin(rest[0]);
      out({ ok: true }, `  ${BRAIN_LABELS[rest[0]]}'s copied login is off this hub.`);
      return 0;
    }
    return fail("usage: hearth brains detect|pick|usage|token|login|logout", 2);
}
