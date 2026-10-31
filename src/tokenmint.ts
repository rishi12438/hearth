import type { Subprocess } from "bun";

// "Use my Claude subscription" for shared links: the hub runs `claude setup-token` for you, hands the approval link to
// your phone, takes back the code Claude shows after you approve, and keeps the token it prints. The token is a long-lived
// one scoped to `user:inference` (talk to Claude, nothing else on your account), which is what sandboxes should hold.
// setup-token wants a terminal, so a few lines of Python give it one (python3 is on macOS and Ubuntu).

const PTY = `
import os, pty, sys, select, fcntl, termios, struct
env = dict(os.environ); env.pop("CLAUDECODE", None)
if os.environ.get("HEARTH_MINT_NO_BROWSER") == "1": env["BROWSER"] = "true"
pid, fd = pty.fork()
if pid == 0:
    os.execvpe("claude", ["claude", "setup-token"], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 1000, 0, 0))
while True:
    r, _, _ = select.select([fd, 0], [], [], 1)
    if fd in r:
        try: data = os.read(fd, 65536)
        except OSError: break
        if not data: break
        sys.stdout.buffer.write(data); sys.stdout.flush()
    if 0 in r:
        line = sys.stdin.buffer.readline()
        if not line: break
        os.write(fd, line.rstrip(b"\\n") + b"\\r")
`;

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g, "").replace(/\r/g, "");
export const TOKEN_RE = /sk-ant-oat01-[A-Za-z0-9_-]{20,}/;
const URL_RE = /https:\/\/claude\.(?:com|ai)\/[^\s"'<>]*oauth\/authorize\?[^\s"'<>]+/;
const TIMEOUT_MS = 10 * 60_000;

export class TokenMint {
  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private out = "";
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** browser: on a desktop, let `claude` open the sign-in page itself; approving there finishes without a code. */
  constructor(private cmd: string[] = ["python3", "-c", PTY], private opts: { browser?: boolean } = {}) {}

  get busy() { return !!this.proc; }

  /** Start: resolves with the link to open and approve. */
  async start(): Promise<{ url: string }> {
    this.cancel();
    this.out = "";
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("HEARTH_") && k !== "CLAUDECODE") env[k] = v;
    if (!this.opts.browser) env.HEARTH_MINT_NO_BROWSER = "1"; // on a server there's no browser to open
    try { this.proc = Bun.spawn(this.cmd, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env }); }
    catch { throw new Error("Couldn't start Claude Code on the hub. Is it installed (`claude --version`)?"); }
    this.timer = setTimeout(() => this.cancel(), TIMEOUT_MS);
    this.read();
    for (let i = 0; i < 60; i++) {
      const m = strip(this.out).match(URL_RE);
      if (m) return { url: m[0] };
      if (!this.proc || this.proc.exitCode !== null) break;
      await Bun.sleep(250);
    }
    const said = strip(this.out).split("\n").map((l) => l.trim()).filter(Boolean).slice(-2).join(" ");
    this.cancel();
    throw new Error(`Claude Code didn't give a sign-in link${said ? `: ${said.slice(0, 160)}` : "."}`);
  }

  private async read() {
    const p = this.proc;
    if (!p) return;
    const dec = new TextDecoder();
    for await (const chunk of p.stdout as unknown as AsyncIterable<Uint8Array>) { this.out += dec.decode(chunk, { stream: true }); if (this.out.length > 200_000) this.out = this.out.slice(-100_000); }
  }

  /** On a desktop: wait for the token after you approve in the browser tab claude opened (no code needed). */
  async waitForToken(timeoutMs = TIMEOUT_MS): Promise<string | null> {
    for (const t0 = Date.now(); Date.now() - t0 < timeoutMs; await Bun.sleep(500)) {
      const m = strip(this.out).match(TOKEN_RE);
      if (m) { this.cancel(); return m[0]; }
      if (!this.proc || this.proc.exitCode !== null) return null;
    }
    return null;
  }

  /** The code Claude showed after you approved. Resolves with the token. */
  async finish(code: string): Promise<string> {
    const c = code.trim();
    if (!this.proc) throw new Error("Start again: that sign-in timed out.");
    if (!/^[A-Za-z0-9_#.-]{8,500}$/.test(c)) throw new Error("That doesn't look like the code Claude showed you.");
    const before = this.out.length;
    this.proc.stdin.write(c + "\n");
    this.proc.stdin.flush();
    for (let i = 0; i < 120; i++) {
      const m = strip(this.out).match(TOKEN_RE);
      if (m) { this.cancel(); return m[0]; }
      if (this.proc?.exitCode !== null) break;
      await Bun.sleep(250);
    }
    const said = strip(this.out.slice(before)).split("\n").map((l) => l.trim()).filter(Boolean).slice(-2).join(" ");
    this.cancel();
    throw new Error(`Claude didn't accept that code${said ? `: ${said.slice(0, 160)}` : ""}. Start again.`);
  }

  cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try { this.proc?.kill(); } catch {}
    this.proc = null;
  }
}
