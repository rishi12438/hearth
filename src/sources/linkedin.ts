import type { Source } from "./index.ts";
import { readList, type Page } from "./pages.ts";

// LinkedIn, read through your own logged-in session (cookies you paste once): messages, notifications, invitations.
// Read-only and at most every 15 minutes, so it looks like you glancing at the tab. A teammate answering a question can
// also search conversations by name (LinkedIn's own "Search messages" box) and page back through older ones.

type What = "messages" | "notifications" | "invitations";
type Config = { what: What; query?: string; page: number };

const SIGNED_OUT = /linkedin\.com\/(login|authwall|checkpoint|uas\/login|signup)/;
const PAGES: Record<What, Page> = {
  messages: { url: "https://www.linkedin.com/messaging/", signedOut: SIGNED_OUT,
    selectors: ["li.msg-conversation-listitem", "[class*='msg-conversation-listitem']", ".msg-conversations-container__conversations-list li"],
    search: ["input#search-conversations", "input[name='searchTerm']", "input[placeholder*='Search messages' i]", "input[aria-label*='Search messages' i]", ".msg-search-form input"],
    noRowLinks: true },
  notifications: { url: "https://www.linkedin.com/notifications/", signedOut: SIGNED_OUT,
    selectors: ["[componentkey^='notification-card']", "article.nt-card", "[class*='nt-card']", "[data-finite-scroll-hotkey-item]"] },
  // Each request is a list item with an "Accept <name>'s invitation" button (2026 layout; class names are hashed).
  // Not "main section ul > li": that matched the Received / Sent tabs instead of the requests.
  invitations: { url: "https://www.linkedin.com/mynetwork/invitation-manager/received/", signedOut: SIGNED_OUT,
    selectors: ["[role='listitem']:has(button[aria-label^='Accept'])", "li:has(button[aria-label^='Accept'])", "li.invitation-card", "[class*='invitation-card']"] },
};

export const linkedin: Source<Config> = {
  id: "linkedin",
  label: "LinkedIn",
  needs: "linkedin.com",
  doc: `LinkedIn through the user's logged-in session. config {"what":"messages"} (a new message in any conversation),
           {"what":"notifications"} or {"what":"invitations"} (connection requests). Minutes >= 15, default 30.
           Reading (source.read): 10 rows a page, newest first. {"what":"messages","query":"Jane Doe"} searches
           conversations by name (or words in them); add "page":2, 3… (up to 10) for older rows, of any list.
           Rows have no link; to reply, message.send channel linkedin with "to" = the row's name exactly as shown.`,
  validate(c) {
    const what = (["messages", "notifications", "invitations"] as const).find((w) => w === c?.what) ?? "messages";
    const query = typeof c?.query === "string" ? c.query.trim().slice(0, 100) : "";
    if (query && what !== "messages") return `Only LinkedIn messages can be searched; drop "query" for ${what}.`;
    const page = Math.min(10, Math.max(1, Math.floor(Number(c?.page) || 1)));
    return { what, ...(query ? { query } : {}), page };
  },
  minutes: () => ({ min: 15, default: 30 }),
  describe: (c) => c.query ? `LinkedIn conversations matching "${c.query}"` : `new LinkedIn ${c.what}`,
  items: (c, ctx) => readList("LinkedIn", PAGES[c.what], ctx.cookies("linkedin.com"), ctx, { query: c.query, page: c.page }),
};
