import type { Source } from "./index.ts";
import { readList, type Page } from "./pages.ts";

// LinkedIn, read through your own logged-in session (cookies you paste once): messages, notifications, invitations.
// Read-only and at most every 15 minutes, so it looks like you glancing at the tab.

type What = "messages" | "notifications" | "invitations";
type Config = { what: What };

const SIGNED_OUT = /linkedin\.com\/(login|authwall|checkpoint|uas\/login|signup)/;
const PAGES: Record<What, Page> = {
  messages: { url: "https://www.linkedin.com/messaging/", signedOut: SIGNED_OUT,
    selectors: ["li.msg-conversation-listitem", "[class*='msg-conversation-listitem']", ".msg-conversations-container__conversations-list li"] },
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
           {"what":"notifications"} or {"what":"invitations"} (connection requests). Minutes >= 15, default 30.`,
  validate(c) {
    const what = (["messages", "notifications", "invitations"] as const).find((w) => w === c?.what) ?? "messages";
    return { what };
  },
  minutes: () => ({ min: 15, default: 30 }),
  describe: (c) => `new LinkedIn ${c.what}`,
  items: (c, ctx) => readList("LinkedIn", PAGES[c.what], ctx.cookies("linkedin.com"), ctx),
};
