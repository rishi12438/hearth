import type { Source } from "./index.ts";

// New email matching a Gmail search. LinkedIn, X and most sites email you about activity, so
// "from:linkedin.com" covers LinkedIn messages and invites without logging into LinkedIn.

type Config = { query: string; account?: string };

export const gmail: Source<Config> = {
  id: "gmail",
  label: "Gmail",
  needs: "google",
  doc: `new email matching a Gmail search. config {"query":"from:school.org"} (Gmail search syntax: from:, subject:, is:important,
           label:, has:attachment, -category:promotions…; "from:linkedin.com" for LinkedIn activity). Minutes >= 5, default 15.
           Reads every connected Gmail account; add "account":"me@work.com" for just one.`,
  validate(c) {
    const query = typeof c?.query === "string" ? c.query.trim().slice(0, 300) : "";
    const account = typeof c?.account === "string" ? c.account.trim().slice(0, 200) : "";
    return query ? { query, ...(account ? { account } : {}) } : "Gmail needs a search, like from:school.org.";
  },
  minutes: () => ({ min: 5, default: 15 }),
  describe: (c) => `new email matching “${c.query}”${c.account ? ` in ${c.account}` : ""}`,
  async items(c, { google }) {
    // A short window keeps each check cheap; ids carry the "already seen" part.
    const mails = await google.searchMail(`(${c.query}) newer_than:2d`, 15, c.account);
    const several = google.accounts().length > 1;
    return mails.map((m) => ({
      id: m.id,
      title: `${m.from.replace(/\s*<[^>]+>$/, "") || m.from} — ${m.subject || "(no subject)"}`,
      at: m.date,
      url: `https://mail.google.com/mail/?authuser=${encodeURIComponent(m.account)}#all/${m.threadId}`,
      // The account matters for a reply: message.send's "from", with this threadId.
      text: `${several ? `Account: ${m.account}\n` : ""}From: ${m.from}\nSubject: ${m.subject}\nthreadId: ${m.threadId}\n\n${m.text || m.snippet}`,
    }));
  },
};
