import { createHash } from "node:crypto";
import type { Cookie } from "../browser.ts";
import type { Item, SourceCtx } from "./index.ts";

// Shared by modules that read a site you're logged into (LinkedIn, X): open the page in headless Chrome with your
// cookies, pick out the list items by selector, and give each an id that ignores "5m ago" style times, so an item only
// counts as new when its words change (a new message in a conversation, a new notification).

export class SignedOut extends Error {}

export type Page = {
  url: string;
  /** Tried in order; the first that matches anything is the list. */
  selectors: string[];
  /** Where a logged-out browser ends up. */
  signedOut: RegExp;
};

/** Lines that are only a time or a separator ("5m", "2 hours ago", "Oct 28", "·"), so they don't change an id. */
const TIME_LINE = /^(·|•|\d+\s?[smhdw]|now|just now|yesterday|today|\d+\s?(sec|secs|min|mins|minute|minutes|hr|hrs|hour|hours|day|days|wk|wks|week|weeks|mo|mos|month|months|yr|yrs|year|years)( ago)?|(mon|tue|wed|thu|fri|sat|sun)[a-z]*|[a-z]{3,9} \d{1,2}(, \d{4})?|\d{1,2}:\d{2}\s?(am|pm)?|\d+ (new )?notifications?)$/i;

export function stableText(text: string) {
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !TIME_LINE.test(l)).join("\n");
}

/** Runs in the page: the first selector that finds elements gives the items; else null (layout not recognised). */
export function extractScript(selectors: string[]) {
  return `(() => {
    for (const sel of ${JSON.stringify(selectors)}) {
      const els = [...document.querySelectorAll(sel)].filter((e) => (e.innerText || "").trim());
      if (!els.length) continue;
      return els.slice(0, 30).map((e) => {
        const a = e.querySelector("a[href]") || e.closest("a[href]");
        return { text: (e.innerText || "").replace(/[ \\t]+/g, " ").replace(/\\n\\s*\\n+/g, "\\n").trim().slice(0, 1500),
          unread: /unread/i.test(String(e.className) + " " + (e.getAttribute("aria-label") || "")), href: a ? a.href : "" };
      });
    }
    return null;
  })()`;
}

type Raw = { text: string; unread: boolean; href: string };

export async function readList(site: string, page: Page, cookies: Cookie[], ctx: SourceCtx): Promise<Item[]> {
  if (!cookies.length) throw new SignedOut(`${site} isn't connected. Paste your ${site} cookies in Menu → Connectors.`);
  const r = await ctx.readPage(page.url, { cookies, waitFor: page.selectors.join(", "), waitMs: 12_000, extract: extractScript(page.selectors) });
  // A dead session either lands on the login page or (LinkedIn, with a stale li_at) bounces until Chrome gives up.
  if (page.signedOut.test(r.url) || (r.url.startsWith("chrome-error:") && /TOO_MANY_REDIRECTS/.test(r.text))) {
    throw new SignedOut(`${site} signed Hearth out. Paste fresh cookies in Menu → Connectors.`);
  }
  if (r.url.startsWith("chrome-error:")) throw new Error(`${site} didn't load (${r.text.match(/ERR_[A-Z_]+/)?.[0] || "network error"}).`);
  const raw = r.data as Raw[] | null;
  if (!raw) throw new Error(`${site}'s page didn't look like the list Hearth expects (it may have changed). Nothing was read.`);
  return raw.map((x) => {
    const lines = stableText(x.text).split("\n");
    return {
      id: createHash("sha256").update(stableText(x.text)).digest("hex").slice(0, 24),
      title: `${x.unread ? "● " : ""}${lines[0] || site}`.slice(0, 120),
      text: lines.slice(1).join("\n") || lines[0] || "",
      url: x.href || page.url,
    };
  });
}
