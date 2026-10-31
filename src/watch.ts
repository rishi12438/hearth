import { lookup } from "node:dns/promises";
import { sha256 } from "./auth.ts";
import pkg from "../package.json" with { type: "json" };

// Watch hooks: the hub reads a web page now and then and speaks only when its text changes, like changedetection.io
// but built in. For pages that only render in a browser, run changedetection.io and point it at a webhook hook.

const MAX_PAGE = 2_000_000;
const MAX_TEXT = 20_000;

/** A public address only: not localhost, not a private, link-local or reserved network (checked after DNS too). */
export function publicIp(ip: string) {
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return false;
  if (/^(::1?|f[cd]|fe[89ab]|::ffff:(127|10|192\.168|169\.254)\.)/i.test(ip)) return false;
  return true;
}

/** GET a public page, following up to 3 redirects by hand and checking every hop's address. */
export async function fetchPublic(raw: string, accept: string, timeoutMs = 15_000): Promise<Response | null> {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.username || u.password || raw.length > 2000) return null;
  for (let hop = 0; hop < 4; hop++) {
    if (!/^https?:$/.test(u.protocol)) return null;
    const addrs = await lookup(u.hostname, { all: true });
    if (!addrs.length || !addrs.every((a) => publicIp(a.address))) return null;
    const res = await fetch(u, { redirect: "manual", headers: { "User-Agent": `Hearth/${pkg.version} (self-hosted personal assistant)`, Accept: accept }, signal: AbortSignal.timeout(timeoutMs) });
    const next = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!next) return res;
    u = new URL(next, u);
  }
  return null;
}

/** The readable text of a page: scripts, styles and tags gone, one line per block. JSON is kept as it is. */
export function pageText(body: string, type: string) {
  if (/json|text\/plain/.test(type)) return body.slice(0, MAX_TEXT);
  return body
    .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/?(p|div|li|tr|h[1-6]|br|section|article|header|footer|td|th|ul|ol|table)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n")
    .slice(0, MAX_TEXT);
}

/** Lines that appeared and lines that went away (by line, ignoring order), capped for a prompt. */
export function lineDiff(before: string, after: string) {
  const a = new Set(before.split("\n")), b = new Set(after.split("\n"));
  const added = [...b].filter((l) => !a.has(l)), removed = [...a].filter((l) => !b.has(l));
  const show = (xs: string[], sign: string) => xs.slice(0, 40).map((l) => `${sign} ${l.slice(0, 300)}`).join("\n") + (xs.length > 40 ? `\n${sign} …and ${xs.length - 40} more` : "");
  return { added: added.length, removed: removed.length, text: [added.length ? show(added, "+") : "", removed.length ? show(removed, "-") : ""].filter(Boolean).join("\n") };
}

export type Look = { hash: string; text: string; at: string };

/** Reads the page once. Returns what it says now, or an error to log. */
export async function look(url: string, now = new Date()): Promise<{ value?: Look; error?: string }> {
  try {
    const res = await fetchPublic(url, "text/html,application/json,text/plain;q=0.9,*/*;q=0.5");
    if (!res) return { error: "that address isn't a public web page" };
    if (!res.ok) return { error: `the page answered ${res.status}` };
    if (Number(res.headers.get("content-length") || 0) > MAX_PAGE) return { error: "the page is too big to watch" };
    const body = await res.text();
    const text = pageText(body.slice(0, MAX_PAGE), res.headers.get("content-type") || "");
    return { value: { hash: sha256(text), text, at: now.toISOString() } };
  } catch (e: any) {
    return { error: e?.name === "TimeoutError" ? "the page took too long" : String(e?.message || e) };
  }
}
