// A stand-in brain for tests: a real separate process per call, like claude/codex.
// Plans come from FAKE_PLAN; job calls sleep FAKE_MS and log start/end to FAKE_LOG so tests can measure concurrency.
import { appendFileSync } from "node:fs";
const prompt = await new Response(Bun.stdin.stream()).text();
if (prompt.startsWith("You are the orchestrator")) { console.log(process.env.FAKE_PLAN); process.exit(0); }
const task = prompt.match(/JOB:\n([^\n]*)/)?.[1] ?? "?";
const log = process.env.FAKE_LOG;
if (log) appendFileSync(log, `start ${Date.now()} ${task}\n`);
await Bun.sleep(Number(process.env.FAKE_MS || 300));
if (log) appendFileSync(log, `end ${Date.now()} ${task}\n`);
if (task.includes("FAIL")) process.exit(1);
const sawDep = prompt.includes("Results from earlier jobs") && prompt.includes("done: find a restaurant");
console.log(`done: ${task}${sawDep ? " (used earlier result)" : ""}`);
