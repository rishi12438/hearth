import type { Item, Source } from "../sources/index.ts";
import type { WhatsApp } from "./whatsapp.ts";

// WhatsApp as a trigger source: messages that got past the ignore list (WhatsApp pushes them to the hub; this just
// hands the newest to the trigger loop).

export function whatsappSource(wa: WhatsApp): Source<{ chat?: string }> {
  return {
    id: "whatsapp", label: "WhatsApp", needs: "whatsapp",
    doc: `WhatsApp messages on the user's linked number (chats on their ignore list never arrive). config {} or {"chat":"<chat id>"}. Minutes >= 1, default 5.`,
    validate: (c: any) => ({ chat: typeof c?.chat === "string" ? c.chat.slice(0, 80) : undefined }),
    minutes: () => ({ min: 1, default: 5 }),
    describe: (c) => (c.chat ? "new WhatsApp messages in one chat" : "new WhatsApp messages"),
    items: async (c): Promise<Item[]> => (await wa.recent(30, c.chat)).filter((m) => !m.fromMe)
      .map((m) => ({ id: m.id, title: `${m.chat}${m.group ? " (group)" : ""} · ${m.jid}`, text: m.text, at: m.at })),
  };
}
