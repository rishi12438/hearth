import { createHash } from "node:crypto";
import { SignedOut, type Cookie } from "../browser.ts";
import type { Item, SourceCtx } from "./index.ts";

// Shared by modules that read a site you're logged into (LinkedIn, X): open the page in headless Chrome with your
// cookies, pick out the list items by selector, and give each an id that ignores "5m ago" style times, so an item only
// counts as new when its words change (a new message in a conversation, a new notification).

export { SignedOut };

export type Page = {
  url: string;
  /** Tried in order; the first that matches anything is the list. */
  selectors: string[];
  /** Where a logged-out browser ends up. */
  signedOut: RegExp;
  /** The site's own search box, tried in order (LinkedIn's "Search messages"), so a read can look for one name. */
  search?: string[];
  /** Rows have no link of their own (LinkedIn): leave url empty rather than hand out the list page as if it were one. */
  noRowLinks?: boolean;
};

/** Rows per page when a teammate pages through a list (source.read with "page"). */
export const PAGE_SIZE = 10;

/** How to read a list: search it for a name first, and/or load enough rows for page N (scrolling for older ones). */
export type ListOpts = { query?: string; page?: number };

/** Lines that are only a time or a separator ("5m", "2 hours ago", "Oct 28", "·"), so they don't change an id. */
const TIME_LINE = /^(·|•|\d+\s?[smhdw]|now|just now|yesterday|today|\d+\s?(sec|secs|min|mins|minute|minutes|hr|hrs|hour|hours|day|days|wk|wks|week|weeks|mo|mos|month|months|yr|yrs|year|years)( ago)?|(mon|tue|wed|thu|fri|sat|sun)[a-z]*|[a-z]{3,9} \d{1,2}(, \d{4})?|\d{1,2}:\d{2}\s?(am|pm)?|\d+ (new )?notifications?)$/i;

export function stableText(text: string) {
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !TIME_LINE.test(l)).join("\n");
}

/** Runs in the page: the first selector that finds elements gives the items; else null (layout not recognised). */
export function extractScript(selectors: string[], limit = 30) {
  return `(() => {
    for (const sel of ${JSON.stringify(selectors)}) {
      const els = [...document.querySelectorAll(sel)].filter((e) => (e.innerText || "").trim());
      if (!els.length) continue;
      return els.slice(0, ${limit}).map((e) => {
        const a = e.querySelector("a[href]") || e.closest("a[href]");
        return { text: (e.innerText || "").replace(/[ \\t]+/g, " ").replace(/\\n\\s*\\n+/g, "\\n").trim().slice(0, 1500),
          unread: /unread/i.test(String(e.className) + " " + (e.getAttribute("aria-label") || "")), href: a ? a.href : "" };
      });
    }
    return null;
  })()`;
}

type Raw = { text: string; unread: boolean; href: string };

export async function readList(site: string, page: Page, cookies: Cookie[], ctx: SourceCtx, o: ListOpts = {}): Promise<Item[]> {
  if (!cookies.length) throw new SignedOut(`${site} isn't connected. Paste your ${site} cookies in Menu → Connectors.`);
  if (o.query && !page.search) throw new Error(`${site} can't be searched here; read it without "query".`);
  // One row past the page, so the reader can tell there's another page after it.
  const want = Math.max(30, (o.page || 1) * PAGE_SIZE + 1);
  const r = await ctx.readPage(page.url, {
    cookies, waitFor: page.selectors.join(", "), waitMs: 12_000, extract: extractScript(page.selectors, want),
    ...(o.query && page.search ? { search: { box: page.search, text: o.query } } : {}),
    ...((o.page || 1) > 1 ? { more: { items: page.selectors, until: want }, timeoutMs: 90_000 } : {}),
  });
  // A dead session either lands on the login page or (LinkedIn, with a stale li_at) bounces until Chrome gives up.
  if (page.signedOut.test(r.url) || (r.url.startsWith("chrome-error:") && /TOO_MANY_REDIRECTS/.test(r.text))) {
    throw new SignedOut(`${site} signed Hearth out. Paste fresh cookies in Menu → Connectors.`);
  }
  if (r.url.startsWith("chrome-error:")) throw new Error(`${site} didn't load (${r.text.match(/ERR_[A-Z_]+/)?.[0] || "network error"}).`);
  const raw = r.data as Raw[] | null;
  // The search box was there and was used; no rows means nobody by that name.
  if (!raw && o.query) return [];
  if (!raw) throw new Error(`${site}'s page didn't look like the list Hearth expects (it may have changed). Nothing was read.`);
  return raw.map((x) => {
    const lines = stableText(x.text).split("\n");
    const when = x.text.split("\n").map((l) => l.trim()).find((l) => l && TIME_LINE.test(l) && !/^(·|•)$/.test(l) && !/notifications?$/i.test(l));
    return {
      when, unread: x.unread,
      id: createHash("sha256").update(stableText(x.text)).digest("hex").slice(0, 24),
      title: `${x.unread ? "● " : ""}${lines[0] || site}`.slice(0, 120),
      text: lines.slice(1).join("\n") || lines[0] || "",
      url: x.href || (page.noRowLinks ? "" : page.url),
    };
  });
}
