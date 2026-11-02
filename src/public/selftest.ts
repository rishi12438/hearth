#!/usr/bin/env bun
import { existsSync, writeFileSync } from "node:fs";
import { connect } from "node:net";

// Run inside a box (same flags as a real one) to check the seal: deploy/box-selftest.sh does it for you.
// Every check must say "ok". Exits non-zero if any fails.

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`${ok ? "ok  " : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); if (!ok) failed++; };

const tcp = (host: string, port: number, ms = 3000) => new Promise<boolean>((res) => {
  const s = connect({ host, port });
  const done = (v: boolean) => { s.destroy(); res(v); };
  s.setTimeout(ms, () => done(false)); s.on("connect", () => done(true)); s.on("error", () => done(false));
});

async function viaProxy(host: string) {
  const proxy = process.env.BOX_PROXY;
  if (!proxy) return "no proxy";
  const u = new URL(proxy);
  return await new Promise<string>((res) => {
    const s = connect({ host: u.hostname, port: Number(u.port) });
    s.setTimeout(8000, () => { s.destroy(); res("timeout"); });
    s.on("connect", () => s.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));
    s.on("data", (d) => { s.destroy(); res(d.toString().split("\r\n")[0]); });
    s.on("error", (e) => res(`error ${e.message}`));
  });
}

check("no hub settings in the environment", !Object.keys(process.env).some((k) => k.startsWith("HEARTH_")));
check("not root", process.getuid?.() !== 0, `uid ${process.getuid?.()}`);
check("hub folder not visible", !existsSync("/opt/hearth") && !existsSync("/home/hearth"));
check("host docker socket not visible", !existsSync("/var/run/docker.sock") && !existsSync("/run/docker.sock"));
let bundleRo = false;
try { writeFileSync("/bundle/x", "x"); } catch { bundleRo = true; }
check("bundle is read-only", bundleRo);
let rootRo = false;
try { writeFileSync("/app/x", "x"); } catch { rootRo = true; }
check("image filesystem is read-only", rootRo);
check("no route to cloud metadata (169.254.169.254:80)", !(await tcp("169.254.169.254", 80)));
check("no route to the open web (1.1.1.1:443)", !(await tcp("1.1.1.1", 443)));
check("no route to the host (172.17.0.1:22)", !(await tcp("172.17.0.1", 22)));
check("no route to the host's hub port (172.17.0.1:8790)", !(await tcp("172.17.0.1", 8790)));
const resolves = await (await import("node:dns/promises")).lookup("example.com").then(() => true, () => false);
check("no DNS for the outside world", !resolves);
const good = await viaProxy("api.anthropic.com");
check("proxy reaches api.anthropic.com", good.includes(" 200 "), good);
const bad = await viaProxy("example.com");
check("proxy refuses other hosts", bad.includes(" 403 "), bad);
const meta = await viaProxy("169.254.169.254");
check("proxy refuses the metadata address", !meta.includes(" 200 "), meta);
process.exit(failed ? 1 : 0);
