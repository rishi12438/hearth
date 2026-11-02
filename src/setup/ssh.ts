import { homedir } from "node:os";

// Talking to your server over SSH: run a command (stdin passed through and never logged), and pack Hearth's files to
// send. BatchMode, so it never stops to ask for a password: it works with your key or fails with a clear reason.

export type SshTarget = { host: string; user: string; key?: string; port?: number };

/** The hearth CLI on the server, as the hub's own user. */
export const APP = "/opt/hearth";
export const remoteHearth = (args: string) => `sudo -iu hearth bash -lc 'cd ${APP} && ~/.bun/bin/bun src/cli.ts ${args}'`;
export const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function sshArgs(o: SshTarget) {
  return ["ssh", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4",
    ...(o.key ? ["-i", o.key.replace(/^~(?=\/)/, homedir())] : []), ...(o.port ? ["-p", String(o.port)] : []), `${o.user}@${o.host}`];
}

/** Run a command on the server. stdin is passed through (never logged); output lines go to `line`. */
export async function ssh(o: SshTarget, cmd: string, opts: { stdin?: string | Uint8Array; line?: (l: string) => void } = {}) {
  const proc = Bun.spawn([...sshArgs(o), cmd], { stdin: opts.stdin !== undefined ? new Blob([opts.stdin as BlobPart]) : "ignore", stdout: "pipe", stderr: "pipe" });
  let out = "";
  const pump = async (s: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of s as unknown as AsyncIterable<Uint8Array>) {
      const t = dec.decode(chunk, { stream: true });
      out += t; buf += t;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) { opts.line?.(buf.slice(0, i).replace(/\x1b\[[0-9;]*m/g, "")); buf = buf.slice(i + 1); }
    }
    if (buf) opts.line?.(buf);
  };
  await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
  return { code: await proc.exited, out };
}


/** Hearth's own files as a .tar.gz (no node_modules, data or .env). */
export async function tarball(src: string): Promise<Uint8Array> {
  const p = Bun.spawn(["tar", "czf", "-", "--exclude", "./node_modules", "--exclude", "./data", "--exclude", "./.env", "--exclude", "./.git", "--exclude", "./mac/build", "."],
    { cwd: src, stdout: "pipe", stderr: "pipe", env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const buf = new Uint8Array(await new Response(p.stdout).arrayBuffer());
  if ((await p.exited) !== 0) throw new Error(`Couldn't pack Hearth's files: ${await new Response(p.stderr).text()}`);
  return buf;
}
