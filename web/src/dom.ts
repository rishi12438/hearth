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
      else if (k === "style") el.setAttribute("style", v);
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
export function richText(text: string) {
  const root = h("div", { class: "rich" });
  const blocks = text.replace(/\r/g, "").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");
    if (lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l))) {
      const ul = h("ul");
      for (const l of lines) ul.appendChild(h("li", null, inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ""))));
      root.appendChild(ul);
    } else {
      const p = h("p");
      lines.forEach((l, i) => { if (i) p.appendChild(h("br")); append(p, inline(l)); });
      root.appendChild(p);
    }
  }
  return root;
}

function inline(s: string): Child[] {
  const out: Child[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/[^\s)<>]+)/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(h("strong", null, t.slice(2, -2)));
    else if (t.startsWith("`")) out.push(h("code", null, t.slice(1, -1)));
    else out.push(h("a", { href: t, target: "_blank", rel: "noopener noreferrer" }, t.replace(/^https?:\/\//, "").slice(0, 60)));
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
