import { existsSync } from "node:fs";
import { connect } from "node:net";
import { lookup, Resolver } from "node:dns/promises";
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
  /** Steps the person chose to skip while setup waits on them (the setup window's "Skip for now"). */
  skip?: Set<string>;
  /** A Claude setup-token you already have, instead of making one now. */
  claudeToken?: string;
};

// The server setup runs on its own on the server (setsid + nohup), with its output in a log this side follows. So a
// dropped connection, a sleeping Mac or a closed app no longer kills it halfway; the next try just follows it again.
const RUN = "/var/lib/hearth-setup";
const RUNNING = `sudo test -f ${RUN}/pid && sudo kill -0 "$(sudo cat ${RUN}/pid)" 2>/dev/null`;
export function detached(cmd: string, run = RUN) {
  const running = `sudo test -f ${run}/pid && sudo kill -0 "$(sudo cat ${run}/pid)" 2>/dev/null`;
  const inner = quote(`echo $$ > ${run}/pid; ${cmd} > ${run}/log 2>&1; echo $? > ${run}/rc`);
  return [
    `sudo mkdir -p ${run}`,
    `if ${running}; then echo "(following the setup already running on the server)"; else sudo rm -f ${run}/rc ${run}/pid; sudo touch ${run}/log; sudo truncate -s 0 ${run}/log; sudo setsid nohup bash -c ${inner} >/dev/null 2>&1 < /dev/null & for i in $(seq 100); do sudo test -s ${run}/pid && break; sleep 0.1; done; fi`,
    `sudo tail -n +1 --pid="$(sudo cat ${run}/pid)" -f ${run}/log`,
    `exit "$(sudo cat ${run}/rc 2>/dev/null || echo 1)"`,
  ].join("; ");
}

/** A new one-time code for the hub's main device, or null if it already has one (then you sign in from that device). */
export async function freshPairLink(o: { host: string; user: string; key?: string }): Promise<string | null> {
  const r = await ssh(o, `sudo -iu hearth bash -lc 'cd ${APP} && ~/.bun/bin/bun src/cli.ts setup'`);
  return pairLink(r.out);
}

/** Can this Mac open a TCP connection to host:port within a few seconds? */
export function portOpen(host: string, port: number, ms = 5000): Promise<boolean> {
  return new Promise((done) => {
    const sock = connect({ host, port });
    const end = (ok: boolean) => { sock.destroy(); done(ok); };
    sock.setTimeout(ms, () => end(false));
    sock.once("connect", () => end(true)).once("error", () => end(false));
  });
}

/** People paste a URL ("https://assistant.example.com/"): keep just the host name. */
export const cleanDomain = (d = "") => d.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[\/?#:]/)[0].replace(/\.$/, "");
/** Same for the server: "ubuntu@1.2.3.4" or "1.2.3.4:22" → 1.2.3.4. */
export const cleanHost = (h = "") => h.trim().replace(/^[a-z]+:\/\//i, "").replace(/^[^@]*@/, "").replace(/\/.*$/, "").replace(/:\d+$/, "");

export function validRemote(o: Partial<RemoteOpts>): string | null {
  o = { ...o, domain: cleanDomain(o.domain), host: cleanHost(o.host) };
  if (!o.host || !/^[A-Za-z0-9.:-]{1,253}$/.test(o.host)) return "Give the server's IP address or host name.";
  if (!o.user || !/^[a-z_][a-z0-9_-]{0,31}$/i.test(o.user)) return "Give the SSH user (on Lightsail it's ubuntu).";
  if (!o.domain || !/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(o.domain)) return "Give the domain for the hub, like assistant.example.com.";
  if (o.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email)) return "That email doesn't look right (or leave it empty).";
  if (o.key && !existsSync(expandHome(o.key))) return `No SSH key at ${o.key}.`;
  if (!o.brains?.length || !(o.brains as string[]).every(isBrainId)) return "Pick at least one brain (claude, codex).";
  return null;
}


// Suffixes where the registered domain has three parts (example.co.uk), so the Host field is what's left of those.
const TWO_PART_TLDS = new Set(["co.uk", "org.uk", "ac.uk", "com.au", "net.au", "org.au", "co.in", "net.in", "org.in", "co.nz", "com.br", "co.jp", "com.sg", "com.mx", "co.za"]);

/** What goes in a registrar's Host field: "@" for the bare domain, "assistant" for assistant.example.com. */
export function dnsHost(domain: string): string {
  const parts = domain.toLowerCase().replace(/\.$/, "").split(".");
  const base = TWO_PART_TLDS.has(parts.slice(-2).join(".")) ? 3 : 2;
  return parts.length <= base ? "@" : parts.slice(0, parts.length - base).join(".");
}

/**
 * The domain's IPv4 addresses, from this Mac and from public DNS. macOS caches a "no such domain" answer for a while,
 * so a record added after the first check can stay invisible here even though the rest of the internet sees it.
 */
export async function resolveA(domain: string): Promise<string[]> {
  const pub = new Resolver({ timeout: 3000, tries: 2 });
  pub.setServers(["1.1.1.1", "8.8.8.8"]);
  const [mine, theirs] = await Promise.all([
    lookup(domain, { all: true, family: 4 }).then((a) => a.map((x) => x.address)).catch((): string[] => []),
    pub.resolve4(domain).catch((): string[] => []),
  ]);
  return [...new Set([...mine, ...theirs])];
}

export async function installRemote(o: RemoteOpts, emit: Emit): Promise<{ url: string; pair: string | null }> {
  o = { ...o, domain: cleanDomain(o.domain), host: cleanHost(o.host) };
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
  const ips = await resolveA(o.domain);
  const ipHost = /^\d+\.\d+\.\d+\.\d+$/.test(o.host);
  if (ipHost && !ips.includes(o.host) && !o.skipDns) {
    const record = { type: "A", host: dnsHost(o.domain), value: o.host, ttl: "Automatic" };
    const t = ips.length
      ? `${o.domain} points at ${ips.join(", ")}, not this server (${o.host}). At your domain registrar, change its A record to: Type ${record.type}, Host ${record.host}, Value ${record.value}.`
      : `${o.domain} doesn't point at this server yet. At your domain registrar, add a record: Type ${record.type}, Host ${record.host}, Value ${record.value}.`;
    emit({ step: "dns", state: "fail", text: t, data: { want: o.host, got: ips, record } });
    throw new Error(t);
  }
  if (ipHost && !ips.includes(o.host)) emit({ step: "dns", state: "warn", text: `${o.domain} doesn't point at ${o.host} yet. Carrying on: HTTPS starts working by itself once it does.` });
  else emit({ step: "dns", state: ips.length ? "ok" : "warn", text: ips.length ? `${o.domain} → ${ips.join(", ")}` : "Couldn't look the domain up from here; the server will check again." });

  // A setup from an earlier try may still be running on the server (the Mac slept, or the app was closed): follow it
  // rather than pulling its files out from under it.
  const already = (await ssh(o, `${RUNNING} && echo RUNNING`)).out.includes("RUNNING");
  if (already) emit({ step: "upload", state: "ok", text: "The server is still setting up from your last try; picking it back up" });
  else {
    emit({ step: "upload", state: "start", text: "Sending Hearth to the server" });
    const tar = await tarball(srcDir(o.src));
    const up = await ssh(o, "rm -rf /tmp/hearth-src && mkdir -p /tmp/hearth-src && tar xzf - -C /tmp/hearth-src && echo UP_OK", { stdin: tar });
    if (!up.out.includes("UP_OK")) { const t = `Upload failed: ${up.out.trim().slice(-300)}`; emit({ step: "upload", state: "fail", text: t }); throw new Error(t); }
    emit({ step: "upload", state: "ok", text: `Sent (${Math.round(tar.length / 1024)} KB)` });
  }

  emit({ step: "server", state: "start", text: "Setting up the server: HTTPS, firewall, the hub and your brains (a few minutes)" });
  const flags = [quote(o.domain), quote(o.email || ""), `--brains=${o.brains.join(",")}`, "--no-pair", ...(o.skipDns ? ["--skip-dns-check"] : [])].join(" ");
  const setup = await ssh(o, detached(`bash /tmp/hearth-src/deploy/setup-lightsail.sh ${flags}`), { line: (l) => l.trim() && emit({ step: "server", state: "log", text: l }) });
  if (setup.code !== 0) { const t = `The server setup stopped: ${setup.out.trim().split("\n").slice(-3).join(" ").slice(0, 400)}`; emit({ step: "server", state: "fail", text: t }); throw new Error(t); }
  emit({ step: "server", state: "ok", text: `Hub is running on the server` });

  // Cloud consoles have their own firewall in front of the box (Lightsail opens only 22 and 80 by default), so HTTPS
  // can be up on the server and still unreachable. Check from here, the way your phone will connect.
  emit({ step: "reach", state: "start", text: `Checking ${o.domain} is reachable over HTTPS` });
  if (!(await portOpen(o.host, 443))) {
    // Wait here and walk them through opening it; carry on by itself the moment it opens.
    const guide = {
      title: "Open the HTTPS port",
      why: "Your hub is running, but your cloud's firewall blocks port 443 (HTTPS), so your phone and this Mac can't reach it. Lightsail only opens SSH and HTTP by default.",
      steps: ["In the AWS Lightsail console, click your instance.", "Go to the Networking tab.", "Under IPv4 firewall, click Add rule.", "Pick Application: HTTPS (TCP 443), then Create."],
      other: "Not on Lightsail? Allow inbound TCP 443 in your server's security group or firewall.",
    };
    emit({ step: "reach", state: "wait", text: "Waiting for port 443 (HTTPS) to open. Setup carries on by itself once it does.", data: { guide } });
    const end = Date.now() + 30 * 60_000;
    let open = false;
    while (!open && Date.now() < end && !o.skip?.has("reach")) { await Bun.sleep(4000); open = await portOpen(o.host, 443); }
    if (!open) emit({ step: "reach", state: "warn", text: `Skipped: ${url} won't open until port 443 is allowed (Lightsail → your instance → Networking → IPv4 firewall → Add rule → HTTPS).` });
  }
  if (await portOpen(o.host, 443)) emit({ step: "reach", state: "ok", text: `${url} is reachable` });

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

  emit({ step: "pair", state: "start", text: "Getting this Mac ready to pair" });
  const pair = await ssh(o, `sudo -iu hearth bash -lc 'cd ${APP} && ~/.bun/bin/bun src/cli.ts setup'`);
  const link = pairLink(pair.out);
  emit(link ? { step: "pair", state: "ok", text: "Ready: this Mac pairs as your main device", data: { link } }
    : { step: "pair", state: "warn", text: /already set up/.test(pair.out) ? "This hub already has a primary phone." : pair.out.trim().slice(-200) });
  emit({ step: "done", state: "done", text: `Hearth is ready at ${url}`, data: { url, pair: link } });
  return { url, pair: link };
}
