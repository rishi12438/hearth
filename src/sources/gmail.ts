import type { Source } from "./index.ts";

// New email matching a Gmail search. LinkedIn, X and most sites email you about activity, so
// "from:linkedin.com" covers LinkedIn messages and invites without logging into LinkedIn.

type Config = { query: string };

export const gmail: Source<Config> = {
  id: "gmail",
  label: "Gmail",
  needs: "google",
  doc: `new email matching a Gmail search. config {"query":"from:school.org"} (Gmail search syntax: from:, subject:, is:important,
           label:, has:attachment, -category:promotions…; "from:linkedin.com" for LinkedIn activity). Minutes >= 5, default 15.`,
  validate(c) {
    const query = typeof c?.query === "string" ? c.query.trim().slice(0, 300) : "";
    return query ? { query } : "Gmail needs a search, like from:school.org.";
  },
  minutes: () => ({ min: 5, default: 15 }),
  describe: (c) => `new email matching “${c.query}”`,
  async items(c, { google }) {
    // A short window keeps each check cheap; ids carry the "already seen" part.
    const mails = await google.searchMail(`(${c.query}) newer_than:2d`, 15);
    return mails.map((m) => ({
      id: m.id,
      title: `${m.from.replace(/\s*<[^>]+>$/, "") || m.from} — ${m.subject || "(no subject)"}`,
      at: m.date,
      url: `https://mail.google.com/mail/u/0/#all/${m.threadId}`,
      text: `From: ${m.from}\nSubject: ${m.subject}\n\n${m.text || m.snippet}`,
    }));
  },
};
