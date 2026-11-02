import QRCode from "qrcode";
import type { Config } from "../config.ts";
import { isBrainId, type BrainId } from "../brains/logins.ts";
import type { Step } from "./steps.ts";
import { installLocal } from "./local.ts";
import { installRemote } from "./remote.ts";
import { wizard } from "./wizard.ts";

// `hearth install` and `hearth wizard`.
//
//   hearth install local  --brains claude,codex [--lan] [--port 8790] [--no-service] [--json]
//   hearth install remote --brains claude,codex --host 1.2.3.4 --user ubuntu --key ~/.ssh/id_ed25519
//                         --domain assistant.example.com --email you@example.com [--skip-dns-check] [--claude-token-stdin] [--json]
//   hearth wizard [--port 0]     the setup window (the Mac app opens this): brains → where → progress → phone
//
// --json prints one JSON line per step, so an agent can follow along and know exactly what failed.

const flag = (a: string[], f: string) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
const brainsOf = (v?: string): BrainId[] => (v || "").split(",").map((s) => s.trim()).filter(isBrainId);

function printer(json: boolean) {
  const icon: Record<Step["state"], string> = { start: "→", ok: "✓", warn: "!", fail: "✗", log: " ", done: "★" };
  return (s: Step) => {
    if (json) { console.log(JSON.stringify(s)); return; }
    console.log(s.state === "log" ? `      ${s.text}` : `  ${icon[s.state]} ${s.text}`);
  };
}

export async function setupCli(config: Config, argv: string[]): Promise<number | null> {
  const [cmd, where, ...rest] = argv;
  if (cmd === "wizard") return wizard(argv.slice(1));
  if (cmd !== "install") return null;
  const a = [where, ...rest];
  const json = a.includes("--json");
  const emit = printer(json);
  const showPair = async (link: string | null) => { if (link && !json) console.log(`\n  Pair your primary phone: scan this, or open ${link}\n${await QRCode.toString(link, { type: "terminal", small: true })}`); };
  const brains = brainsOf(flag(a, "--brains"));
  try {
    if (where === "local") {
      const r = await installLocal({ brains, lan: a.includes("--lan"), port: Number(flag(a, "--port")) || undefined, service: !a.includes("--no-service"), dataDir: flag(a, "--data") }, emit);
      await showPair(r.pair);
      return 0;
    }
    if (where === "remote") {
      const claudeToken = a.includes("--claude-token-stdin") ? (await new Response(Bun.stdin.stream()).text()).trim() : undefined;
      const r = await installRemote({
        brains, host: flag(a, "--host") || "", user: flag(a, "--user") || "ubuntu", key: flag(a, "--key"), port: Number(flag(a, "--ssh-port")) || undefined,
        domain: flag(a, "--domain") || "", email: flag(a, "--email") || "", skipDns: a.includes("--skip-dns-check"), claudeToken,
      }, emit);
      await showPair(r.pair);
      return 0;
    }
  } catch { return 1; }
  console.log(`usage:
  hearth install local  --brains claude,codex [--lan] [--port 8790] [--data <dir>] [--no-service] [--json]
  hearth install remote --brains claude,codex --host <ip> --user ubuntu --key <ssh key> --domain <domain> --email <email>
                        [--skip-dns-check] [--claude-token-stdin] [--json]`);
  return 2;
}

