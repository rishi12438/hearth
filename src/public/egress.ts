#!/usr/bin/env bun
import { lookup } from "node:dns/promises";
import type { Socket } from "bun";

// The boxes' only door to the internet. Boxes sit on an internal Docker network with no route out; this proxy sits on
// that network and the normal one, and opens HTTPS tunnels (CONNECT) to the allowed hosts on port 443, nothing else.
// No plain HTTP, no IP literals, no private addresses: a box can't use it to reach the hub, localhost or cloud metadata.

const ALLOWED = new Set((process.env.EGRESS_ALLOW || "api.anthropic.com").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));

/** Public unicast only. */
export function publicAddress(ip: string) {
  if (ip.includes(":")) return !/^(::1?$|::ffff:|f[cd]|fe[89ab]|ff|64:ff9b|2001:db8|100::)/i.test(ip);
  const [a, b] = ip.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)));
}

/** Where a CONNECT line may go, or why not. */
export async function allowTarget(line: string): Promise<{ host: string; ip: string } | { error: string }> {
  const m = line.match(/^CONNECT ([A-Za-z0-9.-]{1,253}):(\d{1,5}) HTTP\/1\.[01]$/);
  if (!m) return { error: "only CONNECT host:443" };
  const host = m[1].toLowerCase();
  if (m[2] !== "443") return { error: "port not allowed" };
  if (!ALLOWED.has(host)) return { error: "host not allowed" };
  const addrs = await lookup(host, { all: true }).catch(() => []);
  const ok = addrs.find((a) => publicAddress(a.address));
  if (!ok || !addrs.every((a) => publicAddress(a.address))) return { error: "host resolves to a private address" };
  return { host, ip: ok.address };
}

/** Writes everything, queueing what the socket can't take yet until it drains. */
class Pipe {
  private queue: Uint8Array[] = [];
  constructor(readonly sock: Socket<any>) {}
  write(buf: Uint8Array) {
    if (this.queue.length) { this.queue.push(buf); return; }
    const n = this.sock.write(buf);
    if (n < buf.length) this.queue.push(buf.subarray(Math.max(0, n)));
  }
  drain() {
    while (this.queue.length) {
      const buf = this.queue[0];
      const n = this.sock.write(buf);
      if (n < buf.length) { this.queue[0] = buf.subarray(Math.max(0, n)); return; }
      this.queue.shift();
    }
  }
}

type State = { head: string; toBox: Pipe; upstream: Pipe | null; connecting: boolean };

export function startEgress(port = Number(process.env.EGRESS_PORT || 3128), hostname = process.env.EGRESS_HOST || "0.0.0.0") {
  return Bun.listen<State>({
    hostname, port,
    socket: {
      open(s) { s.data = { head: "", toBox: new Pipe(s), upstream: null, connecting: false }; s.timeout(30); },
      drain(s) { s.data.toBox.drain(); },
      async data(s, chunk) {
        const st = s.data;
        if (st.upstream) { st.upstream.write(chunk); return; }
        if (st.connecting || st.head.length > 8192) { s.end(); return; } // nothing may arrive before the tunnel is up
        st.head += new TextDecoder().decode(chunk);
        const end = st.head.indexOf("\r\n\r\n");
        if (end < 0) return;
        if (end + 4 !== st.head.length) { s.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
        st.connecting = true;
        const target = await allowTarget(st.head.split("\r\n")[0]);
        if ("error" in target) { s.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\n${target.error}\n`); return; }
        try {
          const up = await Bun.connect<null>({
            hostname: target.ip, port: 443,
            socket: {
              data(_u, d) { st.toBox.write(d); },
              drain() { st.upstream?.drain(); },
              close() { s.end(); },
              error() { s.end(); },
            },
          });
          st.upstream = new Pipe(up);
        } catch { s.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"); return; }
        s.timeout(300);
        st.toBox.write(new TextEncoder().encode("HTTP/1.1 200 Connection Established\r\n\r\n"));
      },
      close(s) { s.data?.upstream?.sock.end(); },
      error(s) { s.data?.upstream?.sock.end(); },
      timeout(s) { s.end(); },
    },
  });
}

if (import.meta.main) {
  const l = startEgress();
  console.log(`egress proxy on ${l.hostname}:${l.port}, allowing ${[...ALLOWED].join(", ")}`);
}
