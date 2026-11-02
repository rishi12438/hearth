import { sendInPage, type Cookie } from "../browser.ts";

// Sending on sites with no API for it (Instagram, LinkedIn, X): the hub opens the conversation in a headless Chrome
// signed in with your own login, types the message and presses Send, like you would. Only ever after you tapped
// Approve on that exact message (hub.requestMessage). "to" is the conversation's link, which teammates get when they
// read your inbox; starting a brand-new conversation isn't supported, so nothing goes to someone you never talked to.

export type WebChannel = "instagram" | "linkedin" | "x";

type Site = { domain: string; label: string; chat: RegExp; example: string; composer: string[]; sendButton?: string[]; signedOut: RegExp };

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
  },
  x: {
    domain: "x.com", label: "X", example: "https://x.com/messages/12345-67890",
    chat: /^https:\/\/(www\.)?(x|twitter)\.com\/(i\/chat|messages)\/[\w-]+\/?(\?.*)?$/,
    composer: ["[data-testid='dmComposerTextInput']", "div[role='textbox'][contenteditable='true']", "textarea[data-testid='dm-composer-textarea']"],
    sendButton: ["[data-testid='dmComposerSendButton']", "button[data-testid='dm-composer-send-button']"],
    signedOut: /x\.com\/(i\/flow\/login|i\/jf\/onboarding|login|logout|account\/access)/,
  },
};

/** Why `to` can't be used as a conversation link on this site, or null if it can. */
export function badChatLink(channel: WebChannel, to: string): string | null {
  const s = SITES[channel];
  return s.chat.test(to) ? null : `For ${s.label}, "to" is the conversation's link from what you read, like ${s.example}. Starting a new conversation isn't supported.`;
}

export function webSender(channel: WebChannel, cookies: (domain: string) => Cookie[], send = sendInPage) {
  const s = SITES[channel];
  return {
    connected: () => cookies(s.domain).length > 0,
    send: async (to: string, text: string) => {
      const bad = badChatLink(channel, to);
      if (bad) throw new Error(bad);
      await send(to.replace("twitter.com", "x.com"), text, { cookies: cookies(s.domain), composer: s.composer, sendButton: s.sendButton, signedOut: s.signedOut });
      return "";
    },
  };
}
