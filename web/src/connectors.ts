import { h, clear, icon, toast } from "./dom.ts";
import { call } from "./api.ts";

// The connector grid (Settings → Connectors → Available) and the setup sheets for the connectors that came with it:
// brains (Claude Code, Codex), keys (Serper, Deepgram), WhatsApp (QR + ignore list) and Slack. Every tile comes from
// the hub's /api/connectors, so the grid, the API and the `hearth` CLI always agree. app.ts hands in its sheet helpers
// and the screens it already has (Google, cookies, voice).

export type Tile = {
  id: string; label: string; kind: "brain" | "key" | "account"; how: string; blurb: string; risk?: string; getFrom?: string;
  state: "connected" | "off" | "needs-you" | "not-installed"; detail: string | null; riskAccepted?: boolean; usage?: Usage | null;
};
type Usage = { harness: string; percent: number; full: boolean; fullUntil: number | null; plan: string | null; detail: string | null; windows: { label: string; usedPercent: number; resetsAt: number | null }[] };

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
  /** app.ts's own logo for ids it draws (LinkedIn, Instagram, Gmail…), or null. */
  logo(id: string, size: number): HTMLElement | null;
};
let D: Deps;
export function initConnectors(deps: Deps) { D = deps; }

// ---------- logos (simple SVG marks, no images) ----------

type Shape = [string, Record<string, string | number>, string?];
const LOGOS: Record<string, { bg: string; shapes: Shape[] }> = {
  claude: { bg: "#D97757", shapes: [["path", { d: "M12 4v16M4 12h16M6.3 6.3l11.4 11.4M17.7 6.3 6.3 17.7", stroke: "#fff", "stroke-width": 2.2, "stroke-linecap": "round" }]] },
  codex: { bg: "#111", shapes: [["path", { d: "M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12", fill: "none", stroke: "#fff", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" }]] },
  serper: { bg: "#1A73E8", shapes: [["circle", { cx: 10.5, cy: 10.5, r: 5, fill: "none", stroke: "#fff", "stroke-width": 2.2 }], ["path", { d: "M14.5 14.5 19 19", stroke: "#fff", "stroke-width": 2.4, "stroke-linecap": "round" }]] },
  deepgram: { bg: "#13EF93", shapes: [["path", { d: "M6 10v4M9 7v10M12 9v6M15 5v14M18 10v4", stroke: "#0b2a1c", "stroke-width": 2, "stroke-linecap": "round" }]] },
  whatsapp: { bg: "#25D366", shapes: [["path", { d: "M12 4.5a7.5 7.5 0 0 0-6.4 11.4L4.5 19.5l3.7-1.1A7.5 7.5 0 1 0 12 4.5z", fill: "none", stroke: "#fff", "stroke-width": 1.8, "stroke-linejoin": "round" }],
    ["path", { d: "M9.3 9.2c.3 2.6 2.4 4.8 5.2 5.4", fill: "none", stroke: "#fff", "stroke-width": 1.8, "stroke-linecap": "round" }]] },
  slack: { bg: "#4A154B", shapes: [["path", { d: "M10 4.5v6M14 13.5v6M4.5 14h6M13.5 10h6", stroke: "#fff", "stroke-width": 2.6, "stroke-linecap": "round" }]] },
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
  ["Messaging & social", (t) => t.kind === "account"],
];
const STATE_LABEL: Record<Tile["state"], string> = { connected: "Connected", off: "Add", "needs-you": "Needs you", "not-installed": "Not installed" };

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
        t.risk ? h("span", { class: "cgrisk", title: "Unofficial: uses your own login" }, "!") : null)))];
  }));
}

const usageLine = (u: Usage) => (u.full ? "At its limit" : u.windows.length ? `${u.percent}% of ${u.windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a)).label} used` : u.detail || "Usage shows after its next job");

export function openTile(t: Tile) {
  if (t.risk && !t.riskAccepted && t.state !== "connected") return riskSheet(t, () => openTile({ ...t, riskAccepted: true }));
  switch (t.id) {
    case "claude": case "codex": return brainSheet(t);
    case "deepgram": return D.openVoice();
    case "google": return D.openGoogle();
    case "instagram": case "linkedin": return D.openCookies(t.id);
    case "whatsapp": return whatsappSheet();
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
  if (!u.windows.length) return h("p", { class: "muted small" }, u.detail || "Usage shows after its next job.");
  return h("div", { class: "ubars" }, u.windows.map((w) => h("div", { class: "ubar" },
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
  D.openSheet(t.label, [
    h("button", { class: "btn ghost", on: { click: D.back } }, icon("back", 16), "All connectors"),
    h("div", { class: "phero" }, logo(t.id, 52), h("b", null, picked ? `${t.label} is one of your brains` : t.label), h("small", null, t.detail || t.blurb)),
    picked && usage ? [h("h4", null, `Live usage${usage.plan ? ` · ${usage.plan}` : ""}`), bars(usage),
      h("p", { class: "muted small" }, "With more than one brain, each job goes to whichever has the most room on its plan right now.")] : null,
    t.state === "needs-you" || t.state === "off" ? [
      h("h4", null, t.state === "needs-you" ? "Sign it in on the hub" : "Use it"),
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
    "OAuth & Permissions → User Token Scopes: im:history, im:read, users:read, search:read (add chat:write only if teammates may send, after your Approve).",
    "Install to Workspace, copy the User OAuth Token, and paste it here."] },
};

function keySheet(t: Tile) {
  const help = KEY_HELP[t.id] ?? { field: "key" as const, placeholder: `${t.label} key`, steps: [] };
  const input = h("input", { class: "field", type: "password", placeholder: help.placeholder, autocomplete: "off", autocapitalize: "off", spellcheck: false }) as HTMLInputElement;
  const err = h("p", { class: "err small", hidden: true });
  const save = h("button", { class: "btn primary big", on: { click: async () => {
    if (!input.value.trim()) return input.focus();
    save.disabled = true; save.textContent = `Checking with ${t.label}…`; err.hidden = true;
    try { await call(`/api/connectors/${t.id}`, { method: "PUT", body: { [help.field]: input.value.trim() } }); toast(`${t.label} connected`); D.back(); }
    catch (e: any) { err.textContent = e.message; err.hidden = false; save.disabled = false; save.textContent = "Connect"; }
  } } }, "Connect");
  D.openSheet(t.label, [
    h("button", { class: "btn ghost", on: { click: D.back } }, icon("back", 16), "All connectors"),
    h("div", { class: "phero" }, logo(t.id, 52), h("b", null, t.state === "connected" ? `${t.label} is connected` : `Connect ${t.label}`), h("small", null, t.state === "connected" ? t.detail || "" : t.blurb)),
    t.state === "connected"
      ? h("button", { class: "btn danger-ghost", on: { click: () => D.confirmSheet(`Disconnect ${t.label}?`, "The key is removed from the hub.", "Disconnect", async () => { await call(`/api/connectors/${t.id}`, { method: "DELETE" }); toast(`${t.label} disconnected`); D.back(); }) } }, `Disconnect ${t.label}`)
      : [help.steps.length ? h("ol", { class: "steps" }, help.steps.map((s, i) => h("li", null, i === 0 && t.getFrom ? [h("a", { href: t.getFrom, target: "_blank", rel: "noopener noreferrer" }, t.getFrom.replace(/^https:\/\//, "")), " · ", s] : s))) : null,
        input, err, save],
    h("p", { class: "muted small" }, "Kept encrypted in your hub's vault. It never goes to the model, this app or your exports."),
  ]);
}

// ---------- WhatsApp: link by QR, then choose what to ignore ----------

async function whatsappSheet() {
  const body = h("div", { class: "wa" });
  let timer: ReturnType<typeof setInterval> | null = null;
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  let last = "";
  const draw = async (force = false) => {
    let s: any;
    try { s = await call("/api/whatsapp"); } catch (e) { stop(); return D.handleError(e); }
    // Only redraw when something changed, so a button isn't swapped out under your finger.
    const key = `${s.state}|${s.qr || ""}|${s.detail || ""}`;
    if (!force && key === last) return;
    last = key;
    if (s.state === "connected") { stop(); return clear(body, ...linked(s)); }
    clear(body,
      h("div", { class: "phero" }, logo("whatsapp", 52), h("b", null, "Link WhatsApp"), h("small", null, "Like WhatsApp Web: your number stays on your phone.")),
      s.state === "qr" && s.qr ? [
        h("ol", { class: "steps" }, h("li", null, "On your phone, open WhatsApp → Settings → Linked devices."), h("li", null, "Tap Link a device and scan this code.")),
        qrImage(s.qr),
      ] : s.state === "off" || s.state === "signed-out" || s.state === "error" ? [
        s.detail ? h("p", { class: "err small" }, s.detail) : null,
        h("button", { class: "btn primary big", on: { click: async (e: Event) => {
          (e.currentTarget as HTMLButtonElement).disabled = true;
          try { await call("/api/connectors/whatsapp", { method: "PUT", body: {} }); } catch (x) { D.handleError(x); }
          void draw(true);
        } } }, "Show the QR code"),
      ] : h("p", { class: "muted" }, "Connecting to WhatsApp…"),
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

function linked(s: any): any[] {
  const r = s.rules;
  const chats: any[] = s.chats || [];
  const nameOf = (id: string) => chats.find((c) => c.jid === id)?.name || id.replace(/@.*/, "");
  const save = async (patch: any) => { try { await call("/api/whatsapp/ignore", { method: "PUT", body: patch }); void whatsappSheet(); } catch (e) { D.handleError(e); } };
  const edit = async (kind: string, value: string, remove = false) => { try { await call("/api/whatsapp/ignore", { body: { kind, value, remove } }); void whatsappSheet(); } catch (e) { D.handleError(e); } };
  const chip = (label: string, onX: () => void) => h("span", { class: "chip" }, label, h("button", { class: "chipx", title: "Stop ignoring", on: { click: onX } }, icon("x", 12)));
  const toggle = (label: string, on: boolean, key: string) => h("label", { class: "toggle-row" }, h("span", { class: "grow" }, label),
    h("input", { type: "checkbox", checked: on, on: { change: (e: Event) => save({ [key]: (e.target as HTMLInputElement).checked }) } }));
  const pick = h("select", { class: "field" }, h("option", { value: "" }, "Ignore a chat…"),
    chats.filter((c) => !r.contacts.includes(c.jid) && !r.groups.includes(c.jid)).map((c) => h("option", { value: c.jid }, `${c.group ? "Group · " : ""}${c.name}`))) as HTMLSelectElement;
  pick.onchange = () => { const c = chats.find((x) => x.jid === pick.value); if (c) void edit(c.group ? "group" : "contact", c.jid); };
  const num = h("input", { class: "field", placeholder: "Or a phone number, like +1 555 0100", inputmode: "tel" }) as HTMLInputElement;
  const word = h("input", { class: "field", placeholder: "A word or phrase, like OTP" }) as HTMLInputElement;
  return [
    h("div", { class: "phero" }, logo("whatsapp", 52), h("b", null, "WhatsApp is linked"), h("small", null, s.me ? `+${s.me} · teammates read new messages, and only send after your Approve` : "Linked")),
    h("h4", null, "Ignore"),
    h("p", { class: "muted small" }, "Messages from these never reach Hearth: they aren't stored, and no model sees them."),
    h("div", { class: "list pad" },
      toggle("All groups", r.allGroups, "allGroups"),
      toggle("Archived chats", r.archived, "archived"),
      toggle("Muted chats", r.muted, "muted")),
    h("div", { class: "chips" }, [...r.contacts.map((c: string) => chip(nameOf(c), () => edit("contact", c, true))),
      ...(r.allGroups ? [] : r.groups.map((g: string) => chip(`Group · ${nameOf(g)}`, () => edit("group", g, true)))),
      ...r.keywords.map((k: string) => chip(`“${k}”`, () => edit("keyword", k, true)))]),
    chats.length ? pick : null,
    h("div", { class: "row2" }, num, h("button", { class: "btn ghost", on: { click: () => num.value.trim() && edit("contact", num.value.trim()) } }, "Ignore")),
    h("div", { class: "row2" }, word, h("button", { class: "btn ghost", on: { click: () => word.value.trim() && edit("keyword", word.value.trim()) } }, "Ignore")),
    h("button", { class: "btn danger-ghost", on: { click: () => D.confirmSheet("Unlink WhatsApp?", "Hearth signs out of WhatsApp and deletes the messages it kept.", "Unlink", async () => { await call("/api/connectors/whatsapp", { method: "DELETE" }); toast("WhatsApp unlinked"); D.back(); }) } }, "Unlink WhatsApp"),
  ];
}
