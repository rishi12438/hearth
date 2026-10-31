// Line diffs for the edit log: counts for the summary and a unified diff for the preview. Myers' algorithm.

type Op = { t: " " | "+" | "-"; line: string };

const lines = (s: string | null) => (s == null || s === "" ? [] : s.replace(/\n$/, "").split("\n"));

export function diffLines(before: string | null, after: string | null): Op[] {
  const a = lines(before), b = lines(after);
  const n = a.length, m = b.length, max = n + m;
  if (max > 40_000) return [...a.map((line) => ({ t: "-" as const, line })), ...b.map((line) => ({ t: "+" as const, line }))];
  const v = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0)) ? v.get(k + 1) ?? 0 : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v.set(k, x);
      if (x >= n && y >= m) break outer;
    }
  }
  const ops: Op[] = [];
  let x = n, y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d], k = x - y;
    const prevK = k === -d || (k !== d && (vd.get(k - 1) ?? 0) < (vd.get(k + 1) ?? 0)) ? k + 1 : k - 1;
    const px = vd.get(prevK) ?? 0, py = px - prevK;
    while (x > px && y > py) { ops.push({ t: " ", line: a[x - 1] }); x--; y--; }
    if (d > 0) { if (x === px) ops.push({ t: "+", line: b[--y] }); else ops.push({ t: "-", line: a[--x] }); }
  }
  return ops.reverse();
}

export function countChanges(before: string | null, after: string | null) {
  let added = 0, removed = 0;
  for (const o of diffLines(before, after)) { if (o.t === "+") added++; else if (o.t === "-") removed++; }
  return { added, removed };
}

/** A unified diff with 3 lines of context, for showing a change on the phone. */
export function unifiedDiff(path: string, before: string | null, after: string | null, context = 3) {
  const ops = diffLines(before, after);
  const out = [`--- ${before == null ? "/dev/null" : `a/${path}`}`, `+++ ${after == null ? "/dev/null" : `b/${path}`}`];
  const changed = ops.map((o) => o.t !== " ");
  let i = 0;
  while (i < ops.length) {
    if (!changed[i]) { i++; continue; }
    const start = Math.max(0, i - context);
    let end = i;
    while (end < ops.length) {
      if (changed[end]) { end++; continue; }
      let gap = end;
      while (gap < ops.length && !changed[gap]) gap++;
      if (gap - end > context * 2 || gap === ops.length) { end = Math.min(ops.length, end + context); break; }
      end = gap;
    }
    let aLine = 1, bLine = 1;
    for (let j = 0; j < start; j++) { if (ops[j].t !== "+") aLine++; if (ops[j].t !== "-") bLine++; }
    const hunk = ops.slice(start, end);
    const aLen = hunk.filter((o) => o.t !== "+").length, bLen = hunk.filter((o) => o.t !== "-").length;
    out.push(`@@ -${aLen ? aLine : aLine - 1},${aLen} +${bLen ? bLine : bLine - 1},${bLen} @@`);
    for (const o of hunk) out.push(o.t + o.line);
    i = end;
  }
  return out.join("\n");
}
