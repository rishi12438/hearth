import { h, clear, icon, richText, relTime, shortAgo, clockTime, dayLabel, greeting, toast } from "./dom.ts";
import { activeHub, call, hubs, pair, removeHub, setActive, stream, normalizeUrl, ApiError, type HubRef } from "./api.ts";

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
  panel: null as null | "plans" | "memory" | "skills",
};

let live: ReturnType<typeof stream> | null = null;
const app = document.getElementById("app")!;
type Route = { view: "home" } | { view: "dms" } | { view: "activity" } | { view: "chat"; id: string; job?: string } | { view: "dm"; id: string };
const route = (): Route => {
  if (location.hash === "#dms") return { view: "dms" };
  if (location.hash === "#activity") return { view: "activity" };
  let m = location.hash.match(/^#c\/([\w-]+)(?:\/([\w-]+))?/);
  if (m) return { view: "chat", id: m[1], job: m[2] };
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
  await Promise.all([refreshState(), loadTeammates(), loadSkills(), loadFiles()]);
  show();
  connect();
  if (localStorage.getItem("hearth.autoLocation") === "1") shareLocation(true);
  window.addEventListener("hashchange", show);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { checkForUpdate(); refresh(); live?.restart(); } });
  document.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openJump(); } });
  setInterval(checkForUpdate, 5 * 60_000);
  setInterval(() => { if (route().view === "home") drawHome(); }, 30_000);
}

let lastLayout = "";
function show() {
  closeSheet();
  const r = route();
  // Re-render the skeleton only when the layout changes (opening a thread beside the chat keeps the chat in place).
  const layout = r.view === "chat" ? `chat:${r.id}:${r.job && !wide() ? "thread" : wide() && r.job ? "split" : "chat"}` : r.view === "dm" ? `dm:${r.id}` : r.view;
  if (layout !== lastLayout) {
    lastLayout = layout;
    if (r.view === "home") renderHome();
    else if (r.view === "dms") renderDms();
    else if (r.view === "activity") renderActivity();
    else if (r.view === "dm") renderDm();
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
    case "thinking": S.planning = e.data?.threadId || null; if (open) drawChat(); soon(); return;
    case "message":
      if (open && S.chat && e.data.threadId === open) { upsert(S.chat.messages, e.data); drawChat(); }
      else if (r.view === "dm" && e.data.threadId === `tm-${r.id}`) loadDm(r.id);
      else if (e.data.proactive) toast(e.data.proactive.title);
      soon();
      return;
    case "job":
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
    case "threads": soon(); if (open && S.chat) call("/api/threads").then((l: any[]) => { const t = l.find((x) => x.id === open); if (t && S.chat) { S.chat.thread.title = t.title; drawHeader(); } }).catch(() => {}); return;
    case "teammates": loadTeammates().then(soon); return;
    case "skills": loadSkills(); return;
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
  try { const r = await call("/api/skills"); S.skills = r.skills; S.workflows = r.workflows; if (S.panel === "skills") drawSkills(); } catch {}
}

async function loadTeammates() {
  try { S.teammates = await call("/api/teammates"); } catch (e) { handleError(e); }
}

function handleError(err: unknown) {
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
const ROLE: Record<string, string> = { hearth: "Chief of staff", planner: "Time, reminders, routines", scout: "Finds things", money: "Bills and spending" };
const role = (t: any) => ROLE[t.id] || String(t.description || "").split(/[.,:;]/)[0].slice(0, 32);
const jobState = (j: any) => j.status === "working" ? "working" : j.status === "queued" ? "thinking" : j.status === "waiting" ? "waiting" : j.status === "blocked" ? "blocked" : "idle";

async function loadFiles() {
  try { for (const f of await call("/api/files")) S.files.set(f.id, f); } catch {}
}

// ---------------- files: cards with View and Download ----------------

const kb = (n: number) => n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const fileIcon = (m: string) => m.startsWith("image/") ? "eye" : m === "text/calendar" ? "clock" : m.includes("pdf") ? "download" : "code";
const viewable = (m: string) => /^(image\/(png|jpeg|gif|webp)|application\/pdf|text\/(plain|markdown|csv|calendar)|application\/json|audio\/|video\/)/.test(m);

async function fileBlob(f: any, inline: boolean) {
  const hub = activeHub()!;
  const res = await fetch(`${hub.url}/api/files/${f.id}${inline ? "?inline=1" : ""}`, { headers: { Authorization: `Bearer ${hub.token}` } });
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

async function viewFile(f: any) {
  try {
    const blob = await fileBlob(f, true);
    const url = URL.createObjectURL(blob);
    if (f.mime.startsWith("image/")) openSheet(f.name, [h("img", { src: url, alt: f.name, class: "file-preview" }), h("button", { class: "btn primary big", on: { click: () => downloadFile(f) } }, icon("download", 16), "Download")]);
    else if (f.mime.startsWith("text/") || f.mime === "application/json") openSheet(f.name, [h("pre", { class: "output" }, await blob.text()), h("button", { class: "btn primary big", on: { click: () => downloadFile(f) } }, icon("download", 16), "Download")]);
    else window.open(url, "_blank", "noopener");
  } catch (e) { handleError(e); }
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
    const title = r.view === "home" ? (S.state?.hub?.name || "Hearth") : r.view === "dms" ? "DMs" : "Activity";
    clear(top, h("div", { class: "toprow big" },
      r.view === "home" ? h("button", { class: "logo", on: { click: openHubs }, "aria-label": "Your hubs" }, h("img", { src: "/icon.svg", alt: "" })) : null,
      h("h1", null, title, h("i", { class: `status ${S.conn}`, title: S.conn })),
      h("div", { class: "pillgroup glass" },
        S.updateReady ? h("button", { class: "pillbtn", on: { click: () => location.reload() } }, "Update") : null,
        h("button", { class: "pillbtn", "aria-label": "Menu", on: { click: openMenu } }, icon("filter", 22), (S.state?.pendingScripts || 0) ? h("i", { class: "dot" }) : null),
        h("button", { class: "pillbtn", "aria-label": "You", on: { click: openSettings } }, userAvatar(36)))));
    return;
  }
  const back = h("button", { class: "circle glass", "aria-label": "Back", on: { click: () => { history.length > 1 ? history.back() : (location.hash = ""); } } }, icon("back", 24));
  if (r.view === "dm") {
    const t = rosterEntry(r.id);
    clear(top, h("div", { class: "toprow" }, back,
      h("div", { class: "titlepill glass" }, face(t, 28, t.state), h("span", { class: "grow" }, h("b", null, t.name), h("small", null, t.status || role(t)))),
      h("button", { class: "circle glass", "aria-label": "Search", on: { click: openJump } }, icon("search", 21))));
    return;
  }
  const chat = S.chat;
  const name = chat?.thread ? channelName(chat.thread) : "new-ramble";
  const members = [...new Set((chat?.jobs || []).filter((j: any) => !j.parentId).map((j: any) => j.teammateId))] as string[];
  if (r.view === "chat" && r.job) {
    clear(top, h("div", { class: "toprow" }, back,
      h("div", { class: "titlepill glass" }, h("span", { class: "grow" }, h("b", null, "Thread"), h("small", null, `# ${name}`))),
      h("button", { class: "circle glass", "aria-label": "Search", on: { click: openJump } }, icon("search", 21))));
    return;
  }
  const open = (chat?.jobs || []).filter((j: any) => !j.parentId && !["done", "failed"].includes(j.status)).length;
  clear(top, h("div", { class: "toprow" }, back,
    h("button", { class: "titlepill glass", on: { click: chatMenu } }, h("span", { class: "hash" }, "#"),
      h("span", { class: "grow" }, h("b", null, name), h("small", null, [`${members.length + 1} members`, chat?.thread?.title && chat.thread.id !== "new" ? chat.thread.title : null, open ? `${open} working` : null].filter(Boolean).join(" • ")))),
    h("div", { class: "pillgroup glass" },
      h("button", { class: "pillbtn", "aria-label": "Files", on: { click: openFiles } }, icon("clip", 21)),
      h("button", { class: "pillbtn", "aria-label": "Search", on: { click: openJump } }, icon("search", 21)))));
}

function channelName(t: any) {
  return t.num ? `ramble-${t.num}` : t.id === "new" ? "new-ramble" : String(t.title || "ramble").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30);
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
  frame({ header: h("div"), body: h("div", { id: "home" }), fab: true, purple: true });
  drawHeader();
  drawHome();
}

function drawHome() {
  const el = document.getElementById("home");
  if (!el) return;
  const active = S.threads.filter((t) => !t.archived);
  const archived = S.threads.filter((t) => t.archived);
  const team = (S.roster.length ? S.roster : S.teammates.map((t) => ({ ...t, state: "idle", status: t.description })));
  const working = S.roster.reduce((n, t) => n + (t.busy || 0), 0);
  const plans = S.roster.filter((t) => String(t.status).startsWith("Next:")).length;
  const tiles: [string, string, string, () => void, boolean][] = [
    ["lock", "Needs you", `${needsYouCount()} waiting`, () => { location.hash = "#activity"; }, needsYouCount() > 0],
    ["sparkle", "Working", `${working} live`, () => { location.hash = "#activity"; }, working > 0],
    ["bell", "Plans", plans ? `${plans} coming up` : "Reminders", openPlans, false],
    ["clip", "Files", `${S.files.size} files`, openFiles, false],
  ];
  const section = (id: string, title: string, rows: Node[], extra?: Node | null) => h("section", { class: "hsec" },
    h("div", { class: "hsec-head" },
      h("button", { class: "hsec-title", on: { click: () => toggleSection(id) } }, h("span", null, title), icon("chevron", 16)),
      extra || null,
      h("button", { class: `chev ${collapsed.has(id) ? "down" : ""}`, "aria-label": collapsed.has(id) ? "Expand" : "Collapse", on: { click: () => toggleSection(id) } }, icon("up", 22))),
    collapsed.has(id) ? null : rows);
  const channelRow = (t: any) => h("button", { class: `hrow ${t.working || t.needsYou ? "unread" : ""}`, on: { click: () => { location.hash = `#c/${t.id}`; } } },
    h("span", { class: "hicon" }, "#"), h("span", { class: "grow" }, channelName(t)),
    t.needsYou ? h("em", { class: "badge" }, String(t.needsYou)) : t.working ? h("i", { class: "spin" }) : null);
  clear(el,
    h("div", { class: "tiles" }, tiles.map(([ic, title, sub, fn, hot]) =>
      h("button", { class: `tilebtn ${hot ? "hot" : ""}`, on: { click: fn } }, h("span", { class: "ti" }, icon(ic, 22), hot ? h("i", { class: "dot" }) : null), h("b", null, title), h("small", null, sub)))),
    section("rambles", "Active rambles", active.length ? active.map(channelRow)
      : [h("p", { class: "hempty" }, "Tap + and ramble. Each ramble becomes a channel; it archives itself an hour after everything's done.")],
      h("button", { class: "chev", "aria-label": "New ramble", on: { click: () => { location.hash = "#c/new"; } } }, icon("plus", 20))),
    section("dms", "Direct messages", team.map((t) => h("button", { class: `hrow ${t.needsYou || t.busy ? "unread" : ""}`, on: { click: () => { location.hash = `#t/${t.id}`; } } },
      face(t, 30, t.state), h("span", { class: "grow" }, t.name), t.needsYou ? h("em", { class: "badge" }, String(t.needsYou)) : null))),
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
    h("span", { class: "grow" }, h("span", { class: "l1" }, h("b", null, t.name), t.at ? h("time", null, shortAgo(t.at)) : null),
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

function drawChannel(el: HTMLElement, stick: boolean) {
  const top = S.chat.messages.filter((m: any) => !m.replyTo);
  if (!top.length) {
    clear(el, h("div", { class: "hello" },
      h("h2", null, "Start a ramble"),
      h("p", null, "Say it however it comes out. Hearth turns it into tasks for the right teammates, and this becomes #ramble-N."),
      h("div", { class: "starters" }, [
        "Remind me at 6 to call mom, find a cheap dinner spot, and text Sam that Tuesday works",
        "What's the weather in Paris tomorrow, and find pottery studios near Priya in Oakland",
        "I want to get to the gym 3 times a week, nag me if I don't",
      ].map((s) => h("button", { on: { click: () => send(s) } }, s)))));
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
  if (S.planning === S.chat.thread.id) nodes.push(row(mateWho("hearth", "thinking"), new Date().toISOString(), [h("div", { class: "typing" }, h("i"), h("i"), h("i"), h("span", null, "turning that into tasks…"))], lastWho === "hearth"));
  const atBottom = el.parentElement!.scrollHeight - el.parentElement!.scrollTop - el.parentElement!.clientHeight < 120;
  clear(el, nodes);
  if (stick || atBottom) requestAnimationFrame(() => { const s = document.getElementById("scroll")!; s.scrollTop = s.scrollHeight; });
}

/** Mentions (@Scout) look like Slack's blue mentions. */
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
  const body: (Node | null)[] = [m.proactive ? h("div", { class: "proline" }, icon("bell", 13), m.proactive.title) : null, richText(m.text)];
  if (m.proactive) {
    const why = h("div", { class: "why", hidden: true }, m.proactive.why);
    body.push(h("button", { class: "whybtn", on: { click: () => { why.hidden = !why.hidden; } } }, "Why did I get this?"), why);
  }
  return row(mateWho(m.teammateId || "hearth"), m.createdAt, body, grouped, m.error ? "err" : "");
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
  const body: (Node | Node[] | null)[] = [h("button", { class: "ttitle", on: { click: open } }, jobLabel(j))];
  if (st === "working" || st === "queued") {
    body.push(h("div", { class: "typing" }, h("i"), h("i"), h("i"), h("span", null, st === "working" ? "working on it" : latest.dependsOn?.length ? "waiting on another task" : "up next")));
  } else if (st === "waiting") {
    body.push(h("div", { class: "block" }, h("div", { class: "blockhead" }, icon("lock", 15), h("b", null, aps[0]?.summary || "Needs your OK")),
      aps.length ? h("div", { class: "blockbtns" }, h("button", { class: "sbtn primary", on: { click: () => decide(aps[0].id, true) } }, "Approve"), h("button", { class: "sbtn", on: { click: () => decide(aps[0].id, false) } }, "No")) : null));
  } else if (st === "blocked") {
    body.push(h("div", { class: "block" }, h("div", { class: "blockhead" }, h("b", null, `Stuck: ${latest.blocked?.need || ""}`)), latest.blocked?.unblock ? h("p", null, latest.blocked.unblock) : null,
      h("div", { class: "blockbtns" }, h("button", { class: "sbtn primary", on: { click: () => retry(latest.id) } }, "Try again"))));
  } else {
    const tiles = st === "done" ? (latest.tiles || []) : [];
    const skipText = tiles.length && (latest.how === "skill" || latest.how === "workflow");
    body.push(
      skipText ? null : h("div", { class: tiles.length ? "clamp short" : "clamp" }, richText(st === "failed" ? `Couldn't do it: ${latest.result || "it failed"}` : latest.result || "Done.")),
      tiles.map(tile),
      (latest.fileIds || []).map(fileCard));
  }
  const n = follow.length * 2;
  body.push(h("button", { class: "tfoot", on: { click: open } }, n ? h("b", null, `${n} replies`) : null, h("span", null, n ? `Last ${clockTime(latest.finishedAt || latest.updatedAt)}` : "Reply in thread"), icon("chevron", 14)));
  return row(mateWho(j.teammateId, jobState(latest)), m.createdAt, body, false, st === "failed" ? "err" : "");
}

async function decide(id: string, yes: boolean) { try { await call(`/api/approvals/${id}/${yes ? "approve" : "reject"}`, { body: {} }); } catch (e) { handleError(e); } }
async function retry(id: string) { try { await call(`/api/jobs/${id}/retry`, { body: {} }); } catch (e) { handleError(e); } }

/** A task's thread: the task on top, "N replies" divider, the teammate's answers and your replies. */
function drawThread(el: HTMLElement, jobId: string, stick: boolean) {
  const j = S.chat.jobs.find((x: any) => x.id === jobId);
  if (!j) { clear(el, h("p", { class: "muted center" }, "Loading…")); return; }
  const t = mate(j.teammateId);
  const follow = S.chat.jobs.filter((x: any) => x.followsUp === j.id);
  const n = (j.status === "done" || j.status === "failed" ? 1 : 0) + follow.length * 2;
  const nodes: (Node | null)[] = [
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
  if (j.status === "queued" || j.status === "working") return row(who, at, [h("div", { class: "typing" }, h("i"), h("i"), h("i"), h("span", null, j.status === "working" ? "working on it" : "up next"))]);
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
  return [j.escalated ? "escalated" : null, secs(j.durationMs), money(j.costUsd)].filter(Boolean).join(" · ");
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
    h("div", { class: "stack" },
      doneAll && lastRamble ? h("button", { class: "btn ghost", on: { click: async () => {
        try { const wf = await call("/api/workflows/from-ramble", { body: { messageId: lastRamble.id } }); toast(`Saved workflow ${wf.name}. Say “run ${wf.name}” any time.`); closeSheet(); loadSkills(); } catch (e) { handleError(e); }
      } } }, icon("repeat", 16), "Save as workflow") : null,
      h("button", { class: "btn danger-ghost", on: { click: () => confirmSheet("Delete this ramble?", "Its messages and results are deleted. Reminders it set keep working.", "Delete", async () => { await call(`/api/threads/${t.id}`, { method: "DELETE" }); location.hash = ""; }) } }, icon("trash", 16), "Delete")),
  ]);
}

// ---------------- a DM with one teammate ----------------

async function loadDm(id: string) {
  try { S.dm = await call(`/api/teammates/${id}`); drawDm(); }
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
        const res = await fetch(`${hub.url}/api/files`, { method: "POST", headers: { Authorization: `Bearer ${hub.token}`, "X-File-Name": encodeURIComponent(file.name), "Content-Type": file.type || "application/octet-stream" }, body: file });
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
  action.addEventListener("pointerdown", (e) => { if (box.value.trim() || pending.length) return; e.preventDefault(); micTarget = inThread; onMicDown(); });
  action.addEventListener("pointerup", () => { if (recording) onMicUp(); });
  action.addEventListener("pointerleave", () => { if (recording && Date.now() - pressAt > 350) onMicUp(); });
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
function face(t: any, size = 44, state = "idle") {
  return h("span", { class: `face ${shapeOf(t.id)} ${state}`, style: `--c:${t.color};--s:${size}px`, role: "img", "aria-label": `${t.name}, ${state}` },
    h("span", { class: "eyes" }, h("i", { class: "eye" }), h("i", { class: "eye" })));
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
    case "places":
      return h("div", { class: "tile places" }, t.title ? h("small", { class: "tt" }, t.title) : null, d.items.map((x: any, i: number) =>
        h(x.url ? "a" : "div", { class: "place", ...(x.url ? { href: x.url, target: "_blank", rel: "noopener noreferrer" } : {}) },
          h("span", { class: "n" }, String(i + 1)), h("span", { class: "grow" }, h("b", null, x.name), x.detail ? h("small", null, x.detail) : null), x.url ? icon("chevron", 14) : null)));
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

let recording = false;
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let pressAt = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function autosize(t: HTMLTextAreaElement) { t.style.height = "auto"; t.style.height = Math.min(150, t.scrollHeight) + "px"; }

async function onMicDown() {
  if (recording) { stopRecording(true); return; } // second tap ends open-mic
  pressAt = Date.now();
  if (!S.state?.voice) return toast("Voice isn't set up on this hub yet (add a Deepgram key to its .env).", "err");
  try {
    const media = await navigator.mediaDevices.getUserMedia({ audio: true });
    const type = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((t) => MediaRecorder.isTypeSupported(t)) || "";
    recorder = new MediaRecorder(media, type ? { mimeType: type } : undefined);
    chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.start(250);
    recording = true;
    showRecording(true);
  } catch { toast("Microphone permission is off", "err"); }
}

function onMicUp() {
  if (Date.now() - pressAt < 350) { toast("Listening. Tap again when you're done."); return; } // a tap = open mic
  stopRecording(true);
}

function showRecording(on: boolean) {
  const rec = document.getElementById("rec")!;
  document.getElementById("composerbox")?.classList.toggle("listening", on);
  if (timer) clearInterval(timer);
  if (!on) { rec.hidden = true; return; }
  const start = Date.now();
  const label = h("span", { class: "clock" }, "0:00");
  clear(rec, h("i", { class: "wave" }, h("b"), h("b"), h("b"), h("b"), h("b")), h("span", { class: "grow" }, "Listening…"), label,
    h("button", { class: "cancel", on: { click: () => stopRecording(false) } }, "Cancel"));
  rec.hidden = false;
  timer = setInterval(() => { const s = Math.floor((Date.now() - start) / 1000); label.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }, 250);
}

function stopRecording(sendIt: boolean) {
  if (!recorder) return;
  const r = recorder;
  recorder = null;
  recording = false;
  showRecording(false);
  r.onstop = async () => {
    r.stream.getTracks().forEach((t) => t.stop());
    if (!sendIt || !chunks.length) return;
    const blob = new Blob(chunks, { type: (r.mimeType || "audio/webm").split(";")[0] });
    const box = (document.getElementById("composer") as HTMLTextAreaElement | null) || document.createElement("textarea");
    box.placeholder = "Transcribing…";
    try {
      const hub = activeHub()!;
      const res = await fetch(hub.url + "/api/transcribe", { method: "POST", headers: { Authorization: `Bearer ${hub.token}`, "Content-Type": blob.type }, body: blob });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Transcription failed");
      if (data.text) send(data.text, micTarget); else toast("I didn't catch that", "err");
    } catch (e) { handleError(e); }
    finally { box.placeholder = "Ramble. Hearth will hand it out…"; }
  };
  r.stop();
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
  const name = h("input", { class: "field", placeholder: "Coach", maxLength: 24 });
  const what = h("textarea", { class: "field", rows: 2, placeholder: "Keeps me honest about workouts and sleep. Checks in if I skip.", maxLength: 200 });
  openSheet("Teammates", [
    h("p", { class: "muted" }, "You never have to pick one. The orchestrator hands each job to the right teammate, and adds a new one when nobody fits."),
    h("div", { class: "list" }, S.teammates.map((t) => h("div", { class: "item" },
      face(t, 34, "idle"), h("span", { class: "grow" }, h("b", null, t.name), h("small", { class: "sub" }, t.description)),
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

const MODEL_HINTS: Record<string, string[]> = {
  claude: ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  codex: [],
};

async function openBrains() {
  let data: any;
  try { data = await call("/api/brains"); } catch (e) { return handleError(e); }
  const roles: [string, string, string][] = [
    ["orchestrator", "Orchestrator", "Reads every ramble, splits it into jobs, picks the teammate and how hard each job is. Use your smartest model."],
    ["workhorse", "Workhorse", "Does the light jobs. Fast and cheap."],
    ["heavy", "Heavy", "Does the hard jobs, and anything the workhorse can't finish (auto-escalation)."],
  ];
  const state: any = JSON.parse(JSON.stringify(data.current));
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
        : h("button", { class: "btn small primary", on: { click: async () => { closeSheet(); const r = await call("/api/threads", { body: { text: `Run my "${w.name}" workflow` } }); location.hash = `#chat/${r.thread.id}`; } } }, "Run"),
      h("button", { class: `star ${w.pinned ? "on" : ""}`, "aria-label": w.pinned ? "Unpin" : "Pin (never clean up)", on: { click: async () => { await call(`/api/workflows/${w.id}`, { method: "PATCH", body: { pinned: !w.pinned } }); } } }, icon("pin", 16)),
      h("button", { class: "iconbtn", "aria-label": "Delete workflow", on: { click: () => confirmSheet(`Delete ${w.name}?`, "The skills it uses stay.", "Delete", async () => { await call(`/api/workflows/${w.id}`, { method: "DELETE" }); }) } }, icon("trash", 16)))))] : null);
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
    h("div", { id: "memory" }),
  ], { onClose: () => { S.panel = null; } });
  drawMemory();
  loadMemory();
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
    h("div", { class: "list" }, row("Brains", "Orchestrator, workhorse, heavy", openBrains)),
    h("h4", null, "Location"),
    h("div", { class: "list" },
      row("Share when I open the app", "For place reminders and “near me”", () => { localStorage.setItem("hearth.autoLocation", autoLoc ? "0" : "1"); if (!autoLoc) shareLocation(false); closeSheet(); openSettings(); }, sw(autoLoc)),
      row("Places", "Home, office…", openPlaces)),
    h("h4", null, "Security and data"),
    h("div", { class: "list" },
      row("Devices", "Who can talk to this hub", openDevices),
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
    h("p", { class: "hint" }, "No code? On your hub, run ", h("code", null, "bun run pair"), ". Codes work once and expire after 10 minutes."),
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
    const devices = await call("/api/devices");
    const codeBox = h("div");
    openSheet("Devices", [
      h("p", { class: "muted" }, "Each device has its own key. Sign one out and it loses access at once."),
      h("div", { class: "list" }, devices.map((d: any) => h("div", { class: "item" },
        h("div", { class: "hicon" }, icon("phone", 16)),
        h("div", { class: "grow" }, h("div", { class: "title" }, d.name, d.current ? h("span", { class: "tag soft" }, "This device") : null), h("div", { class: "sub" }, `Paired ${dayLabel(d.createdAt)} · seen ${relTime(d.lastSeenAt)}`)),
        h("button", { class: "btn small danger-ghost", on: { click: () => confirmSheet(`Sign out ${d.name}?`, "It will need a new pairing code to come back.", "Sign out", async () => { await call(`/api/devices/${d.id}`, { method: "DELETE" }); if (d.current) { removeHub(activeHub()!.id); location.reload(); } toast("Signed out"); }) } }, "Sign out")))),
      codeBox,
      h("button", { class: "btn ghost", on: { click: async () => {
        const { code, expiresInMin } = await call("/api/devices/pair-code", { body: {} });
        clear(codeBox, h("div", { class: "paircode" }, h("small", null, "Pairing code"), h("b", null, code), h("small", null, `Single use · expires in ${expiresInMin} min · open ${activeHub()!.url}`)));
      } } }, icon("plus", 16), "Pair another device"),
    ]);
  } catch (e) { handleError(e); }
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
    const res = await fetch(hub.url + "/api/export", { headers: { Authorization: `Bearer ${hub.token}` } });
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
