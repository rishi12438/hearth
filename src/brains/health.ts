// Is each brain (Claude Code, Codex) actually signed in, not just holding a login file? A file can be there and still be
// turned away: a token caught wrong, revoked, or a Codex login another copy rotated. Every real call tells us: a sign-in
// error marks the brain signed out, any good answer marks it fine. The hub shows that on Home and in Connectors with a
// Reconnect, tells you once, and sends work to another brain meanwhile.

export type BrainHealthState = { harness: string; ok: boolean; message: string | null; at: number };

/** The brain's own words for "you're not signed in" (Claude Code, Codex), or null if this isn't a sign-in problem. */
export function signInProblem(text: string): string | null {
  const t = String(text || "");
  const hit = [
    /OAuth (?:access )?token (?:is )?(?:invalid|expired|has been revoked)/i,
    /Failed to authenticate/i,
    /Invalid API key/i,
    /Please run \/login/i,
    /\bnot logged in\b/i,
    /authentication_error/i,
    /\b401\b[^\n]{0,40}(?:Unauthorized|token|auth)/i,
    /refresh[_ ]token[^\n]{0,60}(?:expired|invalid|revoked|reused|already been used)/i,
    /token_expired|invalid_grant/i,
    /Your access token could not be refreshed/i,
  ].find((r) => r.test(t));
  if (!hit) return null;
  const line = t.split("\n").find((l) => hit.test(l)) || t;
  return line.replace(/\s+/g, " ").trim().slice(0, 200);
}

export class BrainHealth {
  private states = new Map<string, BrainHealthState>();
  /** Called when a brain goes from fine to signed out, or back. */
  onChange: (s: BrainHealthState) => void = () => {};
  constructor(private clock: () => number = Date.now) {}

  signedOut(harness: string, message: string) {
    const was = this.states.get(harness);
    const s = { harness, ok: false, message, at: this.clock() };
    this.states.set(harness, s);
    if (!was || was.ok) this.onChange(s);
  }

  fine(harness: string) {
    const was = this.states.get(harness);
    const s = { harness, ok: true, message: null, at: this.clock() };
    this.states.set(harness, s);
    if (was && !was.ok) this.onChange(s);
  }

  /** The sign-in problem with this brain right now, or null. */
  problem(harness: string): string | null {
    const s = this.states.get(harness);
    return s && !s.ok ? s.message : null;
  }

  view(): BrainHealthState[] { return [...this.states.values()]; }
}
