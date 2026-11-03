import type { Source } from "./index.ts";
import { readList, type Page } from "./pages.ts";

// Instagram DMs, read through your own logged-in session (the sessionid cookie). Unofficial: the owner accepted the
// ban risk when connecting. Read-only and at most every 15 minutes, so it looks like you glancing at the inbox.

const SIGNED_OUT = /instagram\.com\/(accounts\/login|challenge|accounts\/suspended)/;
// The inbox has no per-chat links any more: each chat is a div[role=button] in the "Thread list", with an <abbr> for
// its time (the "Your note" button above the list has none). The older link-based layout is kept as a fallback.
const INBOX: Page = { url: "https://www.instagram.com/direct/inbox/", signedOut: SIGNED_OUT,
  selectors: ["[aria-label='Thread list'] [role='button']:has(abbr)", "[role='button']:has(abbr)", "div[role='listitem'] a[href^='/direct/t/']", "a[href^='/direct/t/']"] };

export const instagram: Source<{ what: "messages" }> = {
  id: "instagram",
  label: "Instagram",
  needs: "instagram.com",
  doc: `Instagram DMs through the user's logged-in session. config {"what":"messages"} (a new message in any chat). Minutes >= 15, default 30.`,
  validate: () => ({ what: "messages" }),
  minutes: () => ({ min: 15, default: 30 }),
  describe: () => "new Instagram DMs",
  items: (_c, ctx) => readList("Instagram", INBOX, ctx.cookies("instagram.com"), ctx),
};
