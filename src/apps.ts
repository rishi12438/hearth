import { randomBytes, randomUUID } from "node:crypto";
import { sha256 } from "./auth.ts";
import type { Store } from "./store/index.ts";
import type { MiniApp, AppState, AppSize } from "./types.ts";

// Mini apps: small single-file pages a teammate builds for you (flashcards, a habit tracker, a packing list).
//  - Code (html) and data (the cards) are separate, so "add 20 words" changes data without touching code.
//  - Each app runs in a sandboxed frame with an opaque origin and no network (connect-src 'none'), so it can't
//    read your hub token, call the API or send anything anywhere. The only ways out are hearth.save(state) (its own
//    progress) and hearth.ask(text) (a message to the teammate who made it, rate-limited, shown in your DM with them).
//  - Every code change keeps the previous version (last 10), so Undo is one tap.

export const APP_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const MAX_HTML = 200_000;
export const MAX_DATA = 256_000;
export const MAX_STATE = 48_000;
const KEEP_VERSIONS = 10;
const TICKET_MS = 10 * 60_000;
type View = "full" | "inline" | AppSize;

/** A size from the model or the app ("tall" is the old name for large). */
export function appSize(v: unknown, fallback: AppSize = "small"): AppSize {
  return v === "small" || v === "wide" || v === "large" ? v : v === "tall" ? "large" : fallback;
}

/** The bridge every app gets: window.hearth = { data, state, view, save(state), ask(text), open(), ready(cb) }. */
function bridge(data: unknown, state: unknown, view: View, assets: { origin: string; tileKey: string }) {
  const j = (v: unknown) => JSON.stringify(v ?? null).replace(/</g, "\\u003c").replace(/\u2028|\u2029/g, " ");
  return `<script>
window.hearth = { data: ${j(data)}, state: ${j(state)}, view: ${j(view)},
  /** Pictures an app may show (the only things it can load): 3D emoji and map tiles from the hub. */
  emoji(e) { return ${j(assets.origin)} + "/emoji/" + Array.from(String(e)).map((c) => c.codePointAt(0).toString(16)).join("-") + ".webp"; },
  tile(z, x, y) { return ${j(assets.origin)} + "/tiles/" + z + "/" + x + "/" + y + ".png?k=" + ${j(assets.tileKey)}; },
  save(s) { this.state = s; parent.postMessage({ hearth: "save", state: s }, "*"); },
  ask(text) { parent.postMessage({ hearth: "ask", text: String(text).slice(0, 2000) }, "*"); },
  open() { parent.postMessage({ hearth: "open" }, "*"); },
  ready(cb) { document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", cb) : cb(); } };
${view === "inline" ? `window.hearth.ready(() => { const tell = () => parent.postMessage({ hearth: "height", h: Math.ceil(document.body.getBoundingClientRect().height) }, "*");
  document.documentElement.style.height = "auto"; document.body.style.height = "auto"; document.body.style.minHeight = "0";
  new ResizeObserver(tell).observe(document.body); tell(); });` : ""}
</script>`;
}

export function appCsp(frameAncestors: string, hubOrigin = "") {
  return [
    "sandbox allow-scripts allow-forms", "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
    `img-src data: blob: ${hubOrigin}`.trim(), "media-src data: blob:", "font-src data:", "connect-src 'none'", "form-action 'none'",
    "base-uri 'none'", `frame-ancestors ${frameAncestors}`,
  ].join("; ");
}

export class Apps {
  private tickets = new Map<string, { appId: string; exp: number; view: View }>();

  constructor(private store: Store) {}

  list() { return this.store.all<MiniApp>("apps"); }

  async byName(name: string) {
    const n = String(name || "").toLowerCase();
    return (await this.list()).find((a) => a.name === n || a.title.toLowerCase() === n) || null;
  }

  /** Create or change an app. html replaces the code (old version kept); data replaces the data. */
  async save(input: { name?: unknown; title?: unknown; description?: unknown; html?: unknown; data?: unknown; inline?: unknown }, by: { teammateId?: string; threadId?: string; jobId?: string }) {
    const name = String(input.name || "").toLowerCase().trim();
    if (!APP_NAME_RE.test(name)) return { error: "App name must be lowercase letters, digits and dashes." };
    const html = typeof input.html === "string" ? input.html : undefined;
    if (html !== undefined && (!html.trim() || html.length > MAX_HTML)) return { error: "App code is empty or too big." };
    let data = input.data;
    if (data !== undefined && JSON.stringify(data).length > MAX_DATA) return { error: "App data is too big." };
    const prev = await this.byName(name);
    if (!prev && html === undefined) return { error: `No app called ${name} yet; send its code first.` };
    const now = new Date().toISOString();
    const versions = [...(prev?.versions || [])];
    if (html !== undefined && prev && sha256(html) !== prev.sha256) versions.push({ html: prev.html, sha256: prev.sha256, at: prev.updatedAt || prev.createdAt, by: prev.teammateId });
    const app = await this.store.put<MiniApp>("apps", {
      ...(prev || { id: randomUUID(), createdAt: now, pinned: false }),
      name,
      title: typeof input.title === "string" && input.title.trim() ? input.title.trim().slice(0, 60) : prev?.title || name,
      description: typeof input.description === "string" ? input.description.slice(0, 200) : prev?.description || "",
      html: html ?? prev!.html,
      sha256: sha256(html ?? prev!.html),
      data: data !== undefined ? data : prev?.data ?? null,
      versions: versions.slice(-KEEP_VERSIONS),
      teammateId: by.teammateId || prev?.teammateId,
      threadId: prev?.threadId || by.threadId,
      jobId: by.jobId || prev?.jobId,
      inline: prev ? prev.inline && input.inline !== false : input.inline === true,
      updatedAt: now,
    });
    return { value: app, created: !prev, changedCode: html !== undefined && (!prev || prev.sha256 !== app.sha256) };
  }

  /** Back to the previous version of the code. */
  async undo(id: string) {
    const a = await this.store.get<MiniApp>("apps", id);
    const last = a?.versions?.at(-1);
    if (!a || !last) return null;
    return this.store.put<MiniApp>("apps", { ...a, html: last.html, sha256: last.sha256, versions: a.versions.slice(0, -1), updatedAt: new Date().toISOString() });
  }

  /** Put an app on Home (live), or take it off. */
  async pin(name: string, on: boolean, size?: unknown) {
    const a = await this.byName(name);
    if (!a) return null;
    const top = Math.max(0, ...(await this.list()).filter((x) => x.pinned).map((x) => x.order || 0));
    return this.store.put<MiniApp>("apps", { ...a, pinned: on, size: size === undefined ? appSize(a.size) : appSize(size, appSize(a.size)), order: on ? (a.pinned ? a.order : top + 1) : undefined });
  }

  async remove(id: string) {
    await this.store.remove("appState", id);
    return this.store.remove("apps", id);
  }

  async state(id: string) { return (await this.store.get<AppState>("appState", id))?.state ?? null; }

  async setState(id: string, state: unknown) {
    if (!(await this.store.get<MiniApp>("apps", id))) return { error: "No such app." };
    if (JSON.stringify(state ?? null).length > MAX_STATE) return { error: "That's more than an app can save." };
    await this.store.put<AppState>("appState", { id, createdAt: new Date().toISOString(), state });
    return { value: true };
  }

  /** A short-lived, single-app link the frame loads (iframes can't send the device token). */
  ticket(appId: string, view: unknown = "full") {
    const now = Date.now();
    for (const [k, v] of this.tickets) if (v.exp < now) this.tickets.delete(k);
    const t = randomBytes(24).toString("base64url");
    this.tickets.set(t, { appId, exp: now + TICKET_MS, view: view === "full" || view === undefined ? "full" : view === "inline" ? "inline" : appSize(view) });
    return t;
  }

  /** The page for a ticket: the app's html with the bridge in front. */
  async page(ticket: string, assets: { origin: string; tileKey: string } = { origin: "", tileKey: "" }) {
    const t = this.tickets.get(ticket);
    if (!t || t.exp < Date.now()) return null;
    const a = await this.store.get<MiniApp>("apps", t.appId);
    if (!a) return null;
    const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">${bridge(a.data, await this.state(a.id), t.view, assets)}`;
    return /<head[^>]*>/i.test(a.html) ? a.html.replace(/<head[^>]*>/i, (m) => m + head) : head + a.html;
  }
}
