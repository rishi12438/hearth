// Codex through its app-server (`codex app-server`: JSON-RPC, one JSON message per line on stdio), the way Mako drives it,
// instead of `codex exec`. The app-server has real threads: `thread/start` makes one, and `thread/resume` with its id
// carries on with everything that thread already did, so a job's follow-ups resume it (see brains/sessions.ts).
//
// One run, one turn:
//   -> initialize {clientInfo}        <- result
//   -> initialized
//   -> thread/start {cwd, model, sandbox, approvalPolicy, config}  or  thread/resume {threadId, ...same}
//   <- result {thread: {id}}          (a resume of a thread it can't find falls back to thread/start)
//   -> turn/start {threadId, input: [{type: "text", text}]}
//   <- item/started, item/completed, error ...   <- turn/completed {turn: {status, error}}
// Nobody is there to approve anything (approvalPolicy "never"); an approval it asks for anyway is declined.
//
// Its notifications are turned into `codex exec --json` events ({type: "item.completed", item: {type: "agent_message"}}),
// so the brain reads progress, tool errors and the answer the same way it always has.

export type CodexAppOptions = {
  cwd: string;
  prompt: string;
  model?: string;
  /** The thread to carry on, from an earlier run in this job's thread. */
  resume?: string;
  /** Working calls search the web. */
  web: boolean;
  /** No thread kept on disk (a quick call that nothing follows up). */
  ephemeral: boolean;
};

type Rpc = { id?: number | string; method?: string; params?: any; result?: any; error?: { message?: string } };

const VERSION = "1";

export class CodexAppTurn {
  /** The thread this turn ran on: save it to resume next time. */
  threadId: string | null = null;
  /** True when it carried on the thread it was asked to resume. */
  resumed = false;
  /** Why the turn failed, if it did (Codex's own words). */
  failure: string | null = null;
  /** Resolves once the turn is over (completed, failed or interrupted) or couldn't start. */
  readonly done: Promise<void>;
  private finish!: () => void;
  private next = 1;
  private waiting = new Map<number, (m: Rpc) => void>();
  private over = false;

  constructor(private write: (line: string) => void, private o: CodexAppOptions) {
    this.done = new Promise((r) => (this.finish = r));
  }

  /** The first message. Call once the process is up. */
  start() {
    this.request("initialize", { clientInfo: { name: "hearth", title: "Hearth", version: VERSION } }, (m) => {
      if (m.error) return this.fail(`codex app-server didn't start: ${m.error.message || "initialize failed"}`);
      this.send({ jsonrpc: "2.0", method: "initialized" });
      this.open();
    });
  }

  /** One line from its stdout. Returns `codex exec --json` style event lines for the brain's reader. */
  line(raw: string): string[] {
    let m: Rpc;
    try { m = JSON.parse(raw); } catch { return []; }
    if (!m || typeof m !== "object") return [];
    // An answer to one of ours.
    if (m.id !== undefined && !m.method) {
      const cb = typeof m.id === "number" ? this.waiting.get(m.id) : undefined;
      if (cb) { this.waiting.delete(m.id as number); cb(m); }
      return [];
    }
    // It asks us something (an approval, a question for the user): nobody's there, so no.
    if (m.id !== undefined && m.method) { this.answerRequest(m); return []; }
    const p = m.params || {};
    switch (m.method) {
      case "item/started": case "item/completed": {
        const item = execItem(p.item);
        return item ? [JSON.stringify({ type: m.method === "item/started" ? "item.started" : "item.completed", item })] : [];
      }
      case "error":
        // It retries some errors itself (a dropped stream); only a final one counts.
        if (p.willRetry) return [];
        return [JSON.stringify({ type: "error", message: String(p.error?.message || "Codex reported an error") })];
      case "turn/completed": {
        const t = p.turn || {};
        if (t.status === "failed" || t.status === "interrupted") this.failure = String(t.error?.message || `the turn ${t.status === "failed" ? "failed" : "was interrupted"}`);
        this.end();
        return this.failure ? [JSON.stringify({ type: "turn.failed", error: { message: this.failure } })] : [];
      }
    }
    return [];
  }

  /** The process ended: whatever we were waiting for isn't coming. */
  closed(why = "codex app-server exited") {
    if (!this.over) this.fail(why);
  }

  private open() {
    const o = this.o;
    const tuning = {
      cwd: o.cwd,
      ...(o.model ? { model: o.model } : {}),
      // No sandbox, no approvals (like `codex exec --dangerously-bypass-approvals-and-sandbox`): nobody can approve.
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      config: o.web ? { web_search: "live" } : {},
    };
    const fresh = () => this.request("thread/start", { ...tuning, ...(o.ephemeral ? { ephemeral: true } : {}) }, (m) => this.opened(m, false));
    if (!o.resume) return fresh();
    // A thread it can't find (its files were cleared) starts over rather than failing the job.
    this.request("thread/resume", { threadId: o.resume, ...tuning }, (m) => (m.error || !m.result?.thread?.id ? fresh() : this.opened(m, true)));
  }

  private opened(m: Rpc, resumed: boolean) {
    const id = m.result?.thread?.id;
    if (m.error || typeof id !== "string") return this.fail(`Codex couldn't open a thread: ${m.error?.message || "no thread id"}`);
    this.threadId = id;
    this.resumed = resumed;
    this.request("turn/start", { threadId: id, input: [{ type: "text", text: this.o.prompt, text_elements: [] }] }, (r) => {
      if (r.error) this.fail(`Codex couldn't start the turn: ${r.error.message || "turn/start failed"}`);
    });
  }

  private answerRequest(m: Rpc) {
    const decline = /^item\/(commandExecution|fileChange)\/requestApproval$|^applyPatchApproval$|^execCommandApproval$/.test(String(m.method));
    if (decline) this.send({ jsonrpc: "2.0", id: m.id, result: { decision: m.method === "applyPatchApproval" || m.method === "execCommandApproval" ? "denied" : "decline" } });
    else this.send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Hearth runs unattended: nobody can answer this." } });
  }

  private request(method: string, params: unknown, cb: (m: Rpc) => void) {
    const id = this.next++;
    this.waiting.set(id, cb);
    this.send({ jsonrpc: "2.0", id, method, params });
  }
  private send(o: unknown) {
    if (this.over) return;
    try { this.write(JSON.stringify(o) + "\n"); } catch (e: any) { this.fail(`couldn't talk to codex app-server: ${String(e?.message || e)}`); }
  }
  private fail(why: string) {
    if (this.over) return;
    this.failure ??= why;
    this.end();
  }
  private end() {
    if (this.over) return;
    this.over = true;
    this.waiting.clear();
    this.finish();
  }
}

/** An app-server thread item as the `codex exec --json` item the brain already reads, or null for ones it doesn't show. */
export function execItem(it: any): Record<string, unknown> | null {
  if (!it || typeof it !== "object") return null;
  switch (it.type) {
    case "agentMessage": return { type: "agent_message", text: String(it.text || "") };
    case "reasoning": return { type: "reasoning", text: [...(it.summary || []), ...(it.content || [])].map(String).join("\n") };
    case "commandExecution": return { type: "command_execution", command: String(it.command || ""), status: it.status, exit_code: it.exitCode ?? null, aggregated_output: String(it.aggregatedOutput || "") };
    case "webSearch": return { type: "web_search", query: String(it.query || ""), action: it.action ?? null };
    case "mcpToolCall": return { type: "mcp_tool_call", server: String(it.server || ""), tool: String(it.tool || ""), arguments: it.arguments ?? {}, status: it.status };
    default: return null;
  }
}
