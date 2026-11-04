// Trigger formulas: a tiny, safe expression language checked against an event's variables.
//
//   from == "Mom" && text contains "call"
//   source == "webhook" && payload.type == "payment_failed"
//   hour >= 9 && hour < 18 && weekday in ["Mon", "Tue"]
//   price(text) < 500 || lower(subject) matches "deadline|due"
//
// It is parsed into a tree once and evaluated with plain code: no eval, no side effects, no clock, no network.
// The same event and the same formula always give the same answer, so a rule can be dry-run on past events.
//
// Values: "strings" or 'strings', numbers, true, false, null, [lists], and variable paths (a.b.c).
// Operators: == != < <= > >=   contains  startsWith  endsWith  in  matches   && and   || or   ! not   ( )
// Functions: lower(x) upper(x) trim(x) len(x) num(x) price(x) exists(x)
// "contains", "startsWith", "endsWith" and "matches" ignore case; == compares exactly (use lower() to loosen it).
// A variable that isn't there is null: `from == "Mom"` on an event without `from` is simply false.

export type Node =
  | { t: "lit"; v: unknown }
  | { t: "var"; path: string[] }
  | { t: "list"; items: Node[] }
  | { t: "call"; fn: string; args: Node[] }
  | { t: "not"; x: Node }
  | { t: "and" | "or"; a: Node; b: Node }
  | { t: "cmp"; op: string; a: Node; b: Node };

const MAX_LEN = 2000;
const MAX_DEPTH = 40;
const MAX_TEXT = 50_000;
const WORD_OPS = new Set(["contains", "startsWith", "endsWith", "in", "matches"]);
const FUNCS: Record<string, (args: unknown[]) => unknown> = {
  lower: ([x]) => (x == null ? null : String(x).toLowerCase()),
  upper: ([x]) => (x == null ? null : String(x).toUpperCase()),
  trim: ([x]) => (x == null ? null : String(x).trim()),
  len: ([x]) => (Array.isArray(x) ? x.length : x == null ? 0 : typeof x === "object" ? Object.keys(x).length : String(x).length),
  num: ([x]) => toNum(x),
  /** The first money-looking number in some text: "$1,299.00" -> 1299. */
  price: ([x]) => {
    const m = String(x ?? "").match(/(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?/);
    return m ? Number(m[1].replace(/,/g, "") + (m[2] || "")) : null;
  },
  exists: ([x]) => x !== null && x !== undefined && x !== "",
};
export const FUNCTION_NAMES = Object.keys(FUNCS);

type Tok = { k: "str" | "num" | "id" | "op"; v: string; at: number };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1, s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) { j++; s += src[j] === "n" ? "\n" : src[j]; } else s += src[j];
        j++;
      }
      if (j >= src.length) throw new FormulaError(`A quote at ${i + 1} is never closed.`);
      out.push({ k: "str", v: s, at: i }); i = j + 1; continue;
    }
    if (/\d/.test(c) || (c === "-" && /\d/.test(src[i + 1] || "") && !/^(str|num|id)$/.test(out.at(-1)?.k || "") && out.at(-1)?.v !== ")" && out.at(-1)?.v !== "]")) {
      const m = src.slice(i).match(/^-?\d+(\.\d+)?/)!;
      out.push({ k: "num", v: m[0], at: i }); i += m[0].length; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = src.slice(i).match(/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*|\.\d+)*/)!;
      out.push({ k: "id", v: m[0], at: i }); i += m[0].length; continue;
    }
    const two = src.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) { out.push({ k: "op", v: two, at: i }); i += 2; continue; }
    if ("<>!()[],".includes(c)) { out.push({ k: "op", v: c, at: i }); i++; continue; }
    if (c === "=") throw new FormulaError(`Use == to compare (at ${i + 1}).`);
    throw new FormulaError(`Unexpected "${c}" at ${i + 1}.`);
  }
  return out;
}

export class FormulaError extends Error {}

/** Parse a formula into a tree, or throw a FormulaError that says what's wrong in plain words. */
export function parse(src: string): Node {
  if (typeof src !== "string" || !src.trim()) throw new FormulaError("The formula is empty.");
  if (src.length > MAX_LEN) throw new FormulaError(`The formula is too long (over ${MAX_LEN} characters).`);
  const toks = tokenize(src);
  let p = 0, depth = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.k === "op" && peek().v === v;
  const isWord = (v: string) => peek()?.k === "id" && peek().v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new FormulaError(`Expected "${v}"${peek() ? ` at ${peek().at + 1}` : " at the end"}.`);
    p++;
  };
  const deeper = () => { if (++depth > MAX_DEPTH) throw new FormulaError("The formula nests too deeply."); };

  function or(): Node {
    let a = and();
    while (isOp("||") || isWord("or")) { p++; a = { t: "or", a, b: and() }; }
    return a;
  }
  function and(): Node {
    let a = not();
    while (isOp("&&") || isWord("and")) { p++; a = { t: "and", a, b: not() }; }
    return a;
  }
  function not(): Node {
    if (isOp("!") || isWord("not")) { p++; deeper(); const x = not(); depth--; return { t: "not", x }; }
    return cmp();
  }
  function cmp(): Node {
    const a = value();
    const tk = peek();
    if (tk && ((tk.k === "op" && ["==", "!=", "<", "<=", ">", ">="].includes(tk.v)) || (tk.k === "id" && WORD_OPS.has(tk.v)))) {
      p++;
      return { t: "cmp", op: tk.v, a, b: value() };
    }
    // "not in": a not in [..]
    if (tk?.k === "id" && tk.v === "not" && toks[p + 1]?.k === "id" && toks[p + 1].v === "in") {
      p += 2;
      return { t: "not", x: { t: "cmp", op: "in", a, b: value() } };
    }
    return a;
  }
  function value(): Node {
    const tk = peek();
    if (!tk) throw new FormulaError("The formula ends too early.");
    if (tk.k === "str") { p++; return { t: "lit", v: tk.v }; }
    if (tk.k === "num") { p++; return { t: "lit", v: Number(tk.v) }; }
    if (tk.k === "op" && tk.v === "(") { p++; deeper(); const x = or(); depth--; expect(")"); return x; }
    if (tk.k === "op" && tk.v === "[") {
      p++;
      const items: Node[] = [];
      while (!isOp("]")) {
        items.push(value());
        if (!isOp("]")) expect(",");
        if (items.length > 200) throw new FormulaError("A list can hold at most 200 items.");
      }
      p++;
      return { t: "list", items };
    }
    if (tk.k === "id") {
      p++;
      if (tk.v === "true" || tk.v === "false") return { t: "lit", v: tk.v === "true" };
      if (tk.v === "null") return { t: "lit", v: null };
      if (WORD_OPS.has(tk.v) || ["and", "or", "not"].includes(tk.v)) throw new FormulaError(`"${tk.v}" needs something before it (at ${tk.at + 1}).`);
      if (isOp("(")) {
        if (!(tk.v in FUNCS)) throw new FormulaError(`There's no function called ${tk.v}. Use one of: ${FUNCTION_NAMES.join(", ")}.`);
        p++;
        const args: Node[] = [];
        while (!isOp(")")) { args.push(or()); if (!isOp(")")) expect(","); }
        p++;
        return { t: "call", fn: tk.v, args };
      }
      return { t: "var", path: tk.v.split(".") };
    }
    throw new FormulaError(`Unexpected "${tk.v}" at ${tk.at + 1}.`);
  }

  const tree = or();
  if (p < toks.length) throw new FormulaError(`Unexpected "${toks[p].v}" at ${toks[p].at + 1}.`);
  return tree;
}

function toNum(x: unknown): number | null {
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x === "boolean") return x ? 1 : 0;
  if (typeof x === "string" && x.trim() && Number.isFinite(Number(x))) return Number(x);
  return null;
}

const text = (x: unknown) => (x == null ? "" : typeof x === "object" ? JSON.stringify(x) : String(x)).slice(0, MAX_TEXT);

function get(vars: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = vars;
  for (const k of path) {
    if (cur == null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, k)) return null;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur === undefined ? null : cur;
}

function equal(a: unknown, b: unknown) {
  if (a == null || b == null) return a == null && b == null;
  const na = toNum(a), nb = toNum(b);
  if (typeof a === "number" || typeof b === "number") return na !== null && na === nb;
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

function compare(op: string, a: unknown, b: unknown): boolean {
  switch (op) {
    case "==": return equal(a, b);
    case "!=": return !equal(a, b);
    case "<": case "<=": case ">": case ">=": {
      const na = toNum(a), nb = toNum(b);
      if (na !== null && nb !== null) return op === "<" ? na < nb : op === "<=" ? na <= nb : op === ">" ? na > nb : na >= nb;
      if (typeof a === "string" && typeof b === "string") return op === "<" ? a < b : op === "<=" ? a <= b : op === ">" ? a > b : a >= b; // ISO dates, "08:00"
      return false;
    }
    case "contains":
      if (Array.isArray(a)) return a.some((x) => equal(x, b) || (typeof x === "string" && typeof b === "string" && x.toLowerCase() === b.toLowerCase()));
      return a != null && b != null && text(a).toLowerCase().includes(text(b).toLowerCase());
    case "startsWith": return a != null && b != null && text(a).toLowerCase().startsWith(text(b).toLowerCase());
    case "endsWith": return a != null && b != null && text(a).toLowerCase().endsWith(text(b).toLowerCase());
    case "in":
      if (Array.isArray(b)) return b.some((x) => equal(a, x));
      return a != null && b != null && text(b).toLowerCase().includes(text(a).toLowerCase());
    case "matches": {
      if (a == null || b == null) return false;
      const re = regex(String(b));
      return re ? re.test(text(a)) : false;
    }
  }
  return false;
}

const regexCache = new Map<string, RegExp | null>();
function regex(src: string): RegExp | null {
  if (regexCache.has(src)) return regexCache.get(src)!;
  let re: RegExp | null = null;
  // Short patterns only, and no nested repeats like (a+)+ that can take forever.
  if (src.length <= 200 && !/\([^)]*[+*][^)]*\)[+*{]/.test(src)) { try { re = new RegExp(src, "i"); } catch {} }
  if (regexCache.size > 500) regexCache.clear();
  regexCache.set(src, re);
  return re;
}

function truthy(x: unknown) {
  return !(x === null || x === undefined || x === false || x === 0 || x === "" || (Array.isArray(x) && !x.length));
}

function evalNode(n: Node, vars: Record<string, unknown>): unknown {
  switch (n.t) {
    case "lit": return n.v;
    case "var": return get(vars, n.path);
    case "list": return n.items.map((i) => evalNode(i, vars));
    case "call": return FUNCS[n.fn](n.args.map((a) => evalNode(a, vars)));
    case "not": return !truthy(evalNode(n.x, vars));
    case "and": return truthy(evalNode(n.a, vars)) && truthy(evalNode(n.b, vars));
    case "or": return truthy(evalNode(n.a, vars)) || truthy(evalNode(n.b, vars));
    case "cmp": return compare(n.op, evalNode(n.a, vars), evalNode(n.b, vars));
  }
}

/** Does this formula hold for these variables? Always true or false; never throws on odd data. */
export function test(tree: Node, vars: Record<string, unknown>): boolean {
  try { return truthy(evalNode(tree, vars)); } catch { return false; }
}

/** Parse and test in one go; a bad formula is false (with the reason). */
export function check(src: string, vars: Record<string, unknown>): { ok: boolean; error?: string } {
  try { return { ok: test(parse(src), vars) }; } catch (e: any) { return { ok: false, error: e.message }; }
}

/** Every variable path a formula reads ("from", "payload.type"), to check them against what a source sends. */
export function variablesOf(tree: Node): string[] {
  const out = new Set<string>();
  const walk = (n: Node) => {
    if (n.t === "var") out.add(n.path.join("."));
    else if (n.t === "list") n.items.forEach(walk);
    else if (n.t === "call") n.args.forEach(walk);
    else if (n.t === "not") walk(n.x);
    else if (n.t === "and" || n.t === "or" || n.t === "cmp") { walk(n.a); walk(n.b); }
  };
  walk(tree);
  return [...out];
}

/** The formula written one standard way, so two rules that say the same thing are seen as the same. */
export function normalize(tree: Node): string {
  switch (tree.t) {
    case "lit": return JSON.stringify(tree.v);
    case "var": return tree.path.join(".");
    case "list": return `[${tree.items.map(normalize).join(",")}]`;
    case "call": return `${tree.fn}(${tree.args.map(normalize).join(",")})`;
    case "not": return `!(${normalize(tree.x)})`;
    case "and": case "or": {
      // a && b == b && a
      const parts: string[] = [];
      const flat = (n: Node) => { if (n.t === tree.t) { flat((n as any).a); flat((n as any).b); } else parts.push(normalize(n)); };
      flat(tree);
      return `${tree.t}(${parts.sort().join(",")})`;
    }
    case "cmp": {
      const a = normalize(tree.a), b = normalize(tree.b);
      return (tree.op === "==" || tree.op === "!=") && a > b ? `${b} ${tree.op} ${a}` : `${a} ${tree.op} ${b}`;
    }
  }
}
