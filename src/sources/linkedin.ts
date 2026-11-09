import type { Item, Source, SourceCtx } from "./index.ts";
import { readList, SignedOut, type Page } from "./pages.ts";
import { conversationId, LinkedInApi, threadOf, type Conversation } from "../connectors/linkedin-api.ts";

// LinkedIn, read through your own logged-in session (cookies you paste once): messages, notifications, invitations.
// Read-only and at most every 15 minutes, so it looks like you glancing at the tab. A teammate answering a question can
// also search conversations by name (LinkedIn's own "Search messages" box) and page back through older ones.
// Messages go through LinkedIn's own API first (connectors/linkedin-api.ts): each row then has its conversation's link,
// and one conversation can be read whole ("thread"). If the API won't answer, the inbox page is read as before.

type What = "messages" | "notifications" | "invitations";
type Config = { what: What; query?: string; page: number; thread?: string };

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

const PAGE_SIZE = 10;
const when = (at: string | null) => (at ? new Date(at).toISOString().slice(0, 16).replace("T", " ") : undefined);

/** A conversation as a row: its name, the last message, and its link. */
export function conversationItem(c: Conversation): Item {
  return { id: conversationId(c), title: `${c.unread ? "● " : ""}${c.name}`.slice(0, 120), unread: c.unread, url: c.thread,
    at: c.at ?? undefined, when: when(c.at), text: c.last ? `${c.last.from}: ${c.last.text}`.slice(0, 1500) : "" };
}

/** Rows from the API, or null when this read needs the page instead (older rows, or a search with no recent match). */
async function fromApi(c: Config, api: LinkedInApi): Promise<Item[] | null> {
  if (c.thread) {
    const thread = threadOf(c.thread)!;
    const messages = await api.use(async (v) => v.messages(await v.conversationUrn(thread)));
    return messages.reverse().map((m) => ({ id: `li:${m.urn || m.at}`, title: m.from, text: m.text, url: c.thread, at: m.at ?? undefined, when: when(m.at) }));
  }
  const list = (await api.use((v) => v.conversations())).map(conversationItem);
  const q = (c.query || "").toLowerCase();
  const hits = q ? list.filter((i) => `${i.title}\n${i.text}`.toLowerCase().includes(q)) : list;
  if (q && !hits.length) return null;
  // One row past the page, so the reader can tell there's another; beyond what the API gave, the page scrolls for more.
  if (!q && c.page * PAGE_SIZE + 1 > hits.length && list.length >= 20) return null;
  return hits;
}

export const linkedin: Source<Config> = {
  id: "linkedin",
  label: "LinkedIn",
  needs: "linkedin.com",
  doc: `LinkedIn through the user's logged-in session. config {"what":"messages"} (a new message in any conversation),
           {"what":"notifications"} or {"what":"invitations"} (connection requests). Minutes >= 15, default 30.
           Reading (source.read): 10 rows a page, newest first. {"what":"messages","query":"Jane Doe"} searches
           conversations by name (or words in them); add "page":2, 3… (up to 10) for older rows, of any list.
           {"what":"messages","thread":"<a row's link>"} reads that whole conversation, newest first.
           To reply, message.send channel linkedin with "to" = the row's link (or its name exactly as shown).`,
  validate(c) {
    const what = (["messages", "notifications", "invitations"] as const).find((w) => w === c?.what) ?? "messages";
    const query = typeof c?.query === "string" ? c.query.trim().slice(0, 100) : "";
    if (query && what !== "messages") return `Only LinkedIn messages can be searched; drop "query" for ${what}.`;
    const thread = typeof c?.thread === "string" ? c.thread.trim() : "";
    if (thread && (what !== "messages" || !threadOf(thread))) return `"thread" is a conversation's link from a messages read, like https://www.linkedin.com/messaging/thread/2-abc…/.`;
    const page = Math.min(10, Math.max(1, Math.floor(Number(c?.page) || 1)));
    return { what, ...(query ? { query } : {}), ...(thread ? { thread } : {}), page };
  },
  minutes: () => ({ min: 15, default: 30 }),
  describe: (c) => c.thread ? "a LinkedIn conversation" : c.query ? `LinkedIn conversations matching "${c.query}"` : `new LinkedIn ${c.what}`,
  async items(c, ctx: SourceCtx) {
    const cookies = ctx.cookies("linkedin.com");
    if (c.what === "messages" && ctx.openSite && cookies.length) {
      const api = new LinkedInApi(() => cookies, ctx.openSite);
      try {
        const rows = await fromApi(c, api);
        if (rows) return rows;
      } catch (e) {
        if (e instanceof SignedOut) throw new SignedOut("LinkedIn signed Hearth out. Paste fresh cookies in Menu → Connectors.");
        if (c.thread) {
          // The conversation's own page, as text, when the API won't give its messages.
          const r = await ctx.readPage(c.thread, { cookies, waitFor: ".msg-s-message-list", waitMs: 12_000 });
          if (SIGNED_OUT.test(r.url)) throw new SignedOut("LinkedIn signed Hearth out. Paste fresh cookies in Menu → Connectors.");
          return [{ id: "page", title: "LinkedIn conversation", text: r.text.slice(0, 8000), url: c.thread }];
        }
      }
    }
    return readList("LinkedIn", PAGES[c.what], cookies, ctx, { query: c.query, page: c.page });
  },
};
