import type { Source } from "./index.ts";
import { readList, type Page } from "./pages.ts";

// X, read through your own logged-in session (auth_token and ct0 cookies you paste once): notifications, mentions, DMs.

type What = "notifications" | "mentions" | "messages";
type Config = { what: What };

const SIGNED_OUT = /x\.com\/(i\/flow\/login|i\/jf\/onboarding|login|logout|account\/access)/;
const PAGES: Record<What, Page> = {
  notifications: { url: "https://x.com/notifications", signedOut: SIGNED_OUT,
    selectors: ["article[data-testid='notification']", "article[data-testid='tweet']", "[data-testid='cellInnerDiv'] article"] },
  mentions: { url: "https://x.com/notifications/mentions", signedOut: SIGNED_OUT,
    selectors: ["article[data-testid='tweet']", "[data-testid='cellInnerDiv'] article"] },
  messages: { url: "https://x.com/messages", signedOut: SIGNED_OUT,
    selectors: ["[data-testid='conversation']", "[data-testid='cellInnerDiv'] [role='link']"] },
};

export const x: Source<Config> = {
  id: "x",
  label: "X",
  needs: "x.com",
  doc: `X (Twitter) through the user's logged-in session. config {"what":"notifications"}, {"what":"mentions"} or
           {"what":"messages"} (DMs). Minutes >= 15, default 30.`,
  validate(c) {
    const what = (["notifications", "mentions", "messages"] as const).find((w) => w === c?.what) ?? "notifications";
    return { what };
  },
  minutes: () => ({ min: 15, default: 30 }),
  describe: (c) => (c.what === "messages" ? "new X DMs" : `new X ${c.what}`),
  items: (c, ctx) => readList("X", PAGES[c.what], ctx.cookies("x.com"), ctx),
};
