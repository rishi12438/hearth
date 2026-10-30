// Pulls the last ```hearth block out of a brain reply. Returns the visible text and the proposed actions.
export function parseReply(raw: string): { text: string; actions: any[] } {
  // App code comes in its own block (```app <name>), so nobody has to escape HTML inside JSON.
  const apps = new Map<string, string>();
  const text = String(raw || "").replace(/```app[ \t]+([a-z0-9-]{1,40})[ \t]*\n([\s\S]*?)\n```/g, (_, name: string, code: string) => { apps.set(name, code); return ""; });
  const re = /```hearth\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null, last: RegExpExecArray | null = null;
  while ((match = re.exec(text))) last = match;
  if (!last) return { text: text.trim(), actions: [] };
  let actions: any[] = [];
  try {
    const parsed = JSON.parse(last[1]);
    actions = Array.isArray(parsed) ? parsed : [parsed];
  } catch {}
  for (const a of actions) if (a && a.type === "app.save" && typeof a.html !== "string" && apps.has(String(a.name))) a.html = apps.get(String(a.name));
  return { text: text.replace(re, "").trim(), actions };
}
