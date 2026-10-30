// Pulls the last ```hearth block out of a brain reply. Returns the visible text and the proposed actions.
export function parseReply(raw: string): { text: string; actions: any[] } {
  const text = String(raw || "");
  const re = /```hearth\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null, last: RegExpExecArray | null = null;
  while ((match = re.exec(text))) last = match;
  if (!last) return { text: text.trim(), actions: [] };
  let actions: any[] = [];
  try {
    const parsed = JSON.parse(last[1]);
    actions = Array.isArray(parsed) ? parsed : [parsed];
  } catch {}
  return { text: text.replace(re, "").trim(), actions };
}
