// When the hub's machine runs out of memory, the kernel kills the process with the highest score. On Linux every agent
// run and background task starts with a raised score, so the kernel kills one of them, never the hub. The hub's unit
// lowers the hub's own score (deploy/hearth.service: OOMScoreAdjust) and keeps it running when a child is killed
// (OOMPolicy=continue). Raising your own score needs no privilege. The command execs in place, so its pid stays the same.
export const CHILD_OOM_SCORE = 500;

export function expendable(cmd: string[], platform: string = process.platform): string[] {
  if (platform !== "linux") return cmd;
  return ["sh", "-c", `{ echo ${CHILD_OOM_SCORE} > /proc/self/oom_score_adj; } 2>/dev/null; exec "$@"`, "sh", ...cmd];
}
