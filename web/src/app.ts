import { h, clear, icon, richText, relTime, shortAgo, clockTime, dayLabel, greeting, toast } from "./dom.ts";
import { activeHub, call, hubs, pair, removeHub, setActive, stream, normalizeUrl, ApiError, authHeaders, passkeysWork, registerPasskey, passkeyProof, unlock, requestAccess, waitForApproval, type HubRef } from "./api.ts";

declare const __BUILD__: string;

// Feels like Slack:
// - Home is a sidebar: "Jump to…" search, your group chats (one per ramble) and direct messages (one per teammate).
// - A ramble opens a new group chat. Hearth posts each task as its own message; under each task you watch the
//   teammate working, then their reply ("1 reply"). Approve / Try again sit right there.
// - Tap a task to open its thread and reply to that teammate. On a wide screen the thread opens beside the chat.
// - Everything else (plans, memory, skills, brains, settings) is behind the menu.

const S = {
  state: null as any,
  roster: [] as any[],
  threads: [] as any[],
  chat: null as any,            // open group chat: { thread, messages, jobs, approvals }
  dm: null as any,              // open DM: { teammate, jobs, messages, routines, approvals }
  inbox: [] as any[],           // Activity tab
  teammates: [] as any[],
  files: new Map<string, any>(),
  apps: [] as any[],
  ideas: [] as any[],
  components: [] as any[],
  progress: new Map<string, string>(), // jobId -> what it's doing right now
  skills: [] as any[],
  workflows: [] as any[],
  hooks: [] as any[],
  memory: null as any,
  memoryQuery: "",
  plansFilter: "",
  today: null as any,
  conn: "connecting" as "live" | "connecting" | "offline",
  planning: null as null | string, // chat id the orchestrator is reading
  updateReady: false,
  sheetOpen: false,
  panel: null as null | "plans" | "memory" | "skills" | "people",
};

let live: ReturnType<typeof stream> | null = null;
const app = document.getElementById("app")!;
type Route = { view: "home" } | { view: "dms" } | { view: "activity" } | { view: "board"; id?: string } | { view: "chat"; id: string; job?: string } | { view: "dm"; id: string } | { view: "app"; id: string };
const route = (): Route => {
  if (location.hash === "#dms") return { view: "dms" };
  if (location.hash === "#activity") return { view: "activity" };
  let m = location.hash.match(/^#c\/([\w-]+)(?:\/([\w-]+))?/);
  if (m) return { view: "chat", id: m[1], job: m[2] };
  m = location.hash.match(/^#a\/([\w-]+)/);
  if (m) return { view: "app", id: m[1] };
  m = location.hash.match(/^#b(?:\/([\w-]+))?$/);
  if (m) return { view: "board", id: m[1] };
  m = location.hash.match(/^#t\/([\w-]+)/);
  return m ? { view: "dm", id: m[1] } : { view: "home" };
};
const wide = () => matchMedia("(min-width: 980px)").matches;

// ---------------- boot ----------------

async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  const pairCode = new URLSearchParams(location.hash.slice(1)).get("pair");
  if (!activeHub() || pairCode) return renderPairing(pairCode || "");
  if (/^#(chat\/|hearth)/.test(location.hash)) history.replaceState(null, "", "#"); // old links
  // Face ID lock: nothing loads until this device unlocks (or sets up Face ID, if the hub requires it).
  try { await call("/api/state"); } catch (e) { if (e instanceof ApiError && e.status === 423) return renderLock(!!e.data?.hasPasskey); }
  const wantsAccess = location.hash === "#access";
  if (wantsAccess) history.replaceState(null, "", "#");
  await Promise.all([refreshState(), loadTeammates(), loadSkills(), loadFiles(), loadApps(), loadIdeas()]);
  show();
  connect();
  if (localStorage.getItem("hearth.autoLocation") === "1") shareLocation(true);
  window.addEventListener("hashchange", show);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { checkForUpdate(); refresh(); live?.restart(); } });
  document.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openJump(); } });
  setInterval(checkForUpdate, 5 * 60_000);
  setInterval(() => { if (route().view === "home") drawHome(); }, 30_000);
  if (wantsAccess || S.state?.pendingAccess) openDevices();
  else if (S.state?.device.primary && !S.state.device.passkey && passkeysWork() && !localStorage.getItem("hearth.faceIdAsked")) {
    localStorage.setItem("hearth.faceIdAsked", "1");
    openSheet("Lock with Face ID?", [
      h("p", { class: "muted" }, "This is your primary device. With Face ID on, a copied key alone can't open your hub, and letting a new device in needs your face."),
      h("div", { class: "row gap" },
        h("button", { class: "btn ghost grow", on: { click: closeSheet } }, "Not now"),
        h("button", { class: "btn primary grow", on: { click: toggleFaceId } }, "Turn on")),
    ]);
  }
}

function renderLock(hasPasskey: boolean) {
  const err = h("p", { class: "error", role: "alert" });
  const btn = h("button", { class: "btn primary big", on: { click: async () => {
    btn.disabled = true; err.textContent = "";
    try { await (hasPasskey ? unlock() : registerPasskey()); location.reload(); }
    catch (ex: any) { err.textContent = ex.message || "That didn't work. Try again."; btn.disabled = false; }
  } } }, icon("lock", 18), hasPasskey ? "Unlock with Face ID" : "Set up Face ID");
  clear(app, h("div", { class: "pairing" },
    h("div", { class: "mark" }, h("img", { src: "/icon.svg", alt: "", width: 72, height: 72 })),
    h("h1", null, "Locked"),
    h("p", { class: "lede" }, hasPasskey ? "Your hub asks for Face ID (or your device's PIN) before it shows anything." : "This hub requires Face ID on every device. Set it up once; it stays on this device."),
    err, btn,
    h("p", { class: "hint" }, passkeysWork() ? "" : "Open this from the hub's own address to use Face ID."),
  ));
}

let lastLayout = "";
function show() {
  closeSheet();
  const r = route();
  // Re-render the skeleton only when the layout changes (opening a thread beside the chat keeps the chat in place).
  const layout = r.view === "chat" ? `chat:${r.id}:${r.job && !wide() ? "thread" : wide() && r.job ? "split" : "chat"}` : r.view === "dm" ? `dm:${r.id}` : r.view === "board" ? `board:${r.id || ""}` : r.view;
  if (layout !== lastLayout) {
    lastLayout = layout;
    if (r.view === "home") renderHome();
    else if (r.view === "dms") renderDms();
    else if (r.view === "activity") renderActivity();
    else if (r.view === "dm") renderDm();
    else if (r.view === "app") renderApp(r.id);
    else if (r.view === "board") renderBoard(r.id);
    else renderChatLayout(r);
  } else if (r.view === "chat") drawChat();
  refresh();
}

function refresh() {
  const r = route();
  loadRoster();
  loadThreads();
  if (r.view === "chat") loadChat(r.id);
  else if (r.view === "dm") loadDm(r.id);
  else if (r.view === "activity") renderActivity();
  else if (r.view === "board") loadBoard();
}

function connect() {
  live?.stop();
  live = stream(onEvent, (s) => { S.conn = s; drawHeader(); });
}

let rosterTimer: ReturnType<typeof setTimeout> | null = null;
function soon() {
  if (rosterTimer) return;
  rosterTimer = setTimeout(() => {
    rosterTimer = null; loadRoster(); loadThreads();
    if (route().view === "activity") call("/api/inbox").then((x: any[]) => { S.inbox = x; drawActivity(); }).catch(() => {});
  }, 250);
}

function onEvent(e: { type: string; data?: any }) {
  const r = route();
  const open = r.view === "chat" ? r.id : null;
  switch (e.type) {
    case "hello": if (e.data?.build && e.data.build !== __BUILD__) markUpdate(); return;
    case "unpaired": toast("This device was signed out of the hub.", "err"); removeHub(activeHub()!.id); location.reload(); return;
    case "locked": location.reload(); return;
    case "access": if (S.state?.device.primary && e.data?.pending) { toast("A new device wants in. Settings → Devices"); refreshState(); } return;
    case "computers": computersChanged(); return;
    case "thinking":
      if (e.data?.on === false) { if (S.planning === e.data.threadId) S.planning = null; }
      else S.planning = e.data?.threadId || null;
      if (open) drawChat(); soon(); return;
    case "message":
      if (open && S.chat && e.data.threadId === open) { upsert(S.chat.messages, e.data); drawChat(); }
      else if (r.view === "dm" && e.data.threadId === `tm-${r.id}`) loadDm(r.id);
      else if (e.data.proactive) toast(e.data.proactive.title);
      soon();
      return;
    case "job": {
      if (r.view === "board") loadBoard();
      // A teammate finished something you're not looking at: an in-app banner you can tap, like a phone notification.
      const was = jobStatus.get(e.data.id);
      jobStatus.set(e.data.id, e.data.status);
      // Tell them unless they're already looking at that very thread (or that DM).
      const here = (r.view === "chat" && r.job && (r.job === e.data.id || r.job === e.data.followsUp)) || (r.view === "dm" && e.data.threadId === `tm-${r.id}`);
      if (was && was !== e.data.status && (e.data.status === "done" || e.data.status === "failed") && !e.data.parentId && !here) {
        const m = mate(e.data.teammateId);
        banner(m, `${m.name} ${e.data.status === "done" ? "finished" : "couldn't finish"}`, jobLabel(e.data),
          () => { location.hash = e.data.threadId.startsWith("tm-") ? `#t/${e.data.teammateId}` : `#c/${e.data.threadId}/${e.data.followsUp || e.data.id}`; });
      }
    }
      if (open && S.chat && e.data.threadId === open) { upsert(S.chat.jobs, e.data); drawChat(false); }
      if (r.view === "dm" && S.dm && e.data.teammateId === r.id) { upsert(S.dm.jobs, e.data); drawDm(false); }
      soon();
      return;
    case "approval":
      if (S.chat) upsert(S.chat.approvals || (S.chat.approvals = []), e.data);
      if (S.dm) upsert(S.dm.approvals, e.data);
      if (open) drawChat(false); else if (r.view === "dm") drawDm(false);
      else if (e.data.status === "pending") toast(`Needs your OK: ${e.data.summary}`);
      soon();
      return;
    case "threads": if (open) markSeen(open); soon(); if (open && S.chat) call("/api/threads").then((l: any[]) => { const t = l.find((x) => x.id === open); if (t && S.chat) { S.chat.thread.title = t.title; drawHeader(); } }).catch(() => {}); return;
    case "teammates": loadTeammates().then(soon); return;
    case "skills": loadSkills(); return;
    case "progress": {
      S.progress.set(e.data.jobId, e.data.text);
      for (const el of document.querySelectorAll<HTMLElement>(`[data-progress="${e.data.jobId}"]`)) el.textContent = e.data.text;
      return;
    }
    case "people": if (S.panel === "people") openPeople(); return;
    case "ideas": loadIdeas().then(() => { if (route().view === "home") drawHome(); }); return;
    case "about": if (S.panel === "memory") loadAbout(); return;
    case "apps": loadApps().then(() => { const r2 = route(); if (r2.view === "app") { toast("Updated"); renderApp(r2.id); } else if (r2.view === "home") { drawPins(); drawHome(); } else if (r2.view === "chat") drawChat(false); else if (r2.view === "dm") drawDm(false); }); return;
    case "files": loadFiles().then(() => { const r2 = route(); if (r2.view === "chat") drawChat(false); else if (r2.view === "dm") drawDm(false); }); return;
    case "hooks": if (S.panel === "plans") loadHooks(); if (r.view === "dm") loadDm(r.id); return;
    case "memory": if (S.panel === "memory") loadMemory(); return;
    case "scripts": refreshState(); return;
    case "reset": refresh(); return;
  }
}

function upsert(list: any[], item: any) {
  const i = list.findIndex((x) => x.id === item.id);
  if (i >= 0) list[i] = item; else list.push(item);
}

async function refreshState() {
  try { S.state = await call("/api/state"); drawHeader(); } catch (e) { handleError(e); }
}

async function loadSkills() {
  try { const r = await call("/api/skills"); S.skills = r.skills; S.workflows = r.workflows; S.components = r.components || []; if (S.panel === "skills") drawSkills(); } catch {}
}

async function loadTeammates() {
  try { S.teammates = await call("/api/teammates"); } catch (e) { handleError(e); }
}

function handleError(err: unknown) {
  if (err instanceof ApiError && err.status === 423) { renderLock(!!err.data?.hasPasskey); return; }
  if (err instanceof ApiError && err.status === 401) {
    toast("This device isn't paired with the hub any more.", "err");
    removeHub(activeHub()!.id);
    setTimeout(() => location.reload(), 1200);
    return;
  }
  if (err instanceof TypeError) { S.conn = "offline"; drawHeader(); return; }
  toast(err instanceof Error ? err.message : "Something went wrong", "err");
}

async function checkForUpdate() {
  try {
    const hub = activeHub();
    if (!hub) return;
    const r = await fetch(hub.url + "/api/health", { cache: "no-store" }).then((r) => r.json());
    if (r.build && r.build !== __BUILD__) markUpdate();
  } catch {}
}

function markUpdate() {
  const busy = S.sheetOpen || recording || !!(document.getElementById("composer") as HTMLTextAreaElement | null)?.value.trim();
  if (!busy && activeHub()?.url === location.origin) { location.reload(); return; }
  S.updateReady = true;
  drawHeader();
}

const mate = (id?: string) => S.roster.find((t) => t.id === (id || "hearth")) || S.teammates.find((t) => t.id === (id || "hearth")) || { id: id || "hearth", name: "Hearth", color: "#F5A524", description: "" };
const role = (t: any) => String(t.description || "").split(/[.,:;]/)[0].slice(0, 32);
const jobState = (j: any) => j.status === "working" ? "working" : j.status === "queued" ? "thinking" : j.status === "waiting" ? "waiting" : j.status === "blocked" ? "blocked" : "idle";

async function loadApps() {
  try { S.apps = await call("/api/apps"); } catch {}
}

async function loadIdeas() {
  try { S.ideas = await call("/api/ideas"); } catch {}
}

/** A 3D emoji (Fluent Emoji 3D, served by the hub); falls back to the plain emoji if there's no picture for it. */
const emojiUrl = (e: string) => `${activeHub()?.url || ""}/emoji/${Array.from(e).map((c) => c.codePointAt(0)!.toString(16)).join("-")}.webp`;
function emoji3d(e: string, cls = "e3d") {
  const span = h("span", { class: cls, role: "img", "aria-label": e });
  const img = h("img", { src: emojiUrl(e), alt: "", decoding: "async" });
  img.addEventListener("error", () => clear(span, e));
  span.appendChild(img);
  return span;
}

async function loadFiles() {
  try { for (const f of await call("/api/files")) S.files.set(f.id, f); } catch {}
}

// ---------------- files: cards with View and Download ----------------

const kb = (n: number) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const fileIcon = (m: string) => m.startsWith("image/") || m.startsWith("video/") ? "eye" : m.startsWith("audio/") ? "mic" : m === "text/calendar" ? "clock" : m.includes("pdf") ? "download" : "code";
const viewable = (m: string) => /^(image\/(png|jpeg|gif|webp|heic|avif)|application\/pdf|text\/(plain|markdown|csv|tab-separated-values|calendar)|application\/json|audio\/|video\/)/.test(m);

async function fileBlob(f: any, inline: boolean) {
  const hub = activeHub()!;
  const res = await fetch(`${hub.url}/api/files/${f.id}${inline ? "?inline=1" : ""}`, { headers: authHeaders(hub) });
  if (!res.ok) throw new Error("Couldn't fetch the file");
  return new Blob([await res.arrayBuffer()], { type: inline ? f.mime : "application/octet-stream" });
}

async function downloadFile(f: any) {
  try {
    const url = URL.createObjectURL(await fileBlob(f, false));
    const a = h("a", { href: url, download: f.name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) { handleError(e); }
}

/** A file shown in the app: rendered Markdown, a video/audio player, CSV as a table, calendar invites as events. */
async function viewFile(f: any) {
  try {
    const blob = await fileBlob(f, true);
    const url = URL.createObjectURL(blob);
    const m: string = f.mime;
    if (m === "application/pdf") { window.open(url, "_blank", "noopener"); setTimeout(() => URL.revokeObjectURL(url), 60_000); return; }
    const big = (t: string) => (t.length > 400_000 ? `${t.slice(0, 400_000)}\n\n… (cut here; download for the rest)` : t);
    let view: Node;
    if (m.startsWith("image/")) view = h("img", { src: url, alt: f.name, class: "file-preview" });
    else if (m.startsWith("video/")) view = h("video", { src: url, controls: true, playsInline: true, preload: "metadata", class: "file-preview" });
    else if (m.startsWith("audio/")) view = h("div", { class: "file-audio" }, h("span", { class: "ficon big" }, icon("mic", 26)), h("audio", { src: url, controls: true, preload: "metadata" }));
    else {
      const text = big(await blob.text());
      if (m === "text/markdown") view = h("div", { class: "doc" }, richText(text));
      else if (m === "text/csv" || m === "text/tab-separated-values") view = csvTable(text, m === "text/csv" ? "," : "\t");
      else if (m === "text/calendar") view = icsView(text);
      else if (m === "application/json") { let t = text; try { t = JSON.stringify(JSON.parse(text), null, 2); } catch {} view = h("pre", { class: "code" }, t); }
      else view = h("pre", { class: /\.(md|txt|log)$/i.test(f.name) ? "output" : "code" }, text);
    }
    openSheet(f.name, [view, h("button", { class: "btn primary big", on: { click: () => downloadFile(f) } }, icon("download", 16), "Download")],
      { onClose: () => URL.revokeObjectURL(url) });
  } catch (e) { handleError(e); }
}

/** CSV/TSV as a scrollable table (quotes handled; first row is the header). */
function csvTable(text: string, sep: string) {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length && rows.length < 2000; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head = [], ...body] = rows.filter((r) => r.some((c) => c.trim()));
  return h("div", { class: "tablewrap" }, h("table", null,
    h("thead", null, h("tr", null, head.map((c) => h("th", null, c)))),
    h("tbody", null, body.map((r) => h("tr", null, head.map((_, k) => h("td", null, r[k] || "")))))),
    h("p", { class: "muted small" }, `${body.length} row${body.length === 1 ? "" : "s"}`));
}

/** A calendar invite as readable events; Download adds it to your calendar. */
function icsView(text: string) {
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const events = unfolded.split("BEGIN:VEVENT").slice(1).map((e) => {
    const get = (k: string) => (e.match(new RegExp(`^${k}(?:;[^:\\n]*)?:(.*)$`, "m"))?.[1] || "").replace(/\\n/g, "\n").replace(/\\([,;\\])/g, "$1").trim();
    const when = (v: string) => { const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?(Z?)/); if (!m) return v; const d = m[4] ? new Date(m[6] ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime()) : new Date(+m[1], +m[2] - 1, +m[3]); return d.toLocaleString(undefined, m[4] ? { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } : { weekday: "short", month: "short", day: "numeric" }); };
    return { title: get("SUMMARY") || "Event", start: when(get("DTSTART")), end: get("DTEND") ? when(get("DTEND")) : "", where: get("LOCATION"), notes: get("DESCRIPTION") };
  });
  if (!events.length) return h("pre", { class: "code" }, text);
  return h("div", { class: "events" }, events.slice(0, 50).map((e) => h("div", { class: "event" },
    h("b", null, e.title), h("small", null, [e.start, e.end && e.end !== e.start ? `– ${e.end}` : ""].filter(Boolean).join(" ")),
    e.where ? h("small", null, e.where) : null, e.notes ? h("p", null, e.notes.slice(0, 600)) : null)),
    h("p", { class: "muted small" }, "Download to add it to your calendar."));
}

function fileCard(id: string) {
  const f = S.files.get(id);
  if (!f) return null;
  return h("div", { class: "filecard" },
    h("span", { class: "ficon" }, icon(fileIcon(f.mime), 18)),
    h("span", { class: "grow" }, h("b", null, f.name), h("small", null, `${kb(f.size)}${f.source === "you" ? " · from you" : ""}`)),
    viewable(f.mime) ? h("button", { class: "btn ghost small", on: { click: () => viewFile(f) } }, "View") : null,
    h("button", { class: "btn ghost small", "aria-label": `Download ${f.name}`, on: { click: () => downloadFile(f) } }, icon("download", 15)));
}

function openFiles() {
  const list = [...S.files.values()];
  openSheet("Files", [
    h("p", { class: "muted" }, "Everything you attached and everything your teammates made. Stored on your hub."),
    list.length ? list.map((f) => h("div", { class: "filerow" }, fileCard(f.id), h("button", { class: "iconbtn", "aria-label": `Delete ${f.name}`, on: { click: () => confirmSheet(`Delete ${f.name}?`, "It's removed from your hub.", "Delete", async () => { await call(`/api/files/${f.id}`, { method: "DELETE" }); S.files.delete(f.id); }) } }, icon("trash", 16))))
      : h("p", { class: "empty" }, "No files yet."),
  ]);
}

async function loadRoster() {
  try { S.roster = await call("/api/roster"); const v = route().view; if (v === "home") drawHome(); else if (v === "dms") drawDms(); drawHeader(); } catch (e) { handleError(e); }
}

async function loadThreads() {
  try { S.threads = await call("/api/threads"); if (route().view === "home") drawHome(); } catch (e) { handleError(e); }
}

// ---------------- chrome: floating glass header, tab bar, search (Slack mobile) ----------------

const tabOf = (r: Route) => (r.view === "dms" || r.view === "dm" ? "dms" : r.view === "activity" ? "activity" : "home");

/** The frame every screen shares: content scrolls under a glass header and a glass tab bar. */
function frame(opts: { header: Node; body: Node; composer?: boolean; fab?: boolean; purple?: boolean }) {
  const r = route();
  const tab = tabOf(r);
  const tabs = h("nav", { class: "tabbar" },
    h("div", { class: "tabs glass" },
      ([["home", "Home", "home", ""], ["dms", "DMs", "dms", "#dms"], ["activity", "Activity", "bell", "#activity"]] as const).map(([id, label, ic, hash]) =>
        h("button", { class: `tab ${tab === id ? "on" : ""}`, on: { click: () => { location.hash = hash; } } },
          h("span", { class: "tabicon" }, icon(ic, 24), id === "activity" && needsYouCount() ? h("i", { class: "dot" }) : null), h("span", null, label)))),
    h("button", { class: "searchbtn glass", "aria-label": "Search (⌘K)", on: { click: openJump } }, icon("search", 24)));
  clear(app,
    h("div", { class: `screen ${opts.purple ? "purple" : ""}` },
      h("main", { class: "scroll", id: "scroll" }, opts.body),
      h("header", { class: "chrome-top", id: "top" }, opts.header),
      h("footer", { class: "chrome-bottom" },
        opts.fab ? h("button", { class: "fab", "aria-label": "New ramble", on: { click: () => { location.hash = "#c/new"; } } }, icon("plus", 26)) : null,
        opts.composer ? h("div", { class: "composer-wrap", id: "composerwrap" }) : null,
        tabs)));
  if (opts.composer) renderComposer();
}

function needsYouCount() {
  return S.roster.reduce((n, t) => n + (t.needsYou || 0), 0);
}

function userAvatar(size = 40) {
  const name = S.state?.prefs?.userName || "You";
  return h("span", { class: "uavatar", style: `--s:${size}px` }, name[0].toUpperCase());
}

function drawHeader() {
  const r = route();
  const top = document.getElementById("top");
  if (!top) return;
  if (r.view === "home" || r.view === "dms" || r.view === "activity") {
    const left = h("button", { class: "circle glass", "aria-label": "Menu", on: { click: openMenu } }, icon("filter", 22), (S.state?.pendingScripts || 0) ? h("i", { class: "dot" }) : null);
    const right = h("div", { class: "pillgroup glass" },
      S.updateReady ? h("button", { class: "pillbtn", on: { click: () => location.reload() } }, "Update") : null,
      h("button", { class: "pillbtn", "aria-label": "You", on: { click: openSettings } }, userAvatar(36)));
    if (r.view === "home") {
      const hearth = rosterEntry("hearth");
      clear(top, h("div", { class: "toprow stagerow" }, left,
        stage("home", hearth, S.planning ? "thinking" : hearth.state || "idle", S.state?.hub?.name || "Hearth", null, openHubs, true), right));
      return;
    }
    clear(top, h("div", { class: "toprow big" }, left, h("h1", null, r.view === "dms" ? "DMs" : "Activity"), right));
    return;
  }
  const back = h("button", { class: "circle glass", "aria-label": "Back", on: { click: () => { history.length > 1 ? history.back() : (location.hash = ""); } } }, icon("back", 24));
  const search = h("button", { class: "circle glass", "aria-label": "Search", on: { click: openJump } }, icon("search", 21));
  if (r.view === "dm") {
    const t = rosterEntry(r.id);
    clear(top, h("div", { class: "toprow stagerow" }, back, stage("dm", t, t.state || "idle", t.name, t.status || role(t), () => { location.hash = `#b/${t.id}`; }),
      h("button", { class: "circle glass", "aria-label": `${t.name}'s board`, on: { click: () => { location.hash = `#b/${t.id}`; } } }, icon("board", 21))));
    return;
  }
  if (r.view === "board") {
    const t = r.id ? rosterEntry(r.id) : null;
    const others = t ? [] : S.roster.filter((x) => x.busy || x.needsYou).slice(0, 3);
    clear(top, h("div", { class: "toprow stagerow" }, back,
      t ? stage("board", t, t.state || "idle", `${t.name}'s board`, role(t), () => { location.hash = `#t/${t.id}`; })
        : stage("board", rosterEntry("hearth"), "idle", "Everyone's board", "All teammates", null, false, others),
      t ? h("button", { class: "circle glass", "aria-label": `Message ${t.name}`, on: { click: () => { location.hash = `#t/${t.id}`; } } }, icon("dms", 21)) : search));
    return;
  }
  const chat = S.chat;
  const name = chat?.thread ? channelName(chat.thread) : "new-ramble";
  if (r.view === "chat" && r.job) {
    const j = chat?.jobs?.find((x: any) => x.id === r.job);
    const t = mate(j?.teammateId);
    clear(top, h("div", { class: "toprow stagerow" }, back, stage("chat", t, j ? jobState(j) : "idle", t.name, `Thread in #${name}`, null), search));
    return;
  }
  // A ramble: Hearth while it's sorting things out, then whoever is doing the work takes the stage.
  // Two or more at work: they all stand on the stage, each acting out its own state; tap one for its thread.
  const jobs = (chat?.jobs || []).filter((j: any) => !j.parentId);
  const open = jobs.filter((j: any) => !["done", "failed"].includes(j.status)).length;
  const busy = activeMates(chat);
  if (busy.length >= 2 && !(chat?.thread && S.planning === chat.thread.id)) {
    stages.delete("chat");
    const names = busy.length === 2 ? `${busy[0].t.name} & ${busy[1].t.name}` : `${busy[0].t.name}, ${busy[1].t.name} +${busy.length - 2}`;
    clear(top, h("div", { class: "toprow stagerow" }, back,
      h("div", { class: "stage crowd" },
        h("div", { class: "crowdfaces" }, busy.slice(0, 4).map((a) =>
          h("button", { class: "crowdface", "aria-label": `${a.t.name}: open thread`, on: { click: () => { location.hash = `#c/${chat.thread.id}/${a.jobId}`; } } }, face(a.t, 46, a.state)))),
        h("button", { class: "stagepill", on: { click: chatMenu } }, h("b", null, names)),
        h("small", null, [`#${name}`, `${open} working`].join(" · "))),
      h("button", { class: "circle glass", "aria-label": "Files", on: { click: openFiles } }, icon("clip", 21))));
    return;
  }
  const who = speaker(chat);
  const others = [...new Set(jobs.map((j: any) => j.teammateId))].filter((id) => id !== who.t.id).slice(0, 3).map((id) => mate(id as string));
  clear(top, h("div", { class: "toprow stagerow" }, back,
    stage("chat", who.t, who.state, who.t.name, [`#${name}`, open ? `${open} working` : null].filter(Boolean).join(" · "), chatMenu, false, others),
    h("button", { class: "circle glass", "aria-label": "Files", on: { click: openFiles } }, icon("clip", 21))));
}

/** Teammates with something open in this ramble (one entry each, their most recent task), busiest first. */
function activeMates(chat: any): { t: any; state: string; jobId: string }[] {
  const order: Record<string, number> = { working: 0, waiting: 1, blocked: 1, queued: 2 };
  const open = (chat?.jobs || []).filter((j: any) => !j.parentId && j.status in order)
    .sort((a: any, b: any) => order[a.status] - order[b.status] || (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));
  const seen = new Set<string>();
  return open.filter((j: any) => !seen.has(j.teammateId) && seen.add(j.teammateId)).map((j: any) => ({ t: mate(j.teammateId), state: jobState(j), jobId: j.id }));
}

// ---------------- boards: to-dos per teammate (or everyone), Trello-style ----------------

function renderBoard(id?: string) {
  frame({ header: h("div"), body: h("div", { id: "board" }), fab: true });
  drawHeader();
  loadBoard();
}

let boardTimer: ReturnType<typeof setTimeout> | null = null;
async function loadBoard() {
  const r = route();
  if (r.view !== "board") return;
  try { drawBoard(await call(`/api/board${r.id ? `?teammate=${encodeURIComponent(r.id)}` : ""}`), r.id); } catch (e) { handleError(e); }
}

function drawBoard(b: any, teammateId?: string) {
  const el = document.getElementById("board");
  if (!el) return;
  drawHeader();
  const open = (c: any) => {
    if (c.kind === "plan") return openPlans();
    location.hash = c.threadId?.startsWith("tm-") ? `#t/${c.teammateId}` : `#c/${c.threadId}/${c.root}`;
  };
  const card = (c: any) => {
    const t = mate(c.teammateId);
    return h("button", { class: `bcard ${c.status}`, on: { click: () => open(c) } },
      h("span", { class: "btop" }, teammateId ? null : face(t, 22, c.kind === "task" ? jobState({ status: c.status }) : "idle"),
        h("b", null, c.title)),
      c.status === "working" ? h("span", { class: "bline" }, h("span", { "data-progress": c.id }, S.progress.get(c.id) || "On it"), c.startedAt ? h("time", { "data-since": c.startedAt }, elapsed(c.startedAt)) : null)
        : c.need ? h("span", { class: "bline warn" }, `Stuck: ${c.need}`)
        : h("span", { class: "bline" }, [c.where, c.kind === "plan" ? `${dayLabel(c.at)} ${clockTime(c.at)}` : c.status === "done" || c.status === "failed" ? shortAgo(c.at) : c.status === "waiting" ? "Needs your OK" : null].filter(Boolean).join(" · ")));
  };
  const col = (key: string, title: string, emoji: string, list: any[]) => h("section", { class: `bcol ${key}` },
    h("div", { class: "bhead" }, emoji3d(emoji, "ideaicon small"), h("b", null, title), h("em", null, String(list.length))),
    list.length ? list.map(card) : h("p", { class: "bempty" }, key === "next" ? "Nothing queued" : key === "working" ? "Nobody's on anything" : key === "needsYou" ? "Nothing waiting on you" : "Nothing this week"),
    key === "next" ? h("button", { class: "badd", on: { click: () => addTodo(teammateId) } }, icon("plus", 16), "Add a to-do") : null);
  clear(el, h("div", { class: "board" },
    b.needsYou.length || wide() ? col("needsYou", "Needs you", "✋", b.needsYou) : null, col("working", "Working", "⚙️", b.working),
    col("next", "Up next", "🗓️", b.next), col("done", "Done", "✅", b.done)));
  // Keep it fresh while it's open.
  if (boardTimer) clearTimeout(boardTimer);
  boardTimer = setTimeout(() => loadBoard(), 8000);
}

/** A to-do for one teammate (sent to them as a DM) or for the team (a new ramble). */
function addTodo(teammateId?: string) {
  const t = teammateId ? mate(teammateId) : null;
  const what = h("textarea", { class: "field", rows: 3, maxLength: 1000, placeholder: t ? `What should ${t.name} do?` : "What needs doing? Hearth gives it to the right teammate." });
  openSheet(t ? `To-do for ${t.name}` : "New to-do", [what,
    h("button", { class: "btn primary big", on: { click: async () => {
      const text = what.value.trim();
      if (!text) return what.focus();
      try {
        if (t) await call(`/api/teammates/${t.id}/messages`, { body: { text } }); else await call("/api/threads", { body: { text } });
        closeSheet(); toast("Added"); loadBoard();
      } catch (e) { handleError(e); }
    } } }, "Add")]);
  setTimeout(() => what.focus(), 60);
}

/** Who's "on stage" in a ramble right now. */
function speaker(chat: any): { t: any; state: string } {
  if (chat?.thread && S.planning === chat.thread.id) return { t: mate("hearth"), state: "thinking" };
  const jobs = (chat?.jobs || []).filter((j: any) => !j.parentId);
  const by = (st: string[]) => jobs.filter((j: any) => st.includes(j.status)).sort((a: any, b: any) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt))[0];
  const now = by(["working"]) || by(["waiting", "blocked"]) || by(["queued"]);
  if (now) return { t: mate(now.teammateId), state: jobState(now) };
  const last = by(["done", "failed"]);
  if (last) return { t: mate(last.teammateId), state: Date.now() - new Date(last.finishedAt || last.updatedAt).getTime() < 120_000 ? "done" : "idle" };
  return { t: mate("hearth"), state: "idle" };
}

// The stage keeps one face per place and morphs it (color, badge, a little squash) when someone else takes over.
const stages = new Map<string, { id: string; face: HTMLElement }>();
function stage(place: string, t: any, state: string, title: string, sub: string | null, onTap: (() => void) | null, live = false, others: any[] = []) {
  const prev = stages.get(place);
  let f: HTMLElement;
  if (prev && prev.id === t.id) {
    f = prev.face;
    const fresh = face(t, 58, state);
    f.className = fresh.className;
    clear(f, ...Array.from(fresh.childNodes));
  } else {
    f = face(prev ? { ...t, color: prev.face.style.getPropertyValue("--c") || t.color } : t, 58, state);
    if (prev) { requestAnimationFrame(() => requestAnimationFrame(() => f.style.setProperty("--c", t.color))); f.classList.add("morph"); setTimeout(() => f.classList.remove("morph"), 700); }
    stages.set(place, { id: t.id, face: f });
  }
  const pill = h("span", { class: "stagepill" },
    others.length ? h("span", { class: "minis" }, others.map((o) => face(o, 18, "idle"))) : null,
    h("b", null, title, live ? h("i", { class: `status ${S.conn}`, title: S.conn }) : null));
  return h(onTap ? "button" : "div", { class: "stage", ...(onTap ? { on: { click: onTap } } : {}) }, f, pill, sub ? h("small", null, sub) : null);
}

function channelName(t: any) {
  return t.channel || (t.num ? `ramble-${t.num}` : t.id === "new" ? "new-ramble" : String(t.title || "ramble").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30));
}

function rosterEntry(id: string) {
  return S.roster.find((x) => x.id === id) || { ...mate(id), state: "idle", status: "" };
}

// ---------------- Home (Slack Home tab) ----------------

const collapsed = new Set<string>(JSON.parse(localStorage.getItem("hearth.collapsed") || '["archived"]'));
function toggleSection(id: string) {
  collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
  localStorage.setItem("hearth.collapsed", JSON.stringify([...collapsed]));
  drawHome();
}

function renderHome() {
  frame({ header: h("div"), body: h("div", null, h("div", { id: "htiles" }), h("div", { id: "pins" }), h("div", { id: "home" })), fab: true, purple: true });
  pinsKey = "";
  drawPins();
  drawHeader();
  drawHome();
}

/** "I can follow up on your airline refund": yes runs it as a ramble, no makes it go away for good. */
function ideaRow(i: any) {
  const busy = (b: HTMLButtonElement) => { b.disabled = true; };
  return h("div", { class: "idea" }, emoji3d(i.emoji || "💡", "ideaicon"),
    h("div", { class: "grow" }, h("b", null, i.title), i.body ? h("p", null, i.body) : null,
      h("div", { class: "ideabtns" },
        h("button", { class: "btn small primary", on: { click: async (e: Event) => {
          busy(e.currentTarget as HTMLButtonElement);
          try { const r = await call(`/api/ideas/${i.id}/accept`, { body: {} }); S.ideas = S.ideas.filter((x) => x.id !== i.id); location.hash = `#c/${r.thread.id}`; } catch (err) { handleError(err); }
        } } }, "Do it"),
        h("button", { class: "btn small ghost", on: { click: async () => {
          S.ideas = S.ideas.filter((x) => x.id !== i.id); drawHome();
          try { await call(`/api/ideas/${i.id}/dismiss`, { body: {} }); toast("Got it. I won't suggest that again."); } catch (err) { handleError(err); }
        } } }, "Not now"))));
}

async function lookForIdeas() {
  toast("Looking for things I can do for you…");
  try { S.ideas = await call("/api/ideas", { body: {} }); drawHome(); if (!S.ideas.length) toast("Nothing worth suggesting right now."); }
  catch (err) { handleError(err); }
}

function drawHome() {
  const el = document.getElementById("home"), top = document.getElementById("htiles");
  if (!el || !top) return;
  const active = S.threads.filter((t) => !t.archived);
  const archived = S.threads.filter((t) => t.archived);
  const team = (S.roster.length ? S.roster : S.teammates.map((t) => ({ ...t, state: "idle", status: t.description })));
  const working = S.roster.reduce((n, t) => n + (t.busy || 0), 0);
  const plans = S.roster.filter((t) => String(t.status).startsWith("Next:")).length;
  const tiles: [string, string, string, () => void, boolean][] = [
    ["lock", "Needs you", `${needsYouCount()} waiting`, () => { location.hash = "#activity"; }, needsYouCount() > 0],
    ["board", "Board", working ? `${working} working` : "Everyone's to-dos", () => { location.hash = "#b"; }, working > 0],
    ["bell", "Plans", plans ? `${plans} coming up` : "Reminders", openPlans, false],
    ["clip", "Files", `${S.files.size} files`, openFiles, false],
    ["sparkle", "Ideas", S.ideas.length ? `${S.ideas.length} for you` : "Look now", lookForIdeas, false],
  ];
  const section = (id: string, title: string, rows: Node[], extra?: Node | null) => h("section", { class: "hsec" },
    h("div", { class: "hsec-head" },
      h("button", { class: "hsec-title", on: { click: () => toggleSection(id) } }, h("span", null, title), icon("chevron", 16)),
      extra || null,
      h("button", { class: `chev ${collapsed.has(id) ? "down" : ""}`, "aria-label": collapsed.has(id) ? "Expand" : "Collapse", on: { click: () => toggleSection(id) } }, icon("up", 22))),
    collapsed.has(id) ? null : rows);
  const fresh = (t: any) => !!t.updatedAt && t.updatedAt > (seen[t.id] || t.createdAt);
  const channelRow = (t: any) => h("button", { class: `hrow ${t.working || t.needsYou || fresh(t) ? "unread" : ""}`, on: { click: () => { location.hash = `#c/${t.id}`; } } },
    h("span", { class: "hicon" }, "#"), h("span", { class: "grow" }, channelName(t)),
    t.needsYou ? h("em", { class: "badge" }, String(t.needsYou)) : t.working ? h("i", { class: "spin" }) : fresh(t) ? h("i", { class: "udot", "aria-label": "New" }) : null);
  clear(top,
    linkStrip(),
    S.ideas.length ? h("section", { class: "ideas" }, h("h2", { class: "bigtitle" }, "Ideas"), S.ideas.map(ideaRow)) : null,
    h("div", { class: "tiles" }, tiles.map(([ic, title, sub, fn, hot]) =>
      h("button", { class: `tilebtn ${hot ? "hot" : ""}`, on: { click: fn } }, h("span", { class: "ti" }, icon(ic, 22), hot ? h("i", { class: "dot" }) : null), h("b", null, title), h("small", null, sub)))));
  clear(el,
    section("rambles", "Active rambles", active.length ? active.map(channelRow)
      : [h("p", { class: "hempty" }, "Tap + and ramble. Each ramble becomes a channel; it archives itself an hour after everything's done.")],
      h("button", { class: "chev", "aria-label": "New ramble", on: { click: () => { location.hash = "#c/new"; } } }, icon("plus", 20))),
    section("apps", "Mini apps", S.apps.some((a) => !a.inline) ? [...S.apps].filter((a) => !a.inline).sort((a, b) => Number(b.pinned) - Number(a.pinned)).map((a) => h("button", { class: "hrow", on: { click: () => { location.hash = `#a/${a.id}`; } } },
      appIcon(a, 30), h("span", { class: "grow" }, a.title), h("small", null, mate(a.teammateId).name)))
      : [h("p", { class: "hempty" }, "Little apps your teammates build for you: flashcards, trackers, a today view. Ask for one anywhere, or say \"pin it to Home\".")],
      h("button", { class: "chev", "aria-label": "New app", on: { click: newApp } }, icon("plus", 20))),
    section("dms", "Direct messages", team.map((t) => h("button", { class: `hrow ${t.needsYou || t.busy || unreadDm(t) ? "unread" : ""}`, on: { click: () => { location.hash = `#t/${t.id}`; } } },
      face(t, 30, t.state), h("span", { class: "grow" }, t.name), t.needsYou ? h("em", { class: "badge" }, String(t.needsYou)) : unreadDm(t) ? h("i", { class: "udot", "aria-label": "New message" }) : null))),
    archived.length ? section("archived", `Archived (${archived.length})`, archived.slice(0, 30).map((t) => h("button", { class: "hrow dim", on: { click: () => { location.hash = `#c/${t.id}`; } } },
      h("span", { class: "hicon" }, "#"), h("span", { class: "grow" }, channelName(t)), h("small", null, t.title)))) : null,
  );
}

// ---------------- DMs tab ----------------

function renderDms() {
  frame({ header: h("div"), body: h("div", { id: "dms" }), fab: true });
  drawHeader();
  drawDms();
}

function drawDms() {
  const el = document.getElementById("dms");
  if (!el) return;
  const team = [...(S.roster.length ? S.roster : S.teammates)].sort((a, b) => (b.at || "").localeCompare(a.at || ""));
  clear(el, team.map((t) => h("button", { class: "dmrow", on: { click: () => { location.hash = `#t/${t.id}`; } } },
    face(t, 44, t.state || "idle"),
    h("span", { class: "grow" }, h("span", { class: "l1" }, h("b", null, t.name), unreadDm(t) ? h("i", { class: "udot" }) : null, t.at ? h("time", null, shortAgo(t.at)) : null),
      h("small", { class: t.needsYou ? "warn" : "" }, t.status || role(t))))),
    h("button", { class: "dmrow", on: { click: () => openTeammates() } }, h("span", { class: "uavatar ghost", style: "--s:44px" }, icon("plus", 18)), h("span", { class: "grow" }, h("b", null, "Add a teammate"))));
}

// ---------------- Activity tab ----------------

async function renderActivity() {
  frame({ header: h("div"), body: h("div", { id: "activity" }) });
  drawHeader();
  try { S.inbox = await call("/api/inbox"); } catch (e) { handleError(e); }
  drawActivity();
}

function drawActivity() {
  const el = document.getElementById("activity");
  if (!el) return;
  const items = S.inbox || [];
  const chan = (id?: string) => { const t = S.threads.find((x) => x.id === id); return t ? `#${channelName(t)}` : id?.startsWith("tm-") ? "DM" : ""; };
  if (!items.length) return clear(el, h("p", { class: "hempty" }, "Nothing yet. Approvals, results and check-ins show up here."));
  clear(el, items.map((it: any) => {
    const t = mate(it.teammateId);
    const go = () => { location.hash = it.jobId && it.threadId && !it.threadId.startsWith("tm-") ? `#c/${it.threadId}/${it.jobId}` : it.threadId?.startsWith("tm-") ? `#t/${it.threadId.slice(3)}` : it.threadId ? `#c/${it.threadId}` : ""; };
    const line = it.kind === "approval" ? `${t.name} needs your OK` : it.kind === "blocked" ? `${t.name} is stuck` : it.kind === "proactive" ? `${t.name} · ${it.title}` : it.kind === "failed" ? `${t.name} couldn't finish` : `${t.name} replied`;
    return h("div", { class: `actrow ${it.kind === "approval" || it.kind === "blocked" ? "hot" : ""}` },
      h("button", { class: "actmain", on: { click: go } }, face(t, 40, it.kind === "approval" ? "waiting" : it.kind === "blocked" ? "blocked" : "idle"),
        h("span", { class: "grow" },
          h("span", { class: "l1" }, h("b", null, line), h("small", null, chan(it.threadId)), h("time", null, shortAgo(it.at))),
          h("span", { class: "l2" }, it.kind === "done" || it.kind === "failed" ? `${it.summary}${it.result ? ` — ${it.result}` : ""}` : it.kind === "blocked" ? `${it.summary}. ${it.unblock || ""}` : it.summary))),
      it.kind === "approval" ? h("div", { class: "actbtns" }, h("button", { class: "sbtn", on: { click: async () => { await decide(it.approval.id, false); renderActivity(); } } }, "No"), h("button", { class: "sbtn primary", on: { click: async () => { await decide(it.approval.id, true); renderActivity(); } } }, "Approve")) : null,
      it.kind === "blocked" ? h("div", { class: "actbtns" }, h("button", { class: "sbtn primary", on: { click: async () => { await retry(it.id); renderActivity(); } } }, "Try again")) : null);
  }));
}

// ---------------- jump to (⌘K) ----------------

function openJump() {
  const input = h("input", { class: "field", placeholder: "Jump to a teammate, ramble or task", autocapitalize: "off", autocomplete: "off", spellcheck: false });
  const results = h("div", { class: "jump-results" });
  const go = (hash: string) => { closeSheet(); location.hash = hash; };
  const draw = async () => {
    const q = input.value.trim().toLowerCase();
    if (!S.threads.length) S.threads = await call("/api/threads").catch(() => []);
    const team = (S.roster.length ? S.roster : S.teammates).filter((t: any) => !q || `${t.name} ${t.description}`.toLowerCase().includes(q));
    const chats = S.threads.filter((t: any) => !q || `${channelName(t)} ${t.title} ${t.preview || ""}`.toLowerCase().includes(q)).slice(0, 8);
    let tasks: any[] = [];
    if (q.length >= 2) {
      const all = await Promise.all(S.threads.slice(0, 20).map((t: any) => call(`/api/threads/${t.id}`).catch(() => null)));
      tasks = all.filter(Boolean).flatMap((d: any) => d.jobs.filter((j: any) => !j.parentId && !j.followsUp && j.task.toLowerCase().includes(q)).map((j: any) => ({ j, t: d.thread }))).slice(0, 8);
    }
    clear(results,
      team.length ? [h("small", null, "People"), team.map((t: any) => h("button", { class: "jump-row", on: { click: () => go(`#t/${t.id}`) } }, face(t, 28, t.state || "idle"), h("span", { class: "grow" }, h("b", null, t.name), h("small", null, t.status || role(t)))))] : null,
      chats.length ? [h("small", null, "Rambles"), chats.map((t: any) => h("button", { class: "jump-row", on: { click: () => go(`#c/${t.id}`) } }, h("span", { class: "hash" }, "#"), h("span", { class: "grow" }, h("b", null, channelName(t)), h("small", null, `${t.title}${t.archived ? " · archived" : ""}`))))] : null,
      tasks.length ? [h("small", null, "Tasks"), tasks.map(({ j, t }) => h("button", { class: "jump-row", on: { click: () => go(`#c/${j.threadId}/${j.id}`) } }, face(mate(j.teammateId), 28, jobState(j)), h("span", { class: "grow" }, h("b", null, j.task), h("small", null, `${mate(j.teammateId).name} · #${channelName(t)}`))))] : null,
      !team.length && !chats.length && !tasks.length ? h("p", { class: "muted" }, "Nothing matches.") : null);
  };
  let tmr: any;
  input.addEventListener("input", () => { clearTimeout(tmr); tmr = setTimeout(draw, 120); });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") (results.querySelector(".jump-row") as HTMLButtonElement | null)?.click(); });
  openSheet("Search", [input, results]);
  draw();
  setTimeout(() => input.focus(), 250);
}

// ---------------- a ramble channel ----------------

async function loadChat(id: string) {
  if (id !== "new") markSeen(id);
  if (id === "new") { S.chat = { thread: { id: "new", title: "" }, messages: [], jobs: [], approvals: [] }; drawChat(); setTimeout(() => document.getElementById("composer")?.focus(), 80); return; }
  try { S.chat = await call(`/api/threads/${id}`); drawChat(); }
  catch (e) { if (e instanceof ApiError && e.status === 404) { location.hash = ""; return; } handleError(e); }
}

function renderChatLayout(r: { id: string; job?: string }) {
  S.chat = S.chat?.thread?.id === r.id ? S.chat : null;
  const split = wide() && !!r.job;
  frame({ header: h("div"), body: h("div", { id: r.job && !wide() ? "threadview" : "chat", class: "msgs" }), composer: true });
  if (split) {
    app.classList.add("split");
    app.appendChild(h("aside", { class: "threadside" },
      h("div", { class: "threadside-head" }, h("b", null, "Thread"), h("button", { class: "iconbtn", "aria-label": "Close thread", on: { click: () => { location.hash = `#c/${r.id}`; } } }, icon("x", 18))),
      h("div", { class: "msgs", id: "threadview" }), h("div", { class: "composer-wrap", id: "threadcomposer" })));
    renderComposer("threadcomposer", r.job);
  } else app.classList.remove("split");
  drawHeader();
  if (S.chat) drawChat();
}

function drawChat(stick = true) {
  const r = route();
  if (r.view !== "chat" || !S.chat) return;
  drawHeader();
  const box = document.getElementById("composer") as HTMLTextAreaElement | null;
  if (box && !(r.job && !wide()) && S.chat.thread.id !== "new") box.placeholder = `Message #${channelName(S.chat.thread)}`;
  const chatEl = document.getElementById("chat");
  if (chatEl) drawChannel(chatEl, stick);
  const tv = document.getElementById("threadview");
  if (tv && r.job) drawThread(tv, r.job, stick);
}

/** Slack message row: square avatar, bold name, grey time, text. Consecutive messages from one sender group. */
function row(who: { face: Node; name: string; badge?: Node | null }, at: string, body: (Node | null | Node[])[], grouped = false, extraClass = "") {
  return h("div", { class: `mrow ${grouped ? "grouped" : ""} ${extraClass}` },
    h("div", { class: "mav" }, grouped ? h("time", { class: "gtime" }, clockTime(at)) : who.face),
    h("div", { class: "mbody" },
      grouped ? null : h("div", { class: "mhead" }, h("b", null, who.name), who.badge || null, h("time", null, clockTime(at))),
      ...body));
}

const youWho = () => ({ face: userAvatar(40), name: S.state?.prefs?.userName || "You" });
const mateWho = (id: string, state = "idle") => { const t = mate(id); return { face: face(t, 40, state), name: t.name, badge: t.id !== "hearth" ? null : h("span", { class: "apptag" }, "APP") }; };

function dayDivider(at: string) {
  const d = new Date(at);
  const today = new Date(); const y = new Date(); y.setDate(today.getDate() - 1);
  const label = d.toDateString() === today.toDateString() ? "Today" : d.toDateString() === y.toDateString() ? "Yesterday"
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" }).replace(/(\d+)$/, (n) => n + (["th", "st", "nd", "rd"][(+n % 100 > 10 && +n % 100 < 14) ? 0 : Math.min(+n % 10, 4) % 4] || "th"));
  return h("div", { class: "daydiv" }, label);
}

async function fillNow(el: HTMLElement) {
  let b: any = { working: [], next: [], needsYou: [] };
  try { b = await call("/api/board"); } catch {}
  const row = (lead: Node, title: string, sub: string, fn: () => void) => h("button", { class: "nowrow", on: { click: fn } }, lead, h("span", { class: "grow" }, h("b", null, title), h("small", null, sub)), icon("chevron", 16));
  const go = (c: any) => () => { location.hash = c.kind === "plan" ? "#b" : c.threadId?.startsWith("tm-") ? `#t/${c.teammateId}` : `#c/${c.threadId}/${c.root}`; };
  const sec = (title: string, rows: Node[]) => rows.length ? h("section", { class: "nowsec" }, h("h4", null, title), h("div", { class: "nowcard" }, rows)) : null;
  const recent = S.threads.filter((t: any) => !t.archived).slice(0, 3);
  const parts = [
    sec("Needs you", b.needsYou.slice(0, 3).map((c: any) => row(face(mate(c.teammateId), 32, jobState({ status: c.status })), c.title, c.need ? `Stuck: ${c.need}` : "Needs your OK", go(c)))),
    sec("In progress", b.working.slice(0, 4).map((c: any) => row(face(mate(c.teammateId), 32, "working"), c.title, `${mate(c.teammateId).name} · ${S.progress.get(c.id) || "on it"}`, go(c)))),
    sec("Coming up", b.next.filter((c: any) => c.kind === "plan").slice(0, 3).map((c: any) => row(emoji3d("🔔", "ideaicon small"), c.title, `${dayLabel(c.at)} ${clockTime(c.at)}`, go(c)))),
    sec("Ideas", S.ideas.slice(0, 2).map((i: any) => row(emoji3d(i.emoji || "💡", "ideaicon small"), i.title, i.body || "Tap to ask for it", () => {
      const box = document.getElementById("composer") as HTMLTextAreaElement | null;
      if (box) { box.value = i.prompt; box.dispatchEvent(new Event("input")); box.focus(); }
    }))),
    sec("Pick up where you left off", recent.map((t: any) => row(h("span", { class: "hicon" }, "#"), channelName(t), t.title || "", () => { location.hash = `#c/${t.id}`; }))),
  ].filter(Boolean) as Node[];
  clear(el, parts.length ? parts : h("div", { class: "starters" }, [
    "Remind me at 6 to call mom, find a cheap dinner spot, and text Sam that Tuesday works",
    "Plan 5 days in Tokyo in March: food, a day trip, and a map of where we go",
    "I want to get to the gym 3 times a week, nag me if I don't",
  ].map((x) => h("button", { on: { click: () => send(x) } }, x))));
}

function drawChannel(el: HTMLElement, stick: boolean) {
  const top = S.chat.messages.filter((m: any) => !m.replyTo);
  if (!top.length) {
    // A fresh ramble shows what's going on (in progress, coming up, ideas, recent rambles), not the same examples every time.
    const live = h("div", { class: "nowlist" });
    clear(el, h("div", { class: "hello" },
      h("h2", null, "What's on your mind?"),
      h("p", null, "Talk or type, however it comes out. Hearth hands it to the right teammates."), live));
    fillNow(live);
    return;
  }
  const nodes: Node[] = [];
  let lastDay = "", lastWho = "", lastAt = 0;
  for (const m of top) {
    const day = new Date(m.createdAt).toDateString();
    if (day !== lastDay) { nodes.push(dayDivider(m.createdAt)); lastDay = day; lastWho = ""; }
    const who = m.role === "user" ? "you" : m.teammateId || "hearth";
    const t = new Date(m.createdAt).getTime();
    const grouped = who === lastWho && t - lastAt < 5 * 60_000 && !m.proactive;
    nodes.push(m.taskJobId ? taskMessage(m) : plainMessage(m, grouped));
    lastWho = m.taskJobId ? "task" : who; lastAt = t;
  }
  if (S.planning === S.chat.thread.id) nodes.push(row(mateWho("hearth", "thinking"), new Date().toISOString(), [h("div", { class: "typing" }, h("i"), h("i"), h("i"), h("span", null, "Reading that and splitting it up…"))], lastWho === "hearth"));
  const atBottom = el.parentElement!.scrollHeight - el.parentElement!.scrollTop - el.parentElement!.clientHeight < 120;
  clear(el, nodes);
  if (stick || atBottom) requestAnimationFrame(() => { const s = document.getElementById("scroll")!; s.scrollTop = s.scrollHeight; });
}

/** Mentions (@Research) look like Slack's blue mentions. */
function withMentions(text: string) {
  const out: (Node | string)[] = [];
  const re = /@([A-Z][\w-]{1,23})/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const t = S.teammates.find((x) => x.name === m![1]);
    if (!t) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(h("button", { class: "mention", on: { click: () => { location.hash = `#t/${t.id}`; } } }, `@${t.name}`));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return h("div", { class: "mtext" }, out);
}

function plainMessage(m: any, grouped = false) {
  if (m.role === "user") return row(youWho(), m.createdAt, [h("div", { class: "mtext" }, m.text), (m.fileIds || []).map(fileCard)], grouped);
  const from = m.fromThreadId ? S.threads.find((t) => t.id === m.fromThreadId) : null;
  const body: (Node | null)[] = [m.proactive ? h("div", { class: "proline" }, icon("bell", 13), m.proactive.title) : null, richText(m.text),
    from ? h("button", { class: "fromchip", on: { click: () => { location.hash = `#c/${from.id}`; } } }, `From #${channelName(from)}`, icon("chevron", 13)) : null];
  if (m.proactive) {
    const why = h("div", { class: "why", hidden: true }, m.proactive.why);
    body.push(h("button", { class: "whybtn", on: { click: () => { why.hidden = !why.hidden; } } }, "Why did I get this?"), why);
  }
  return row(mateWho(m.teammateId || "hearth"), m.createdAt, body, grouped, m.error ? "err" : "");
}

/** Markdown answer as one plain line of text for previews. */
function plain(md: string) {
  return String(md).replace(/```[\s\S]*?```/g, " ").replace(/[*_`#>]+/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/^\s*[-•]\s+/gm, "").replace(/\s+/g, " ").trim();
}

/** The few words shown for a task; older jobs have no label, so take the first clause of the brief. */
function jobLabel(j: any) {
  if (j.label) return j.label;
  const first = String(j.task).trim().split(/[.!?\n]|,\s|\s(?:and|then)\s/)[0].replace(/^(please|can you|could you)\s+/i, "");
  const words = first.split(/\s+/);
  return first.charAt(0).toUpperCase() + words.slice(0, 7).join(" ").slice(1) + (words.length > 7 ? "…" : "");
}

/** A task is a post by the teammate doing it: a bold title, then the answer (or working / Approve / stuck) right there. */
function taskMessage(m: any) {
  const j = S.chat.jobs.find((x: any) => x.id === m.taskJobId);
  if (!j) return plainMessage(m);
  const t = mate(j.teammateId);
  const follow = S.chat.jobs.filter((x: any) => x.followsUp === j.id);
  const latest = follow.length ? follow[follow.length - 1] : j;
  const open = () => { location.hash = `#c/${S.chat.thread.id}/${j.id}`; };
  const aps = (S.chat.approvals || []).filter((a: any) => (a.jobId === j.id || follow.some((f: any) => f.id === a.jobId)) && a.status === "pending");
  const st = latest.status;
  const body: (Node | Node[] | null)[] = [h("button", { class: "ttitle", on: { click: open } }, h("span", null, jobLabel(j)), icon("chevron", 16))];
  if (st === "working" || st === "queued") {
    body.push(h("button", { class: "typing live", on: { click: open } }, h("i"), h("i"), h("i"),
      h("span", { "data-progress": latest.id }, st === "working" ? S.progress.get(latest.id) || (latest.tier === "heavy" ? "Thinking it through" : "On it") : latest.dependsOn?.length ? "Waiting on another task" : "Up next"),
      st === "working" && latest.startedAt ? h("time", { "data-since": latest.startedAt }, elapsed(latest.startedAt)) : null));
  } else if (st === "waiting") {
    body.push(h("div", { class: "block" }, h("div", { class: "blockhead" }, icon("lock", 15), h("b", null, aps[0]?.summary || "Needs your OK")),
      aps.length ? h("div", { class: "blockbtns" }, h("button", { class: "sbtn primary", on: { click: () => decide(aps[0].id, true) } }, "Approve"), h("button", { class: "sbtn", on: { click: () => decide(aps[0].id, false) } }, "No")) : null));
  } else if (st === "blocked") {
    body.push(h("div", { class: "block" }, h("div", { class: "blockhead" }, h("b", null, `Stuck: ${latest.blocked?.need || ""}`)), latest.blocked?.unblock ? h("p", null, latest.blocked.unblock) : null,
      h("div", { class: "blockbtns" }, h("button", { class: "sbtn primary", on: { click: () => retry(latest.id) } }, "Try again"))));
  } else {
    // The channel keeps it short: two lines and small tiles. Lists, files and the full answer live in the thread.
    const tiles = st === "done" ? (latest.tiles || []) : [];
    const small = tiles.filter((x: any) => x.type === "weather" || x.type === "stat").map((x: any) => ({ ...x, options: { ...x.options, compact: true } }));
    const more = [
      ...tiles.filter((x: any) => !small.some((y: any) => y.type === x.type)).map((x: any) => {
        const n = x.data?.items?.length;
        return n ? `${n} ${x.type === "places" ? "places" : "items"}` : x.title || x.type;
      }),
      ...((latest.fileIds || []).length ? [`${latest.fileIds.length} file${latest.fileIds.length === 1 ? "" : "s"}`] : []),
    ];
    body.push(
      appCards(latest),
      h("button", { class: "clamp short", on: { click: open } }, plain(st === "failed" ? `Couldn't do it: ${latest.result || "it failed"}` : latest.result || "Done.")),
      small.length ? h("button", { class: "tilelink", on: { click: open } }, small.map(tile)) : null,
      more.length ? h("button", { class: "chips", on: { click: open } }, more.map((x) => h("span", { class: "chipx" }, x))) : null);
    const n = follow.length * 2;
    body.push(h("button", { class: "tfoot", on: { click: open } }, n ? h("b", null, `${n} replies`) : null, h("span", null, n ? `Last ${clockTime(latest.finishedAt || latest.updatedAt)}` : "Open thread"), icon("chevron", 14)));
  }
  return row(mateWho(j.teammateId, jobState(latest)), m.createdAt, body, false, st === "failed" ? "err" : "");
}

/** "0:42" since a task started; kept ticking by the clock below. */
function elapsed(since: string) {
  const s = Math.max(0, Math.round((Date.now() - new Date(since).getTime()) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
setInterval(() => { for (const el of document.querySelectorAll<HTMLElement>("[data-since]")) el.textContent = elapsed(el.dataset.since!); }, 1000);

async function decide(id: string, yes: boolean) { try { await call(`/api/approvals/${id}/${yes ? "approve" : "reject"}`, { body: {} }); } catch (e) { handleError(e); } }
async function retry(id: string) { try { await call(`/api/jobs/${id}/retry`, { body: {} }); } catch (e) { handleError(e); } }

/** A task's thread: the task on top, "N replies" divider, the teammate's answers and your replies. */
function drawThread(el: HTMLElement, jobId: string, stick: boolean) {
  const j = S.chat.jobs.find((x: any) => x.id === jobId);
  if (!j) { clear(el, h("p", { class: "muted center" }, "Loading…")); return; }
  const t = mate(j.teammateId);
  const follow = S.chat.jobs.filter((x: any) => x.followsUp === j.id);
  const n = (j.status === "done" || j.status === "failed" ? 1 : 0) + follow.length * 2;
  // The ramble's other threads, one tap away (like switching threads in Slack).
  const roots = S.chat.jobs.filter((x: any) => !x.parentId && !x.followsUp);
  const switcher = roots.length > 1 ? h("div", { class: "threadtabs" }, roots.map((x: any) =>
    h("button", { class: `threadtab ${x.id === j.id ? "on" : ""}`, on: { click: () => { location.hash = `#c/${S.chat.thread.id}/${x.id}`; } } },
      face(mate(x.teammateId), 20, jobState(x)), h("span", null, jobLabel(x)), x.status === "done" ? null : h("i", { class: `tdot ${x.status}` })))) : null;
  if (switcher) requestAnimationFrame(() => switcher.querySelector(".on")?.scrollIntoView({ inline: "center", block: "nearest" }));
  const nodes: (Node | null)[] = [
    switcher,
    row(mateWho("hearth"), j.createdAt, [h("div", { class: "ttitle" }, jobLabel(j)), h("div", { class: "brief" }, withMentions(`@${t.name} ${j.task}`))]),
    h("div", { class: "repdiv" }, n ? `${n} repl${n === 1 ? "y" : "ies"}` : "No replies yet"),
    answer(j),
  ];
  for (const f of follow) {
    const m = S.chat.messages.find((x: any) => x.id === f.messageId);
    if (m) nodes.push(row(youWho(), m.createdAt, [h("div", { class: "mtext" }, m.text)]));
    nodes.push(answer(f));
  }
  clear(el, nodes);
  if (stick) requestAnimationFrame(() => { const s = el.closest(".threadside") ? el : document.getElementById("scroll")!; s.scrollTop = s.scrollHeight; });
}

/** One teammate answer inside a thread (or "working…", or the Approve / stuck block). */
function answer(j: any) {
  const who = mateWho(j.teammateId, jobState(j));
  const at = j.finishedAt || j.startedAt || j.createdAt;
  if (j.status === "queued" || j.status === "working") return row(who, at, [h("div", { class: "typing live" }, h("i"), h("i"), h("i"),
    h("span", { "data-progress": j.id }, j.status === "working" ? S.progress.get(j.id) || (j.tier === "heavy" ? "Thinking it through" : "On it") : "Up next"),
    j.status === "working" && j.startedAt ? h("time", { "data-since": j.startedAt }, elapsed(j.startedAt)) : null)]);
  if (j.status === "waiting") {
    const aps = (S.chat.approvals || []).filter((a: any) => a.jobId === j.id);
    return row(who, at, [j.result ? richText(j.result) : null, aps.map((a: any) => h("div", { class: "block" },
      h("div", { class: "blockhead" }, icon("lock", 15), h("b", null, a.summary)), a.details ? h("p", null, a.details) : null,
      a.status === "pending" ? h("div", { class: "blockbtns" }, h("button", { class: "sbtn primary", on: { click: () => decide(a.id, true) } }, "Approve"), h("button", { class: "sbtn", on: { click: () => decide(a.id, false) } }, "No"))
        : h("small", { class: "muted" }, a.status === "done" ? "Approved and done" : a.status === "rejected" ? "You said no" : a.status)))]);
  }
  if (j.status === "blocked") return row(who, at, [h("div", { class: "block" }, h("div", { class: "blockhead" }, h("b", null, j.blocked?.need)), j.blocked?.why ? h("p", null, j.blocked.why) : null,
    h("p", null, j.blocked?.unblock), h("div", { class: "blockbtns" }, h("button", { class: "sbtn primary", on: { click: () => retry(j.id) } }, "Try again")))]);
  const tiles = j.status === "done" ? (j.tiles || []) : [];
  const did = (j.did || []).filter((d: any) => ["hook", "memory", "skill", "place"].includes(d.kind)).map((d: any) => d.label);
  const canSave = j.status === "done" && !j.followsUp && (j.how === "fresh" || j.how === "repaired") && !(j.did || []).some((d: any) => d.kind === "skill");
  return row({ ...who, badge: h("small", { class: "jobmeta" }, metaLine(j)) }, at, [
    tiles.length && (j.how === "skill" || j.how === "workflow") ? null : richText(j.status === "failed" ? `Couldn't do it: ${j.result || "it failed"}` : j.result || "Done."),
    tiles.map(tile),
    artifacts(j),
    appCards(j),
    (j.fileIds || []).map(fileCard),
    did.length ? h("div", { class: "did-line" }, icon("check", 12), did.join(" · ")) : null,
    canSave ? h("button", { class: "linkbtn", on: { click: async (e: Event) => {
      const b = e.currentTarget as HTMLButtonElement; b.disabled = true;
      try { const sk = await call(`/api/jobs/${j.id}/save-skill`, { body: {} }); toast(`Saved skill ${sk.name}`); b.textContent = "Saved as skill"; loadSkills(); } catch (err) { b.disabled = false; handleError(err); }
    } } }, "Save as skill") : null,
  ], false, j.status === "failed" ? "err" : "");
}

function metaLine(j: any) {
  if (j.how === "skill" || j.how === "workflow") {
    const n = (j.skillId ? S.skills.find((x) => x.id === j.skillId) : S.workflows.find((x) => x.id === j.workflowId))?.name;
    return `${n ? `used ${n} · ` : ""}${secs(j.durationMs)} · ${money(j.costUsd)}`;
  }
  const model = j.voiced ? `${j.tier === "quick" ? "quick" : "workhorse"} + heavy` : j.tier === "quick" ? "quick" : j.tier === "heavy" ? "heavy" : null;
  return [j.escalated ? "moved up" : null, model, j.ranOn ? `on ${j.ranOn === "cloud" ? "the cloud" : j.ranOn}` : null, secs(j.durationMs), money(j.costUsd)].filter(Boolean).join(" · ");
}

function chatMenu() {
  const t = S.chat?.thread;
  if (!t || t.id === "new") return;
  const doneAll = S.chat.jobs.length && S.chat.jobs.filter((j: any) => !j.parentId && !j.followsUp).every((j: any) => j.status === "done");
  const lastRamble = [...S.chat.messages].reverse().find((m: any) => m.jobIds?.length && !m.replyTo);
  const members = [...new Set(S.chat.jobs.filter((j: any) => !j.parentId).map((j: any) => j.teammateId))] as string[];
  openSheet(`# ${channelName(t)}`, [
    h("p", { class: "muted" }, t.title),
    h("div", { class: "list" }, h("div", { class: "item" }, userAvatar(30), h("span", { class: "grow" }, S.state?.prefs?.userName || "You")),
      members.map((id) => h("button", { class: "item", on: { click: () => { closeSheet(); location.hash = `#t/${id}`; } } }, face(mate(id), 30, "idle"), h("span", { class: "grow" }, mate(id).name)))),
    h("p", { class: "muted small" }, "Rambles archive themselves an hour after everything in them is done. Posting here brings it back."),
    h("button", { class: "btn ghost", on: { click: () => renameRamble(t) } }, icon("edit", 16), "Rename"),
    h("div", { class: "stack" },
      doneAll && lastRamble ? h("button", { class: "btn ghost", on: { click: async () => {
        try { const wf = await call("/api/workflows/from-ramble", { body: { messageId: lastRamble.id } }); toast(`Saved workflow ${wf.name}. Say “run ${wf.name}” any time.`); closeSheet(); loadSkills(); } catch (e) { handleError(e); }
      } } }, icon("repeat", 16), "Save as workflow") : null,
      h("button", { class: "btn danger-ghost", on: { click: () => confirmSheet("Delete this ramble?", "Its messages and results are deleted. Reminders it set keep working.", "Delete", async () => { await call(`/api/threads/${t.id}`, { method: "DELETE" }); location.hash = ""; }) } }, icon("trash", 16), "Delete")),
  ]);
}

function renameRamble(t: any) {
  const name = h("input", { class: "field", value: channelName(t), maxLength: 30, autocapitalize: "off", spellcheck: false, placeholder: "japan-trip" });
  openSheet("Rename", [h("label", null, h("span", null, "Channel name"), name),
    h("button", { class: "btn primary big", on: { click: async () => {
      try { const r = await call(`/api/threads/${t.id}`, { method: "PATCH", body: { channel: name.value } }); S.chat.thread.channel = r.channel; closeSheet(); drawChat(); loadThreads(); toast(`Renamed to #${r.channel}`); }
      catch (e) { handleError(e); }
    } } }, "Save")]);
  setTimeout(() => { name.focus(); name.select(); }, 60);
}

// ---------------- a DM with one teammate ----------------

// When you last opened each DM or ramble (this device), for the unread dot.
const seen: Record<string, string> = JSON.parse(localStorage.getItem("hearth.seen") || "{}");
function markSeen(id: string) {
  seen[id] = new Date(Date.now() + 2000).toISOString(); // a little ahead, so your own message landing doesn't count as new
  localStorage.setItem("hearth.seen", JSON.stringify(seen));
}
const unreadDm = (t: any) => !!t.lastDmAt && t.lastDmAt > (seen[t.id] || "");

async function loadDm(id: string) {
  try { S.dm = await call(`/api/teammates/${id}`); markSeen(id); drawDm(); }
  catch (e) { if (e instanceof ApiError && e.status === 404) { location.hash = ""; return; } handleError(e); }
}

function renderDm() {
  S.dm = null;
  frame({ header: h("div"), body: h("div", { id: "dm", class: "msgs" }), composer: true });
  drawHeader();
}

function drawDm(stick = true) {
  const el = document.getElementById("dm");
  const d = S.dm;
  if (!el || !d) return;
  drawHeader();
  const t = rosterEntry(d.teammate.id);
  const direct = new Set(d.messages.map((m: any) => m.id));
  const items: { at: string; nodes: Node[] }[] = [];
  const saved = S.chat;
  S.chat = { approvals: d.approvals, jobs: d.jobs, messages: d.messages, thread: { id: `tm-${t.id}` } };
  for (const m of d.messages) if (!d.jobs.some((j: any) => j.messageId === m.id)) items.push({ at: m.createdAt, nodes: [plainMessage(m)] });
  for (const j of d.jobs.filter((j: any) => direct.has(j.messageId))) {
    const m = d.messages.find((x: any) => x.id === j.messageId);
    items.push({ at: j.createdAt, nodes: [row(youWho(), m.createdAt, [h("div", { class: "mtext" }, m.text)]), answer(j)] });
  }
  S.chat = saved;
  items.sort((a, b) => a.at.localeCompare(b.at));
  const elsewhere = d.jobs.filter((j: any) => !direct.has(j.messageId) && !j.followsUp).slice(-6).reverse();
  clear(el,
    h("div", { class: "dmhero" }, face(t, 72, t.state), h("h2", null, t.name), h("p", null, t.description || role(t)),
      d.routines.length ? h("div", { class: "routines" }, h("small", null, "Routines"), d.routines.map((r: any) =>
        h("button", { class: `routine ${r.status}`, on: { click: () => openHook(r) } }, icon(r.trigger.type === "at" ? "clock" : "repeat", 14), h("span", null, r.title), h("small", null, r.status === "paused" ? "paused" : r.when)))) : null,
      elsewhere.length ? h("div", { class: "routines" }, h("small", null, "In rambles"), elsewhere.map((j: any) =>
        h("button", { class: "routine", on: { click: () => { location.hash = `#c/${j.threadId}/${j.id}`; } } }, face(t, 18, jobState(j)), h("span", null, j.task), h("small", null, j.status === "done" ? shortAgo(j.finishedAt || j.updatedAt) : j.status)))) : null),
    items.flatMap((x) => x.nodes));
  if (stick) requestAnimationFrame(() => { const s = document.getElementById("scroll")!; s.scrollTop = s.scrollHeight; });
}

// ---------------- composer ----------------

function renderComposer(targetId = "composerwrap", threadJob?: string) {
  const wrap = document.getElementById(targetId);
  if (!wrap) return;
  const r = route();
  const inThread = threadJob || (r.view === "chat" && r.job && !wide() ? r.job : undefined);
  const placeholder = S.conn === "offline" ? "Hub is offline"
    : inThread ? "Reply…"
    : r.view === "dm" ? `Message ${mate(r.id).name}`
    : r.view === "chat" && r.id !== "new" && S.chat?.thread ? `Message #${channelName(S.chat.thread)}`
    : "Ramble. Hearth will hand it out…";
  const draftKey = `hearth.draft.${targetId}`;
  const box = h("textarea", { rows: 1, value: sessionStorage.getItem(draftKey) || "", placeholder, enterKeyHint: "send",
    on: {
      input: () => { autosize(box); sessionStorage.setItem(draftKey, box.value); swap(); },
      keydown: (e: KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer: coarse)").matches) { e.preventDefault(); submit(); } },
    } }) as HTMLTextAreaElement;
  if (targetId === "composerwrap") box.id = "composer";
  const submit = () => { const v = box.value; box.value = ""; sessionStorage.removeItem(draftKey); box.dispatchEvent(new Event("input")); send(v, inThread); };
  const action = h("button", { class: "act", "aria-label": "Hold to talk" });
  const canAttach = !inThread && r.view !== "dm";
  const pending: any[] = [];
  const chips = h("div", { class: "attach-chips" });
  const drawChips = () => clear(chips, pending.map((f) => h("span", { class: "chip" }, f.name, h("button", { "aria-label": `Remove ${f.name}`, on: { click: () => { pending.splice(pending.indexOf(f), 1); drawChips(); swap(); } } }, icon("x", 12)))));
  const picker = h("input", { type: "file", multiple: true, hidden: true, on: { change: async () => {
    for (const file of Array.from(picker.files || []).slice(0, 5)) {
      try {
        const hub = activeHub()!;
        const res = await fetch(`${hub.url}/api/files`, { method: "POST", headers: { ...authHeaders(hub), "X-File-Name": encodeURIComponent(file.name), "Content-Type": file.type || "application/octet-stream" }, body: file });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Upload failed");
        S.files.set(data.id, data); pending.push(data); drawChips(); swap();
      } catch (e) { handleError(e); }
    }
    picker.value = "";
  } } }) as HTMLInputElement;
  const clip = h("button", { class: "plus", "aria-label": "Attach a file", disabled: !canAttach, on: { click: () => picker.click() } }, icon("plus", 22));
  attachments = () => pending.splice(0).map((f) => f.id);
  const swap = () => {
    const hasText = !!box.value.trim() || pending.length > 0;
    action.classList.toggle("send", hasText);
    clear(action, icon(hasText ? "send" : "mic", 20));
    action.setAttribute("aria-label", hasText ? "Send" : "Hold to talk");
  };
  // Mic: tap to dictate (✓/✕ to finish), or hold and let go.
  action.addEventListener("pointerdown", (e) => { if (box.value.trim() || pending.length || dict) return; e.preventDefault(); micTarget = inThread; onMicDown(box, swap, wrap); });
  action.addEventListener("pointerup", () => { if (recording && Date.now() - pressAt > 600) finishDictation(true); });
  action.addEventListener("click", () => { if (box.value.trim() || pending.length) { submit(); drawChips(); } });
  clear(wrap, h("div", { class: "rec", id: targetId === "composerwrap" ? "rec" : undefined, hidden: true }), chips, h("div", { class: "composer", id: targetId === "composerwrap" ? "composerbox" : undefined }, clip, box, action, picker));
  swap();
  autosize(box);
}

let micTarget: string | undefined;
/** Takes the files waiting in the message box (set by renderComposer). */
let attachments: () => string[] = () => [];

async function send(text: string, threadJob?: string) {
  const t = text.trim();
  const fileIds = threadJob || route().view === "dm" ? [] : attachments();
  if (!t && !fileIds.length) return;
  const r = route();
  try {
    if (threadJob) { await call(`/api/jobs/${threadJob}/reply`, { body: { text: t } }); if (r.view === "chat") loadChat(r.id); return; }
    if (r.view === "dm") { await call(`/api/teammates/${r.id}/messages`, { body: { text: t } }); loadDm(r.id); return; }
    const inChat = r.view === "chat" && r.id !== "new";
    const res = inChat ? await call(`/api/threads/${r.id}/messages`, { body: { text: t, fileIds } }) : await call("/api/threads", { body: { text: t, fileIds } });
    S.planning = res.thread.id;
    if (!inChat) { S.chat = { thread: res.thread, messages: [res.message], jobs: [], approvals: [] }; location.hash = `#c/${res.thread.id}`; return; }
    upsert(S.chat.messages, res.message);
    drawChat();
  } catch (e) {
    toast(`Not sent: ${(e as Error).message}`, "err");
    handleError(e);
  }
}

// ---------------- faces: simple shapes, expressive eyes; the face acts out the state ----------------

const SHAPES = ["round", "squircle", "blob", "tall", "wide", "leaf"];
function shapeOf(id: string) {
  if (id === "hearth") return "round";
  let n = 0;
  for (const c of id) n = (n * 31 + c.charCodeAt(0)) >>> 0;
  return SHAPES[n % SHAPES.length];
}

/** state: idle | thinking | working | waiting | blocked | done */
// The badge on each avatar: the teammate's emoji (the orchestrator picks one; you can change it). Older teammates
// without one get one from their name or description.
const LANE_EMOJI: [RegExp, string][] = [
  [/fit|gym|workout|exercise|training|sport|run|yoga/i, "🏋️"], [/health|doctor|medic|wellness|sleep/i, "❤️"],
  [/research|search|find|scout|news/i, "🔍"], [/travel|trip|flight|vacation/i, "✈️"], [/bill|money|financ|budget|tax|invest|expense|pay/i, "💸"],
  [/remind|plan|calendar|schedul|errand/i, "🔔"], [/language|learn|study|school|flashcard|tutor/i, "💬"], [/read|book/i, "📚"],
  [/meal|food|cook|recipe|diet|grocer|nutrition/i, "🍳"], [/gift|shop|buy/i, "🎁"], [/repair|fix|maintenance|car|diy/i, "🔧"],
  [/home|house|apartment|rent|landlord/i, "🏠"], [/music|song|playlist|concert|ticket/i, "🎵"], [/job|career|work|interview|resume/i, "💼"],
  [/pet|dog|cat|vet/i, "🐾"],
];
const badgeOf = (t: any): string | null => t.emoji || (t.id === "hearth" ? "🔥" : null) || LANE_EMOJI.find(([re]) => re.test(t.name || ""))?.[1] || LANE_EMOJI.find(([re]) => re.test(t.description || ""))?.[1] || null;
// How the badge moves, from the emoji: dumbbells lift, planes fly off and back, coins flip, bells ring… anything else wiggles.
const MOVES: [RegExp, string][] = [
  [/🏋|💪|🤸|🏃|🚴|⛹|🏐|⚽|🏀|🎾/u, "lift"], [/🔍|🔎|🧭|🗺/u, "sweep"], [/✈|🛫|🚀|🌍|🌎|🌏|🧳|🚗|🚆/u, "fly"],
  [/💸|💰|🪙|💵|💳|🏦|📈/u, "flip"], [/🔔|⏰|📅|🗓|⏳/u, "ring"], [/📚|📖|🗣|📝|✏|🎓|💬/u, "flick"], [/🔥|🕯|⚡/u, "flicker"],
  [/🎵|🎶|🎸|🐾|🐶|🐱/u, "hop"], [/❤|💚|💙|🩺|💊|🧘/u, "beat"],
];
const moveOf = (e: string) => MOVES.find(([re]) => re.test(e))?.[1] || "wiggle";

function face(t: any, size = 44, state = "idle") {
  const badge = size >= 26 ? badgeOf(t) : null;
  return h("span", { class: `face ${shapeOf(t.id)} ${state}`, style: `--c:${t.color};--s:${size}px`, role: "img", "aria-label": `${t.name}, ${state}` },
    h("span", { class: "eyes" }, h("i", { class: "eye" }), h("i", { class: "eye" })),
    badge ? h("span", { class: `prop m-${moveOf(badge)}`, "aria-hidden": "true" }, h("span", { class: "em" }, emoji3d(badge))) : null);
}

const jobStatus = new Map<string, string>();

/** An in-app notification: who, what, tap to open. Stacks at the top; goes away on its own. */
function banner(who: any, title: string, text: string, onTap: () => void) {
  const b = h("button", { class: "banner", on: { click: () => { b.remove(); onTap(); } } },
    face(who, 34, "done"), h("span", { class: "grow" }, h("b", null, title), h("small", null, text)));
  let stack = document.getElementById("banners");
  if (!stack) { stack = h("div", { id: "banners", "aria-live": "polite" }); document.body.appendChild(stack); }
  stack.appendChild(b);
  requestAnimationFrame(() => b.classList.add("show"));
  setTimeout(() => { b.classList.remove("show"); setTimeout(() => b.remove(), 350); }, 6000);
}

// ---- maps: real map tiles (fetched and cached by the hub), stops on top, a route that plays stop by stop ----

const TILE = 256;
function mercator(lat: number, lon: number, z: number) {
  const n = TILE * 2 ** z, r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return { x: ((lon + 180) / 360) * n, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n };
}

/**
 * A map you can read at a glance: one stop at a time, zoomed in, with a plain card underneath ("Day 1-2 · Osaka",
 * what to do, ‹ 1 of 5 ›). It plays through the stops once on its own; "See whole route" shows the overview.
 */
function mapView(stops: { name: string; lat: number; lon: number; when?: string; note?: string; url?: string; leg?: string }[], route: boolean, _list = false) {
  const H = 210;
  const hub = activeHub()!, key = S.state?.tileKey || "";
  const ns = "http://www.w3.org/2000/svg";
  let cur = 0, overview = false, touched = false;
  const stage = h("div", { class: "mstage" });
  const counter = h("span", { class: "mcount" });
  const label = h("div", { class: "mlabel" });
  const dots = h("div", { class: "mdots" }, stops.map((_, k) => h("i", { on: { click: () => go(k) } })));
  // Tiles for a view centered on (cx, cy) at zoom z, plus a function placing a point on it.
  const tilesFor = (cx: number, cy: number, z: number) => {
    const out: Node[] = [], max = 2 ** z;
    for (let tx = Math.floor((cx - 420) / TILE); tx <= Math.floor((cx + 420) / TILE); tx++)
      for (let ty = Math.floor((cy - H / 2 - 10) / TILE); ty <= Math.floor((cy + H / 2 + 10) / TILE); ty++) {
        if (ty < 0 || ty >= max) continue;
        out.push(h("img", { class: "mtile", alt: "", draggable: false, src: `${hub.url}/tiles/${z}/${((tx % max) + max) % max}/${ty}.png?k=${encodeURIComponent(key)}`, style: `left:calc(50% + ${tx * TILE - cx}px);top:calc(50% + ${ty * TILE - cy}px)` }));
      }
    return out;
  };
  const draw = () => {
    if (overview) {
      let z = 14;
      for (; z > 2; z--) {
        const p = stops.map((s) => mercator(s.lat, s.lon, z));
        if (Math.max(...p.map((q) => q.x)) - Math.min(...p.map((q) => q.x)) <= 260 && Math.max(...p.map((q) => q.y)) - Math.min(...p.map((q) => q.y)) <= 150) break;
      }
      const p = stops.map((s) => mercator(s.lat, s.lon, z));
      const cx = (Math.max(...p.map((q) => q.x)) + Math.min(...p.map((q) => q.x))) / 2, cy = (Math.max(...p.map((q) => q.y)) + Math.min(...p.map((q) => q.y))) / 2;
      const svg = document.createElementNS(ns, "svg"); svg.setAttribute("class", "mroute");
      if (route && stops.length > 1) {
        const path = document.createElementNS(ns, "path");
        path.setAttribute("d", p.map((q, k) => `${k ? "L" : "M"}${(q.x - cx).toFixed(1)} ${(q.y - cy).toFixed(1)}`).join(" "));
        svg.appendChild(path);
      }
      // How you get from one stop to the next ("✈️ 2h 40m"), on the middle of each line.
      // Each label sits beside the middle of its own line, alternating sides, so lines that run close don't stack labels.
      const legs = route ? p.slice(1).map((q, k) => {
        if (!stops[k + 1].leg) return null;
        const a = p[k], dx = q.x - a.x, dy = q.y - a.y, len = Math.hypot(dx, dy) || 1, side = k % 2 ? 1 : -1;
        const mx = (a.x + q.x) / 2 + (-dy / len) * 16 * side, my = (a.y + q.y) / 2 + (dx / len) * 16 * side;
        return h("span", { class: "mleg", style: `left:calc(50% + ${mx - cx}px);top:calc(50% + ${my - cy}px)` }, stops[k + 1].leg!);
      }) : [];
      clear(stage, tilesFor(cx, cy, z), svg, legs, p.map((q, k) => h("button", { class: `mpin on ${k === cur ? "cur" : ""}`, style: `left:calc(50% + ${q.x - cx}px);top:calc(50% + ${q.y - cy}px)`, "aria-label": stops[k].name,
        on: { click: () => { overview = false; go(k); } } }, h("span", null, String(k + 1)))));
    } else {
      const s = stops[cur], z = 13, q = mercator(s.lat, s.lon, z);
      clear(stage, tilesFor(q.x, q.y, z), h("span", { class: "mpinbig" }, emoji3d("📍")));
    }
    const s = stops[cur];
    clear(label, h("small", null, [s.when, s.name].filter(Boolean).join(" · ")), h("b", null, s.note || s.name),
      cur > 0 && s.leg ? h("span", { class: "mlegline" }, `From ${stops[cur - 1].name} · ${s.leg}`) : null,
      h("a", { href: s.url || `https://maps.google.com/?q=${s.lat},${s.lon}`, target: "_blank", rel: "noopener noreferrer", class: "mopenlink" }, "Open in Maps"));
    counter.textContent = stops.length > 1 ? `${cur + 1} of ${stops.length}` : "";
    Array.from(dots.children).forEach((d, k) => d.classList.toggle("on", k === cur));
    toggle.textContent = overview ? "Back to stops" : "See whole route";
  };
  const go = (k: number) => { cur = (k + stops.length) % stops.length; stage.classList.remove("in"); void stage.offsetWidth; stage.classList.add("in"); draw(); };
  const toggle = h("button", { class: "mtoggle", on: { click: () => { touched = true; overview = !overview; draw(); } } });
  const nav = stops.length > 1 ? h("div", { class: "mnav" },
    h("button", { class: "mbtn", "aria-label": "Previous stop", on: { click: () => { touched = true; overview = false; go(cur - 1); } } }, icon("back", 18)), counter,
    h("button", { class: "mbtn", "aria-label": "Next stop", on: { click: () => { touched = true; overview = false; go(cur + 1); } } }, icon("chevron", 18))) : null;
  // Swipe left/right on the map to change stop.
  let sx = 0;
  stage.addEventListener("pointerdown", (e) => { sx = e.clientX; });
  stage.addEventListener("pointerup", (e) => { const dx = e.clientX - sx; if (Math.abs(dx) > 40 && !overview) { touched = true; go(cur + (dx < 0 ? 1 : -1)); } });
  const box = h("div", { class: "mapwrap" },
    h("div", { class: "mapbox" }, stage, stops.length > 1 && route ? toggle : null, h("span", { class: "mattr" }, "© OpenStreetMap")),
    h("div", { class: "mcardline" }, label, nav), stops.length > 1 ? dots : null);
  draw();
  // Plays through the stops once when it comes into view, until you touch it.
  if (stops.length > 1) {
    const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      io.disconnect();
      const tick = () => { if (touched || cur >= stops.length - 1 || !box.isConnected) return; go(cur + 1); setTimeout(tick, 2600); };
      setTimeout(tick, 2600);
    }, { threshold: .6 });
    requestAnimationFrame(() => io.observe(box));
  }
  return box;
}

function secs(ms?: number) {
  if (!ms) return "";
  return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`;
}

function money(c: number | null | undefined) {
  return c === null || c === undefined ? "$?" : c === 0 ? "$0" : c < 0.01 ? "<$0.01" : `$${c.toFixed(2)}`;
}

// ---- tiles: fixed, good-looking components fed with data; options come from the skill ("hourly", "units") ----

const deg = (c: number | undefined, units: unknown) => c === undefined ? "–" : `${Math.round(units === "F" ? c * 9 / 5 + 32 : c)}°`;

function tile(t: any) {
  const o = t.options || {};
  const d = t.data || {};
  switch (t.type) {
    case "weather":
      return h("div", { class: `tile weather ${o.compact ? "compact" : ""}` },
        h("div", { class: "wtop" },
          h("div", null, h("small", null, d.place || t.title), h("div", { class: "big" }, deg(d.temp, o.units)), h("div", { class: "wsum" }, d.summary)),
          h("div", { class: "wside" },
            d.high !== undefined ? h("span", null, `H ${deg(d.high, o.units)}  L ${deg(d.low, o.units)}`) : null,
            d.feels !== undefined ? h("span", null, `Feels ${deg(d.feels, o.units)}`) : null,
            d.rain !== undefined ? h("span", null, `${Math.round(d.rain)}% rain`) : null)),
        o.hourly !== false && !o.compact && d.hours?.length ? h("div", { class: "hours" }, d.hours.map((x: any) =>
          h("div", { class: "hour" }, h("small", null, x.t), h("b", null, deg(x.temp, o.units)), x.rain ? h("i", { style: `--r:${Math.min(100, x.rain)}%` }) : h("i", { class: "dry" })))) : null);
    case "places": {
      const pins = d.items.filter((x: any) => typeof x.lat === "number" && typeof x.lon === "number");
      return h("div", { class: "tile places" }, t.title ? h("small", { class: "tt" }, t.title) : null,
        pins.length ? mapView(pins.map((x: any) => ({ name: x.name, lat: x.lat, lon: x.lon, note: x.detail, url: x.url })), false) : null, d.items.map((x: any, i: number) =>
        h(x.url ? "a" : "div", { class: "place", ...(x.url ? { href: x.url, target: "_blank", rel: "noopener noreferrer" } : {}) },
          h("span", { class: "n" }, String(i + 1)), h("span", { class: "grow" }, h("b", null, x.name), x.detail ? h("small", null, x.detail) : null), x.url ? icon("chevron", 14) : null)));
    }
    case "map":
      return h("div", { class: "tile map" }, t.title ? h("small", { class: "tt" }, t.title) : null, mapView(d.stops, d.route !== false, true));
    case "checklist":
      return h("div", { class: "tile checklist" }, t.title ? h("small", { class: "tt" }, t.title) : null, d.items.map((x: any) =>
        h("div", { class: `ci ${x.done ? "done" : ""}` }, h("span", { class: "box" }, x.done ? icon("check", 12) : null), x.text)));
    case "stat":
      return h("div", { class: "tile stat" }, h("small", null, d.label || t.title), h("div", { class: "big" }, d.value), d.sub ? h("span", null, d.sub) : null);
    case "note":
      return h("div", { class: "tile note" }, t.title ? h("small", { class: "tt" }, t.title) : null, richText(d.body));
  }
  return null;
}

// ---------------- voice ----------------

/** Connect speech-to-text: paste a Deepgram key once; the hub checks it, keeps it, and never shows it again. */
async function openVoice() {
  let v: any;
  try { v = await call("/api/voice"); } catch (e) { return handleError(e); }
  const key = h("input", { class: "field", type: "password", placeholder: "Deepgram API key", autocomplete: "off", autocapitalize: "off", spellcheck: false });
  const err = h("p", { class: "err small", hidden: true });
  const connect = h("button", { class: "btn primary big", on: { click: async () => {
    if (!key.value.trim()) return key.focus();
    connect.disabled = true; connect.textContent = "Checking with Deepgram…"; err.hidden = true;
    try { await call("/api/voice", { method: "PUT", body: { key: key.value } }); await refreshState(); closeSheet(); toast("Voice is on. Hold the mic to talk."); }
    catch (e: any) { err.textContent = e.message; err.hidden = false; connect.disabled = false; connect.textContent = "Connect"; }
  } } }, "Connect");
  openSheet("Voice", [
    h("div", { class: "phero" }, emoji3d("🎙️", "ideaicon"), h("b", null, v.provider ? "Voice is on" : "Talk instead of typing"),
      h("small", null, v.provider ? `Deepgram · key ${v.hint}${v.source === "env" ? " · set in the hub's .env" : ""}` : "Hold the mic and ramble; Hearth turns it into tasks.")),
    v.source === "env" ? h("p", { class: "muted" }, "This key comes from the hub's .env file, so change it there.")
      : v.provider ? h("button", { class: "btn danger-ghost", on: { click: () => confirmSheet("Turn voice off?", "The key is removed from the hub.", "Disconnect", async () => { await call("/api/voice", { method: "DELETE" }); await refreshState(); toast("Voice is off"); }) } }, "Disconnect Deepgram")
      : [
        h("ol", { class: "steps" },
          h("li", null, "Make a free account at ", h("a", { href: "https://console.deepgram.com/signup", target: "_blank", rel: "noopener noreferrer" }, "console.deepgram.com"), " (it comes with free credit)."),
          h("li", null, "Go to API Keys, create a key with Member access, and copy it."),
          h("li", null, "Paste it here.")),
        key, err, connect,
        h("p", { class: "muted small" }, "The key is checked with Deepgram, then stays on your hub in a private file. It's never stored in your data or exports and never sent back to this app. Your recordings go from the hub to Deepgram only to be transcribed."),
      ],
  ]);
  setTimeout(() => key.focus(), 80);
}

// Dictation, Wispr Flow style: tap the mic and talk as long as you like. A panel takes the keyboard's place (✕, a live
// waveform, ✓); your words stream into the message box as you speak; ✓ tidies them (fillers, self-corrections) and leaves
// them ready to send. Holding the mic works too: let go to finish. Audio goes to your hub, which relays it to Deepgram.
type Dictation = { box: HTMLTextAreaElement; swap: () => void; panel: HTMLElement; base: string; finals: string[]; interim: string;
  ws: WebSocket | null; ctx: AudioContext | null; media: MediaStream | null; rec: MediaRecorder | null; chunks: Blob[]; raf: number; started: number; ended: Promise<void>; endNow: () => void };
let dict: Dictation | null = null;
let recording = false;
let pressAt = 0;

function autosize(t: HTMLTextAreaElement) { t.style.height = "auto"; t.style.height = Math.min(150, t.scrollHeight) + "px"; }

const dictText = (d: Dictation) => [d.base.trim(), [...d.finals, d.interim].join(" ").replace(/\s+/g, " ").trim()].filter(Boolean).join(d.base.trim() ? " " : "");

async function onMicDown(box: HTMLTextAreaElement, swap: () => void, panelHost: HTMLElement) {
  if (dict) return;
  pressAt = Date.now();
  if (!S.state?.voice) { openVoice(); return; }
  let media: MediaStream;
  try { media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch { toast("Microphone permission is off", "err"); return; }
  const bars = Array.from({ length: 11 }, () => h("i"));
  const clock = h("span", { class: "dclock" }, "0:00");
  const status = h("span", { class: "dstatus" }, "Listening");
  let endNow = () => {};
  const d: Dictation = { box, swap, panel: h("div"), base: box.value, finals: [], interim: "", ws: null, ctx: null, media, rec: null, chunks: [], raf: 0, started: Date.now(),
    ended: new Promise<void>((res) => { endNow = res; }), endNow: () => endNow() };
  d.endNow = () => endNow();
  d.panel = h("div", { class: "dictate", role: "dialog", "aria-label": "Dictation" },
    h("div", { class: "drow" },
      h("button", { class: "dbtn", "aria-label": "Cancel", on: { click: () => finishDictation(false) } }, icon("x", 22)),
      h("button", { class: "dbtn done", "aria-label": "Done", on: { click: () => finishDictation(true) } }, icon("check", 22))),
    h("div", { class: "dwave" }, bars), h("div", { class: "dlabel" }, status, clock));
  dict = d;
  recording = true;
  panelHost.appendChild(d.panel);
  requestAnimationFrame(() => d.panel.classList.add("open"));
  box.placeholder = "Say anything. Ramble on…";

  // Audio: a level meter for the waveform, raw PCM to the hub for live words, and a recording as a fallback.
  const ctx = new AudioContext();
  d.ctx = ctx;
  const src = ctx.createMediaStreamSource(media);
  const meter = ctx.createAnalyser();
  meter.fftSize = 256;
  src.connect(meter);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain(); mute.gain.value = 0;
  src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
  proc.onaudioprocess = (e) => {
    if (d.ws?.readyState !== WebSocket.OPEN) return;
    const f = e.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) pcm[i] = Math.max(-1, Math.min(1, f[i])) * 0x7fff;
    d.ws.send(pcm.buffer);
  };
  const levels = new Uint8Array(meter.frequencyBinCount);
  const draw = () => {
    meter.getByteTimeDomainData(levels);
    let peak = 0;
    for (const v of levels) peak = Math.max(peak, Math.abs(v - 128) / 128);
    bars.forEach((b, i) => { const shape = 1 - Math.abs(i - 5) / 6; const jitter = 0.6 + Math.random() * 0.4; b.style.setProperty("--h", `${Math.max(0.12, Math.min(1, peak * 2.2 * shape * jitter + 0.08))}`); });
    const s = Math.floor((Date.now() - d.started) / 1000);
    clock.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    d.raf = requestAnimationFrame(draw);
  };
  draw();
  try {
    const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((t) => MediaRecorder.isTypeSupported(t)) || "";
    d.rec = new MediaRecorder(media, type ? { mimeType: type } : undefined);
    d.rec.ondataavailable = (e) => { if (e.data.size) d.chunks.push(e.data); };
    d.rec.start(500);
  } catch {}
  try {
    const hub = activeHub()!;
    const { ticket } = await call("/api/voice/live", { body: {} });
    const ws = new WebSocket(`${hub.url.replace(/^http/, "ws")}/voice-live?ticket=${encodeURIComponent(ticket)}&rate=${ctx.sampleRate}`);
    d.ws = ws;
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(String(e.data));
        if (m.t === "partial") d.interim = m.text;
        else if (m.t === "final") { if (m.text) d.finals.push(m.text); d.interim = ""; }
        else if (m.t === "end") d.endNow();
        else if (m.t === "error") status.textContent = "Listening (words appear when you're done)";
        if (dict === d) { box.value = dictText(d); autosize(box); box.scrollTop = box.scrollHeight; }
      } catch {}
    };
    ws.onclose = () => d.endNow();
  } catch { status.textContent = "Listening (words appear when you're done)"; }
}

/** ✓ (keep) or ✕ (throw away). Keep: wait for the last words, tidy them, leave them in the box to send. */
async function finishDictation(keep: boolean) {
  const d = dict;
  if (!d) return;
  dict = null;
  recording = false;
  cancelAnimationFrame(d.raf);
  try { d.ws?.readyState === WebSocket.OPEN && d.ws.send("stop"); } catch {}
  const recStopped = new Promise<void>((res) => { if (d.rec && d.rec.state !== "inactive") { d.rec.onstop = () => res(); d.rec.stop(); } else res(); });
  d.media?.getTracks().forEach((t) => t.stop());
  d.panel.classList.remove("open");
  setTimeout(() => d.panel.remove(), 260);
  d.box.placeholder = "Ramble. Hearth will hand it out…";
  if (!keep) { try { d.ws?.close(); } catch {} d.ctx?.close(); d.box.value = d.base; d.box.dispatchEvent(new Event("input")); return; }
  d.box.classList.add("cleaning");
  await Promise.race([d.ended, new Promise((r) => setTimeout(r, 2500))]);
  try { d.ws?.close(); } catch {}
  d.ctx?.close();
  let said = [...d.finals, d.interim].join(" ").replace(/\s+/g, " ").trim();
  try {
    if (!said) {
      // No live words (no connection, or Deepgram streaming unavailable): transcribe the recording instead.
      await recStopped;
      if (d.chunks.length) {
        const hub = activeHub()!;
        const blob = new Blob(d.chunks, { type: (d.rec?.mimeType || "audio/webm").split(";")[0] });
        const res = await fetch(hub.url + "/api/transcribe", { method: "POST", headers: { ...authHeaders(hub), "Content-Type": blob.type }, body: blob });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Transcription failed");
        said = String(data.text || "").trim();
      }
    }
    if (!said) { toast("I didn't catch that", "err"); d.box.value = d.base; return; }
    const { text } = await call("/api/voice/clean", { body: { text: said } });
    d.box.value = [d.base.trim(), text].filter(Boolean).join(" ");
  } catch (e) { handleError(e); if (said) d.box.value = [d.base.trim(), said].filter(Boolean).join(" "); }
  finally {
    d.box.classList.remove("cleaning");
    d.box.dispatchEvent(new Event("input"));
    autosize(d.box);
    d.box.focus();
  }
}

// ---------------- menu ----------------

function openMenu() {
  const st = S.state;
  const item = (ic: string, label: string, sub: string, fn: () => void, badge?: string) =>
    h("button", { class: "mi", on: { click: () => { closeDrawer(); setTimeout(fn, 180); } } }, icon(ic, 20), h("span", { class: "grow" }, h("b", null, label), h("small", null, sub)), badge ? h("em", null, badge) : null);
  const drawer = h("aside", { class: "drawer", role: "dialog", "aria-label": "Menu" },
    h("button", { class: "hubcard", on: { click: () => { closeDrawer(); setTimeout(openHubs, 180); } } },
      h("span", { class: "hubicon" }, icon("server", 20)),
      h("span", { class: "grow" }, h("b", null, st?.hub?.name || "Hub"), h("small", null, `${st?.hub?.storage || "?"}${st?.voice ? " · voice on" : ""}`)),
      h("i", { class: `status ${S.conn}` })),
    h("nav", null,
      item("search", "Jump to…", "Find a teammate, chat or task (⌘K)", openJump),
      item("bell", "Plans", "Reminders, routines, watches", openPlans),
      item("brain", "Memory", "What I know about you", openMemory),
      item("dms", "People", "Your relationship map", openPeople),
      item("users", "Teammates", "Who the orchestrator can hand work to", openTeammates),
      item("sparkle", "Skills", "What the team already knows how to do", openSkills),
      item("brain", "Brains", "Which harness and model does what", openBrains),
      item("download", "Files", "Attached and made, ready to download", openFiles),
      item("code", "Scripts", "What I can run", openScripts, st?.pendingScripts ? `${st.pendingScripts} to approve` : undefined),
      item("settings", "Settings", "Notifications, location, data", openSettings)),
    h("p", { class: "foot" }, `Hearth · open source · ${__BUILD__}`),
  );
  const scrim = h("div", { class: "drawer-scrim", id: "drawer", on: { click: (e: Event) => { if (e.target === scrim) closeDrawer(); } } }, drawer);
  document.body.appendChild(scrim);
  requestAnimationFrame(() => scrim.classList.add("open"));
}

function closeDrawer() {
  const d = document.getElementById("drawer");
  if (!d) return;
  d.classList.remove("open"); d.id = "";
  setTimeout(() => d.remove(), 220);
}

// ---------------- teammates & brains ----------------

function openTeammates() {
  const name = h("input", { class: "field", placeholder: "Fitness", maxLength: 24 });
  const what = h("textarea", { class: "field", rows: 2, placeholder: "Keeps me honest about workouts and sleep. Checks in if I skip.", maxLength: 200 });
  openSheet("Teammates", [
    h("p", { class: "muted" }, "You never have to pick one. The orchestrator hands each job to the right teammate, and adds a new one when nobody fits."),
    h("div", { class: "list" }, S.teammates.map((t) => h("div", { class: "item" },
      h("button", { class: "facebtn", "aria-label": `Change ${t.name}'s badge`, on: { click: () => openBadge(t) } }, face(t, 34, "idle")),
      h("span", { class: "grow" }, h("b", null, t.name), h("small", { class: "sub" }, t.description)),
      !t.builtIn ? h("button", { class: "iconbtn", "aria-label": `Remove ${t.name}`, on: { click: () => confirmSheet(`Remove ${t.name}?`, "Past work stays.", "Remove", async () => { await call(`/api/teammates/${t.id}`, { method: "DELETE" }); toast("Removed"); }) } }, icon("trash", 16)) : null))),
    h("h4", null, "Add one yourself"),
    h("label", null, h("span", null, "Name"), name),
    h("label", null, h("span", null, "What do they do?"), what),
    h("button", { class: "btn primary big", on: { click: async () => {
      if (!name.value.trim() || !what.value.trim()) return name.focus();
      try { const t = await call("/api/teammates", { body: { name: name.value, description: what.value } }); closeSheet(); toast(`${t.name} joined`); loadTeammates(); }
      catch (e) { handleError(e); }
    } } }, "Add teammate"),
  ]);
}

/** Pick a teammate's badge: any emoji (type it or use the phone's emoji keyboard), or one of a few suggestions. */
function openBadge(t: any) {
  const input = h("input", { class: "field emojifield", value: badgeOf(t) || "", maxLength: 16, "aria-label": "Emoji", inputMode: "text" });
  const save = async (emoji: string) => {
    try { await call(`/api/teammates/${t.id}`, { method: "PATCH", body: { emoji } }); closeSheet(); toast(`${t.name} updated`); loadTeammates(); }
    catch (e) { handleError(e); }
  };
  const ideas = ["🏋️", "🏐", "🧘", "✈️", "🧭", "🔍", "💸", "📈", "🔔", "📅", "🗣️", "📚", "🍳", "🎁", "🔧", "🏠", "🎵", "💼", "🐾", "❤️", "🌱", "🎨", "📸", "🧠"];
  openSheet(`${t.name}'s badge`, [
    h("div", { class: "badgepreview" }, face({ ...t, emoji: input.value || t.emoji }, 72, "idle")),
    h("div", { class: "emojigrid" }, ideas.map((e) => h("button", { class: "emojibtn", "aria-label": e, on: { click: () => save(e) } }, emoji3d(e)))),
    h("label", null, h("span", null, "Or any emoji"), input),
    h("button", { class: "btn primary big", on: { click: () => save(input.value.trim()) } }, "Save"),
  ]);
}

const MODEL_HINTS: Record<string, string[]> = {
  claude: ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  codex: [],
};

async function openBrains() {
  let data: any;
  try { data = await call("/api/brains"); } catch (e) { return handleError(e); }
  const roles: [string, string, string][] = [
    ["orchestrator", "Orchestrator", "Reads every message, splits it into tasks, and picks who does each and on which model. Use your smartest model."],
    ["quick", "Quick", "Simple jobs: reminders, notes, pinning, small app changes. Use your cheapest model."],
    ["workhorse", "Workhorse", "Most jobs: lookups, options, advice, building apps."],
    ["heavy", "Heavy", "Long research and careful writing, and anything the others can't finish (they move up on their own)."],
  ];
  const state: any = JSON.parse(JSON.stringify(data.current));
  state.hybrid = data.hybrid;
  const hy = h("button", { class: "item", on: { click: () => { state.hybrid = !state.hybrid; hy.querySelector(".switch")!.classList.toggle("on", state.hybrid); } } },
    h("span", { class: "grow left" }, h("b", null, "Smart voice (hybrid)"), h("small", { class: "sub" }, "Cheaper models do the legwork (searching, reminders, gathering); Heavy reads their notes and writes every answer you see. Redoes the job itself if the notes fall short.")),
    h("span", { class: `switch ${state.hybrid ? "on" : ""}` }, h("i")));
  const block = ([key, title, blurb]: [string, string, string]) => {
    const model = h("input", { class: "field", value: state[key].model, placeholder: "harness default", list: `models-${key}`, autocapitalize: "off", spellcheck: false,
      on: { input: () => { state[key].model = model.value.trim(); } } });
    const list = h("datalist", { id: `models-${key}` });
    const fillHints = () => clear(list, (MODEL_HINTS[state[key].harness] || []).map((m) => h("option", { value: m })));
    const seg = h("div", { class: "segmented" }, data.available.map((hn: string) => {
      const b = h("button", { class: state[key].harness === hn ? "on" : "", on: { click: () => { state[key].harness = hn; seg.querySelectorAll("button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); fillHints(); } } },
        hn === "claude" ? "Claude Code" : hn === "codex" ? "Codex" : hn === "echo" ? "Demo" : "Custom");
      return b;
    }));
    fillHints();
    return h("div", { class: "brain" }, h("h4", null, title), h("p", { class: "muted small" }, blurb), seg, model, list);
  };
  openSheet("Brains", [
    h("p", { class: "muted" }, "Pick a harness and model for each role. The harnesses listed are the ones installed on this hub."),
    h("div", { class: "list" }, hy),
    roles.map(block),
    h("button", { class: "btn primary big", on: { click: async () => {
      try { await call("/api/brains", { method: "PATCH", body: state }); toast("Saved"); closeSheet(); } catch (e) { handleError(e); }
    } } }, "Save"),
  ]);
}

// ---------------- skills ----------------

function openSkills() {
  S.panel = "skills";
  openSheet("Skills", h("div", { id: "skills" }), { onClose: () => { S.panel = null; } });
  drawSkills();
  loadSkills();
}

function drawSkills() {
  const el = document.getElementById("skills");
  if (!el) return;
  const wfs = S.workflows;
  clear(el,
    h("p", { class: "muted" }, "When a teammate works something out, it saves how, so next time it's instant. Skills with code need your approval first."),
    h("button", { class: "link", on: { click: async () => { const r = await call("/api/library/purge", { body: {} }); toast(r.removed.length ? `Cleaned up ${r.removed.length}: ${r.removed.join(", ")}` : "Nothing to clean up"); } } },
      "Clean up now (pinned ones stay)"),
    S.skills.length ? h("div", { class: "list" }, S.skills.map((sk) => h("button", { class: "item", on: { click: () => openSkill(sk) } },
      h("span", { class: "hicon" }, icon(sk.kind === "script" ? "code" : "sparkle", 16)),
      h("span", { class: "grow" },
        h("b", null, sk.name, sk.status === "proposed" ? h("span", { class: "tag" }, "needs approval") : null, sk.pinned ? h("span", { class: "tag" }, "pinned") : null),
        h("small", { class: "sub" }, sk.description),
        h("small", { class: "sub" }, [`${sk.runs} use${sk.runs === 1 ? "" : "s"}`, sk.lastUsedAt ? `last ${shortAgo(sk.lastUsedAt)}` : null, sk.lastFixedAt ? `fixed ${shortAgo(sk.lastFixedAt)}` : null, sk.avgMs ? `~${secs(sk.avgMs)}` : null].filter(Boolean).join(" · "))))))
      : h("p", { class: "empty" }, "No skills yet. They appear as your team finishes jobs."),
    wfs.length ? [h("h4", null, "Workflows"), h("div", { class: "list" }, wfs.map((w) => h("div", { class: "item" },
      h("span", { class: "grow" }, h("b", null, w.name, w.status === "proposed" ? h("span", { class: "tag" }, "proposed") : null, w.pinned ? h("span", { class: "tag" }, "pinned") : null),
        h("small", { class: "sub" }, w.description), h("small", { class: "sub" }, w.steps.map((x: any) => x.skill || x.teammate || "task").join(" → "))),
      w.status === "proposed" ? h("button", { class: "btn small primary", on: { click: async () => { await call(`/api/workflows/${w.id}/activate`, { body: {} }); toast("Switched on"); } } }, "Switch on")
        : h("button", { class: "btn small primary", on: { click: async () => { closeSheet(); const r = await call("/api/threads", { body: { text: `Run my "${w.name}" workflow` } }); location.hash = `#c/${r.thread.id}`; } } }, "Run"),
      h("button", { class: `star ${w.pinned ? "on" : ""}`, "aria-label": w.pinned ? "Unpin" : "Pin (never clean up)", on: { click: async () => { await call(`/api/workflows/${w.id}`, { method: "PATCH", body: { pinned: !w.pinned } }); } } }, icon("pin", 16)),
      h("button", { class: "iconbtn", "aria-label": "Delete workflow", on: { click: () => confirmSheet(`Delete ${w.name}?`, "The skills it uses stay.", "Delete", async () => { await call(`/api/workflows/${w.id}`, { method: "DELETE" }); }) } }, icon("trash", 16)))))] : null,
    // Components: reusable artifacts (visual skills). The team reuses them with new data instead of writing new code.
    S.components.length ? [h("h4", null, "Components"), h("p", { class: "muted small" }, "Visuals your team built once and reuses with new data, like an itinerary with a map or a comparison."),
      h("div", { class: "list" }, S.components.map((c: any) => h("div", { class: "item" },
        h("span", { class: "hicon" }, icon("sparkle", 16)),
        h("span", { class: "grow" }, h("b", null, c.title), h("small", { class: "sub" }, c.description || "Writing a description…"),
          h("small", { class: "sub" }, [c.name, `${c.uses} use${c.uses === 1 ? "" : "s"}`, c.versions ? `improved ${c.versions}×` : null].filter(Boolean).join(" · "))),
        h("button", { class: "iconbtn", "aria-label": `Delete ${c.title}`, on: { click: () => confirmSheet(`Delete ${c.title}?`, "Answers that already used it keep working.", "Delete", async () => { await call(`/api/components/${c.id}`, { method: "DELETE" }); loadSkills(); }) } }, icon("trash", 16)))))] : null);
}

function openSkill(sk: any) {
  const desc = h("textarea", { class: "field", rows: 2, value: sk.description, maxLength: 240 });
  const steps = sk.kind === "recipe" ? h("textarea", { class: "field", rows: Math.min(10, (sk.steps || []).length + 1), value: (sk.steps || []).join("\n") }) : null;
  openSheet(sk.name, [
    h("dl", { class: "facts" },
      h("dt", null, "Kind"), h("dd", null, sk.kind === "script" ? `Runs the script ${sk.script} directly, no model` : "A recipe a light model follows"),
      sk.inputs?.length ? [h("dt", null, "Inputs"), h("dd", null, sk.inputs.map((i: any) => i.name).join(", "))] : null,
      sk.uses?.length ? [h("dt", null, "May use"), h("dd", null, sk.uses.join(", "))] : null,
      h("dt", null, "Used"), h("dd", null, `${sk.runs}× · ${sk.failures} failure${sk.failures === 1 ? "" : "s"} · v${sk.version}`),
      sk.teammateId ? [h("dt", null, "Made by"), h("dd", null, mate(sk.teammateId).name)] : null),
    h("label", null, h("span", null, "Description"), desc),
    steps ? h("label", null, h("span", null, "Steps (one per line)"), steps) : null,
    h("div", { class: "stack" },
      h("button", { class: "btn primary", on: { click: async () => {
        try { await call(`/api/skills/${sk.id}`, { method: "PATCH", body: { description: desc.value, steps: steps ? steps.value.split("\n").map((x) => x.trim()).filter(Boolean) : undefined } }); toast("Saved"); closeSheet(); }
        catch (e) { handleError(e); }
      } } }, "Save changes"),
      h("button", { class: "btn ghost", on: { click: async () => { await call(`/api/skills/${sk.id}`, { method: "PATCH", body: { pinned: !sk.pinned } }); toast(sk.pinned ? "Unpinned" : "Pinned: cleanup will never remove it"); closeSheet(); } } }, icon("pin", 16), sk.pinned ? "Unpin" : "Pin (never clean up)"),
      sk.kind === "script" ? h("button", { class: "btn ghost", on: { click: async () => { const list = await call("/api/scripts"); const sc = list.find((x: any) => x.name === sk.script); if (sc) openScript(sc); } } }, icon("code", 16), "View the code") : null,
      h("button", { class: "btn danger-ghost", on: { click: () => confirmSheet(`Delete ${sk.name}?`, "The team will work it out again next time.", "Delete", async () => { await call(`/api/skills/${sk.id}`, { method: "DELETE" }); toast("Deleted"); }) } }, icon("trash", 16), "Delete")),
  ]);
}

// ---------------- plans & memory panels ----------------

async function loadHooks() {
  try { S.hooks = await call("/api/hooks"); if (S.panel === "plans") drawPlans(); } catch (e) { handleError(e); }
}

function openPlans() {
  S.panel = "plans";
  openSheet("Plans", h("div", { id: "plans" }), { onClose: () => { S.panel = null; } });
  drawPlans();
  loadHooks();
}

function drawPlans() {
  const el = document.getElementById("plans");
  if (!el) return;
  const active = S.hooks.filter((x) => x.status !== "done" && x.source !== "system").sort((a, b) => (a.nextAt || "~").localeCompare(b.nextAt || "~"));
  const done = S.hooks.filter((x) => x.status === "done").slice(-5).reverse();
  const row = (hk: any) => h("button", { class: `item ${hk.status}`, on: { click: () => openHook(hk) } },
    h("span", { class: "dotwrap" }, face(mate(hk.teammateId), 30, "idle")),
    h("span", { class: "grow" },
      h("b", null, hk.title, hk.status === "paused" ? h("span", { class: "tag" }, "Paused") : null),
      h("small", { class: "sub" }, hk.nextAt && hk.status === "active" ? `${dayLabel(hk.nextAt)} ${clockTime(hk.nextAt)} · ${hk.when}` : hk.when)));
  clear(el,
    h("p", { class: "muted" }, "When your teammates will speak up, and why."),
    active.length ? h("div", { class: "list" }, active.map(row)) : h("p", { class: "empty" }, "Nothing planned. Just say “remind me…” or “every morning…”."),
    done.length ? [h("h4", null, "Done"), h("div", { class: "list" }, done.map(row))] : null,
    h("button", { class: "btn ghost", on: { click: openNewPlan } }, icon("plus", 16), "Add a reminder or routine"));
}

async function loadMemory() {
  try { S.memory = await call(`/api/memory?q=${encodeURIComponent(S.memoryQuery)}`); if (S.panel === "memory") drawMemory(); } catch (e) { handleError(e); }
}

function openMemory() {
  S.panel = "memory";
  openSheet("Memory", [
    h("div", { class: "search" }, icon("search", 18), h("input", { placeholder: "Search", type: "search", value: S.memoryQuery,
      on: { input: debounce((e: Event) => { S.memoryQuery = (e.target as HTMLInputElement).value; loadMemory(); }, 250) } })),
    h("div", { id: "about" }),
    h("div", { id: "memory" }),
  ], { onClose: () => { S.panel = null; } });
  drawMemory();
  loadMemory();
  loadAbout();
}

// ---------------- people: the relationship map ----------------

const CIRCLES: [RegExp, string, string][] = [
  [/partner|wife|husband|girlfriend|boyfriend|fianc|spouse/i, "Partner", "#e0849a"],
  [/mom|mother|dad|father|sister|brother|son|daughter|aunt|uncle|cousin|grand|niece|nephew|parent|sibling|family|in-law/i, "Family", "#e2a560"],
  [/friend|roommate|neighbo|buddy/i, "Friends", "#72b083"],
  [/boss|manager|cowork|colleague|team|client|work|report|mentor|investor|founder|recruiter/i, "Work", "#7093d8"],
];
// "Priya's partner" is someone else's partner, not yours: they go with everyone else.
const circleOf = (p: any) => (/\w['’]s\s/.test(p.relation || "") ? null : CIRCLES.find(([re]) => re.test(p.relation || ""))) || [null, "Others", "#a99d90"] as const;

function personDot(p: any, size: number) {
  const [, , color] = circleOf(p);
  return h("span", { class: "pdot", style: `--c:${color};--s:${size}px` }, p.emoji ? emoji3d(p.emoji) : h("b", null, (p.name || "?")[0].toUpperCase()));
}

/** You in the middle; partner and family close, everyone else on the outer ring; lines for how people know each other. */
async function openPeople() {
  let people: any[] = [];
  try { people = await call("/api/people"); } catch (e) { return handleError(e); }
  S.panel = "people";
  const order = ["Partner", "Family", "Friends", "Work", "Others"];
  people.sort((a, b) => order.indexOf(circleOf(a)[1]) - order.indexOf(circleOf(b)[1]) || a.name.localeCompare(b.name));
  const inner = people.length > 8 ? people.filter((p) => ["Partner", "Family"].includes(circleOf(p)[1])) : people;
  const outer = people.length > 8 ? people.filter((p) => !inner.includes(p)) : [];
  const pos = new Map<string, { x: number; y: number }>();
  // Oval rings: the sheet is narrower than it is tall, and names need room at the sides.
  const ring = (list: any[], r: number, turn: number) => list.forEach((p, i) => {
    const a = -Math.PI / 2 + turn + (i / list.length) * Math.PI * 2;
    pos.set(p.name.toLowerCase(), { x: 50 + r * 0.8 * Math.cos(a), y: 50 + r * Math.sin(a) });
  });
  ring(inner, outer.length ? 25 : 36, inner.length % 2 ? 0 : Math.PI / Math.max(2, inner.length));
  ring(outer, 45, Math.PI / Math.max(2, outer.length) + (inner.length % 2 ? Math.PI / Math.max(2, inner.length) : 0));
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("class", "plines");
  const line = (a: { x: number; y: number }, b: { x: number; y: number }, color: string, dashed: boolean) => {
    const l = document.createElementNS(ns, "line");
    for (const [k, v] of Object.entries({ x1: a.x, y1: a.y, x2: b.x, y2: b.y })) l.setAttribute(k, String(v));
    l.setAttribute("stroke", color);
    l.setAttribute("class", dashed ? "plink" : "pspoke");
    svg.appendChild(l);
  };
  for (const p of people) line({ x: 50, y: 50 }, pos.get(p.name.toLowerCase())!, circleOf(p)[2], false);
  for (const p of people) for (const l of p.links || []) {
    const to = pos.get(String(l.to).toLowerCase());
    if (to) line(pos.get(p.name.toLowerCase())!, to, "#b9aea2", true);
  }
  const map = h("div", { class: "pmap" }, svg,
    h("div", { class: "pnode you", style: "left:50%;top:50%" }, userAvatar(52), h("small", null, "You")),
    people.map((p) => { const at = pos.get(p.name.toLowerCase())!; return h("button", { class: "pnode", style: `left:${at.x}%;top:${at.y}%`, on: { click: () => openPerson(p, people) } },
      personDot(p, 40), h("b", null, p.name), h("small", null, p.relation || "")); }));
  const used = order.filter((g) => people.some((p) => circleOf(p)[1] === g));
  openSheet("People", [
    people.length ? map : h("div", { class: "pempty" }, emoji3d("🫂", "ideaicon"), h("p", null, "As you mention people (your sister, your manager, your landlord), the team adds them here and keeps notes on each.")),
    used.length ? h("div", { class: "plegend" }, used.map((g) => h("span", null, h("i", { style: `--c:${CIRCLES.find((c) => c[1] === g)?.[2] || "#a99d90"}` }), g))) : null,
    people.length ? h("div", { class: "list" }, people.map((p) => h("button", { class: "item", on: { click: () => openPerson(p, people) } },
      personDot(p, 34), h("span", { class: "grow left" }, h("b", null, p.name), h("small", { class: "sub" }, [p.relation, p.notes?.at(-1)].filter(Boolean).join(" · "))), icon("chevron", 16)))) : null,
    h("button", { class: "btn ghost", on: { click: addPerson } }, icon("plus", 16), "Add someone"),
  ], { onClose: () => { S.panel = null; } });
}

function openPerson(p: any, all: any[]) {
  const rel = h("input", { class: "field", value: p.relation || "", maxLength: 60, placeholder: "sister, manager, landlord…" });
  const knows = [...(p.links || []), ...all.filter((o) => o !== p).flatMap((o) => (o.links || []).filter((l: any) => String(l.to).toLowerCase() === p.name.toLowerCase()).map((l: any) => ({ to: o.name, relation: `${l.relation} (of ${p.name})` })))];
  openSheet(p.name, [
    h("div", { class: "phero" }, personDot(p, 72), h("b", null, p.name), h("small", null, p.relation || "")),
    p.notes?.length ? [h("h4", null, "What I know"), h("ul", { class: "pnotes" }, p.notes.slice().reverse().map((n: string) => h("li", null, n)))] : null,
    knows.length ? [h("h4", null, "Connected to"), h("div", { class: "list" }, knows.map((l: any) => { const o = all.find((x) => x.name.toLowerCase() === String(l.to).toLowerCase()); return h("button", { class: "item", on: { click: () => o && openPerson(o, all) } }, o ? personDot(o, 28) : null, h("span", { class: "grow left" }, h("b", null, l.to), h("small", { class: "sub" }, l.relation))); }))] : null,
    h("label", null, h("span", null, "How you know them"), rel),
    h("button", { class: "btn primary big", on: { click: async () => { try { await call(`/api/people/${p.id}`, { method: "PATCH", body: { relation: rel.value } }); toast("Saved"); openPeople(); } catch (e) { handleError(e); } } } }, "Save"),
    h("button", { class: "btn ghost", on: { click: async () => { closeSheet(); const r = await call("/api/threads", { body: { text: `What do you know about ${p.name}? Anything coming up I should remember?` } }); location.hash = `#c/${r.thread.id}`; } } }, `Ask about ${p.name}`),
    h("button", { class: "btn danger-ghost", on: { click: () => confirmSheet(`Forget ${p.name}?`, "They come off your map. Memory facts stay.", "Forget", async () => { await call(`/api/people/${p.id}`, { method: "DELETE" }); openPeople(); }) } }, `Forget ${p.name}`),
  ]);
}

function addPerson() {
  const name = h("input", { class: "field", maxLength: 40, placeholder: "Priya" });
  const rel = h("input", { class: "field", maxLength: 60, placeholder: "sister" });
  openSheet("Add someone", [
    h("label", null, h("span", null, "Name"), name), h("label", null, h("span", null, "How you know them"), rel),
    h("button", { class: "btn primary big", on: { click: async () => { if (!name.value.trim()) return name.focus(); try { await call("/api/people", { body: { name: name.value, relation: rel.value } }); openPeople(); } catch (e) { handleError(e); } } } }, "Add"),
  ]);
  setTimeout(() => name.focus(), 60);
}

/** "About you": the short profile the team keeps of you, always in mind. You can rewrite it. */
async function loadAbout() {
  const el = document.getElementById("about");
  if (!el) return;
  let a: any;
  try { a = await call("/api/about"); } catch (e) { return handleError(e); }
  clear(el, h("div", { class: "aboutcard" },
    h("div", { class: "row" }, emoji3d("🪪", "ideaicon small"), h("b", { class: "grow" }, "About you"),
      h("button", { class: "btn small ghost", on: { click: () => editAbout(a.text) } }, a.text ? "Edit" : "Write it")),
    a.text ? h("div", { class: "abouttext" }, richText(a.text)) : h("p", { class: "muted small" }, "The team writes this from what you tell it (people, routines, goals), and keeps it current every night."),
    a.updatedAt ? h("small", { class: "muted" }, `Updated ${relTime(a.updatedAt)}`) : null));
}

function editAbout(text: string) {
  const area = h("textarea", { class: "field", rows: 12, maxLength: 2500, value: text, placeholder: "Sister Priya, turns 30 on Dec 12.\nTraining for a half marathon in March.\nVegetarian. Hates early meetings." });
  openSheet("About you", [
    h("p", { class: "muted" }, "Everyone on the team reads this before they help. Keep it short; most important first."), area,
    h("button", { class: "btn primary big", on: { click: async () => { try { await call("/api/about", { method: "PUT", body: { text: area.value } }); closeSheet(); toast("Saved"); openMemory(); } catch (e) { handleError(e); } } } }, "Save"),
  ]);
}

function drawMemory() {
  const el = document.getElementById("memory");
  if (!el || !S.memory) return;
  const facts = [...S.memory.facts].sort((a: any, b: any) => b.importance - a.importance || b.createdAt.localeCompare(a.createdAt));
  clear(el,
    facts.length ? h("div", { class: "list" }, facts.map((f: any) => h("div", { class: "item" },
      h("button", { class: "grow left", on: { click: () => openFact(f) } }, h("b", { class: "light" }, f.fact), h("small", { class: "sub" }, `${f.notebook}${f.useCount ? ` · used ${f.useCount}×` : ""}`)),
      h("button", { class: `star ${f.importance === 3 ? "on" : ""}`, "aria-label": "Always keep in mind",
        on: { click: async () => { await call(`/api/memory/${f.id}`, { method: "PATCH", body: { importance: f.importance === 3 ? 2 : 3 } }); loadMemory(); } } }, icon("star", 18)))))
      : h("p", { class: "empty" }, S.memoryQuery ? "Nothing matches." : "Nothing yet. Tell me things and I'll keep them."),
    h("button", { class: "btn ghost", on: { click: () => openFact(null) } }, icon("plus", 16), "Add something to remember"));
}

// ---------------- settings ----------------

function openSettings() {
  const st = S.state;
  if (!st) return;
  const p = st.prefs;
  const autoLoc = localStorage.getItem("hearth.autoLocation") === "1";
  const row = (label: string, sub: string, fn: () => void, right?: Node) =>
    h("button", { class: "item", on: { click: fn } }, h("span", { class: "grow" }, h("b", { class: "light" }, label), h("small", { class: "sub" }, sub)), right || icon("chevron", 16));
  const sw = (on: boolean) => h("span", { class: `switch ${on ? "on" : ""}` }, h("i"));
  openSheet("Settings", [
    h("div", { class: "list" },
      row("Name and time zone", `${p.userName || "Not set"} · ${p.tz}`, openProfile),
      row("Notifications", st.push.subscribed ? "On for this device" : "Off", () => togglePush(st.push.subscribed), sw(st.push.subscribed)),
      row("Quiet hours and daily limit", `${p.quietStart}–${p.quietEnd} · up to ${p.maxProactivePerDay}/day`, openQuiet)),
    h("div", { class: "list" }, row("Brains", "Which models do what, and smart voice", openBrains),
      row("Voice", st.voice ? `On · ${st.voice === "deepgram" ? "Deepgram" : st.voice}` : "Off · connect Deepgram to talk", openVoice)),
    h("h4", null, "Location"),
    h("div", { class: "list" },
      row("Share when I open the app", "For place reminders and “near me”", () => { localStorage.setItem("hearth.autoLocation", autoLoc ? "0" : "1"); if (!autoLoc) shareLocation(false); closeSheet(); openSettings(); }, sw(autoLoc)),
      row("Places", "Home, office…", openPlaces)),
    h("h4", null, "Security and data"),
    h("div", { class: "list" },
      row("Devices", st.device.primary ? (st.pendingAccess ? `${st.pendingAccess} waiting to join` : "This is your primary device") : "Who can talk to this hub", openDevices),
      passkeysWork() ? row("Face ID lock", st.device.passkey ? "On · asked each time you open the app" : "Off · a copied key alone could open this hub", toggleFaceId, sw(st.device.passkey)) : null,
      row("Activity log", "Everything the hub did", openActivity),
      row("Export everything", "One JSON file", exportData),
      row("Delete my data", "Chats, memory, plans, places", openWipe)),
    h("p", { class: "muted small center" }, `app ${__BUILD__} · hub ${st.hub.build} · brain ${st.hub.brain} · ${st.hub.storage}`),
  ]);
}


function openSheet(title: string, body: Node | any[], opts: { onClose?: () => void } = {}) {
  closeSheet();
  S.sheetOpen = true;
  const sheet = h("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": title },
    h("div", { class: "grab" }),
    h("div", { class: "sheethead" }, h("h2", null, title), h("button", { class: "iconbtn", "aria-label": "Close", on: { click: closeSheet } }, icon("x"))),
    h("div", { class: "sheetbody" }, body),
  );
  const scrim = h("div", { class: "scrim", id: "scrim", on: { click: (e: Event) => { if (e.target === scrim) closeSheet(); } } }, sheet);
  (scrim as any)._onClose = opts.onClose;
  document.body.appendChild(scrim);
  requestAnimationFrame(() => scrim.classList.add("open"));
  return sheet;
}

function closeSheet() {
  const s = document.getElementById("scrim");
  if (!s) return;
  S.sheetOpen = false;
  (s as any)._onClose?.();
  s.classList.remove("open");
  s.id = "";
  setTimeout(() => s.remove(), 250);
}

function confirmSheet(title: string, text: string, action: string, fn: () => Promise<void>) {
  openSheet(title, [
    h("p", { class: "muted" }, text),
    h("div", { class: "row gap" },
      h("button", { class: "btn ghost grow", on: { click: closeSheet } }, "Cancel"),
      h("button", { class: "btn danger grow", on: { click: async () => { try { await fn(); closeSheet(); } catch (e) { handleError(e); } } } }, action)),
  ]);
}


function renderPairing(code: string) {
  const isHubPage = location.protocol === "https:" || ["localhost", "127.0.0.1"].includes(location.hostname);
  const url = h("input", { class: "field", value: isHubPage ? location.origin : "", placeholder: "https://hub.example.com", autocapitalize: "off", autocomplete: "off", spellcheck: false, inputMode: "url" });
  const codeIn = h("input", { class: "field code", value: code, placeholder: "ABCD-2345", autocapitalize: "characters", autocomplete: "one-time-code", maxLength: 9 });
  const guess = /iPhone/.test(navigator.userAgent) ? "iPhone" : /iPad/.test(navigator.userAgent) ? "iPad" : /Android/.test(navigator.userAgent) ? "Android phone" : "This computer";
  const name = h("input", { class: "field", value: guess, maxLength: 60 });
  const err = h("p", { class: "error", role: "alert" });
  const btn = h("button", { class: "btn primary big", type: "submit" }, "Pair this device");
  const form = h("form", { class: "pairform", on: { submit: async (e: Event) => {
    e.preventDefault();
    btn.disabled = true; btn.textContent = "Pairing…"; err.textContent = "";
    try {
      await pair(url.value, codeIn.value, name.value);
      history.replaceState(null, "", "#today");
      location.reload();
    } catch (ex: any) { err.textContent = ex.message; btn.disabled = false; btn.textContent = "Pair this device"; }
  } } },
    h("label", null, h("span", null, "Hub address"), url),
    h("label", null, h("span", null, "Pairing code"), codeIn),
    h("label", null, h("span", null, "Name this device"), name),
    err, btn,
    h("button", { class: "btn ghost", type: "button", on: { click: () => askToJoin(url.value, name.value, err) } }, "No code? Ask your primary device"),
    h("p", { class: "hint" }, "Setting up for the first time? On your server, run ", h("code", null, "bun run setup"), " and scan the code. That phone becomes your primary device."),
  );
  clear(app, h("div", { class: "pairing" },
    h("div", { class: "mark" }, h("img", { src: "/icon.svg", alt: "", width: 72, height: 72 })),
    h("h1", null, "Hearth"),
    h("p", { class: "lede" }, "A personal assistant that lives on your own server and speaks up when it matters."),
    h("ul", { class: "promises" },
      h("li", null, icon("lock", 18), h("span", null, h("b", null, "Your data, your box. "), "Everything is stored on the hub you run.")),
      h("li", null, icon("sparkle", 18), h("span", null, h("b", null, "Your agent is the brain. "), "Claude Code, Codex or any CLI you trust.")),
      h("li", null, icon("phone", 18), h("span", null, h("b", null, "Direct line. "), "This phone talks to your hub. No middleman."))),
    form,
  ));
}


function hookIcon(hk: any) {
  const t = hk.trigger?.type;
  return t === "at" ? (hk.trigger.repeat !== "none" ? "repeat" : "clock") : t === "schedule" ? "repeat" : t === "place" ? "pin" : t === "silence" ? "moon" : "eye";
}


function openHook(hk: any) {
  const actionText = hk.action.type === "notify" ? `Send: “${hk.action.text}”` : hk.action.type === "think" ? (hk.action.prompt === "[[memory-review]]" ? "Review and tidy memory" : `Think: ${hk.action.prompt}`) : `Run script ${hk.action.script}${hk.action.then === "think" ? " and interpret it" : ""}`;
  const patch = async (body: any, msg: string) => { try { await call(`/api/hooks/${hk.id}`, { method: "PATCH", body }); toast(msg); closeSheet(); loadHooks(); } catch (e) { handleError(e); } };
  const isAt = hk.trigger.type === "at";
  openSheet(hk.title, [
    h("dl", { class: "facts" },
      h("dt", null, "When"), h("dd", null, hk.when),
      hk.nextAt && hk.status === "active" ? [h("dt", null, "Next"), h("dd", null, `${dayLabel(hk.nextAt)} ${clockTime(hk.nextAt)} (${relTime(hk.nextAt)})`)] : null,
      h("dt", null, "Does"), h("dd", null, actionText),
      h("dt", null, "Why"), h("dd", null, hk.why),
      h("dt", null, "Set by"), h("dd", null, hk.source === "you" ? "You" : hk.source === "system" ? "The hub" : "Your assistant"),
      hk.fireCount ? [h("dt", null, "Fired"), h("dd", null, `${hk.fireCount}× · last ${relTime(hk.lastFiredAt)}`)] : null),
    hk.status !== "done" && isAt ? h("div", { class: "snoozes" }, h("span", { class: "muted small" }, "Snooze"),
      [["10 min", 10], ["1 hour", 60], ["3 hours", 180], ["Tomorrow", 24 * 60]].map(([l, m]) =>
        h("button", { class: "chip", on: { click: () => patch({ snoozeMin: m }, `Snoozed ${l}`) } }, String(l)))) : null,
    h("div", { class: "stack" },
      hk.status !== "done" ? h("button", { class: "btn ghost", on: { click: async () => { await call(`/api/hooks/${hk.id}/run`, { body: {} }); toast("Running it now"); closeSheet(); } } }, icon("play", 16), "Run now") : null,
      hk.status === "active" ? h("button", { class: "btn ghost", on: { click: () => patch({ status: "paused" }, "Paused") } }, icon("pause", 16), "Pause") : null,
      hk.status === "paused" ? h("button", { class: "btn ghost", on: { click: () => patch({ status: "active" }, "Resumed") } }, icon("play", 16), "Resume") : null,
      hk.source !== "system" ? h("button", { class: "btn danger-ghost", on: { click: () => confirmSheet("Delete this?", `“${hk.title}” will stop for good.`, "Delete", async () => { await call(`/api/hooks/${hk.id}`, { method: "DELETE" }); toast("Deleted"); loadHooks(); }) } }, icon("trash", 16), "Delete") : null),
  ]);
}

function localInputValue(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function openNewPlan() {
  let kind: "reminder" | "routine" = "reminder";
  const body = h("div");
  const draw = () => {
    const seg = h("div", { class: "segmented" },
      h("button", { class: kind === "reminder" ? "on" : "", on: { click: () => { kind = "reminder"; draw(); } } }, "Reminder"),
      h("button", { class: kind === "routine" ? "on" : "", on: { click: () => { kind = "routine"; draw(); } } }, "Routine"));
    if (kind === "reminder") {
      const d = new Date(Date.now() + 3.6e6); d.setMinutes(0, 0, 0);
      const text = h("input", { class: "field", placeholder: "Call mom", maxLength: 300 });
      const when = h("input", { class: "field", type: "datetime-local", value: localInputValue(d) });
      const repeat = h("select", { class: "field" }, ["none", "daily", "weekdays", "weekly", "monthly"].map((r) => h("option", { value: r }, r === "none" ? "Doesn't repeat" : r[0].toUpperCase() + r.slice(1))));
      clear(body, seg,
        h("label", null, h("span", null, "Remind me to"), text),
        h("label", null, h("span", null, "When"), when),
        h("label", null, h("span", null, "Repeat"), repeat),
        h("button", { class: "btn primary big", on: { click: async () => {
          if (!text.value.trim()) return text.focus();
          try {
            await call("/api/hooks", { body: { title: text.value, why: `You set this on ${new Date().toLocaleDateString()}`, trigger: { type: "at", at: new Date(when.value).toISOString(), repeat: repeat.value }, action: { type: "notify", text: text.value } } });
            toast("Reminder set"); closeSheet(); loadHooks();
          } catch (e) { handleError(e); }
        } } }, "Set reminder"));
    } else {
      const title = h("input", { class: "field", placeholder: "Morning brief", maxLength: 80 });
      const prompt = h("textarea", { class: "field", rows: 3, placeholder: "Tell me today's weather, what's coming up, and one thing I said I'd do." });
      const time = h("input", { class: "field", type: "time", value: "08:00" });
      const days = new Set([1, 2, 3, 4, 5]);
      const dayRow = h("div", { class: "days" }, ["S", "M", "T", "W", "T", "F", "S"].map((l, i) => {
        const b = h("button", { class: `day ${days.has(i) ? "on" : ""}`, type: "button", on: { click: () => { days.has(i) ? days.delete(i) : days.add(i); b.classList.toggle("on"); } } }, l);
        return b;
      }));
      clear(body, seg,
        h("label", null, h("span", null, "Name"), title),
        h("label", null, h("span", null, "What should I do?"), prompt),
        h("label", null, h("span", null, "At"), time),
        h("div", { class: "label" }, h("span", null, "On"), dayRow),
        h("p", { class: "muted small" }, "Your assistant runs this on schedule and messages you with the result. It can stay quiet when there's nothing worth saying."),
        h("button", { class: "btn primary big", on: { click: async () => {
          if (!title.value.trim() || !prompt.value.trim()) return;
          try {
            await call("/api/hooks", { body: { title: title.value, why: "A routine you set up", trigger: { type: "schedule", time: time.value, days: [...days] }, action: { type: "think", prompt: prompt.value } } });
            toast("Routine added"); closeSheet(); loadHooks();
          } catch (e) { handleError(e); }
        } } }, "Add routine"));
    }
  };
  draw();
  openSheet("New plan", body);
}


function openFact(f: any | null) {
  const text = h("textarea", { class: "field", rows: 3, value: f?.fact || "", placeholder: "I'm allergic to peanuts", maxLength: 500 });
  const book = h("input", { class: "field", value: f?.notebook || "", placeholder: "health, people, work…", maxLength: 40 });
  let importance = f?.importance || 2;
  const imp = h("div", { class: "segmented" }, [[1, "Minor"], [2, "Useful"], [3, "Core"]].map(([n, l]) => {
    const b = h("button", { class: importance === n ? "on" : "", on: { click: () => { importance = n; imp.querySelectorAll("button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); } } }, String(l));
    return b;
  }));
  const history: any[] = [];
  if (f) { let cur = f; while (cur?.supersedes) { cur = S.memory.history.find((x: any) => x.id === cur.supersedes); if (cur) history.push(cur); } }
  openSheet(f ? "Memory" : "Add a memory", [
    h("label", null, h("span", null, "Fact"), text),
    h("label", null, h("span", null, "Notebook"), book),
    h("div", { class: "label" }, h("span", null, "Importance"), imp),
    f?.evidence ? h("blockquote", { class: "evidence" }, "From: “", f.evidence, "”") : null,
    history.length ? h("div", { class: "history" }, h("h4", null, "Earlier versions"), history.map((x) => h("div", { class: "old" }, h("s", null, x.fact), h("small", null, ` · ${dayLabel(x.createdAt)}`)))) : null,
    h("div", { class: "stack" },
      h("button", { class: "btn primary big", on: { click: async () => {
        if (!text.value.trim()) return;
        try {
          if (f) await call(`/api/memory/${f.id}`, { method: "PATCH", body: { fact: text.value, notebook: book.value || f.notebook, importance } });
          else await call("/api/memory", { body: { fact: text.value, notebook: book.value || "general", importance } });
          if (f && text.value === f.fact && importance !== f.importance) await call(`/api/memory/${f.id}`, { method: "PATCH", body: { importance } });
          toast(f ? "Updated" : "Saved"); closeSheet(); loadMemory();
        } catch (e) { handleError(e); }
      } } }, f ? "Save" : "Remember this"),
      f ? h("button", { class: "btn danger-ghost", on: { click: () => confirmSheet("Forget this?", "It's deleted from your hub, with its earlier versions.", "Forget", async () => { await call(`/api/memory/${f.id}`, { method: "DELETE" }); toast("Forgotten"); loadMemory(); }) } }, icon("trash", 16), "Forget") : null),
  ]);
}

function debounce<T extends (...a: any[]) => void>(fn: T, ms: number) {
  let t: any;
  return (...a: any[]) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}


function openProfile() {
  const p = S.state.prefs;
  const name = h("input", { class: "field", value: p.userName, placeholder: "What should I call you?", maxLength: 40 });
  const tz = h("input", { class: "field", value: p.tz, list: "tzs" });
  const zones: string[] = (Intl as any).supportedValuesOf?.("timeZone") || [];
  openSheet("Name and time zone", [
    h("label", null, h("span", null, "Name"), name),
    h("label", null, h("span", null, "Time zone"), tz, h("datalist", { id: "tzs" }, zones.map((z) => h("option", { value: z })))),
    h("button", { class: "link", on: { click: () => { tz.value = Intl.DateTimeFormat().resolvedOptions().timeZone; } } }, "Use this device's time zone"),
    h("button", { class: "btn primary big", on: { click: async () => { try { await call("/api/prefs", { method: "PATCH", body: { userName: name.value, tz: tz.value } }); toast("Saved"); closeSheet(); refreshState(); } catch (e) { handleError(e); } } } }, "Save"),
  ]);
}

function openQuiet() {
  const p = S.state.prefs;
  const start = h("input", { class: "field", type: "time", value: p.quietStart });
  const end = h("input", { class: "field", type: "time", value: p.quietEnd });
  let n = p.maxProactivePerDay;
  const count = h("b", null, String(n));
  const step = (d: number) => { n = Math.max(0, Math.min(50, n + d)); count.textContent = String(n); };
  openSheet("Speaking up", [
    h("p", { class: "muted" }, "Outside quiet hours and under the daily limit, your assistant may message you first. Reminders you set yourself always come through."),
    h("div", { class: "row gap" }, h("label", { class: "grow" }, h("span", null, "Quiet from"), start), h("label", { class: "grow" }, h("span", null, "Until"), end)),
    h("div", { class: "label" }, h("span", null, "Unprompted messages per day"),
      h("div", { class: "stepper" }, h("button", { on: { click: () => step(-1) } }, "−"), count, h("button", { on: { click: () => step(1) } }, "+"))),
    h("button", { class: "btn primary big", on: { click: async () => { try { await call("/api/prefs", { method: "PATCH", body: { quietStart: start.value, quietEnd: end.value, maxProactivePerDay: n } }); toast("Saved"); closeSheet(); refreshState(); } catch (e) { handleError(e); } } } }, "Save"),
  ]);
}

function b64ToBytes(b64: string) {
  const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function togglePush(subscribed: boolean) {
  try {
    if (!("PushManager" in window)) {
      return openSheet("Notifications", [h("p", null, "On iPhone, notifications need the app on your Home Screen: tap Share, then “Add to Home Screen”, open it from there, and turn this on.")]);
    }
    const reg = await navigator.serviceWorker.ready;
    if (subscribed) {
      await (await reg.pushManager.getSubscription())?.unsubscribe();
      await call("/api/push/subscribe", { method: "DELETE" });
      toast("Notifications off");
    } else {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return toast("Notifications are blocked in your settings", "err");
      const { publicKey } = await call("/api/push/key");
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
      await call("/api/push/subscribe", { body: sub.toJSON() });
      await call("/api/push/test", { body: {} });
      toast("Notifications on");
    }
    refreshState();
  } catch (e) { handleError(e); }
}

function shareLocation(silent: boolean) {
  if (!navigator.geolocation) return silent || toast("Location isn't available here", "err");
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try { await call("/api/location", { body: { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy } }); if (!silent) toast("Location shared with your hub"); }
      catch (e) { if (!silent) handleError(e); }
    },
    () => { if (!silent) toast("Couldn't get your location", "err"); },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 120000 },
  );
}

async function openPlaces() {
  const places = await call("/api/places");
  const today = S.today || (await call("/api/today"));
  const name = h("input", { class: "field", placeholder: "home, office, gym…", maxLength: 60 });
  openSheet("Places", [
    h("p", { class: "muted" }, "Saved places let your assistant act when you arrive or leave. Location is only sent when the app is open, and history is kept for 7 days."),
    places.length ? h("div", { class: "list" }, places.map((p: any) => h("div", { class: "item" },
      h("div", { class: "hicon place" }, icon("pin", 16)),
      h("div", { class: "grow" }, h("div", { class: "title" }, p.name), h("div", { class: "sub" }, `within ${p.radiusM} m`)),
      h("button", { class: "iconbtn", "aria-label": "Delete", on: { click: async () => { await call(`/api/places/${p.id}`, { method: "DELETE" }); closeSheet(); openPlaces(); } } }, icon("trash", 16))))) : null,
    h("label", null, h("span", null, "Save where I am now as"), name),
    h("button", { class: "btn primary big", on: { click: () => {
      if (!name.value.trim()) return name.focus();
      navigator.geolocation.getCurrentPosition(async (pos) => {
        try {
          await call("/api/location", { body: { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy } });
          await call("/api/places", { body: { name: name.value, here: true } });
          toast(`Saved ${name.value}`); closeSheet(); openPlaces();
        } catch (e) { handleError(e); }
      }, () => toast("Couldn't get your location", "err"), { enableHighAccuracy: true, timeout: 15000 });
    } } }, "Save this place"),
    today?.location ? h("p", { class: "muted small" }, `Last location received ${relTime(today.location.createdAt)}.`) : null,
    h("button", { class: "btn danger-ghost", on: { click: () => confirmSheet("Clear location history?", "Places stay; past locations are deleted.", "Clear", async () => { await call("/api/location", { method: "DELETE" }); toast("Cleared"); }) } }, "Clear location history"),
  ]);
}

async function openScripts() {
  try {
    const scripts = await call("/api/scripts");
    openSheet("Scripts", [
      h("p", { class: "muted" }, "Small programs your assistant can run on the hub: checks, lookups, watches. Ones it writes itself only run after you read and approve them."),
      h("div", { class: "list" }, scripts.map((s: any) => h("button", { class: "item", on: { click: () => openScript(s) } },
        h("div", { class: "hicon" }, icon("code", 16)),
        h("div", { class: "grow" },
          h("div", { class: "title" }, s.name, s.status === "proposed" ? h("span", { class: "tag warn" }, "Needs approval") : s.status === "rejected" ? h("span", { class: "tag" }, "Rejected") : null, s.origin === "repo" ? h("span", { class: "tag soft" }, "Built in") : null),
          h("div", { class: "sub" }, s.description))))),
    ]);
  } catch (e) { handleError(e); }
}

function openScript(s: any) {
  const out = h("pre", { class: "output", hidden: true });
  openSheet(s.name, [
    h("p", { class: "muted" }, s.description),
    s.status === "proposed" ? h("div", { class: "notice" }, icon("lock", 16), h("span", null, "Your assistant wrote this. Read it: it will run on your hub with network access, but without your hub's secrets.")) : null,
    h("pre", { class: "code" }, s.code || "(file missing)"),
    s.lastResult ? h("p", { class: "muted small" }, `Last run ${relTime(s.lastRunAt)}: ${s.lastResult.slice(0, 160)}`) : null,
    out,
    h("div", { class: "stack" },
      s.status === "proposed" || s.status === "rejected" ? h("button", { class: "btn primary big", on: { click: async () => { try { await call(`/api/scripts/${s.id}/approve`, { body: { sha256: s.codeSha256 } }); toast("Approved"); closeSheet(); refreshState(); } catch (e) { handleError(e); } } } }, icon("check", 16), "Approve this code") : null,
      s.status === "approved" ? h("button", { class: "btn ghost", on: { click: async () => { out.hidden = false; out.textContent = "Running…"; const r = await call(`/api/scripts/${s.id}/run`, { body: {} }); out.textContent = r.output; } } }, icon("play", 16), "Test run") : null,
      s.status === "proposed" ? h("button", { class: "btn danger-ghost", on: { click: async () => { await call(`/api/scripts/${s.id}/reject`, { body: {} }); toast("Rejected"); closeSheet(); refreshState(); } } }, "Reject") : null),
  ]);
}

async function openDevices() {
  try {
    const primary = !!S.state?.device.primary;
    const [devices, waiting] = await Promise.all([call("/api/devices"), primary ? call("/api/access") : Promise.resolve([])]);
    const codeBox = h("div");
    const decide = async (r: any, verb: "approve" | "deny") => {
      try {
        // Letting a device in takes a fresh Face ID check, so someone holding your unlocked phone for a moment can't.
        const body = verb === "approve" && S.state?.device.passkey ? { passkey: await passkeyProof() } : {};
        await call(`/api/access/${r.id}/${verb}`, { body });
        toast(verb === "approve" ? `${r.name} is in` : "Denied"); refreshState(); openDevices();
      } catch (e) { handleError(e); }
    };
    openSheet("Devices", [
      h("p", { class: "muted" }, primary
        ? "This is your primary device: it lets other devices in. Each device has its own key; sign one out and it loses access at once."
        : "New devices join through your primary device. Each device has its own key; sign one out and it loses access at once."),
      waiting.length ? h("h4", null, "Waiting to join") : null,
      waiting.length ? h("div", { class: "list" }, waiting.map((r: any) => h("div", { class: "item" },
        h("div", { class: "hicon" }, icon(r.kind === "computer" ? "laptop" : "phone", 16)),
        h("div", { class: "grow" }, h("div", { class: "title" }, r.name, h("span", { class: "tag soft" }, `code ${r.code}`)), h("div", { class: "sub" }, `${r.kind === "computer" ? "Wants to link as a computer · " : ""}Asked ${relTime(r.createdAt)} · only approve if the same code is on its screen`)),
        h("button", { class: "btn small primary", on: { click: () => decide(r, "approve") } }, "Approve"),
        h("button", { class: "btn small danger-ghost", on: { click: () => decide(r, "deny") } }, "Deny")))) : null,
      h("h4", null, "Phones and browsers"),
      h("div", { class: "list" }, devices.filter((d: any) => d.role !== "computer").map((d: any) => h("div", { class: "item" },
        h("div", { class: "hicon" }, icon(d.passkey ? "lock" : "phone", 16)),
        h("div", { class: "grow" }, h("div", { class: "title" }, d.name, d.primary ? h("span", { class: "tag soft" }, "Primary") : null, d.current ? h("span", { class: "tag soft" }, "This device") : null), h("div", { class: "sub" }, `Paired ${dayLabel(d.createdAt)} · seen ${relTime(d.lastSeenAt)}${d.passkey ? " · Face ID" : ""}`)),
        primary && !d.primary ? h("button", { class: "btn small ghost", on: { click: () => confirmSheet(`Make ${d.name} primary?`, "It will be the one that lets new devices in. This device stays paired.", "Make primary", async () => { await call(`/api/devices/${d.id}/primary`, { body: {} }); toast(`${d.name} is primary`); refreshState(); }) } }, "Make primary") : null,
        primary || d.current ? h("button", { class: "btn small danger-ghost", on: { click: () => confirmSheet(`Sign out ${d.name}?`, "It will need to be let in again to come back.", "Sign out", async () => { await call(`/api/devices/${d.id}`, { method: "DELETE" }); if (d.current) { removeHub(activeHub()!.id); location.reload(); } toast("Signed out"); }) } }, "Sign out") : null))),
      codeBox,
      computersSection(devices.filter((d: any) => d.role === "computer"), primary),
      primary ? h("button", { class: "btn ghost", on: { click: async () => {
        try {
          const { code, expiresInMin, qr } = await call("/api/devices/pair-code", { body: {} });
          clear(codeBox, h("div", { class: "paircode" },
            h("img", { src: `data:image/svg+xml;utf8,${encodeURIComponent(qr)}`, alt: "Pairing QR code", width: 200, height: 200, class: "qr" }),
            h("small", null, "Scan with the new device's camera, or enter"), h("b", null, code),
            h("small", null, `Single use · expires in ${expiresInMin} min · ${activeHub()!.url}`)));
        } catch (e) { handleError(e); }
      } } }, icon("plus", 16), "Add a device") : null,
    ]);
  } catch (e) { handleError(e); }
}

// ---- Linked computers: where work runs ----

/** Four bars, like a phone's signal. */
function bars(level: number, state: string) {
  return h("span", { class: `bars ${state}`, "aria-label": `Signal ${level} of 4` }, [1, 2, 3, 4].map((n) => h("i", { class: n <= level ? "on" : "" })));
}
const STATE_LABEL: Record<string, string> = { online: "Online", asleep: "Not answering", offline: "Offline" };
const shortName = (n: string) => n.replace(/ \((Mac)\)$/, "");

/** Home: one line saying where work runs right now. Only shows once a computer is linked. */
function linkStrip() {
  const c = S.state?.computers;
  if (!c?.linked) return null;
  const best = c.list[0];
  const on = best?.state === "online";
  const text = on
    ? [h("b", null, shortName(best.name)), ` is online · work runs there${best.running ? ` · ${best.running} running` : ""}`]
    : [h("b", null, c.linked === 1 ? shortName(best.name) : "Your computers"), ` ${best?.state === "asleep" ? "isn't answering" : "is offline"} · the cloud is doing the work`];
  return h("button", { class: `linkstrip ${best?.state || "offline"}`, on: { click: openDevices } },
    h("span", { class: "lsicon" }, icon(on ? "laptop" : "cloud", 18)),
    h("span", { class: "grow" }, text),
    on ? bars(best.level, best.state) : null, icon("chevron", 14));
}

function computersSection(list: any[], primary: boolean) {
  const accept = !!S.state?.computers?.acceptCopies;
  const hub = activeHub()?.url || "https://yournameassistant.com";
  const cmd = `bash deploy/setup.sh mac ${hub}`;
  const card = (d: any) => {
    const l = d.link;
    const detail = l.state === "online"
      ? [`Connected ${relTime(l.connectedAt).replace(/ ago$/, "")}`, l.rttMs != null ? `${l.rttMs} ms` : null, l.running ? `running ${l.running} job${l.running > 1 ? "s" : ""}` : "idle"].filter(Boolean).join(" · ")
      : l.lastAliveAt ? `Last seen ${relTime(l.lastAliveAt)} · the cloud is doing the work` : "Hasn't connected yet · run the setup on it";
    const copyRow = (item: "claude" | "codex", label: string) => {
      const on = d.copy.includes(item);
      const at = d.copiedAt?.[item];
      return h("button", { class: "item copyrow", disabled: !primary, on: { click: async () => {
        try {
          await call(`/api/devices/${d.id}/copy`, { method: "PUT", body: { ...Object.fromEntries(d.copy.map((i: string) => [i, true])), [item]: !on } });
          toast(on ? `Stopped copying ${label}` : `Copying ${label} to the cloud`); openDevices();
        } catch (e) { handleError(e); }
      } } },
        h("span", { class: "grow" }, h("b", { class: "light" }, label),
          h("small", { class: "sub" }, on ? (at ? `Copied ${relTime(at)} · kept up to date` : l.state === "online" ? "Copying…" : "Copies next time it's online") : `So the cloud can use ${item === "claude" ? "Claude" : "Codex"} while this computer is off`)),
        h("span", { class: `switch ${on ? "on" : ""}` }, h("i")));
    };
    return h("div", { class: `ccard ${l.state}` },
      h("div", { class: "cchead" },
        h("span", { class: "ccicon" }, icon("laptop", 20), h("i", { class: `cdot ${l.state}` })),
        h("span", { class: "grow" }, h("b", null, d.name), h("small", { class: `cstate ${l.state}` }, STATE_LABEL[l.state])),
        bars(l.level, l.state)),
      h("p", { class: "ccsub" }, detail),
      l.harnesses.filter((x: string) => x !== "echo").length ? h("div", { class: "ccbrains" }, h("small", null, "Brains here"), l.harnesses.filter((x: string) => x !== "echo").map((x: string) => h("span", { class: "tag soft" }, x))) : null,
      accept ? h("div", { class: "cccopy" }, h("small", { class: "cclabel" }, "Copy to the cloud"),
        h("div", { class: "list" }, copyRow("claude", "Claude login"), copyRow("codex", "Codex login"))) : null,
      primary ? h("button", { class: "btn small danger-ghost", on: { click: () => confirmSheet(`Unlink ${d.name}?`, "It stops running work for this hub, and logins it copied to the cloud are removed.", "Unlink", async () => { await call(`/api/devices/${d.id}`, { method: "DELETE" }); toast("Unlinked"); refreshState(); }) } }, "Unlink") : null);
  };
  return h("div", null,
    h("h4", null, "Computers"),
    list.length ? list.map(card) : null,
    h("div", { class: "ccinfo" },
      h("p", { class: "muted small" }, list.length
        ? "Work runs on a linked computer when it's online, with its own logins. When none is, this hub (the cloud) does it."
        : "Link your Mac and teammates run on it, with your own Claude or Codex login. When it's off, the cloud does the work."),
      primary ? h("button", { class: "codeline", title: "Copy", on: { click: () => { navigator.clipboard?.writeText(cmd); toast("Copied. Run it in the hearth folder on your Mac"); } } }, h("code", null, cmd), icon("clip", 14)) : null));
}

let computersTimer: ReturnType<typeof setTimeout> | null = null;
/** A computer came or went: refresh Home's strip, and the Devices sheet if it's open. */
function computersChanged() {
  if (computersTimer) return;
  computersTimer = setTimeout(async () => {
    computersTimer = null;
    await refreshState();
    if (route().view === "home") drawHome();
    if (document.querySelector('.sheet[aria-label="Devices"]')) openDevices();
  }, 400);
}

async function toggleFaceId() {
  try {
    if (S.state?.device.passkey) await call("/api/passkey", { method: "DELETE" });
    else await registerPasskey();
    toast(S.state?.device.passkey ? "Face ID lock off" : "Face ID lock on");
    await refreshState(); closeSheet(); openSettings();
  } catch (e) { e instanceof ApiError ? handleError(e) : toast((e as Error).message || "Face ID didn't work", "err"); }
}

/** A new device with no code: ask the hub, show a short code, and wait for the primary phone to approve. */
async function askToJoin(url: string, name: string, err: HTMLElement) {
  err.textContent = "";
  try {
    const { origin, poll, code } = await requestAccess(url, name);
    const stop = new AbortController();
    clear(app, h("div", { class: "pairing" },
      h("div", { class: "mark" }, h("img", { src: "/icon.svg", alt: "", width: 72, height: 72 })),
      h("h1", null, "Asked to join"),
      h("p", { class: "lede" }, "Your primary device got a notification. Approve it there if it shows this same code:"),
      h("div", { class: "paircode" }, h("b", null, code), h("small", null, "Waiting… the request lasts 10 minutes")),
      h("button", { class: "btn ghost", on: { click: () => { stop.abort(); location.reload(); } } }, "Cancel")));
    await waitForApproval(origin, poll, stop.signal);
    history.replaceState(null, "", "#today");
    location.reload();
  } catch (ex: any) {
    if (ex?.name === "AbortError") return;
    if (err.isConnected) err.textContent = ex.message; else { toast(ex.message, "err"); setTimeout(() => location.reload(), 1500); }
  }
}

async function openActivity() {
  try {
    const acts = await call("/api/activity");
    openSheet("Activity", h("div", { class: "activity full" }, acts.map((a: any) =>
      h("div", { class: "act" }, h("span", { class: "acttime" }, `${dayLabel(a.createdAt)} ${clockTime(a.createdAt)}`), h("span", null, a.text)))));
  } catch (e) { handleError(e); }
}

async function exportData() {
  try {
    const hub = activeHub()!;
    const res = await fetch(hub.url + "/api/export", { headers: authHeaders(hub) });
    if (!res.ok) throw new Error("Export failed");
    const blob = await res.blob();
    const a = h("a", { href: URL.createObjectURL(blob), download: `hearth-export-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.appendChild(a); a.click(); a.remove();
    toast("Exported");
  } catch (e) { handleError(e); }
}

function openWipe() {
  const input = h("input", { class: "field", placeholder: "delete my data", autocapitalize: "off" });
  openSheet("Delete my data", [
    h("p", null, "This deletes every message, memory, plan, place and location on this hub. Paired devices and scripts stay. It can't be undone; export first if you want a copy."),
    h("label", null, h("span", null, "Type “delete my data” to confirm"), input),
    h("button", { class: "btn danger big", on: { click: async () => {
      if (input.value.trim() !== "delete my data") return input.focus();
      try { await call("/api/wipe", { body: { confirm: "delete my data" } }); toast("Deleted"); closeSheet(); location.hash = ""; refresh(); } catch (e) { handleError(e); }
    } } }, "Delete everything"),
  ]);
}


function openHubs() {
  const list = hubs();
  const current = activeHub();
  const url = h("input", { class: "field", placeholder: "https://laptop.example.com", autocapitalize: "off", inputMode: "url" });
  const code = h("input", { class: "field code", placeholder: "ABCD-2345", autocapitalize: "characters" });
  const err = h("p", { class: "error" });
  openSheet("Your hubs", [
    h("p", { class: "muted" }, "Each hub is a server you run: an always-on box for routines, your laptop, a home server. This app talks to each one directly."),
    h("div", { class: "list" }, list.map((hb: HubRef) => h("div", { class: `item ${hb.id === current?.id ? "current" : ""}` },
      h("button", { class: "grow left row", on: { click: () => { setActive(hb.id); location.reload(); } } },
        h("div", { class: "hicon" }, icon("server", 16)),
        h("div", { class: "grow" }, h("div", { class: "title" }, hb.name), h("div", { class: "sub" }, hb.url.replace(/^https?:\/\//, "")))),
      hb.id === current?.id ? h("span", { class: "tick" }, icon("check", 18)) : null,
      h("button", { class: "iconbtn", "aria-label": `Forget ${hb.name}`, on: { click: () => confirmSheet(`Forget ${hb.name} on this phone?`, "The hub keeps your data. You'll need a new code to reconnect.", "Forget", async () => { try { await call("/api/devices/" + hb.id, { method: "DELETE", hub: hb }); } catch {} removeHub(hb.id); location.reload(); }) } }, icon("trash", 16))))),
    h("h4", null, "Add a hub"),
    h("label", null, h("span", null, "Address"), url),
    h("label", null, h("span", null, "Pairing code"), code),
    err,
    h("button", { class: "btn primary big", on: { click: async () => {
      err.textContent = "";
      try {
        const origin = normalizeUrl(url.value);
        if (origin !== location.origin) {
          // The other hub must list this app's origin in HEARTH_ALLOWED_ORIGINS for the browser to let us in.
          err.textContent = `If this fails, add ${location.origin} to HEARTH_ALLOWED_ORIGINS on that hub.`;
        }
        await pair(origin, code.value, /iPhone/.test(navigator.userAgent) ? "iPhone" : "Phone");
        location.reload();
      } catch (e: any) { err.textContent = e.message + (err.textContent ? ` ${err.textContent}` : ""); }
    } } }, "Pair hub"),
  ]);
}

boot();

// ---------------- mini apps ----------------

function appIcon(a: any, size = 30) {
  const el = h("span", { class: "appicon", style: `--s:${size}px` }, String(a.title || a.name || "?").trim()[0].toUpperCase());
  el.style.setProperty("--c", mate(a.teammateId).color || "#8b5cf6");
  return el;
}

/** "Built Portuguese flashcards" in a job becomes a card you tap to open the app. */
function appCards(j: any) {
  const ids = [...new Set((j.did || []).filter((d: any) => d.kind === "app" && d.id).map((d: any) => d.id))] as string[];
  return ids.map((id) => S.apps.find((x) => x.id === id)).filter((a: any) => a && !a.inline).map((a: any) => {
    return h("button", { class: "appcard", on: { click: (e: Event) => { e.stopPropagation(); location.hash = `#a/${a.id}`; } } },
      appIcon(a, 40), h("span", { class: "grow" }, h("b", null, a.title), h("small", null, a.description || "Tap to open")), h("span", { class: "openpill" }, "Open"));
  });
}

/** Artifacts: one-off interactive pieces a teammate made for this answer, shown in place at their own height. */
function artifacts(j: any) {
  const ids = [...new Set((j.did || []).filter((d: any) => d.kind === "app" && d.id).map((d: any) => d.id))] as string[];
  return ids.map((id) => S.apps.find((x) => x.id === id)).filter((a: any) => a?.inline).map((a: any) => {
    const box = h("div", { class: "artframe" }, h("p", { class: "muted small center" }, "Loading…"));
    appFrame(a.id, a.title, "inline").then((f) => { f.classList.add("autoh"); f.setAttribute("scrolling", "no"); clear(box, f); }).catch(() => clear(box, h("p", { class: "muted small center" }, "Couldn't open this")));
    return h("div", { class: "artifact" }, box,
      h("div", { class: "artfoot" }, h("b", null, a.title), a.versions ? h("small", null, `v${a.versions + 1}`) : null, h("span", { class: "grow" }),
        h("button", { class: "linkbtn", on: { click: () => { location.hash = `#a/${a.id}`; } } }, "Full screen"),
        h("button", { class: "linkbtn", on: { click: async (e: Event) => {
          (e.currentTarget as HTMLButtonElement).disabled = true;
          try { await call(`/api/apps/${a.id}`, { method: "PATCH", body: { inline: false } }); toast(`${a.title} is in your Mini apps`); } catch (err) { handleError(err); }
        } } }, "Keep as app")));
  });
}

function newApp() {
  const what = h("textarea", { class: "field", rows: 3, maxLength: 1000, placeholder: "Flashcards for the Portuguese words from my lesson, and quiz me on the ones I miss" });
  openSheet("New app", [
    h("p", { class: "muted" }, "Say what it should do. The right teammate builds it, and you can ask for changes any time."),
    what,
    h("button", { class: "btn primary big", on: { click: async (e: Event) => {
      const text = (what as HTMLTextAreaElement).value.trim();
      if (!text) return;
      (e.currentTarget as HTMLButtonElement).disabled = true;
      try { const r = await call("/api/threads", { body: { text: `Build me a mini app: ${text}` } }); closeSheet(); location.hash = `#c/${r.thread.id}`; }
      catch (err) { (e.currentTarget as HTMLButtonElement).disabled = false; handleError(err); }
    } } }, icon("sparkle", 16), "Build it"),
  ]);
  setTimeout(() => what.focus(), 50);
}

// Every app frame on screen (full screen or pinned on Home) and which app it is. Messages are trusted only from these.
const appFrames = new Map<Window, string>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
window.addEventListener("message", (e: MessageEvent) => {
  const id = e.source ? appFrames.get(e.source as Window) : undefined;
  if (!id || typeof e.data !== "object" || !e.data) return;
  if (e.data.hearth === "save") {
    clearTimeout(saveTimers.get(id));
    const state = e.data.state;
    saveTimers.set(id, setTimeout(() => call(`/api/apps/${id}/state`, { method: "PUT", body: { state } }).catch(handleError), 400));
  } else if (e.data.hearth === "ask") {
    const a = S.apps.find((x) => x.id === id);
    call(`/api/apps/${id}/ask`, { body: { text: String(e.data.text || "") } }).then(() => toast(`Asked ${mate(a?.teammateId).name}`)).catch(handleError);
  } else if (e.data.hearth === "open") location.hash = `#a/${id}`;
  else if (e.data.hearth === "copy") navigator.clipboard?.writeText(String(e.data.text || "")).then(() => toast("Copied"), () => toast("Couldn't copy", "err"));
  else if (e.data.hearth === "download") {
    // Plain text types only, with a safe file name.
    const type = /^(text\/(plain|csv|calendar|tab-separated-values)|application\/json)$/.test(String(e.data.type)) ? String(e.data.type) : "text/plain";
    const a = h("a", { href: URL.createObjectURL(new Blob([String(e.data.text || "")], { type })), download: String(e.data.name || "export.txt").replace(/[^\w.\- ]/g, "_").slice(0, 80) });
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  } else if (e.data.hearth === "link") {
    // An app asked to open a web page (YouTube, a booking page): web links only, in a new tab.
    try { const u = new URL(String(e.data.url)); if (/^https?:$/.test(u.protocol)) window.open(u.href, "_blank", "noopener,noreferrer"); } catch {}
  } else if (e.data.hearth === "height") {
    const f = frameEls.get(e.source as Window);
    if (f?.classList.contains("autoh")) f.style.height = `${Math.max(80, Math.min(720, Number(e.data.h) || 0))}px`;
  }
});

/** A sandboxed frame for an app (opaque origin, no network), registered so its messages are accepted. */
const frameEls = new Map<Window, HTMLIFrameElement>();
async function appFrame(id: string, title: string, view: "full" | "inline" | "small" | "wide" | "large" = "full") {
  const { url } = await call(`/api/apps/${id}/open`, { body: { view } });
  const f = h("iframe", { sandbox: "allow-scripts allow-forms", src: activeHub()!.url + url, title }) as HTMLIFrameElement;
  f.addEventListener("load", () => {
    for (const [w, x] of appFrames) if (x === id && !w.parent) { appFrames.delete(w); frameEls.delete(w); }
    if (f.contentWindow) { appFrames.set(f.contentWindow, id); frameEls.set(f.contentWindow, f); }
  });
  return f;
}

const pinSize = (a: any): "small" | "wide" | "large" => a.size === "wide" || a.size === "large" ? a.size : a.size === "tall" ? "large" : "small";

/** Pinned mini apps run live on Home as widgets, under the shortcut tiles. Redrawn only when the pins change, so they don't reload. */
let pinsKey = "";
async function drawPins() {
  const el = document.getElementById("pins");
  if (!el) return;
  const pins = S.apps.filter((a) => a.pinned).sort((a, b) => (a.order || 0) - (b.order || 0));
  const key = pins.map((a) => `${a.id}:${a.size}:${a.updatedAt}`).join("|");
  if (key === pinsKey) return;
  pinsKey = key;
  clear(el, pins.length ? h("div", { class: "widgets" }, pins.map((a) => {
    const size = pinSize(a);
    // Like an iPhone widget: it stays live on Home, and a tap anywhere opens the full app.
    const openIt = () => { location.hash = `#a/${a.id}`; };
    const frameBox = h("div", { class: "wframe" });
    appFrame(a.id, a.title, size).then((f) => { f.setAttribute("scrolling", "no"); f.tabIndex = -1; clear(frameBox, f); }).catch(() => clear(frameBox, h("p", { class: "muted center" }, "Couldn't open")));
    const box = h("div", { class: "wbody" }, frameBox, h("button", { class: "wtap", "aria-label": `Open ${a.title}`, on: { click: openIt } }));
    return h("div", { class: `widget ${size}` }, box,
      h("button", { class: "wcap", on: { click: openIt } }, a.title));
  })) : null);
}

/** Full screen: the app in a sandboxed frame (no network, no hub access), with a glass back button and menu. */
async function renderApp(id: string) {
  const box = h("div", { class: "appframe" }, h("p", { class: "muted center" }, "Opening…"));
  const title = h("b", null, S.apps.find((x) => x.id === id)?.title || "App");
  clear(app, h("div", { class: "screen appscreen" },
    box,
    h("header", { class: "chrome-top" }, h("div", { class: "toprow" },
      h("button", { class: "circle glass", "aria-label": "Back", on: { click: () => { history.length > 1 ? history.back() : (location.hash = ""); } } }, icon("back", 24)),
      h("button", { class: "titlepill glass", on: { click: () => appMenu(id) } }, h("span", { class: "grow" }, title, h("small", null, "Tap to change, pin or undo"))),
      h("button", { class: "circle glass", "aria-label": "Reload", on: { click: () => renderApp(id) } }, icon("repeat", 20))))));
  try { clear(box, await appFrame(id, title.textContent || "App")); }
  catch (err) { clear(box, h("p", { class: "muted center" }, "That app is gone.")); handleError(err); }
}

function appMenu(id: string) {
  const a = S.apps.find((x) => x.id === id);
  if (!a) return;
  const ask = h("textarea", { class: "field", rows: 2, maxLength: 1000, placeholder: "Add 20 more words · show the Portuguese side first · bigger text" });
  openSheet(a.title, [
    h("p", { class: "muted" }, `${a.description ? a.description + " " : ""}Made by ${mate(a.teammateId).name}, updated ${shortAgo(a.updatedAt || a.createdAt)}. Runs on its own with no internet access.`),
    ask,
    h("button", { class: "btn primary big", on: { click: async (e: Event) => {
      const text = (ask as HTMLTextAreaElement).value.trim();
      if (!text) return;
      (e.currentTarget as HTMLButtonElement).disabled = true;
      try { await call(`/api/teammates/${a.teammateId || "hearth"}/messages`, { body: { text: `Change the app "${a.title}" (${a.name}): ${text}` } }); closeSheet(); toast(`${mate(a.teammateId).name} is on it. It updates here when done.`); }
      catch (err) { (e.currentTarget as HTMLButtonElement).disabled = false; handleError(err); }
    } } }, icon("sparkle", 16), "Ask for a change"),
    h("div", { class: "stack" },
      a.versions ? h("button", { class: "btn ghost", on: { click: async () => { try { await call(`/api/apps/${id}/undo`, { body: {} }); closeSheet(); await loadApps(); renderApp(id); toast("Back to the previous version"); } catch (err) { handleError(err); } } } }, "Undo last change") : null,
      h("button", { class: "btn ghost", on: { click: async () => { await call(`/api/apps/${id}`, { method: "PATCH", body: { pinned: !a.pinned } }); closeSheet(); toast(a.pinned ? "Taken off Home" : "Pinned to Home"); } } }, a.pinned ? "Remove from Home" : "Pin to Home"),
      a.pinned ? h("div", { class: "segmented" }, (["small", "wide", "large"] as const).map((z) => h("button", { class: pinSize(a) === z ? "on" : "", on: { click: async () => { await call(`/api/apps/${id}`, { method: "PATCH", body: { size: z } }); closeSheet(); } } }, z[0].toUpperCase() + z.slice(1)))) : null,
      h("button", { class: "btn ghost", on: { click: async () => { await call(`/api/apps/${id}/state`, { method: "PUT", body: { state: null } }); closeSheet(); renderApp(id); toast("Progress reset"); } } }, "Reset my progress"),
      h("button", { class: "btn danger", on: { click: async () => { if (!confirm(`Delete ${a.title}?`)) return; await call(`/api/apps/${id}`, { method: "DELETE" }); closeSheet(); location.hash = ""; } } }, "Delete app")),
  ]);
}
