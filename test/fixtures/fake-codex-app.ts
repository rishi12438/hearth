// A stand-in `codex app-server` for tests: JSON-RPC over stdio, like the real one (see src/brains/codex-app.ts).
// argv[2] is a scenario file: { events?: [{method, params}], answer?: string, fail?: string, log?: string, state?: string }
//   events  notifications sent during the turn, before the answer
//   answer  the agentMessage that ends the turn
//   fail    end the turn as failed with this message instead
//   log     every request it gets is appended here, one JSON per line
//   state   threads it knows (so thread/resume finds them across runs, like the real one's files)
//   hang    the turn never ends by itself; turn/interrupt ends it as interrupted (like Esc in Codex)
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const sc = JSON.parse(readFileSync(process.argv[2], "utf8"));
const known = (): string[] => (sc.state && existsSync(sc.state) ? JSON.parse(readFileSync(sc.state, "utf8")) : []);
const send = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
let buf = "";
for await (const chunk of Bun.stdin.stream() as unknown as AsyncIterable<Uint8Array>) {
  buf += new TextDecoder().decode(chunk);
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (sc.log) appendFileSync(sc.log, JSON.stringify(m) + "\n");
    if (m.id === undefined) continue;
    if (m.method === "initialize") send({ id: m.id, result: { userAgent: "fake/0" } });
    else if (m.method === "thread/start") {
      const id = `thr-${Math.random().toString(36).slice(2, 10)}`;
      if (sc.state && !m.params?.ephemeral) writeFileSync(sc.state, JSON.stringify([...known(), id]));
      send({ id: m.id, result: { thread: { id } } });
    } else if (m.method === "thread/resume") {
      if (known().includes(m.params?.threadId)) send({ id: m.id, result: { thread: { id: m.params.threadId } } });
      else send({ id: m.id, error: { code: -32600, message: `no rollout found for thread id ${m.params?.threadId}` } });
    } else if (m.method === "turn/start") {
      send({ id: m.id, result: { turn: { id: "t1", status: "inProgress", items: [] } } });
      for (const e of sc.events || []) send(e);
      if (sc.hang) continue;
      if (sc.fail) send({ method: "turn/completed", params: { threadId: m.params.threadId, turn: { id: "t1", status: "failed", items: [], error: { message: sc.fail } } } });
      else {
        send({ method: "item/completed", params: { item: { type: "agentMessage", id: "a1", text: sc.answer ?? "" } } });
        send({ method: "turn/completed", params: { threadId: m.params.threadId, turn: { id: "t1", status: "completed", items: [] } } });
      }
    } else if (m.method === "turn/interrupt") {
      send({ id: m.id, result: {} });
      send({ method: "turn/completed", params: { threadId: m.params.threadId, turn: { id: m.params.turnId, status: "interrupted", items: [] } } });
    } else send({ id: m.id, error: { code: -32601, message: "unknown method" } });
  }
}
