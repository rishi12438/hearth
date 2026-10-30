// Tiny DOM helpers. Everything is built with createElement/textContent, never innerHTML,
// because a lot of what we render (assistant replies, script output) is untrusted text.

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, any> & { class?: string; on?: Record<string, (e: any) => void> };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "on") for (const [ev, fn] of Object.entries(v as Record<string, any>)) el.addEventListener(ev, fn);
      else if (k === "class") el.className = v;
      // CSSOM, not a style attribute: the CSP forbids inline style attributes.
      else if (k === "style") for (const decl of String(v).split(";")) { const i = decl.indexOf(":"); if (i > 0) el.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim()); }
      else if (k in el && k !== "list") (el as any)[k] = v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Element, ...children: Child[]) { el.replaceChildren(); append(el, children); return el; }

// Inline SVG icons (Lucide-style strokes), built as nodes.
const PATHS: Record<string, string[]> = {
  sun: ["M12 3v2", "M12 19v2", "M5.6 5.6l1.4 1.4", "M17 17l1.4 1.4", "M3 12h2", "M19 12h2", "M5.6 18.4L7 17", "M17 7l1.4-1.4", "M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8"],
  chat: ["M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"],
  bell: ["M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9", "M10.3 21a1.9 1.9 0 0 0 3.4 0"],
  brain: ["M12 5a3 3 0 0 0-5.8 1A3 3 0 0 0 4 11a3 3 0 0 0 2 5 3 3 0 0 0 6 1z", "M12 5a3 3 0 0 1 5.8 1A3 3 0 0 1 20 11a3 3 0 0 1-2 5 3 3 0 0 1-6 1"],
  user: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4 21a8 8 0 0 1 16 0"],
  send: ["M12 19V5", "M5 12l7-7 7 7"],
  plus: ["M12 5v14", "M5 12h14"],
  clock: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M12 7v5l3 2"],
  repeat: ["M17 2l4 4-4 4", "M3 11V9a3 3 0 0 1 3-3h15", "M7 22l-4-4 4-4", "M21 13v2a3 3 0 0 1-3 3H3"],
  eye: ["M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"],
  pin: ["M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z", "M12 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"],
  moon: ["M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"],
  code: ["M16 18l6-6-6-6", "M8 6l-6 6 6 6"],
  star: ["M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"],
  trash: ["M3 6h18", "M8 6V4h8v2", "M6 6l1 14h10l1-14"],
  more: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
  x: ["M18 6L6 18", "M6 6l12 12"],
  check: ["M20 6L9 17l-5-5"],
  search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "M21 21l-4.3-4.3"],
  server: ["M4 4h16v6H4z", "M4 14h16v6H4z", "M8 7h.01", "M8 17h.01"],
  lock: ["M5 11h14v10H5z", "M8 11V7a4 4 0 0 1 8 0v4"],
  download: ["M12 3v12", "M7 10l5 5 5-5", "M5 21h14"],
  play: ["M7 4l13 8-13 8z"],
  pause: ["M7 4h3v16H7z", "M14 4h3v16h-3z"],
  sparkle: ["M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z", "M19 17l.7 1.8 1.8.7-1.8.7L19 22l-.7-1.8-1.8-.7 1.8-.7z"],
  chevron: ["M9 6l6 6-6 6"],
  phone: ["M7 2h10v20H7z", "M11 18h2"],
  back: ["M15 18l-6-6 6-6"],
  clip: ["M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"],
  home: ["M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"],
  dms: ["M14 9a6 6 0 1 0-11 3.3L2 16l3.7-1A6 6 0 0 0 14 9z", "M10 15.6a6 6 0 0 0 8.3 2.4L22 19l-1-3.7A6 6 0 0 0 17 7"],
  filter: ["M4 7h16", "M7 12h10", "M10 17h4"],
  up: ["M6 15l6-6 6 6"],
  menu: ["M4 7h16", "M4 12h10", "M4 17h16"],
  mic: ["M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z", "M5 11a7 7 0 0 0 14 0", "M12 18v3"],
  users: ["M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M2 21a7 7 0 0 1 14 0", "M16 3.5a4 4 0 0 1 0 7", "M22 21a7 7 0 0 0-4-6.3"],
  settings: ["M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z", "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"],
};

export function icon(name: string, size = 20) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "icon");
  for (const d of PATHS[name] || []) {
    const p = document.createElementNS(ns, "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  }
  return svg;
}

/** A safe subset of markdown: paragraphs, bullet lists, **bold**, `code` and http(s) links. */
/**
 * Markdown to DOM, built with createElement only (never innerHTML), so nothing in a message or file can run.
 * Headings, paragraphs, lists (incl. [ ] / [x]), quotes, fenced code, tables, rules; **bold**, *italic*, `code`, links.
 */
export function richText(text: string) {
  const root = h("div", { class: "rich" });
  const lines = text.replace(/\r/g, "").split("\n");
  const isList = (l: string) => /^\s*([-*+•]|\d+[.)])\s+/.test(l);
  const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const special = (l: string) => /^(#{1,6}\s|```|>\s?|\s*([-*_])\s*\2\s*\2[\s\-*_]*$)/.test(l) || isList(l) || isRow(l);
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m: RegExpMatchArray | null;
    if ((m = l.match(/^(#{1,6})\s+(.*)$/))) {
      root.appendChild(h(`h${Math.min(6, m[1].length + 2)}` as "h3", null, inline(m[2].replace(/\s#+\s*$/, ""))));
      i++;
    } else if (l.startsWith("```")) {
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) code.push(lines[i]);
      i++;
      root.appendChild(h("pre", { class: "code" }, h("code", null, code.join("\n"))));
    } else if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(l)) {
      root.appendChild(h("hr")); i++;
    } else if (/^>\s?/.test(l)) {
      const q: string[] = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) q.push(lines[i].replace(/^>\s?/, ""));
      root.appendChild(h("blockquote", null, richText(q.join("\n"))));
    } else if (isRow(l) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const cells = (r: string) => r.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const head = cells(l);
      const body: string[][] = [];
      for (i += 2; i < lines.length && isRow(lines[i]); i++) body.push(cells(lines[i]));
      root.appendChild(h("div", { class: "tablewrap" }, h("table", null,
        h("thead", null, h("tr", null, head.map((c) => h("th", null, inline(c))))),
        h("tbody", null, body.map((r) => h("tr", null, head.map((_, k) => h("td", null, inline(r[k] || "")))))))));
    } else if (isList(l)) {
      const ordered = /^\s*\d/.test(l);
      const list = h(ordered ? "ol" : "ul");
      for (; i < lines.length && (isList(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && list.lastChild)); i++) {
        if (!isList(lines[i])) { append(list.lastChild!, [" ", ...inline(lines[i].trim())]); continue; }
        const item = lines[i].replace(/^\s*([-*+•]|\d+[.)])\s+/, "");
        const task = item.match(/^\[( |x|X)\]\s+(.*)$/);
        list.appendChild(task ? h("li", { class: "task" }, h("span", { class: `box ${task[1] === " " ? "" : "on"}` }), h("span", null, inline(task[2]))) : h("li", null, inline(item)));
      }
      root.appendChild(list);
    } else {
      const p = h("p");
      for (let first = true; i < lines.length && lines[i].trim() && !special(lines[i]); i++, first = false) {
        if (!first) p.appendChild(h("br"));
        append(p, inline(lines[i]));
      }
      root.appendChild(p);
    }
  }
  return root;
}

function inline(s: string): Child[] {
  const out: Child[] = [];
  const re = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|(?<![\w])_[^_\s][^_]*_(?![\w])|~~[^~]+~~|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s)<>]+)/g;
  let last = 0, m: RegExpExecArray | null;
  const link = (href: string, label: string) => h("a", { href, target: "_blank", rel: "noopener noreferrer" }, label);
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**") || t.startsWith("__")) out.push(h("strong", null, inline(t.slice(2, -2))));
    else if (t.startsWith("~~")) out.push(h("s", null, t.slice(2, -2)));
    else if (t.startsWith("*") || t.startsWith("_")) out.push(h("em", null, inline(t.slice(1, -1))));
    else if (t.startsWith("`")) out.push(h("code", null, t.slice(1, -1)));
    else if (t.startsWith("[")) { const mm = t.match(/^\[([^\]]+)\]\((.+)\)$/)!; out.push(link(mm[2], mm[1])); }
    else out.push(link(t, t.replace(/^https?:\/\//, "").slice(0, 60)));
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

// ---- formatting ----

export function relTime(iso: string, now = Date.now()) {
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (abs < 60_000) return diff > 0 ? "in a moment" : "just now";
  if (abs < 3.6e6) return fmt.format(Math.round(diff / 60_000), "minute");
  if (abs < 864e5) return fmt.format(Math.round(diff / 3.6e6), "hour");
  return fmt.format(Math.round(diff / 864e5), "day");
}

export function shortAgo(iso: string) {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

export function clockTime(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function dayLabel(iso: string) {
  const d = new Date(iso), today = new Date();
  const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === tomorrow.toDateString()) return "Tomorrow";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export function greeting(name?: string) {
  const hr = new Date().getHours();
  const part = hr < 5 ? "Still up" : hr < 12 ? "Good morning" : hr < 17 ? "Good afternoon" : "Good evening";
  return name ? `${part}, ${name}` : part;
}

export function toast(text: string, kind: "ok" | "err" = "ok") {
  const t = h("div", { class: `toast ${kind}`, role: "status" }, text);
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 2600);
}
