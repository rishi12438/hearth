import type { McpView } from "./mcp.ts";
import type { MacGate } from "./other-browser.ts";

// hearth-help: where an agent asks the hub what to do. The answer is made here, from what's true right now (is the Mac
// online, did the user say yes or no to it, which MCP servers are connected), so changing what agents do when they're
// stuck means changing this file, not skill text spread around.
//
//   hearth-help stuck                          the kinds of stuck, to pick one
//   hearth-help stuck <kind>   what to do about it, best first (STUCK below: one entry per kind). Words after the
//                              kind are ignored. The thread's step line shows "Stuck (<kind>)" while it happens.

/**
 * A cloud browser or scraper with a hosted MCP server the hub can add, best first. Checked 2026-11-05 by probing each
 * endpoint and reading its pricing page; free plans change, so keep `free` short and recheck when editing.
 */
export type CloudBrowser = {
  name: string; label: string; url: string;
  /** How it signs in once added: "none" works with no account; "key" an API key (header, or ?param in the address); "oauth" a sign-in link. */
  auth: "none" | "key" | "oauth";
  /** Where its key goes when it has one: the Authorization header (Bearer) unless header or query says otherwise. */
  key?: { header?: string; query?: string };
  getKey?: string;
  /** What you get without paying, in a few words. */
  free: string;
  /** What it's best at. */
  good: string;
  /** How to drive its tools, in a line or two. */
  how: string;
};

export const CLOUD_BROWSERS: CloudBrowser[] = [
  {
    name: "firecrawl", label: "Firecrawl", url: "https://mcp.firecrawl.dev/v2/mcp", auth: "none",
    key: {}, getKey: "https://www.firecrawl.dev/app/api-keys",
    free: "works with no account at all (a free account adds 1,000 credits a month, no card)",
    good: "reads pages that block servers (retries through better proxies when a site refuses) and searches the web",
    how: `firecrawl_scrape {"url": …, "formats": ["markdown"]} reads a page; firecrawl_search {"query": …} searches. Put the details in the URL where the site allows it (a search URL with the dates and place). With a key it can also drive a browser (firecrawl_interact) for pages that need clicks.`,
  },
  {
    name: "browserless", label: "Browserless", url: "https://mcp.browserless.io/mcp", auth: "key",
    key: {}, getKey: "https://account.browserless.io/",
    free: "a free plan (1,000 units a month, no card) that includes captcha solving and residential proxies",
    good: "a cloud browser that gets past human checks and captchas, and can click and fill forms",
    how: `browserless_smartscraper {"url": …} reads a page, stepping up through proxies, a real browser and captcha solving as needed; browserless_agent drives a browser step by step for searches and forms.`,
  },
  {
    name: "brightdata", label: "Bright Data", url: "https://mcp.brightdata.com/mcp", auth: "oauth",
    free: "a free plan (5,000 requests a month, no card)",
    good: "scraping built to get past bot checks, with a browser for pages that need clicks",
    how: `scrape_as_markdown {"url": …} reads a page past bot checks; search_engine {"query": …} searches.`,
  },
  {
    name: "browserbase", label: "Browserbase", url: "https://mcp.browserbase.com/mcp", auth: "key",
    key: { query: "browserbaseApiKey" }, getKey: "https://www.browserbase.com/overview",
    free: "a free plan (1 browser hour, no proxies or captcha solving on it)",
    good: "a cloud browser you drive in plain English (type into a box, click search), good for multi-step searches",
    how: `Run start first, then navigate {"url": …}; act {"action": "type Phoenix into the pick-up box"} clicks and types; observe {"instruction": …} finds what's on the page; extract {"instruction": "every car with its price per day"} reads it out; end when you're done.`,
  },
];

/** The connected MCP server that is one of these, if any. */
export function connectedBrowsers(servers: McpView[]): { b: CloudBrowser; server: McpView }[] {
  const host = (u: string) => { try { return new URL(u).host; } catch { return ""; } };
  const out: { b: CloudBrowser; server: McpView }[] = [];
  for (const b of CLOUD_BROWSERS) {
    const s = servers.find((x) => x.state === "connected" && x.enabled && (x.name === b.name || host(x.url) === host(b.url)));
    if (s) out.push({ b, server: s });
  }
  return out;
}

/** What's true right now, for the answer. waiting: this job's cards still waiting for the user. */
export type StuckState = { mac: string | null; gate: MacGate | null; servers: McpView[]; waiting?: string[] };
type Steps = (s: StuckState) => string[];

/** One kind of stuck: its name (and other words an agent might use), when it applies, and its steps, best first. */
export type StuckKind = { id: string; aka: string[]; when: string; steps: Steps };

const macStep = (s: StuckState, why: string): string | null => {
  if (!s.mac || s.gate === "no") return null;
  if (s.gate === "ok") return `Chrome on ${s.mac} (the user's Mac) is yours in this conversation already: run hearth-browser open <url> "<what blocked you>" and carry on there (see the get-past-blocks skill for its commands). ${why}`;
  if (s.gate === "pending") return `You already asked to use Chrome on ${s.mac}; it's waiting for the user's Approve. Finish what you can meanwhile; you'll get a turn when they answer.`;
  return `Ask the user if you can use Chrome on their Mac (${s.mac}). ${why} Run hearth-browser open <url> "<what blocked you, in a few words>": that puts a card under your reply, with those words on it and two ways to say yes: run it in the background (its own Chrome with their logins; they watch in live view) or use their own Chrome (a tab they can watch). In your reply, ask them plainly ("Can I use Chrome on your Mac for this? Pick one below") and say what's in the way; finish what you can meanwhile. When they answer you get a turn and carry on with hearth-browser.`;
};

/** A site blocks the browser: a cloud browser that's connected, then the user's Mac, then one to add (no Mac, or they said no). */
const blockedSteps: Steps = (s) => {
  const out: string[] = [];
  const on = connectedBrowsers(s.servers);
  for (const { b, server } of on) out.push(`${b.label} is connected as the MCP server ${server.name}: ${b.good}. Its tools are yours (mcp__${server.name}__<tool> on Claude; on any brain, hearth-mcp call ${server.name} <tool> '<json>'). ${b.how}`);
  const m = macStep(s, "It's a real browser on their home connection, so sites that block servers let it through.");
  if (m) out.push(on.length ? `If that can't get through: ${m}` : m);
  const macOk = !!s.mac && s.gate !== "no";
  const asked = s.servers.filter((x) => CLOUD_BROWSERS.some((b) => b.name === x.name) && x.state !== "connected");
  for (const x of asked) out.push(`${x.name} is on the list but not connected (${x.state === "pending" ? "it waits for the user's Approve" : x.state === "signin" ? "it still needs signing in" : x.state}). ${x.state === "pending" ? "You'll get a turn when they answer." : keyStep(CLOUD_BROWSERS.find((b) => b.name === x.name)!)}`);
  const pick = CLOUD_BROWSERS.filter((b) => !on.some((o) => o.b.name === b.name) && !asked.some((x) => x.name === b.name));
  if (!pick.length) return out;
  const list = (bs: CloudBrowser[]) => bs.map((o) => `${o.label}, ${o.good} (hearth-mcp add ${o.url} ${o.name}; ${o.free})`).join("; ");
  if (macOk) {
    // The Mac comes first; a cloud browser only if they say no (or it can't get through).
    out.push(`If the user says no to their Mac, or it can't get through either: run hearth-help stuck blocked again, and it'll say which cloud browser to add.`);
    return out;
  }
  if (on.length) { out.push(`If that one can't get through either, add another yourself: ${list(pick)}. One Approve card each; once approved, ${keyStep(pick[0])}`); return out; }
  const b = pick[0];
  out.push(`Add a cloud browser yourself (no need to ask the user to do it): ${b.label}, ${b.good}. Run: hearth-mcp add ${b.url} ${b.name}. That's one Approve card for the user; in your reply say what it's for and that it ${b.auth === "none" ? b.free : `has ${b.free}`}${b.auth === "none" ? "" : `, and that if they don't have an account you'll make a free one with their Google login`}. Once they approve, ${keyStep(b)}`
    + (pick.length > 1 ? ` Others that work too: ${pick.slice(1).map((o) => `${o.label} (hearth-mcp add ${o.url} ${o.name}; ${o.free})`).join(", ")}.` : ""));
  return out;
};

export const STUCK: StuckKind[] = [
  {
    id: "blocked", aka: ["bot-detection", "bot", "captcha", "human-check", "403", "access-denied", "scrape", "cant-scrape", "wont-load", "fetch", "fetch-failed", "page-error"],
    when: "a site blocks you or won't load, by WebFetch, curl or the browser: a fetch error, a human check, a captcha, Access Denied, a 403 or error page, endless loading, results that ignore what you typed",
    steps: blockedSteps,
  },
  {
    id: "signed-out", aka: ["login", "logged-out", "sign-in", "signin", "auth", "password", "2fa"],
    when: "a site wants you signed in (or signed you out) and you don't have that login",
    steps: (s) => [
      ...[macStep(s, "Its Chrome has the user's own logins, so the site is likely signed in already.")].filter((x): x is string => !!x),
      `Put a connection.refresh {site} action in your \`\`\`hearth block: Hearth asks the user's Mac for a fresh login to that site and runs the job again with it (or tells the user exactly what to sign in to). Meanwhile finish what doesn't need the login.`,
      `Never ask for a password, a code or a card number in chat. If a person really has to sign in, say which site and that they can do it on their Mac (or in your browser while they watch, when you have a page open).`,
    ],
  },
  {
    id: "no-access", aka: ["no-tool", "missing-tool", "no-integration", "integration", "service", "api", "connect"],
    when: "the task needs a service or data you have no tool for (an app like Linear, Notion, a CRM, an account's data)",
    steps: (s) => [
      `Check what's there first: hearth-mcp list (MCP servers the hub has: ${s.servers.length ? s.servers.map((x) => `${x.name} ${x.state}`).join(", ") : "none yet"}), and hearth-skill search <the service> for a skill that covers it.`,
      `Not there: add the service's official MCP server yourself. Find its address on the service's own docs (search "<service> MCP server", the official one), then hearth-mcp add <https url> <name>. That's one Approve card for the user; say in your reply what it's for. Once approved you sign in or get its key yourself (the hearth-mcp skill says how), and you get a turn to carry on.`,
      `No MCP server exists: look for a public API or an export you can reach with code (the automate-repetitive-work skill), or the site itself in your browser.`,
    ],
  },
  {
    id: "failing", aka: ["error", "broken", "crash", "timeout", "tool-error", "command-failed", "loop"],
    when: "a command or tool keeps failing, timing out, or giving results that look wrong",
    steps: () => [
      `Read the error word for word (the message in its output, not a guess) and fix what it says. Don't run the same thing a third time unchanged.`,
      `Try one different way: another command or tool, smaller input, a fresh session, another source for the same data.`,
      `Still stuck after two honest tries: hearth-lead "<the task in a line, what you ran, the exact error, what you want to know>" and follow its advice.`,
    ],
  },
  {
    id: "need-info", aka: ["question", "unclear", "ambiguous", "missing-info", "dont-know", "choice"],
    when: "you need something only the user knows (a preference, a detail, a choice between options)",
    steps: () => [
      `Make the sensible choice yourself and carry on: the usual option, what earlier messages or the workspace notes point to. Say in a line which you picked, so they can change it.`,
      `If it really changes the result (money, who it goes to, something hard to undo): finish everything that doesn't depend on it, then end your reply with one short question with the options spelled out.`,
    ],
  },
  {
    id: "waiting", aka: ["approval", "approve", "pending", "held"],
    when: "something you asked for is waiting for the user's Approve",
    steps: (s) => [
      `${s.waiting?.length ? `Waiting now: ${s.waiting.join("; ")}.` : "Nothing of this job's is waiting right now."} Don't ask again or try another way round it.`,
      `Finish every part that doesn't need it, and say in your reply what's waiting and why. When they answer you get a turn with the result and carry on from there.`,
    ],
  },
];

/** The kind an agent named, by its id or another word for it. */
export function stuckKind(word: string): StuckKind | null {
  const w = word.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/'/g, "");
  return STUCK.find((k) => k.id === w || k.aka.includes(w)) ?? null;
}

export const STUCK_MENU = `hearth-help stuck <kind>. Pick the kind that fits:\n`
  + STUCK.map((k) => `  ${k.id.padEnd(11)} ${k.when}`).join("\n");

/** The answer for one kind of stuck: its steps, best first, built from what's there right now. */
export function stuckHelp(kind: string, s: StuckState): string {
  const k = stuckKind(kind);
  if (!k) return `${kind ? `"${kind}" isn't one of the kinds. ` : ""}${STUCK_MENU}`;
  const steps = [...k.steps(s), `If none of that works, tell the user plainly what's in the way and what you got without it, and finish the rest of the task.`];
  return `You're stuck (${k.id}: ${k.when}). What to do, best first. Don't give the work back to the user or tell them to do it by hand.`
    + steps.map((t, i) => `\n${i + 1}. ${t}`).join("");
}

/** What happens after the user approves adding it, for the agent. */
function keyStep(b: CloudBrowser) {
  if (b.auth === "none") return `it connects by itself (no account needed), and you get a turn to carry on with its tools.`;
  if (b.auth === "oauth") return `you get its sign-in link; open it in your browser and go through it (your browser has the user's logins; sign up with their Google account on the free plan if there's no account). Ask the user only for a password you don't have.`;
  const where = b.key?.query ? ` ?${b.key.query}` : b.key?.header ? ` ${b.key.header}` : "";
  return `get its API key yourself: open ${b.getKey} in your browser (it has the user's logins; sign up with their Google account on the free plan if there's no account, never a paid one), copy the key, and run hearth-mcp key ${b.name} <key>${where}. Ask the user only for a password you don't have.`;
}

/** The agent's hearth-help command: curl to the hub with its agent key (like hearth-lead). */
export function helpSkill(hubUrl: string, key: string) {
  const script = `#!/usr/bin/env bash
# hearth-help: ask the hub what to do. hearth-help stuck [<kind>]
set -uo pipefail
if [ $# -eq 0 ]; then set -- topics; fi
args=()
for a in "$@"; do args+=(--data-urlencode "a=$a"); done
run=()
if [ -n "\${HEARTH_JOB:-}" ]; then run=(-H "X-Hearth-Job: \${HEARTH_JOB}"); fi
exec curl -sS -m 60 -H "X-Hearth-Agent: ${key}" \${run[@]+"\${run[@]}"} "\${args[@]}" "${hubUrl}/api/agent/help"
`;
  return {
    name: "hearth-help", common: true, commands: ["hearth-help"], reads: [] as string[], scripts: { "hearth-help": script },
    description: "Stuck on anything (a site blocks you or a page won't load, you're signed out, no tool for a service, a command keeps failing, you need the user's input, waiting on an Approve)? hearth-help stuck says what to do, from what's there right now.",
    body: `# hearth-help

When you're stuck, don't give the work back to the user: ask the hub.
- \`hearth-help stuck\` lists the kinds of stuck (blocked, signed-out, no-access, failing, need-info, waiting).
- \`hearth-help stuck <kind>\` answers with steps, best first, built from what's there right now (the user's Mac, the
  MCP servers it has, what's waiting). Do them in order.
Run it again after something changes (they approved, a server connected).`,
  };
}

export const HELP_TOPICS = `hearth-help topics:
  stuck [<kind>]   you're stuck on something: hearth-help stuck lists the kinds`;
