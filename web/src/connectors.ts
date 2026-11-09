import { h, clear, icon, toast, relTime } from "./dom.ts";
import { call } from "./api.ts";

// The connector grid (Settings → Connectors → Available) and the setup sheets for the connectors that came with it:
// brains (Claude Code, Codex), keys (Serper, Deepgram), WhatsApp (QR + ignore list) and Slack. Every tile comes from
// the hub's /api/connectors, so the grid, the API and the `hearth` CLI always agree. app.ts hands in its sheet helpers
// and the screens it already has (Google, cookies, voice).

export type Tile = {
  id: string; label: string; kind: "brain" | "key" | "account"; how: string; blurb: string; risk?: string; getFrom?: string;
  state: "connected" | "off" | "needs-you" | "not-installed"; detail: string | null; riskAccepted?: boolean; usage?: Usage | null;
  /** Has a login, but the brain turns it away (bad, expired or revoked): reconnect it. */
  signedOut?: boolean;
};
type Usage = { harness: string; percent: number; full: boolean; fullUntil: number | null; plan: string | null; detail: string | null; at: number | null; lastError: string | null; retryAfter: number | null; windows: { label: string; usedPercent: number; resetsAt: number | null }[] };

export type Deps = {
  openSheet(title: string, body: Node | any[], opts?: { onClose?: () => void }): void;
  closeSheet(): void;
  confirmSheet(title: string, text: string, action: string, fn: () => Promise<void>): void;
  handleError(e: unknown): void;
  /** Back to the grid. */
  back(): void;
  /** Screens app.ts already has. */
  openVoice(): void;
  openGoogle(): void;
  openCookies(id: string): void;
  /** Ask the Mac app (it reads Chrome on this Mac). Rejects outside the app. */
  askMac(type: string, args: Record<string, unknown>, timeoutMs?: number): Promise<any>;
  /** A finished call's facts line and its recording controls (app.ts draws the same in a thread). */
  callFacts(c: any): Node;
  callRecording(c: any): Node | null;
  /** app.ts's own logo for ids it draws (LinkedIn, Instagram, Gmail…), or null. */
  logo(id: string, size: number): HTMLElement | null;
};
let D: Deps;
export function initConnectors(deps: Deps) { D = deps; }

// ---------- logos (SVG marks, no images) ----------

// Official brand marks: Simple Icons (CC0) paths, 24x24; Slack in its four brand colors.
const CLAUDE_MARK = "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z";
const OPENAI_MARK = "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";

type Shape = [string, Record<string, string | number>, string?];
const LOGOS: Record<string, { bg: string; shapes: Shape[] }> = {
  claude: { bg: "#D97757", shapes: [["path", { d: CLAUDE_MARK, fill: "#fff" }]] },
  codex: { bg: "#000", shapes: [["path", { d: OPENAI_MARK, fill: "#fff" }]] },
  serper: { bg: "#1A73E8", shapes: [["circle", { cx: 10.5, cy: 10.5, r: 5, fill: "none", stroke: "#fff", "stroke-width": 2.2 }], ["path", { d: "M14.5 14.5 19 19", stroke: "#fff", "stroke-width": 2.4, "stroke-linecap": "round" }]] },
  calls: { bg: "#0B8F5B", shapes: [["path", { d: "M8.2 4.5 6.4 4.4c-1 0-2 .9-1.9 2 .5 6.6 5.6 11.8 12.2 12.3 1.1.1 2-.9 2-1.9l-.1-1.8c0-.5-.4-.9-.9-1l-2.6-.6c-.4-.1-.8.1-1 .4l-.8 1.2a10 10 0 0 1-4.3-4.3l1.2-.8c.3-.2.5-.6.4-1L10 5.4c-.1-.5-.5-.9-1-.9Z", fill: "#fff" }]] },
  deepgram: { bg: "#101012", shapes: [["path", { d: "M6 10v4M9 7v10M12 9v6M15 5v14M18 10v4", stroke: "#13EF93", "stroke-width": 2, "stroke-linecap": "round" }]] },
  whatsapp: { bg: "#25D366", shapes: [["path", { d: "M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z", fill: "#fff" }]] },
  plaid: { bg: "#0B1F33", shapes: [["path", { d: "M4.5 9.5 12 5l7.5 4.5M6 10.5v6M10 10.5v6M14 10.5v6M18 10.5v6M4.5 19h15", fill: "none", stroke: "#fff", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" }]] },
  slack: { bg: "#fff", shapes: [["path", { d: "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52z", fill: "#E01E5A" }], ["path", { d: "M6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z", fill: "#E01E5A" }], ["path", { d: "M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834z", fill: "#36C5F0" }], ["path", { d: "M8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z", fill: "#36C5F0" }], ["path", { d: "M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834z", fill: "#2EB67D" }], ["path", { d: "M17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z", fill: "#2EB67D" }], ["path", { d: "M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52z", fill: "#ECB22E" }], ["path", { d: "M15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z", fill: "#ECB22E" }]] },
};
export function logo(id: string, size = 48): HTMLElement {
  const own = D?.logo(id, size);
  if (own) return own;
  const l = LOGOS[id] ?? { bg: "#eef2f7", shapes: [["circle", { cx: 12, cy: 12, r: 7, fill: "none", stroke: "#64748b", "stroke-width": 2 }]] as Shape[] };
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", String(size * 0.62)); svg.setAttribute("height", String(size * 0.62));
  for (const [tag, attrs] of l.shapes) { const el = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v)); svg.append(el); }
  const tile = h("span", { class: "ctile" }, svg);
  tile.style.cssText = `width:${size}px;height:${size}px;background:${l.bg}`;
  return tile;
}

// ---------- the grid ----------

const GROUPS: [string, (t: Tile) => boolean][] = [
  ["Brains", (t) => t.kind === "brain"],
  ["Keys", (t) => t.kind === "key"],
  ["Messaging & social", (t) => t.kind === "account" && t.id !== "plaid"],
  ["Money", (t) => t.id === "plaid"],
];
const STATE_LABEL: Record<Tile["state"], string> = { connected: "Connected", off: "Add", "needs-you": "Needs you", "not-installed": "Not installed" };

/** The same connectors as quiet rows (logo, name, one line, status), grouped: for the "Finish setting up" screen. */
export function rows(tiles: Tile[]): HTMLElement[] {
  return GROUPS.flatMap(([name, pick]) => {
    const list = tiles.filter(pick);
    if (!list.length) return [];
    return [h("div", { class: "wsec" }, name), h("div", { class: "wcard" }, list.map((t) =>
      h("button", { class: "wrow", on: { click: () => openTile(t) } },
        logo(t.id, 34),
        h("span", { class: "grow" }, h("b", null, t.label),
          h("small", null, t.kind === "brain" && t.usage && t.state === "connected" ? usageLine(t.usage) : t.blurb)),
        t.state === "connected" ? h("span", { class: "wst on" }, "Connected")
          : t.state === "needs-you" ? h("span", { class: "wst warn" }, "Needs you")
          : t.state === "not-installed" ? h("span", { class: "wst" }, "Not installed")
          : h("span", { class: "wadd" }, "Connect"))))];
  });
}

export async function loadTiles(): Promise<Tile[]> { return (await call("/api/connectors")).connectors; }

/** The grid of tiles, grouped. `q` filters by name. */
export function grid(tiles: Tile[], q = ""): HTMLElement {
  const match = (t: Tile) => !q || `${t.label} ${t.blurb}`.toLowerCase().includes(q);
  return h("div", { class: "cgrid-wrap" }, GROUPS.map(([name, pick]) => {
    const list = tiles.filter((t) => pick(t) && match(t));
    if (!list.length) return null;
    return [h("h4", null, name), h("div", { class: "cgrid" }, list.map((t) =>
      h("button", { class: `cgtile ${t.state}`, on: { click: () => openTile(t) } },
        logo(t.id, 44),
        h("b", null, t.label),
        h("small", null, t.kind === "brain" && t.usage && t.state === "connected" ? usageLine(t.usage) : t.detail || t.blurb),
        h("span", { class: `cgstate ${t.state}` }, t.state === "connected" ? icon("check", 12) : null, STATE_LABEL[t.state]),
        t.risk ? h("span", { class: "cgrisk", title: "Uses your own login" }, "Unofficial") : null)))];
  }));
}

/** "checked 2 hours ago", when the numbers are the last good ones because the newest read failed. */
const staleNote = (u: Usage) => (u.lastError && u.at ? `checked ${relTime(new Date(u.at).toISOString())}` : null);
const usageLine = (u: Usage) => u.full ? "At its limit"
  : u.windows.length ? [`${u.percent}% of ${u.windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a)).label} used`, staleNote(u)].filter(Boolean).join(" · ")
  : u.detail || "Usage shows after its next job";

export function openTile(t: Tile) {
  if (t.risk && !t.riskAccepted && t.state !== "connected") return riskSheet(t, () => openTile({ ...t, riskAccepted: true }));
  switch (t.id) {
    case "claude": case "codex": return brainSheet(t);
    case "deepgram": return D.openVoice();
    case "google": return D.openGoogle();
    case "instagram": case "linkedin": return D.openCookies(t.id);
    case "whatsapp": return whatsappSheet();
    case "slack": return slackSheet(t);
    case "plaid": return plaidSheet(t);
    case "calls": return callsSheet(t);
    default: return keySheet(t);
  }
}

// ---------- the ban-risk warning (WhatsApp, Instagram, LinkedIn) ----------

function riskSheet(t: Tile, then: () => void) {
  D.openSheet(t.label, [
    h("button", { class: "btn ghost", on: { click: D.back } }, icon("back", 16), "All connectors"),
    h("div", { class: "phero" }, logo(t.id, 52), h("b", null, `Before you connect ${t.label}`), h("small", null, t.blurb)),
    h("div", { class: "riskbox" }, h("b", null, "This one is unofficial"), h("p", null, t.risk || "")),
    h("p", { class: "muted small" }, "Hearth only reads, and never sends anything without your Approve. You can disconnect any time."),
    h("button", { class: "btn primary big", on: { click: async (e: Event) => {
      (e.currentTarget as HTMLButtonElement).disabled = true;
      try { await call(`/api/connectors/${t.id}/risk`, { body: {} }); then(); } catch (err) { D.handleError(err); }
    } } }, "I understand, it's my choice"),
    h("button", { class: "btn ghost", on: { click: D.back } }, "Not now"),
  ]);
}

// ---------- brains ----------

function bars(u: Usage) {
  const when = (ms: number) => new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  const later = u.retryAfter ? `, checking again ${when(u.retryAfter)}` : "";
  if (!u.windows.length) return h("p", { class: "muted small" }, `${u.detail || "Usage shows after its next job"}${later}.`);
  const stale = u.lastError && u.at ? h("p", { class: "muted small" }, `Last checked ${relTime(new Date(u.at).toISOString())} (${when(u.at)}). ${u.lastError}${later}.`) : null;
  return h("div", { class: "ubars" }, stale, u.windows.map((w) => h("div", { class: "ubar" },
    h("div", { class: "ubar-top" }, h("span", null, w.label), h("span", null, `${w.usedPercent}%`)),
    h("div", { class: "ubar-track" }, (() => { const f = h("i", { class: w.usedPercent >= 90 ? "hot" : w.usedPercent >= 70 ? "warm" : "" }); f.style.width = `${Math.min(100, w.usedPercent)}%`; return f; })()),
    w.resetsAt ? h("small", { class: "muted" }, `Resets ${new Date(w.resetsAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`) : null)));
}

async function brainSheet(t: Tile) {
  let usage: Usage | null = t.usage ?? null;
  try { const r = await call("/api/brains/usage?fresh=1"); usage = (r.usage as Usage[]).find((u) => u.harness === t.id) ?? usage; } catch {}
  const picked = t.state === "connected";
  const signIn = t.id === "claude"
    ? "On your Mac run `hearth brains token claude` (it opens the browser once), then paste the token below. Or set the hub up from the Hearth app, which does this for you."
    : "Codex signs in with your ChatGPT login. The Hearth app copies ~/.codex/auth.json from your Mac; or paste that file below.";
  const box = h("textarea", { class: "field mono", rows: 3, placeholder: t.id === "claude" ? "sk-ant-oat01-…" : "Contents of ~/.codex/auth.json", autocapitalize: "off", spellcheck: false }) as HTMLTextAreaElement;
  const err = h("p", { class: "err small", hidden: true });
  const inApp = !!(window as any).webkit?.messageHandlers?.hearth;
  const fail = (x: any) => { err.textContent = x?.message || String(x); err.hidden = false; };
  const reopen = async () => { try { const n = (await loadTiles()).find((x) => x.id === t.id); if (n) return brainSheet(n); } catch {} D.back(); };
  // One tap in the Mac app: this Mac signs in again (Claude: the browser asks once) and the login goes up to the hub.
  const reconnect = inApp && t.state !== "not-installed" ? h("button", { class: "btn primary big", on: { click: async (e: Event) => {
    const b = e.currentTarget as HTMLButtonElement; b.disabled = true; err.hidden = true;
    b.textContent = t.id === "claude" ? "Finish signing in in your browser…" : "Copying this Mac's Codex login…";
    try {
      const r = await D.askMac("brain-login", { brain: t.id }, 5 * 60_000);
      if (r?.error) throw new Error(r.error);
      b.textContent = "Checking it on the hub…";
      await call(`/api/connectors/${t.id}`, { method: "PUT", body: t.id === "claude" ? { token: r.token } : { auth: r.auth } });
      toast(`${t.label} is signed in`); reopen();
    } catch (x) { fail(x); b.disabled = false; b.textContent = "Try again"; }
  } } }, t.id === "claude" ? "Reconnect with this Mac" : "Use this Mac's Codex login") : null;
  const checkAgain = picked || t.signedOut ? h("button", { class: "btn ghost", on: { click: async (e: Event) => {
    const b = e.currentTarget as HTMLButtonElement; b.disabled = true; b.textContent = "Checking…"; err.hidden = true;
    try {
      const r = await call(`/api/brains/check/${t.id}`, { method: "POST", body: {} });
      if (r.ok) { toast(`${t.label} is signed in and working`); reopen(); }
      else { fail(new Error(r.message || "It still won't sign in.")); b.disabled = false; b.textContent = "Check again"; }
    } catch (x) { fail(x); b.disabled = false; b.textContent = "Check again"; }
  } } }, icon("repeat", 16), "Check again") : null;
  D.openSheet(t.label, [
    h("button", { class: "btn ghost", on: { click: D.back } }, icon("back", 16), "All connectors"),
    h("div", { class: "phero" }, logo(t.id, 52),
      h("b", null, t.signedOut ? `${t.label} is signed out` : picked ? `${t.label} is one of your brains` : t.label),
      h("small", { class: t.signedOut ? "err" : "" }, t.detail || t.blurb)),
    t.signedOut ? h("p", { class: "muted small" }, `The hub has a login for ${t.label}, but ${t.label} turns it away, so it can't think for the team. Reconnect it; jobs go to your other brain meanwhile, if you have one.`) : null,
    picked && usage ? [h("h4", null, `Live usage${usage.plan ? ` · ${usage.plan}` : ""}`), bars(usage),
      h("p", { class: "muted small" }, "With more than one brain, each job goes to whichever has the most room on its plan right now.")] : null,
    t.state === "needs-you" ? [reconnect, checkAgain] : null,
    t.state === "needs-you" || t.state === "off" ? [
      h("h4", null, t.state === "needs-you" ? (reconnect ? "Or paste a login" : t.signedOut ? "Reconnect it" : "Sign it in on the hub") : "Use it"),
      t.state === "needs-you" ? [h("p", { class: "muted small" }, signIn), box, err] : null,
      h("button", { class: "btn primary big", on: { click: async (e: Event) => {
        const b = e.currentTarget as HTMLButtonElement; b.disabled = true; err.hidden = true;
        const v = box.value.trim();
        try {
          await call(`/api/connectors/${t.id}`, { method: "PUT", body: t.id === "claude" ? (v ? { token: v } : {}) : (v ? { auth: v } : {}) });
          toast(`${t.label} is on`); D.back();
        } catch (x: any) { err.textContent = x.message; err.hidden = false; b.disabled = false; }
      } } }, t.state === "needs-you" ? "Save and use it" : `Use ${t.label}`),
    ] : null,
    picked ? checkAgain : null,
    picked ? err : null,
    t.state === "not-installed" ? h("p", { class: "muted" }, t.id === "claude" ? "Install Claude Code on the hub: curl -fsSL https://claude.ai/install.sh | bash" : "Install Codex on the hub: npm install -g @openai/codex") : null,
    picked ? h("button", { class: "btn danger-ghost", on: { click: () => D.confirmSheet(`Stop using ${t.label}?`, "Jobs go to your other brain. Its login stays on the hub.", "Stop using it", async () => {
      await call(`/api/connectors/${t.id}`, { method: "DELETE" }); toast(`${t.label} is off`); D.back();
    }) } }, `Stop using ${t.label}`) : null,
  ]);
}

// ---------- a key or a token (Serper, Slack) ----------

const KEY_HELP: Record<string, { steps: string[]; placeholder: string; field: "key" | "token" }> = {
  serper: { field: "key", placeholder: "Serper API key", steps: ["Sign up at serper.dev (free searches to start).", "Open API Key and copy it.", "Paste it here: Hearth checks it with one search and keeps it encrypted."] },
  slack: { field: "token", placeholder: "xoxp-… (user) or xoxb-… (bot)", steps: [
    "At api.slack.com/apps, Create New App → From scratch, in your workspace.",
    "Open OAuth & Permissions, scroll to Scopes → User Token Scopes, and add: im:history, im:read, users:read, search:read (and chat:write only if teammates may send, after your Approve).",
    "Scroll back up and tap Install to Workspace (it only shows once a scope is added). Then the User OAuth Token (xoxp-…) appears on that page: copy it and paste it here. If Slack says “Request to install”, your workspace admin has to approve the app first."] },
};

function keyForm(t: Tile) {
  const help = KEY_HELP[t.id] ?? { field: "key" as const, placeholder: `${t.label} key`, steps: [] };
  const input = h("input", { class: "field", type: "password", placeholder: help.placeholder, autocomplete: "off", autocapitalize: "off", spellcheck: false }) as HTMLInputElement;
  const err = h("p", { class: "err small", hidden: true });
  const save = h("button", { class: "btn primary big", on: { click: async () => {
    if (!input.value.trim()) return input.focus();
    save.disabled = true; save.textContent = `Checking with ${t.label}…`; err.hidden = true;
    try { await call(`/api/connectors/${t.id}`, { method: "PUT", body: { [help.field]: input.value.trim() } }); toast(`${t.label} connected`); D.back(); }
    catch (e: any) { err.textContent = e.message; err.hidden = false; save.disabled = false; save.textContent = "Connect"; }
  } } }, "Connect");
  return [help.steps.length ? h("ol", { class: "steps" }, help.steps.map((s, i) => h("li", null, i === 0 && t.getFrom ? [h("a", { href: t.getFrom, target: "_blank", rel: "noopener noreferrer" }, t.getFrom.replace(/^https:\/\//, "")), " · ", s] : s))) : null,
    input, err, save];
}

function keySheet(t: Tile) {
  D.openSheet(t.label, [
    h("button", { class: "btn ghost", on: { click: D.back } }, icon("back", 16), "All connectors"),
    h("div", { class: "phero" }, logo(t.id, 52), h("b", null, t.state === "connected" ? `${t.label} is connected` : `Connect ${t.label}`), h("small", null, t.state === "connected" ? t.detail || "" : t.blurb)),
    t.state === "connected"
      ? h("button", { class: "btn danger-ghost", on: { click: () => D.confirmSheet(`Disconnect ${t.label}?`, "The key is removed from the hub.", "Disconnect", async () => { await call(`/api/connectors/${t.id}`, { method: "DELETE" }); toast(`${t.label} disconnected`); D.back(); }) } }, `Disconnect ${t.label}`)
      : keyForm(t),
    h("p", { class: "muted small" }, "Kept encrypted in your hub's vault. It never goes to the model, this app or your exports."),
  ]);
}

// ---------- Voice calls: an OpenAI or Gemini key, then how the bot sounds ----------

function callsSheet(t: Tile) {
  const head = [h("button", { class: "btn ghost", on: { click: D.back } }, icon("back", 16), "All connectors"),
    h("div", { class: "phero" }, logo(t.id, 52), h("b", null, t.state === "connected" ? "Voice calls are on" : "Turn on voice calls"), h("small", null, t.state === "connected" ? t.detail || "" : t.blurb))];
  if (t.state !== "connected") {
    const input = h("input", { class: "field", type: "password", placeholder: "OpenAI key (sk-…) or Gemini key (AIza…)", autocomplete: "off", autocapitalize: "off", spellcheck: false }) as HTMLInputElement;
    const err = h("p", { class: "err small", hidden: true });
    const save = h("button", { class: "btn primary big", on: { click: async () => {
      if (!input.value.trim()) return input.focus();
      save.disabled = true; save.textContent = "Checking the key and setting up the line…"; err.hidden = true;
      try { await call("/api/connectors/calls", { method: "PUT", body: { key: input.value.trim() } }); toast("Voice calls are on"); D.back(); }
      catch (e: any) { err.textContent = e.message; err.hidden = false; save.disabled = false; save.textContent = "Turn on"; }
    } } }, "Turn on");
    return D.openSheet(t.label, [...head,
      h("ol", { class: "steps" },
        h("li", null, "Get a key for the bot's voice: ", h("a", { href: "https://platform.openai.com/api-keys", target: "_blank", rel: "noopener noreferrer" }, "OpenAI"), " (Realtime) or ", h("a", { href: "https://aistudio.google.com/apikey", target: "_blank", rel: "noopener noreferrer" }, "Gemini"), " (Live). Calls are billed to that key."),
        h("li", null, "Paste it here. Hearth checks it and sets up its phone line (a shared number, through Arca)."),
        h("li", null, "Agents can then call people for you. Every call waits for your Approve, and you can listen in or join from the thread.")),
      input, err, save,
      h("p", { class: "muted small" }, "Free line: a shared number with no callbacks (anyone who calls it back hears that it doesn't take calls). The key is kept encrypted on your hub.")]);
  }
  const box = h("div", { class: "stack" }, h("p", { class: "muted small" }, "Loading…"));
  D.openSheet(t.label, [...head, box,
    h("button", { class: "btn danger-ghost", on: { click: () => D.confirmSheet("Turn off voice calls?", "The voice key is removed from the hub. Your phone line stays, so turning them on again is quick.", "Turn off", async () => { await call("/api/connectors/calls", { method: "DELETE" }); toast("Voice calls are off"); D.back(); }) } }, "Turn off voice calls")]);
  call<any>("/api/calls/settings").then((v) => {
    const vp = v.voice || {};
    const field = (label: string, el: HTMLElement, hint?: string) => h("label", { class: "fieldrow" }, h("b", { class: "small" }, label), el, hint ? h("small", { class: "muted" }, hint) : null);
    const text = (val: string | undefined, ph: string, max = 60) => h("input", { class: "field", value: val || "", placeholder: ph, maxlength: String(max) }) as HTMLInputElement;
    const voice = h("select", { class: "field" }, h("option", { value: "" }, v.provider === "openai" ? "Default (marin)" : "Default (Puck)"),
      (v.voices || []).map((x: string) => h("option", { value: x, selected: vp.voice === x }, x))) as HTMLSelectElement;
    const speed = h("input", { type: "range", min: "0.7", max: "1.3", step: "0.05", value: String(vp.speed ?? 1) }) as HTMLInputElement;
    const speedLabel = h("small", { class: "muted" }, `${Number(speed.value).toFixed(2)}×`);
    speed.addEventListener("input", () => { speedLabel.textContent = `${Number(speed.value).toFixed(2)}×`; });
    const name = text(vp.name, "Hearth"), owner = text(vp.owner, "Your name"), language = text(vp.language, "English");
    const intro = h("textarea", { class: "field", rows: "2", maxlength: "300", placeholder: "Hi, this is Sam, Rishi's assistant, calling about…" }, vp.intro || "") as HTMLTextAreaElement;
    const style = h("textarea", { class: "field", rows: "2", maxlength: "300", placeholder: "Warm, brief, a little informal" }, vp.style || "") as HTMLTextAreaElement;
    const freePlan = v.line?.plan !== "paid";
    const record = h("input", { type: "checkbox", checked: freePlan || vp.record !== false, disabled: freePlan }) as HTMLInputElement;
    const save = h("button", { class: "btn primary big", on: { click: async () => {
      save.disabled = true;
      try {
        await call("/api/calls/settings", { method: "PUT", body: { voice: voice.value, ...(v.provider === "openai" ? { speed: Number(speed.value) === 1 ? "" : Number(speed.value) } : {}),
          name: name.value, owner: owner.value, language: language.value, intro: intro.value, style: style.value, ...(freePlan ? {} : { record: record.checked }) } });
        toast("Saved");
      } catch (e) { D.handleError(e); } finally { save.disabled = false; }
    } } }, "Save");
    const log = h("div", { class: "stack" });
    const secs = (n: number) => (n >= 60 ? `${Math.floor(n / 60)}m${n % 60 ? ` ${n % 60}s` : ""}` : `${n}s`);
    const used = v.line ? `${v.line.today.calls} of ${v.line.limits.calls} calls, ${Math.round(v.line.today.seconds / 60)} of ${Math.round(v.line.limits.seconds / 60)} minutes today` : null;
    clear(box,
      h("p", { class: "small" }, h("b", null, "Line: "), v.number || "—", " · shared number, no callbacks", used ? h("br") : null, used ? h("span", { class: "muted" }, used) : null),
      v.line ? h("p", { class: "small" }, h("b", null, "Plan: "), v.line.plan === "paid" ? "Paid · calls up to 15 minutes" : "Free",
        v.line.allowance ? ` · ${secs(Math.max(0, v.line.allowance.seconds - v.line.allowance.used))} of ${secs(v.line.allowance.seconds)} left, for all your calls together` : null,
        v.line.plan === "paid" ? null : h("span", { class: "muted" }, " (the bot wraps up before the line cuts off)")) : null,
      h("p", { class: "small" }, h("b", null, "Voice model: "), v.provider === "openai" ? "OpenAI Realtime" : "Gemini Live", v.model ? ` (${v.model})` : "", " · ", v.hint || ""),
      field("Voice", voice),
      v.provider === "openai" ? field("Speed", h("div", { class: "row2" }, speed, speedLabel)) : null,
      field("Its name", name), field("Calls for", owner, "Who it says it's calling for."),
      field("Language", language),
      field("Opening line", intro, "Leave empty and it says who it is, who for, and why it's calling."),
      field("How it comes across", style),
      h("label", { class: "fieldrow" }, h("span", { class: "row2" }, record, h("b", { class: "small" }, "Record calls")),
        h("small", { class: "muted" }, freePlan
          ? "Free calls are always recorded (on your hub and on Arca). The bot tells them up front that the call is recorded."
          : "Saves each call as an MP3 on your hub and on Arca, and the bot tells them up front that the call is recorded (some places need everyone's OK).")),
      h("p", { class: "muted small" }, "An agent can pick another voice or language for one call when you ask it to."),
      save, log);
    void call<any>("/api/calls").then((r) => {
      const list = r.calls || [];
      clear(log, h("h3", null, "Recent calls"), list.length ? list.slice(0, 50).map((c: any) => h("div", { class: "block callcard " + c.status },
        h("div", { class: "blockhead" }, h("b", null, c.to), h("small", { class: "muted" }, c.status === "failed" ? " · didn't connect" : c.status === "ended" ? "" : " · on now"),
          h("a", { class: "small", href: `#c/${c.threadId}`, on: { click: () => D.closeSheet() } }, "Open thread")),
        D.callFacts(c), c.outcome || c.error ? h("p", { class: "small" }, c.status === "failed" ? c.error : c.outcome) : null, D.callRecording(c)))
        : h("p", { class: "muted small" }, "No calls yet."));
    }).catch(() => clear(log));
  }).catch((e) => clear(box, h("p", { class: "err small" }, e.message)));
}

// ---------- Slack: your Chrome login, or a Slack app's token ----------

function slackSheet(t: Tile) {
  const inApp = !!(window as any).webkit?.messageHandlers?.hearth;
  const box = h("div", { class: "stack" });
  const err = h("p", { class: "err small", hidden: true });
  const fail = (e: any) => { err.textContent = e.message; err.hidden = false; };
  const connect = async (r: any, workspace: string, btn: HTMLButtonElement) => {
    btn.disabled = true; btn.textContent = "Connecting…"; err.hidden = true;
    try {
      await call("/api/connectors/slack", { method: "PUT", body: { cookies: JSON.stringify({ cookies: r.cookies }), auth: { fingerprint: r.fingerprint, workspace } } });
      toast("Slack connected"); D.back();
    } catch (e) { fail(e); btn.disabled = false; btn.textContent = "Connect"; }
  };
  const useChrome = async (btn: HTMLButtonElement, profile: { id: string; label: string }, again: string) => {
    btn.disabled = true; btn.textContent = "Reading from Chrome…"; err.hidden = true;
    try {
      const r = await D.askMac("chrome-cookies", { site: "slack", profile: profile.id });
      if (r.error) throw new Error(r.error);
      if (!r.fingerprint) throw new Error("This Hearth for Mac is too old for this. Update it, then try again.");
      btn.textContent = "Finding your workspaces…";
      const { workspaces } = await call("/api/connectors/slack/workspaces", { body: { cookies: JSON.stringify({ cookies: r.cookies }), fingerprint: r.fingerprint } });
      if (!workspaces.length) throw new Error("Chrome's Slack login didn't open any workspace. Open app.slack.com in Chrome, sign in, then check again.");
      if (workspaces.length === 1) return connect(r, workspaces[0].domain, btn);
      clear(box, h("p", null, h("b", null, "Which workspace?")),
        h("div", { class: "wcard" }, workspaces.map((w: any) => {
          const b = h("button", { class: "wa-btn dark", on: { click: () => connect(r, w.domain, b) } }, "Connect") as HTMLButtonElement;
          return h("div", { class: "wa-rule" }, h("span", { class: "grow" }, h("b", null, w.team), h("small", null, `${w.domain}${w.user ? ` · ${w.user}` : ""}`)), b);
        })));
    } catch (e) { fail(e); btn.disabled = false; btn.textContent = again; }
  };
  const check = async () => {
    clear(box, h("p", { class: "muted small" }, "Checking Chrome on this Mac…"));
    let r: any;
    try { r = await D.askMac("chrome-logins", {}, 15_000); } catch (e: any) { r = { error: e.message }; }
    const found: { id: string; label: string }[] = r?.logins?.slack || [];
    const again = h("button", { class: "btn ghost", on: { click: () => check() } }, icon("repeat", 16), "Check again");
    if (r?.error) return clear(box, h("p", { class: "err small" }, r.error), again);
    if (!r?.chrome) return clear(box, h("p", { class: "muted small" }, "Chrome isn't installed on this Mac. Use a Slack app below instead."), again);
    if (!found.length) return clear(box,
      h("p", { class: "muted small" }, "You're not signed in to Slack in Chrome. Open ", h("a", { href: "https://app.slack.com", target: "_blank", rel: "noopener noreferrer" }, "app.slack.com"), " in Chrome, sign in, then check again."), again);
    clear(box, ...found.map((p) => {
      const label = found.length === 1 ? "Use my Chrome login" : `Use ${p.label}`;
      const b = h("button", { class: "btn primary big", on: { click: () => useChrome(b, p, label) } }, label) as HTMLButtonElement;
      return b;
    }));
  };
  if (inApp) void check();
  else clear(box, h("p", { class: "muted small" }, "Open the Hearth app on your Mac to use the Slack login in your Chrome."));
  if (t.state === "connected") return slackConnected(t);
  D.openSheet(t.label, [
    h("button", { class: "btn ghost", on: { click: D.back } }, icon("back", 16), "All connectors"),
    h("div", { class: "phero" }, logo(t.id, 52), h("b", null, "Connect Slack"), h("small", null, t.blurb)),
    h("div", { class: "stack" },
      h("p", null, h("b", null, "1 · With your Chrome login"), h("small", { class: "sub" }, " · easiest, no app to make")),
      box, err,
      h("p", { class: "muted small" }, "Reads Slack as you, the way Slack in your browser does. Slack doesn't officially support this, so it's your choice. The first time, macOS asks to let Hearth use “Chrome Safe Storage”: choose Always Allow.")),
    h("div", { class: "stack" },
      h("p", null, h("b", null, "2 · With a Slack app"), h("small", { class: "sub" }, " · official, may need your admin")),
      ...keyForm(t)),
    h("p", { class: "muted small" }, "Kept encrypted in your hub's vault. It never goes to the model, this app or your exports."),
  ]);
}

// Connected: show it works by reading a few of your own DMs (and mentions) right now.
function slackConnected(t: Tile) {
  const out = h("div", { class: "ctest" });
  const show = (r: any) => {
    if (!r.ok) return clear(out, h("p", { class: "err small" }, r.error || "Couldn't read Slack."));
    const who = r.user ? `Signed in as ${r.user}${r.team ? ` in ${r.team}` : ""}.` : "Connected.";
    clear(out,
      h("p", { class: "okline" }, icon("check", 16), ` ${who}`),
      typeof r.dmCount === "number" ? h("p", { class: "muted small" }, `Can read ${r.dmCount} direct-message ${r.dmCount === 1 ? "conversation" : "conversations"}${r.people?.length ? `, incl. ${r.people.slice(0, 5).join(", ")}` : ""}.`) : null,
      r.note ? h("div", { class: "riskbox" }, h("b", null, "Needs one more permission"), h("p", { class: "small" }, r.note)) : null,
      r.holdings?.length ? h("div", { class: "stack" }, h("small", { class: "sub" }, "Investments:"), h("div", { class: "list" }, r.holdings.map((l: string) => h("div", { class: "item" }, h("small", null, l))))) : null,
      r.recent?.length ? h("div", { class: "stack" }, h("small", { class: "sub" }, "Most recent:"), h("div", { class: "list" }, r.recent.map((line: string) => h("div", { class: "item" }, h("small", null, line)))))
        : r.note ? null
        : h("p", { class: "muted small" }, "No recent DMs or mentions to show right now — but the read above works."));
  };
  const check = async (e: Event) => {
    const b = e.currentTarget as HTMLButtonElement; b.disabled = true; b.textContent = "Checking…"; clear(out);
    try { show(await call(`/api/connectors/slack/test`, { body: {} })); }
    catch (x: any) { show({ ok: false, error: x.message }); }
    b.disabled = false; b.textContent = "Check messages again";
  };
  const check0 = h("button", { class: "btn primary big", on: { click: check } }, "Check messages");
  // Read straight away so the proof is there without a tap.
  void (async () => { check0.disabled = true; check0.textContent = "Checking…"; try { show(await call(`/api/connectors/slack/test`, { body: {} })); } catch (x: any) { show({ ok: false, error: x.message }); } check0.disabled = false; check0.textContent = "Check messages again"; })();
  D.openSheet(t.label, [
    h("button", { class: "btn ghost", on: { click: D.back } }, icon("back", 16), "All connectors"),
    h("div", { class: "phero" }, logo(t.id, 52), h("b", null, "Slack is connected"), h("small", null, t.detail || "")),
    h("div", { class: "stack" }, check0, out),
    h("p", { class: "muted small" }, "Teammates read your DMs and mentions through this, read-only, at most every 15 min. It never sends anything without your Approve."),
    h("button", { class: "btn danger-ghost", on: { click: () => D.confirmSheet("Disconnect Slack?", "The login is removed from the hub. Triggers on Slack stop until you connect again.", "Disconnect", async () => { await call(`/api/connectors/slack`, { method: "DELETE" }); toast("Slack disconnected"); D.back(); }) } }, "Disconnect Slack"),
    h("p", { class: "muted small" }, "Kept encrypted in your hub's vault. It never goes to the model, this app or your exports."),
  ]);
}

// ---------- Plaid: your keys, then add banks through Plaid's own page ----------

const reloadPlaid = async () => { try { const n = (await loadTiles()).find((x) => x.id === "plaid"); if (n) return plaidSheet(n); } catch {} D.back(); };

function plaidSheet(t: Tile) {
  if (t.state === "off") return plaidKeys(t);
  const body = h("div", { class: "stack" });
  const banks = h("div", { class: "stack" });
  const err = h("p", { class: "err small", hidden: true });
  const fail = (e: any) => { err.textContent = e?.message || String(e); err.hidden = false; };
  let poll: ReturnType<typeof setInterval> | null = null;
  const stop = () => { if (poll) clearInterval(poll); poll = null; };
  const sandbox = /Sandbox/.test(t.detail || "");

  // Plaid's hosted page opens in your browser; this sheet watches for it to finish.
  const link = async (btn: HTMLButtonElement, update: string | null, label: string, kind: "bank" | "investments" = "bank") => {
    const again = btn.textContent || "Try again";
    btn.disabled = true; err.hidden = true; btn.textContent = "Asking Plaid…";
    try {
      const r = await call("/api/connectors/plaid/link", { body: update ? { update } : { kind } });
      const inv = kind === "investments" && !update;
      const open = h("a", { class: "btn primary big", href: r.url, target: "_blank", rel: "noopener noreferrer" }, update ? "Open Plaid to sign in again" : inv ? "Open Plaid to pick your broker" : "Open Plaid to pick your bank");
      clear(body, h("p", null, h("b", null, update ? `Sign in to ${label} again` : inv ? "Add an investment account" : "Add a bank")),
        h("ol", { class: "steps" },
          h("li", null, "Tap the button: Plaid's page opens in your browser."),
          h("li", null, sandbox ? "Pick any bank and sign in with user_good / pass_good (Sandbox has only test banks)." : inv ? "Pick your broker (Robinhood, Fidelity…) and sign in there. Hearth never sees your password, and can't trade." : "Pick your bank (Chase, Discover…) and sign in there. Hearth never sees your bank password."),
          h("li", null, "Come back here: it finishes by itself.")),
        open, h("p", { class: "muted small" }, "Waiting for Plaid…"), err,
        h("button", { class: "btn ghost", on: { click: () => { stop(); reloadPlaid(); } } }, "Cancel"));
      stop();
      poll = setInterval(async () => {
        try {
          const c = await call("/api/connectors/plaid/link", { body: { check: r.token } });
          if (!c.done) return;
          stop();
          if (c.error) { fail(new Error(c.error)); return; }
          if (update) toast(`${label} is signed in again`);
          else if (c.added.length) toast(`${c.added.map((a: any) => a.institution).join(", ")} added`);
          else toast("Plaid closed without adding a bank");
          reloadPlaid();
        } catch (e) { stop(); fail(e); }
      }, 3000);
    } catch (e) { fail(e); btn.disabled = false; btn.textContent = again; }
  };

  const show = (r: any) => {
    if (!r.ok) return clear(banks, h("p", { class: "err small" }, r.error || "Couldn't read Plaid."));
    clear(banks,
      r.banks.length ? r.banks.map((b: any) => h("div", { class: "wcard" },
        h("div", { class: "wa-rule" },
          h("span", { class: "grow" }, h("b", null, b.institution),
            h("small", { class: b.needsLogin || b.error ? "err" : "" }, b.needsLogin ? "The bank signed Hearth out. Reconnect it (this doesn't use a new slot)." : b.error || `${b.accounts.length} account${b.accounts.length === 1 ? "" : "s"}`)),
          b.needsLogin ? (() => { const x = h("button", { class: "wa-btn dark", on: { click: () => link(x, b.itemId, b.institution) } }, "Reconnect") as HTMLButtonElement; return x; })() : null,
          h("button", { class: "wa-btn", on: { click: () => D.confirmSheet(`Remove ${b.institution}?`, "Hearth stops reading it and Plaid ends the connection. On a Trial plan this does not give the slot back.", "Remove", async () => {
            await call(`/api/connectors/plaid/items/${encodeURIComponent(b.itemId)}`, { method: "DELETE" }); toast(`${b.institution} removed`); reloadPlaid();
          }) } }, "Remove")),
        b.accounts.map((a: any) => h("div", { class: "wa-rule" }, h("span", { class: "grow" }, h("small", null, a.line)), h("b", null, a.balanceText))))) 
        : h("p", { class: "muted small" }, "No banks yet."),
      r.cards?.length ? h("div", { class: "stack" }, h("small", { class: "sub" }, "Cards:"), h("div", { class: "list" }, r.cards.map((c: any) => h("div", { class: "item" }, h("small", { class: c.overdue ? "err" : "" }, c.text))))) : null,
      r.recent?.length ? h("div", { class: "stack" }, h("small", { class: "sub" }, "Most recent:"), h("div", { class: "list" }, r.recent.map((l: string) => h("div", { class: "item" }, h("small", null, l))))) : null,
      r.txNote ? h("p", { class: "muted small" }, r.txNote) : null);
  };
  // Keys but no bank yet: nothing to read.
  if (t.state === "connected" || /sign in again/.test(t.detail || "")) {
    clear(banks, h("p", { class: "muted small" }, "Reading your banks…"));
    call("/api/connectors/plaid/test", { body: {} }).then(show, (e) => show({ ok: false, error: e.message }));
  } else clear(banks, h("p", { class: "muted small" }, "No banks yet. Add your bank, and your investment account if you have one."));

  const add = h("button", { class: "btn primary big", on: { click: () => link(add, null, "") } }, "Add a bank") as HTMLButtonElement;
  const addInv = h("button", { class: "btn ghost", on: { click: () => link(addInv, null, "", "investments") } }, "Add an investment account (Robinhood…)") as HTMLButtonElement;
  clear(body, banks, add, addInv,
    h("p", { class: "muted small" }, sandbox ? "Sandbox: test banks only, as many as you like." : "Each bank login you add uses one of your Plaid plan's Items (a Trial has 10, and removing one doesn't free it). If a bank signs Hearth out, use Reconnect instead of adding it again."),
    err);
  D.openSheet(t.label, [
    h("button", { class: "btn ghost", on: { click: () => { stop(); D.back(); } } }, icon("back", 16), "All connectors"),
    h("div", { class: "phero" }, logo(t.id, 52), h("b", null, t.state === "connected" ? "Your banks" : "Plaid keys saved"), h("small", { class: t.state === "needs-you" && /sign in again/.test(t.detail || "") ? "err" : "" }, t.detail || t.blurb)),
    body,
    h("p", { class: "muted small" }, "Read-only: balances, transactions, card details and investments. Teammates can watch for new transactions; Hearth can't move money or trade."),
    h("button", { class: "btn danger-ghost", on: { click: () => D.confirmSheet("Disconnect Plaid?", "Every bank is removed at Plaid and the keys leave the hub. On a Trial plan the slots don't come back.", "Disconnect", async () => { stop(); await call("/api/connectors/plaid", { method: "DELETE" }); toast("Plaid disconnected"); D.back(); }) } }, "Disconnect Plaid"),
    h("p", { class: "muted small" }, "Kept encrypted in your hub's vault. It never goes to the model, this app or your exports."),
  ], { onClose: stop });
}

function plaidKeys(t: Tile) {
  const id = h("input", { class: "field mono", placeholder: "client_id", autocomplete: "off", autocapitalize: "off", spellcheck: false }) as HTMLInputElement;
  const secret = h("input", { class: "field mono", type: "password", placeholder: "secret", autocomplete: "off", autocapitalize: "off", spellcheck: false }) as HTMLInputElement;
  let env: "sandbox" | "production" = "sandbox";
  const tabs = h("div", { class: "wa-tabs" });
  const drawTabs = () => clear(tabs, ([["sandbox", "Sandbox (test)"], ["production", "Production (real)"]] as const).map(([k, label]) =>
    h("button", { class: `wa-tab ${env === k ? "on" : ""}`, on: { click: () => { env = k; drawTabs(); } } }, label)));
  drawTabs();
  const err = h("p", { class: "err small", hidden: true });
  const save = h("button", { class: "btn primary big", on: { click: async () => {
    if (!id.value.trim()) return id.focus();
    if (!secret.value.trim()) return secret.focus();
    save.disabled = true; save.textContent = "Checking with Plaid…"; err.hidden = true;
    try { await call("/api/connectors/plaid", { method: "PUT", body: { auth: { clientId: id.value.trim(), secret: secret.value.trim(), env } } }); toast("Plaid keys saved"); reloadPlaid(); }
    catch (e: any) { err.textContent = e.message; err.hidden = false; save.disabled = false; save.textContent = "Save keys"; }
  } } }, "Save keys") as HTMLButtonElement;
  D.openSheet(t.label, [
    h("button", { class: "btn ghost", on: { click: D.back } }, icon("back", 16), "All connectors"),
    h("div", { class: "phero" }, logo(t.id, 52), h("b", null, "Connect your banks"), h("small", null, t.blurb)),
    h("ol", { class: "steps" },
      h("li", null, "Make a free account at ", h("a", { href: "https://dashboard.plaid.com/signup", target: "_blank", rel: "noopener noreferrer" }, "dashboard.plaid.com"), ". For your real banks, apply for the free Trial plan there (10 bank logins)."),
      h("li", null, "Open ", h("a", { href: t.getFrom || "https://dashboard.plaid.com/developers/keys", target: "_blank", rel: "noopener noreferrer" }, "Developers → Keys"), " and copy your client_id and the secret for the environment you pick below."),
      h("li", null, "Start with Sandbox to try it out; switch to Production once your Trial is approved.")),
    tabs, id, secret, err, save,
    h("p", { class: "muted small" }, "Kept encrypted in your hub's vault. It never goes to the model, this app or your exports."),
  ]);
}

// ---------- WhatsApp: link by QR, then choose what to ignore ----------

async function whatsappSheet() {
  const body = h("div", { class: "wa" });
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  let last = "";
  // A new code with fresh keys, for when the phone won't take this one (or it's gone stale).
  const refresh = h("button", { class: "btn ghost", on: { click: async (e: Event) => {
    const b = e.currentTarget as HTMLButtonElement; b.disabled = true;
    try { await call("/api/whatsapp/relink", { body: {} }); toast("Getting a new code…"); } catch (x) { D.handleError(x); }
    b.disabled = false; void draw(true);
  } } }, icon("refresh", 16), "Get a new code");
  const draw = async (force = false) => {
    let s: any;
    try { s = await call("/api/whatsapp"); } catch (e) { stop(); return D.handleError(e); }
    // Only redraw when something changed, so a button isn't swapped out under your finger. Once linked, WhatsApp's
    // recent-chats sync keeps landing for a while, so the chat counts are part of the key too.
    const chats: any[] = s.chats || [];
    const key = `${s.state}|${s.syncing ? 1 : 0}|${s.qr || ""}|${s.detail || ""}|${chats.length}|${chats.filter((c) => c.lastAt).length}`;
    if (!force && key === last) return;
    // Don't redraw the list under someone typing a search or keyword.
    if (!force && s.state === "connected" && last.startsWith("connected|") && body.contains(document.activeElement) && document.activeElement?.tagName === "INPUT") return;
    last = key;
    if (s.state === "connected") return clear(body, ...linked(s));
    clear(body,
      h("div", { class: "phero" }, logo("whatsapp", 52), h("b", null, "Link WhatsApp"), h("small", null, "Like WhatsApp Web: your number stays on your phone.")),
      s.state === "qr" && s.qr ? [
        h("ol", { class: "steps" }, h("li", null, "On your phone, open WhatsApp → Settings → Linked devices."), h("li", null, "Tap Link a device and scan this code.")),
        qrImage(s.qr),
        refresh,
      ] : s.state === "off" || s.state === "signed-out" || s.state === "error" ? [
        s.detail ? h("p", { class: "err small" }, s.detail) : null,
        h("button", { class: "btn primary big", on: { click: async (e: Event) => {
          (e.currentTarget as HTMLButtonElement).disabled = true;
          try { await call("/api/connectors/whatsapp", { method: "PUT", body: {} }); } catch (x) { D.handleError(x); }
          void draw(true);
        } } }, "Show the QR code"),
        s.state === "off" ? null : refresh,
      ] : [h("p", { class: "muted" }, "Connecting to WhatsApp…"), refresh],
    );
  };
  D.openSheet("WhatsApp", [h("button", { class: "btn ghost", on: { click: () => { stop(); D.back(); } } }, icon("back", 16), "All connectors"), body], { onClose: stop });
  await draw();
  timer = setInterval(() => void draw(), 2000);
}

function qrImage(text: string) {
  // The hub draws QR codes for pairing already; render this one on a canvas without any library.
  const wrap = h("div", { class: "waqr" });
  call(`/api/whatsapp/qr?text=${encodeURIComponent(text)}`).then((r) => { const img = h("img", { src: r.dataUrl, alt: "WhatsApp link code" }); wrap.append(img); }).catch(() => wrap.append(h("p", { class: "muted small" }, "Couldn't draw the code. Run `hearth connect whatsapp` on the hub instead.")));
  return wrap;
}

// Linked: your chats, like WhatsApp Web's list, each with Ignore. Rules that aren't one chat (all groups, archived,
// muted, words) sit under "More". Typing in search or switching tabs redraws only the list, so focus stays put.
function linked(s: any): any[] {
  const r = s.rules;
  const chats: any[] = s.chats || [];
  // Ignoring a chat or flipping a rule updates the list in place, so your search, tab and scroll stay where they were.
  const edit = async (kind: string, value: string, remove = false) => {
    try { const res = await call("/api/whatsapp/ignore", { body: { kind, value, remove } }); Object.assign(r, res.rules); if (kind === "keyword") return void whatsappSheet(); drawTabs(); drawList(); }
    catch (e) { D.handleError(e); }
  };
  const save = async (patch: any) => { try { const res = await call("/api/whatsapp/ignore", { method: "PUT", body: patch }); Object.assign(r, res.rules); drawTabs(); drawList(); } catch (e) { D.handleError(e); } };
  const isIgnored = (c: any) => r.contacts.includes(c.jid) || r.groups.includes(c.jid) || (c.group && r.allGroups);
  const byRule = (c: any) => !r.contacts.includes(c.jid) && !r.groups.includes(c.jid);
  let q = "", tab: "all" | "groups" | "ignored" = "all";
  const list = h("div", { class: "wa-list" });
  const time = (ms?: number) => {
    if (!ms) return "";
    const d = new Date(ms), now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const days = (now.getTime() - ms) / 864e5;
    return days < 7 ? d.toLocaleDateString([], { weekday: "short" }) : d.toLocaleDateString([], { day: "numeric", month: "short" });
  };
  const avatar = (c: any) => h("span", { class: `wa-av ${c.group ? "g" : ""}` }, c.group ? icon("users", 18) : (c.name.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 1) || "#").toUpperCase());
  // Like your phone: chats with recent activity, newest first. Everything else (old groups, unnamed ones) is found
  // by searching, so thousands of groups don't bury the ones you actually use.
  const named = (c: any) => !/^\d{6,}$/.test(c.name);
  const drawList = () => {
    const inTab = (c: any) => tab === "all" ? !!c.lastAt : tab === "groups" ? c.group && !!c.lastAt : isIgnored(c);
    const shown = chats.filter((c) => q ? c.name.toLowerCase().includes(q) && (named(c) || c.name.includes(q)) && (tab !== "ignored" || isIgnored(c)) && (tab !== "groups" || c.group) : inTab(c));
    clear(list, shown.length ? shown.slice(0, 300).map((c) => {
      const off = isIgnored(c);
      return h("div", { class: `wa-row ${off ? "off" : ""}` },
        avatar(c),
        h("span", { class: "grow" },
          h("span", { class: "wa-top" }, h("b", null, c.name), h("time", null, time(c.lastAt))),
          h("small", null, off ? (c.group && r.allGroups && byRule(c) ? "Ignored · all groups are ignored" : "Ignored · Hearth never sees it") : c.lastCallAt && c.lastCallAt >= (c.lastAt || 0) ? (c.group ? "Group call" : "Call") : c.last || (c.group ? "Group" : "Chat"))),
        c.group && r.allGroups && byRule(c) ? null
          : h("button", { class: `wa-btn ${off ? "on" : ""}`, on: { click: () => edit(c.group ? "group" : "contact", c.jid, off) } }, off ? "Ignored" : "Ignore"));
    }) : h("p", { class: "wa-empty" }, q ? "No chats match." : tab === "ignored" ? "Nothing ignored yet. Tap Ignore on any chat."
      : s.syncing ? "Your chats will appear here in a moment."
      : "Your recent chats show up here as messages come in. Search to find any chat or group."));
  };
  const tabs = h("div", { class: "wa-tabs" });
  const drawTabs = () => {
    const n = chats.filter(isIgnored).length;
    clear(tabs, ([["all", "All"], ["groups", "Groups"], ["ignored", n ? `Ignored ${n}` : "Ignored"]] as const).map(([k, label]) =>
      h("button", { class: `wa-tab ${tab === k ? "on" : ""}`, on: { click: () => { tab = k; drawTabs(); drawList(); } } }, label)));
  };
  const search = h("input", { class: "wa-search", placeholder: `Search all ${chats.length > 50 ? chats.length + " " : ""}chats and groups`, type: "search", on: { input: (e: Event) => { q = (e.target as HTMLInputElement).value.trim().toLowerCase(); drawList(); } } });
  drawTabs(); drawList();
  const sw = (label: string, sub: string, on: boolean, key: string) => h("label", { class: "wa-rule" }, h("span", { class: "grow" }, h("b", null, label), h("small", null, sub)),
    h("input", { type: "checkbox", class: "wa-switch", checked: on, on: { change: (e: Event) => save({ [key]: (e.target as HTMLInputElement).checked }) } }));
  const word = h("input", { class: "wa-search", placeholder: "Ignore messages containing… (like OTP)" }) as HTMLInputElement;
  const phone = s.me ? `+${s.me}` : "";
  return [
    h("div", { class: "wa-head" }, logo("whatsapp", 40), h("span", { class: "grow" }, h("b", null, "WhatsApp is linked"), h("small", null, `${phone ? phone + " · " : ""}Teammates read new messages and only send after you Approve`))),
    h("p", { class: "wa-note" }, "Ignore a chat and its messages never reach Hearth: not stored, never shown to a model."),
    // Linked before Hearth kept track of recent chats: WhatsApp only sends that list while linking, so offer a relink.
    // A new link: WhatsApp is still sending your chats.
    s.syncing ? h("div", { class: "wa-relink" }, h("span", { class: "spin" }),
      h("span", { class: "grow" }, h("b", null, "Loading your chats from WhatsApp…"),
        h("small", null, "Usually under a minute. Keep this open; the list fills in as they arrive."))) :
    chats.filter((c) => c.lastAt).length < 5 ? h("div", { class: "wa-relink" },
      h("span", { class: "grow" }, h("b", null, "Load your recent chats"),
        h("small", null, "WhatsApp sends your recent chats only while linking. Relink once (scan the QR again, about 20 seconds) and this list matches your phone. Messages Hearth kept so far are cleared; ignore settings stay.")),
      h("button", { class: "wa-btn dark", on: { click: async (e: Event) => {
        (e.currentTarget as HTMLButtonElement).disabled = true;
        try { await call("/api/connectors/whatsapp", { method: "DELETE" }); await call("/api/connectors/whatsapp", { method: "PUT", body: {} }); } catch (x) { D.handleError(x); }
        void whatsappSheet();
      } } }, "Relink")) : null,
    search, tabs, list,
    h("details", { class: "wa-more" }, h("summary", null, "More ways to ignore"),
      h("div", { class: "wcard" },
        sw("All groups", "Every group chat, now and later", r.allGroups, "allGroups"),
        sw("Archived chats", "Whatever you've archived in WhatsApp", r.archived, "archived"),
        sw("Muted chats", "Whatever you've muted in WhatsApp", r.muted, "muted")),
      h("div", { class: "wa-words" }, word, h("button", { class: "wa-btn", on: { click: () => word.value.trim() && edit("keyword", word.value.trim()) } }, "Add")),
      r.keywords.length ? h("div", { class: "chips" }, r.keywords.map((k: string) => h("span", { class: "chip" }, `“${k}”`, h("button", { class: "chipx", title: "Stop ignoring", on: { click: () => edit("keyword", k, true) } }, icon("x", 12))))) : null),
    h("button", { class: "wa-unlink", on: { click: () => D.confirmSheet("Unlink WhatsApp?", "Hearth signs out of WhatsApp and deletes the messages it kept.", "Unlink", async () => { await call("/api/connectors/whatsapp", { method: "DELETE" }); toast("WhatsApp unlinked"); D.back(); }) } }, "Unlink WhatsApp"),
  ];
}
