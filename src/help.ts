import type { McpView } from "./mcp.ts";
import type { MacGate } from "./other-browser.ts";

// hearth-help: where an agent asks the hub what to do. The answer is made here, from what's true right now (is the Mac
// online, did the user say yes or no to it, which MCP servers are connected), so changing what agents do when they're
// stuck means changing this file, not skill text spread around.
//
//   hearth-help stuck "<what's blocking you>"   a site blocks the browser, a page won't load, a tool can't reach it

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

export type StuckState = { what: string; mac: string | null; gate: MacGate | null; servers: McpView[] };

/** What to do when stuck, in order: the user's Mac, a connected cloud browser, one to add, else say so. */
export function stuckHelp(s: StuckState): string {
  const what = s.what.trim() || "a site blocks the browser here";
  const out: string[] = [`You're stuck: ${what}. Here is what's available right now, best first. Don't give the work back to the user or tell them to do it by hand.`];
  let n = 0;
  const step = (t: string) => out.push(`\n${++n}. ${t}`);
  if (s.mac && s.gate !== "no") {
    step(s.gate === "ok"
      ? `Chrome on ${s.mac} (the user's Mac) is yours in this conversation already: run hearth-browser open <url> "${what}" and carry on there. It's a real browser on their home connection, with their logins.`
      : s.gate === "pending"
        ? `You already asked to use Chrome on ${s.mac}; it's waiting for the user's Approve. Finish what you can without the site; you'll get a turn when they answer.`
        : `Ask the user if you can use Chrome on their Mac (${s.mac}): a real browser on their home connection, with their logins, so sites that block servers let it through. Run hearth-browser open <url> "${what}": that puts an Approve card under your reply. In your reply, ask them plainly ("Can I use Chrome on your Mac for this? Tap Approve"), say what blocked you, and finish what you can meanwhile. When they approve you get a turn and carry on with hearth-browser.`);
  }
  const on = connectedBrowsers(s.servers);
  for (const { b, server } of on) {
    step(`${b.label} is connected as the MCP server ${server.name}: ${b.good}. Its tools are yours (mcp__${server.name}__<tool> on Claude; on any brain, hearth-mcp call ${server.name} <tool> '<json>'). ${b.how}`);
  }
  if (on.length) {
    const more = CLOUD_BROWSERS.filter((b) => !on.some((o) => o.b.name === b.name) && !s.servers.some((x) => x.name === b.name));
    if (more.length) step(`If that one can't get through either, add another yourself: ${more.map((o) => `${o.label}, ${o.good} (hearth-mcp add ${o.url} ${o.name}; ${o.free})`).join("; ")}. One Approve card each; once approved, ${keyStep(more[0])}`);
  }
  if (!on.length) {
    const asked = s.servers.filter((x) => CLOUD_BROWSERS.some((b) => b.name === x.name) && x.state !== "connected");
    const pick = CLOUD_BROWSERS.filter((b) => !asked.some((x) => x.name === b.name));
    for (const x of asked) {
      step(`${x.name} is on the list but not connected (${x.state === "pending" ? "it waits for the user's Approve" : x.state === "signin" ? "it needs its API key" : x.state}). ${x.state === "pending" ? "You'll get a turn when they answer." : keyStep(CLOUD_BROWSERS.find((b) => b.name === x.name)!)}`);
    }
    if (pick.length) {
      const b = pick[0];
      step(`Add a cloud browser yourself (no need to ask the user to do it): ${b.label}, ${b.good}. Run: hearth-mcp add ${b.url} ${b.name}. That's one Approve card for the user; in your reply say what it's for and that it ${b.auth === "none" ? b.free : `has ${b.free}`}${b.auth === "none" ? "" : `, and that if they don't have an account you'll make a free one with their Google login`}. Once they approve, ${keyStep(b)}`
        + (pick.length > 1 ? ` Others that work too: ${pick.slice(1).map((o) => `${o.label} (hearth-mcp add ${o.url} ${o.name}; ${o.free})`).join(", ")}.` : ""));
    }
  }
  step(`If none of that works, tell the user plainly what blocked you and what you got without it, and finish the rest of the task.`);
  return out.join("");
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
# hearth-help: ask the hub what to do. hearth-help stuck "<what's blocking you>"
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
    description: "Stuck? A site blocks you (human check, captcha, Access Denied, a page that never loads) or a tool can't get there: hearth-help stuck says what you can use right now.",
    body: `# hearth-help

\`hearth-help stuck "<what's blocking you, in a few words>"\` asks the hub what to do. It looks at what's there right
now (the user's Mac, the MCP servers it has) and answers with steps, best first. Do them in order; don't give the work
back to the user. Run it again after something changes (they approved, a server connected).`,
  };
}

export const HELP_TOPICS = `hearth-help topics:
  stuck "<what's blocking you>"   a site blocks the browser, a page won't load, a tool can't reach something`;
