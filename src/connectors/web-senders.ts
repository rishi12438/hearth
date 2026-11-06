import { sendInPage, type Cookie, type OpenByName } from "../browser.ts";

// Sending on sites with no API for it (Instagram, LinkedIn, X): the hub opens the conversation in a headless Chrome
// signed in with your own login, types the message and presses Send, like you would. Only ever after you tapped
// Approve on that exact message (hub.requestMessage). "to" is the conversation's link, which teammates get when they
// read your inbox; starting a brand-new conversation isn't supported, so nothing goes to someone you never talked to.
// LinkedIn's list has no link per conversation (rows are plain clickable boxes), so there "to" can be the conversation's
// name as the read showed it: the hub searches the inbox for it, opens it, and checks the chat's header says that name
// before typing (LinkedIn opens your newest chat on its own, so typing without that check could reach the wrong person).

export type WebChannel = "instagram" | "linkedin" | "x";

type Site = { domain: string; label: string; chat: RegExp; example: string; composer: string[]; sendButton?: string[]; signedOut: RegExp;
  /** Where to open a conversation by name ("to" isn't a link): the inbox, and how to find and check it there. */
  byName?: { inbox: string } & Omit<OpenByName, "name"> };

export const SITES: Record<WebChannel, Site> = {
  instagram: {
    domain: "instagram.com", label: "Instagram", example: "https://www.instagram.com/direct/t/1234567890/",
    chat: /^https:\/\/(www\.)?instagram\.com\/direct\/t\/[\w-]+\/?(\?.*)?$/,
    composer: ["div[role='textbox'][contenteditable='true']", "textarea[placeholder]"],
    signedOut: /instagram\.com\/(accounts\/login|challenge|accounts\/suspended)/,
  },
  linkedin: {
    domain: "linkedin.com", label: "LinkedIn", example: "https://www.linkedin.com/messaging/thread/2-abc…/",
    chat: /^https:\/\/(www\.)?linkedin\.com\/messaging\/thread\/[^/?#]+\/?(\?.*)?$/,
    composer: [".msg-form__contenteditable[contenteditable='true']", "div[role='textbox'][contenteditable='true']"],
    sendButton: ["button.msg-form__send-button", "button.msg-form__send-btn", "form.msg-form button[type='submit']"],
    signedOut: /linkedin\.com\/(login|authwall|checkpoint|uas\/login|signup)/,
    byName: {
      inbox: "https://www.linkedin.com/messaging/",
      search: ["input#search-conversations", "input[name='searchTerm']", "input[placeholder*='Search messages' i]"],
      rows: ["li.msg-conversation-listitem", "[class*='msg-conversation-listitem']"],
      rowName: [".msg-conversation-listitem__participant-names", ".msg-conversation-card__participant-names"],
      rowClick: [".msg-conversation-listitem__link", "[tabindex='0']"],
      header: [".msg-entity-lockup__entity-title", ".msg-thread__link-to-profile", "#thread-detail-jump-target"],
    },
  },
  x: {
    domain: "x.com", label: "X", example: "https://x.com/messages/12345-67890",
    chat: /^https:\/\/(www\.)?(x|twitter)\.com\/(i\/chat|messages)\/[\w-]+\/?(\?.*)?$/,
    composer: ["[data-testid='dmComposerTextInput']", "div[role='textbox'][contenteditable='true']", "textarea[data-testid='dm-composer-textarea']"],
    sendButton: ["[data-testid='dmComposerSendButton']", "button[data-testid='dm-composer-send-button']"],
    signedOut: /x\.com\/(i\/flow\/login|i\/jf\/onboarding|login|logout|account\/access)/,
  },
};

/** Why `to` can't be used as a conversation on this site, or null if it can: its link, or (LinkedIn) its name. */
export function badChatLink(channel: WebChannel, to: string): string | null {
  const s = SITES[channel];
  if (s.chat.test(to)) return null;
  if (s.byName && to && !/^https?:|\/\//i.test(to) && to.length <= 120) return null;
  return s.byName
    ? `For ${s.label}, "to" is the conversation's name exactly as the inbox read (source.read) shows it, like "Jane Doe", or its link like ${s.example}. Starting a new conversation isn't supported.`
    : `For ${s.label}, "to" is the conversation's link from what you read, like ${s.example}. Starting a new conversation isn't supported.`;
}

export function webSender(channel: WebChannel, cookies: (domain: string) => Cookie[], send = sendInPage) {
  const s = SITES[channel];
  return {
    connected: () => cookies(s.domain).length > 0,
    send: async (to: string, text: string) => {
      const bad = badChatLink(channel, to);
      if (bad) throw new Error(bad);
      const base = { cookies: cookies(s.domain), composer: s.composer, sendButton: s.sendButton, signedOut: s.signedOut };
      if (!s.chat.test(to) && s.byName) {
        const { inbox, ...how } = s.byName;
        // "● " marks an unread row in what the read showed; it isn't part of the name.
        await send(inbox, text, { ...base, open: { ...how, name: to.replace(/^●\s*/, "") }, timeoutMs: 90_000 });
      } else await send(to.replace("twitter.com", "x.com"), text, base);
      return "";
    },
  };
}
