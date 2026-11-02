import QRCode from "qrcode";
import type { Config } from "../config.ts";
import { flag, has, io, onOff, positional, stdin } from "../cli-common.ts";

// `hearth connectors|connect|disconnect|whatsapp …`. Nothing prompts: flags and stdin in, --json out.
//   hearth connectors                          the grid: every connector and its state
//   hearth connect <id> [--key K | --token T | --stdin] [--accept-risk]
//   hearth connect instagram|linkedin --stdin --accept-risk     (cookies on stdin)
//   hearth connect whatsapp --accept-risk      shows a QR code to scan, waits until linked
//   hearth disconnect <id>
//   hearth whatsapp chats                      chats to pick from (ids for the ignore list)
//   hearth whatsapp ignore [list]
//   hearth whatsapp ignore add|remove contact|group|keyword <value>
//   hearth whatsapp ignore set [--all-groups on|off] [--archived on|off] [--muted on|off]

export async function connectCli(config: Config, argv: string[]): Promise<number | null> {
  const [cmd, ...args] = argv;
  if (!["connectors", "connect", "disconnect", "whatsapp"].includes(cmd)) return null;
  const { out, fail, hub, json } = io(config, args);
  const [sub, ...rest] = positional(args);

  if (cmd === "connectors") {
    const r = await hub("/api/connectors");
    if ("error" in r) return fail(r.error!, r.code);
    const mark: Record<string, string> = { connected: "✓", "needs-you": "!", off: "·", "not-installed": "×" };
    out(r.data, (r.data.connectors as any[]).map((t) => `  ${mark[t.state] ?? "?"} ${t.label.padEnd(12)} ${t.detail ?? t.blurb}${t.risk && !t.riskAccepted ? "  (unofficial: needs --accept-risk)" : ""}`).join("\n"));
    return 0;
  }

  if (cmd === "connect" || cmd === "disconnect") {
    const id = sub;
    if (!id) return fail(`usage: hearth ${cmd} <connector>   (see: hearth connectors)`, 2);
    if (cmd === "disconnect") {
      const r = await hub(`/api/connectors/${encodeURIComponent(id)}`, { method: "DELETE" });
      if ("error" in r) return fail(r.error!, r.code);
      out(r.data, `  ${r.data.label} disconnected.`);
      return 0;
    }
    const bodyIn: Record<string, unknown> = { acceptRisk: has(args, "--accept-risk") };
    const piped = has(args, "--stdin") ? await stdin() : undefined;
    if (id === "instagram" || id === "linkedin") bodyIn.cookies = piped;
    else if (flag(args, "--key") || flag(args, "--token") || piped) bodyIn[id === "slack" ? "token" : "key"] = flag(args, "--key") ?? flag(args, "--token") ?? piped;
    const r = await hub(`/api/connectors/${encodeURIComponent(id)}`, { method: "PUT", body: bodyIn });
    if ("error" in r) return fail(r.error!, r.code);
    if (id !== "whatsapp") { out(r.data, `  ✓ ${r.data.label} connected${r.data.detail ? ` (${r.data.detail})` : ""}.`); return 0; }
    // WhatsApp: show the QR code until the phone scans it (WhatsApp → Settings → Linked devices → Link a device).
    let shown = "";
    const until = Date.now() + 5 * 60_000;
    while (Date.now() < until) {
      const s = await hub("/api/whatsapp");
      if ("error" in s) return fail(s.error!, s.code);
      const st = s.data;
      if (st.state === "connected") { out({ state: "connected", me: st.me }, `  ✓ WhatsApp linked${st.me ? ` (+${st.me})` : ""}.`); return 0; }
      if (st.state === "signed-out" || st.state === "error") return fail(st.detail || "WhatsApp didn't link.");
      if (st.qr && st.qr !== shown) {
        shown = st.qr;
        if (json) console.log(JSON.stringify({ state: "qr", qr: st.qr }));
        else console.log(`\n  On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan:\n\n${await QRCode.toString(st.qr, { type: "terminal", small: true })}`);
      }
      await Bun.sleep(1500);
    }
    return fail("Nobody scanned the code in 5 minutes. Run it again.");
  }

  if (cmd === "whatsapp") {
    if (sub === "chats") {
      const r = await hub("/api/whatsapp");
      if ("error" in r) return fail(r.error!, r.code);
      out({ chats: r.data.chats }, (r.data.chats as any[]).map((c) => `  ${c.group ? "group  " : "contact"} ${c.name.padEnd(28)} ${c.jid}`).join("\n") || "  No chats yet (link WhatsApp first).");
      return 0;
    }
    if (sub === "ignore") {
      const [action, kind, ...value] = rest;
      let r;
      if (!action || action === "list") r = await hub("/api/whatsapp");
      else if (action === "add" || action === "remove") {
        if (!["contact", "group", "keyword"].includes(kind) || !value.length) return fail("usage: hearth whatsapp ignore add|remove contact|group|keyword <value>", 2);
        r = await hub("/api/whatsapp/ignore", { method: "POST", body: { kind, value: value.join(" "), remove: action === "remove" } });
      } else if (action === "set") {
        const patch: Record<string, boolean> = {};
        for (const [f, k] of [["--all-groups", "allGroups"], ["--archived", "archived"], ["--muted", "muted"]] as const) { const v = onOff(flag(args, f)); if (v !== undefined) patch[k] = v; }
        r = await hub("/api/whatsapp/ignore", { method: "PUT", body: patch });
      } else return fail("usage: hearth whatsapp ignore [list|add|remove|set]", 2);
      if ("error" in r) return fail(r.error!, r.code);
      const rules = r.data.rules;
      out({ rules }, [
        `  Contacts: ${rules.contacts.join(", ") || "none"}`, `  Groups:   ${rules.allGroups ? "ALL groups" : rules.groups.join(", ") || "none"}`,
        `  Keywords: ${rules.keywords.join(", ") || "none"}`, `  Archived chats: ${rules.archived ? "ignored" : "read"} · Muted chats: ${rules.muted ? "ignored" : "read"}`,
      ].join("\n"));
      return 0;
    }
    return fail("usage: hearth whatsapp chats | ignore …", 2);
  }
  return null;
}
