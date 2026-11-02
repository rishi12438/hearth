import { existsSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { BRAIN_LABELS, isBrainId, mintClaudeToken, readCodexAuth, type BrainId } from "../brains/logins.ts";
import { pairLink, srcDir, type Emit } from "./steps.ts";
import { APP, quote, remoteHearth, ssh, tarball } from "./ssh.ts";
import { expandHome, tightenKey } from "./keys.ts";

// A hub on your own server (domain + IP + SSH key): ship Hearth over SSH, run deploy/setup-lightsail.sh there (HTTPS,
// firewall, the hub as a service, the brains you picked), then copy long-lived logins up the same SSH line the way
// Enkidu signs in its cloud agents (a `claude setup-token` made on this Mac, and Codex's auth.json), pick the brains,
// and hand back the phone's pairing link.

export type RemoteOpts = {
  host: string; user: string; key?: string; port?: number;
  domain: string; /** Optional: Let's Encrypt only uses it for expiry notices. */ email?: string; brains: BrainId[];
  skipDns?: boolean;
  /** Where Hearth's own files are (the repo, or the copy inside the Mac app). */
  src?: string;
  /** A Claude setup-token you already have, instead of making one now. */
  claudeToken?: string;
};

export function validRemote(o: Partial<RemoteOpts>): string | null {
  if (!o.host || !/^[A-Za-z0-9.:-]{1,253}$/.test(o.host)) return "Give the server's IP address or host name.";
  if (!o.user || !/^[a-z_][a-z0-9_-]{0,31}$/i.test(o.user)) return "Give the SSH user (on Lightsail it's ubuntu).";
  if (!o.domain || !/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(o.domain)) return "Give the domain for the hub, like assistant.example.com.";
  if (o.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email)) return "That email doesn't look right (or leave it empty).";
  if (o.key && !existsSync(expandHome(o.key))) return `No SSH key at ${o.key}.`;
  if (!o.brains?.length || !(o.brains as string[]).every(isBrainId)) return "Pick at least one brain (claude, codex).";
  return null;
}


export async function installRemote(o: RemoteOpts, emit: Emit): Promise<{ url: string; pair: string | null }> {
  const bad = validRemote(o);
  if (bad) { emit({ step: "check", state: "fail", text: bad }); throw new Error(bad); }
  const url = `https://${o.domain}`;

  emit({ step: "ssh", state: "start", text: `Connecting to ${o.user}@${o.host}` });
  if (o.key && tightenKey(o.key)) emit({ step: "ssh", state: "log", text: `Made ${o.key} readable only by you (ssh refuses keys others can read)` });
  const hello = await ssh(o, "uname -sm && (lsb_release -ds 2>/dev/null || true) && sudo -n true && echo SUDO_OK");
  if (hello.code !== 0) { const t = `Couldn't log in over SSH: ${hello.out.trim().split("\n").at(-1) || "no answer"}. Check the IP, user and key.`; emit({ step: "ssh", state: "fail", text: t }); throw new Error(t); }
  if (!hello.out.includes("SUDO_OK")) { const t = `${o.user} can't use sudo without a password on that server.`; emit({ step: "ssh", state: "fail", text: t }); throw new Error(t); }
  if (!/Linux/.test(hello.out)) { const t = "That server isn't Linux. Hearth's server setup is for Ubuntu."; emit({ step: "ssh", state: "fail", text: t }); throw new Error(t); }
  emit({ step: "ssh", state: "ok", text: `Logged in (${hello.out.split("\n")[1] || hello.out.split("\n")[0]})` });

  emit({ step: "dns", state: "start", text: `Checking ${o.domain} points at ${o.host}` });
  const ips = await lookup(o.domain, { all: true, family: 4 }).then((a) => a.map((x) => x.address)).catch((): string[] => []);
  const ipHost = /^\d+\.\d+\.\d+\.\d+$/.test(o.host);
  if (ipHost && !ips.includes(o.host) && !o.skipDns) {
    const t = `${o.domain} points at ${ips.join(", ") || "nothing yet"}, not ${o.host}. Add an A record ${o.domain} → ${o.host} at your domain registrar, wait a few minutes, and try again.`;
    emit({ step: "dns", state: "fail", text: t, data: { want: o.host, got: ips } });
    throw new Error(t);
  }
  emit({ step: "dns", state: ips.length ? "ok" : "warn", text: ips.length ? `${o.domain} → ${ips.join(", ")}` : "Couldn't look the domain up from here; the server will check again." });

  emit({ step: "upload", state: "start", text: "Sending Hearth to the server" });
  const tar = await tarball(srcDir(o.src));
  const up = await ssh(o, "rm -rf /tmp/hearth-src && mkdir -p /tmp/hearth-src && tar xzf - -C /tmp/hearth-src && echo UP_OK", { stdin: tar });
  if (!up.out.includes("UP_OK")) { const t = `Upload failed: ${up.out.trim().slice(-300)}`; emit({ step: "upload", state: "fail", text: t }); throw new Error(t); }
  emit({ step: "upload", state: "ok", text: `Sent (${Math.round(tar.length / 1024)} KB)` });

  emit({ step: "server", state: "start", text: "Setting up the server: HTTPS, firewall, the hub and your brains (a few minutes)" });
  const flags = [quote(o.domain), quote(o.email || ""), `--brains=${o.brains.join(",")}`, "--no-pair", ...(o.skipDns ? ["--skip-dns-check"] : [])].join(" ");
  const setup = await ssh(o, `sudo bash /tmp/hearth-src/deploy/setup-lightsail.sh ${flags}`, { line: (l) => l.trim() && emit({ step: "server", state: "log", text: l }) });
  if (setup.code !== 0) { const t = `The server setup stopped: ${setup.out.trim().split("\n").slice(-3).join(" ").slice(0, 400)}`; emit({ step: "server", state: "fail", text: t }); throw new Error(t); }
  emit({ step: "server", state: "ok", text: `Hub is running at ${url}` });

  for (const b of o.brains) {
    emit({ step: `login-${b}`, state: "start", text: `Signing ${BRAIN_LABELS[b]} in on the hub` });
    let secret: string | null = null;
    if (b === "claude") {
      secret = o.claudeToken?.trim() || null;
      if (!secret) {
        emit({ step: "login-claude", state: "log", text: "Approve in the browser that opens: this makes a long-lived Claude login for your hub." });
        secret = await mintClaudeToken((t) => { for (const l of t.split(/\r?\n/)) if (l.trim()) emit({ step: "login-claude", state: "log", text: l.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").trim() }); }, { stdin: "ignore" })
          .catch((e) => { emit({ step: "login-claude", state: "warn", text: e.message }); return null; });
      }
    } else secret = readCodexAuth();
    if (!secret) {
      emit({ step: `login-${b}`, state: "warn", text: b === "claude" ? "No Claude token. Run `claude setup-token`, then paste it in Settings → Connectors → Claude Code." : "No Codex login on this Mac (run `codex login` here first), so the hub's Codex isn't signed in yet." });
      continue;
    }
    const r = await ssh(o, remoteHearth(`brains login ${b} --stdin --json`), { stdin: secret });
    emit(r.code === 0 ? { step: `login-${b}`, state: "ok", text: `${BRAIN_LABELS[b]} signed in on the hub` } : { step: `login-${b}`, state: "warn", text: `Couldn't sign ${BRAIN_LABELS[b]} in: ${r.out.trim().slice(-200)}` });
  }

  emit({ step: "brains", state: "start", text: `Picking brains: ${o.brains.map((b) => BRAIN_LABELS[b]).join(", ")}` });
  const pick = await ssh(o, remoteHearth(`brains pick ${o.brains.join(",")} --json`));
  emit(pick.code === 0 ? { step: "brains", state: "ok", text: o.brains.length > 1 ? "Each job goes to the brain with the most room on its plan" : "Brain set" }
    : { step: "brains", state: "warn", text: `Couldn't pick brains yet: ${pick.out.trim().slice(-200)}` });

  emit({ step: "pair", state: "start", text: "Making the code for your phone" });
  const pair = await ssh(o, `sudo -iu hearth bash -lc 'cd ${APP} && ~/.bun/bin/bun src/cli.ts setup'`);
  const link = pairLink(pair.out);
  emit(link ? { step: "pair", state: "ok", text: "Scan this with your phone's camera. That phone becomes the primary device.", data: { link } }
    : { step: "pair", state: "warn", text: /already set up/.test(pair.out) ? "This hub already has a primary phone." : pair.out.trim().slice(-200) });
  emit({ step: "done", state: "done", text: `Hearth is ready at ${url}`, data: { url, pair: link } });
  return { url, pair: link };
}
