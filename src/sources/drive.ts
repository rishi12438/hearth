import type { Source } from "./index.ts";

// Google Drive: files you added or changed that match some words (or any file, with no words). A file edited again
// counts again, so its id includes when it changed. source.read on it doubles as "find my file and read it".

type Config = { search: string; days: number; account?: string };

export const drive: Source<Config> = {
  id: "drive",
  label: "Google Drive",
  needs: "google",
  doc: `Google Drive files, newest change first, with the text of the top few (Docs, Sheets as CSV, text files).
           config {"search":"lease"} (words in the name or contents; "" for any file), "days":7 (changed in the last N days,
           default 2 for a trigger, use more for source.read), "account":"me@work.com" for one account. Minutes >= 15.`,
  validate(c) {
    const search = typeof c?.search === "string" ? c.search.trim().slice(0, 200) : "";
    const days = Math.round(Number(c?.days ?? 2));
    if (!(days >= 1 && days <= 3650)) return "days must be between 1 and 3650.";
    const account = typeof c?.account === "string" ? c.account.trim().slice(0, 200) : "";
    return { search, days, ...(account ? { account } : {}) };
  },
  minutes: () => ({ min: 15, default: 30 }),
  describe: (c) => `${c.search ? `a Drive file matching “${c.search}”` : "a Drive file"} added or changed${c.account ? ` in ${c.account}` : ""}`,
  async items(c, { google }) {
    const files = await google.files(c.search, 15, c.account, c.days);
    const several = google.accounts().length > 1;
    // Text only for the first few: each is another request.
    const texts = await Promise.all(files.map((f, i) => (i < 5 ? google.fileText(f, 1500).catch(() => "") : Promise.resolve(""))));
    return files.map((f, i) => ({
      id: `${f.id}@${f.modified}`,
      title: f.name,
      at: f.modified,
      url: f.link,
      text: [several && `Account: ${f.account}`, `Type: ${f.mimeType.replace("application/vnd.google-apps.", "Google ")}`, f.owner && `Owner: ${f.owner}`,
        texts[i]].filter(Boolean).join("\n"),
    }));
  },
};
