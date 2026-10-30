import { h, clear, icon, richText, relTime, shortAgo, clockTime, dayLabel, greeting, toast } from "./dom.ts";
import { activeHub, call, hubs, pair, removeHub, setActive, stream, normalizeUrl, ApiError, type HubRef } from "./api.ts";

declare const __BUILD__: string;

// Inspired by Grok Bot and Muse:
// - Home is a roster of teammates, not a list of chats. Each has a face that acts out what it's doing and a
//   one-line status in its own voice. Hearth, the chief of staff, is pinned on top.
// - You ramble into Hearth's one long conversation; it hands the work out and teammates' faces come alive.
// - Tap a teammate to see everything it did and its routines, or to message it directly.
// - Everything else (plans, memory, skills, brains, settings) is behind the menu.

const S = {
  state: null as any,
  roster: [] as any[],
  thread: null as any,          // main conversation: { thread, messages, jobs, approvals }
  mateView: null as any,        // a teammate's page: { teammate, jobs, messages, routines, approvals }
  teammates: [] as any[],
  skills: [] as any[],
  workflows: [] as any[],
  hooks: [] as any[],
  memory: null as any,
  memoryQuery: "",
  plansFilter: "",
  today: null as any,
  conn: "connecting" as "live" | "connecting" | "offline",
  planning: false,
  updateReady: false,
  sheetOpen: false,
  panel: null as null | "plans" | "memory" | "skills" | "activity",
};

let live: ReturnType<typeof stream> | null = null;
const app = document.getElementById("app")!;
type Route = { view: "home" } | { view: "hearth" } | { view: "mate"; id: string };
const route = (): Route => {
  if (location.hash === "#hearth") return { view: "hearth" };
  const m = location.hash.match(/^#t\/([\w-]+)/);
  return m ? { view: "mate", id: m[1] } : { view: "home" };
};

// ---------------- boot ----------------

async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  const pairCode = new URLSearchParams(location.hash.slice(1)).get("pair");
  if (!activeHub() || pairCode) return renderPairing(pairCode || "");
  if (/^#chat\//.test(location.hash)) history.replaceState(null, "", "#hearth"); // old links
  await Promise.all([refreshState(), loadTeammates(), loadSkills()]);
  show();
  connect();
  if (localStorage.getItem("hearth.autoLocation") === "1") shareLocation(true);
  window.addEventListener("hashchange", show);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { checkForUpdate(); refresh(); live?.restart(); } });
  setInterval(checkForUpdate, 5 * 60_000);
  setInterval(() => { if (route().view === "home") drawRoster(); }, 30_000); // keep "2m ago" honest
}

function show() {
  closeSheet();
  const r = route();
  if (r.view === "home") renderHome();
  else if (r.view === "hearth") renderHearth();
  else renderMate(r.id);
  refresh();
}

function refresh() {
  const r = route();
  if (r.view === "home") loadRoster();
  else if (r.view === "hearth") loadMain();
  else loadMate(r.id);
}

function connect() {
  live?.stop();
  live = stream(onEvent, (s) => { S.conn = s; drawHeader(); });
}

let rosterTimer: ReturnType<typeof setTimeout> | null = null;
function soonRoster() { if (rosterTimer) return; rosterTimer = setTimeout(() => { rosterTimer = null; loadRoster(); }, 250); }

function onEvent(e: { type: string; data?: any }) {
  const r = route();
  switch (e.type) {
    case "hello": if (e.data?.build && e.data.build !== __BUILD__) markUpdate(); return;
    case "unpaired": toast("This device was signed out of the hub.", "err"); removeHub(activeHub()!.id); location.reload(); return;
    case "thinking": S.planning = !!e.data; if (r.view === "hearth") drawMain(); soonRoster(); return;
    case "message":
      if (r.view === "hearth" && e.data.threadId === "main" && S.thread) { if (!S.thread.messages.some((m: any) => m.id === e.data.id)) S.thread.messages.push(e.data); drawMain(); }
      else if (r.view === "mate" && S.mateView && e.data.threadId === `tm-${r.id}`) loadMate(r.id);
      else if (e.data.proactive && r.view !== "hearth") toast(e.data.proactive.title);
      soonRoster();
      return;
    case "job":
      if (r.view === "hearth" && S.thread && e.data.threadId === "main") { upsert(S.thread.jobs, e.data); drawMain(false); }
      if (r.view === "mate" && S.mateView && e.data.teammateId === r.id) { upsert(S.mateView.jobs, e.data); drawMate(false); }
      soonRoster();
      return;
    case "approval":
      if (S.thread) upsert(S.thread.approvals || (S.thread.approvals = []), e.data);
      if (S.mateView) upsert(S.mateView.approvals, e.data);
      if (r.view === "hearth") drawMain(false); else if (r.view === "mate") drawMate(false);
      if (e.data.status === "pending" && r.view === "home") toast(`Needs your OK: ${e.data.summary}`);
      soonRoster();
      return;
    case "teammates": loadTeammates().then(soonRoster); return;
    case "skills": loadSkills(); return;
    case "hooks": if (S.panel === "plans") loadHooks(); if (r.view === "mate") loadMate(r.id); return;
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

const mate = (id?: string) => S.roster.find((t) => t.id === (id || "hearth")) || S.teammates.find((t) => t.id === (id || "hearth")) || { id: "hearth", name: "Hearth", color: "#F5A524", description: "" };

const ROLE: Record<string, string> = { hearth: "Chief of staff", planner: "Time, reminders, routines", scout: "Finds things", money: "Bills and spending" };
const role = (t: any) => ROLE[t.id] || String(t.description || "").split(/[.,:;]/)[0].slice(0, 32);

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

// ---------------- header ----------------

function drawHeader() {
  const top = document.getElementById("top");
  if (!top) return;
  const r = route();
  const pending = S.state?.pendingScripts || 0;
  const status = h("i", { class: `status ${S.conn}`, title: S.conn });
  if (r.view === "home") {
    clear(top,
      h("button", { class: "brand", on: { click: openHubs } }, h("b", null, S.state?.hub?.name || "Hearth"), status),
      S.updateReady ? h("button", { class: "pill", on: { click: () => location.reload() } }, "Update") : null,
      h("button", { class: "iconbtn menu", "aria-label": "Menu", on: { click: openMenu } }, icon("menu", 22), pending ? h("i", { class: "badge" }) : null));
    return;
  }
  const t = r.view === "hearth" ? rosterEntry("hearth") : rosterEntry(r.id);
  const snippet = r.view === "hearth" ? hearthSnippet() : t.status;
  clear(top,
    h("button", { class: "iconbtn", "aria-label": "Back", on: { click: () => { location.hash = ""; } } }, icon("back", 22)),
    h("button", { class: "who-head", on: { click: r.view === "hearth" ? openWork : () => {} } },
      face(t, 34, t.state), h("span", { class: "grow" }, h("b", null, t.name, status), h("small", null, snippet || role(t)))),
    r.view === "hearth" ? h("button", { class: "iconbtn", "aria-label": "Activity", on: { click: openWork } }, icon("eye", 20)) : h("span", { class: "iconbtn" }));
}

function rosterEntry(id: string) {
  return S.roster.find((x) => x.id === id) || { ...mate(id), state: "idle", status: "" };
}

function hearthSnippet() {
  if (S.planning) return "Sorting out who does what…";
  const busy = S.roster.filter((t) => t.busy).length;
  const needs = S.roster.reduce((n, t) => n + (t.needsYou || 0), 0);
  if (needs) return `${needs} thing${needs > 1 ? "s" : ""} need${needs > 1 ? "" : "s"} you`;
  if (busy) return `${busy} teammate${busy > 1 ? "s" : ""} working`;
  return "Chief of staff";
}

// ---------------- home: the roster ----------------

async function loadRoster() {
  try { S.roster = await call("/api/roster"); if (route().view === "home") drawRoster(); else drawHeader(); } catch (e) { handleError(e); }
}

function renderHome() {
  clear(app,
    h("header", { class: "top home-top", id: "top" }),
    h("main", { class: "roster-wrap" },
      h("div", { class: "greet" }, h("h1", null, greeting(S.state?.prefs?.userName)), h("p", null, "Tell Hearth anything. It hands the work to the right teammate.")),
      h("div", { class: "roster", id: "roster" })),
    h("footer", { class: "dock" }, h("div", { class: "composer-wrap", id: "composerwrap" })),
  );
  drawHeader();
  drawRoster();
  renderComposer();
}

function drawRoster() {
  const el = document.getElementById("roster");
  if (!el) return;
  const list = S.roster.length ? S.roster : S.teammates.map((t) => ({ ...t, state: "idle", status: t.description }));
  const [hearth, ...rest] = [...list].sort((a, b) => (a.id === "hearth" ? -1 : b.id === "hearth" ? 1 : 0));
  const order = (t: any) => (t.needsYou ? 0 : t.busy ? 1 : t.state === "done" ? 2 : 3);
  rest.sort((a, b) => order(a) - order(b) || (b.at || "").localeCompare(a.at || ""));
  const row = (t: any, big = false) => h("button", { class: `mate-row ${big ? "big" : ""} st-${t.state}`, on: { click: () => { location.hash = t.id === "hearth" ? "#hearth" : `#t/${t.id}`; } } },
    face(t, big ? 58 : 48, t.state),
    h("span", { class: "grow" },
      h("span", { class: "line1" }, h("b", null, t.name), h("small", { class: "role" }, role(t)), t.at ? h("time", null, shortAgo(t.at)) : null),
      h("span", { class: `line2 ${t.needsYou ? "warnline" : ""}` }, t.id === "hearth" ? (hearthSnippetFor(list) || t.status) : t.status)));
  clear(el,
    hearth ? row(hearth, true) : null,
    h("div", { class: "roster-label" }, "Team"),
    rest.map((t) => row(t)),
    h("button", { class: "mate-row add", on: { click: () => openTeammates() } }, h("span", { class: "face ghost", style: "--s:48px" }, icon("plus", 18)), h("span", { class: "grow" }, h("b", null, "Add a teammate"), h("span", { class: "line2" }, "Or just ask. Hearth adds one when nobody fits."))));
}

function hearthSnippetFor(list: any[]) {
  const needs = list.reduce((n, t) => n + (t.needsYou || 0), 0);
  const busy = list.filter((t) => t.busy).map((t) => t.name);
  if (S.planning) return "Sorting out who does what…";
  if (needs) return `${needs} thing${needs > 1 ? "s" : ""} need${needs > 1 ? "" : "s"} you`;
  if (busy.length) return `${busy.slice(0, 3).join(", ")} ${busy.length > 1 ? "are" : "is"} on it`;
  return "";
}

// ---------------- Hearth: the one main conversation ----------------

async function loadMain() {
  try {
    const [d] = await Promise.all([call("/api/threads/main").catch(async (e) => { if (e instanceof ApiError && e.status === 404) return { thread: { id: "main", title: "Hearth" }, messages: [], jobs: [], approvals: [] }; throw e; }), loadRoster()]);
    S.thread = d;
    drawMain();
  } catch (e) { handleError(e); }
}

function renderHearth() {
  clear(app,
    h("header", { class: "top chat-top", id: "top" }),
    h("main", { class: "thread", id: "thread" }),
    h("footer", { class: "dock" }, h("div", { class: "composer-wrap", id: "composerwrap" })),
  );
  drawHeader();
  renderComposer();
}

/** One timeline: what you said, Hearth's reply, live "on it" rows that become results, and approval cards. */
function drawMain(stick = true) {
  const el = document.getElementById("thread");
  if (!el || !S.thread) return;
  drawHeader();
  const { messages } = S.thread;
  const jobs = (S.thread.jobs || []).filter((j: any) => !j.parentId);
  if (!messages.length) {
    clear(el, h("div", { class: "hello" },
      h("div", { class: "bigface" }, face(mate("hearth"), 84, "idle")),
      h("h2", null, "What's on your mind?"),
      h("p", null, "Ramble. Several things at once is fine; I'll hand them out."),
      h("div", { class: "starters" }, [
        "Remind me at 6 to call mom, and find somewhere cheap for dinner tonight",
        "What's the weather in Paris tomorrow?",
        "I want to get to the gym 3 times a week, nag me if I don't",
      ].map((s) => h("button", { on: { click: () => send(s) } }, s)))));
    return;
  }
  type Item = { at: string; node: Node };
  const items: Item[] = [];
  for (const m of messages) items.push({ at: m.createdAt, node: message(m) });
  for (const j of jobs) items.push({ at: j.finishedAt || j.startedAt || j.createdAt, node: jobItem(j) });
  items.sort((a, b) => a.at.localeCompare(b.at));
  const nodes: Node[] = [];
  let lastDay = "";
  for (const it of items) {
    const day = new Date(it.at).toDateString();
    if (day !== lastDay) { nodes.push(h("div", { class: "day" }, dayLabel(it.at))); lastDay = day; }
    nodes.push(it.node);
  }
  if (S.planning) nodes.push(h("div", { class: "event" }, face(mate("hearth"), 22, "thinking"), h("span", null, "Hearth is sorting out who does what…")));
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  clear(el, nodes);
  if (stick || atBottom) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}

function message(m: any) {
  if (m.role === "user") return h("div", { class: "msg me" }, h("div", { class: "bubble" }, m.text));
  const t = mate(m.teammateId);
  const parts: (Node | null)[] = [h("div", { class: "who" }, face(t, 22, "idle"), h("b", null, t.name), m.proactive ? h("span", { class: "tag" }, icon("bell", 11), m.proactive.title) : null), richText(m.text)];
  if (m.proactive) {
    const why = h("div", { class: "why", hidden: true }, m.proactive.why);
    parts.push(h("button", { class: "whybtn", on: { click: () => { why.hidden = !why.hidden; } } }, "Why?"), why);
  }
  return h("div", { class: `msg bot ${m.error ? "err" : ""}` }, parts);
}

/** A job in the timeline: a live "on it" row while it works, the teammate's result when done, a card if it needs you. */
function jobItem(j: any) {
  const t = mate(j.teammateId);
  if (j.status === "queued" || j.status === "working") {
    return h("button", { class: "event live", on: { click: () => { location.hash = `#t/${t.id}`; } } }, face(t, 22, j.status === "working" ? "working" : "thinking"),
      h("span", null, h("b", null, t.name), j.status === "working" ? " is on it: " : (j.dependsOn?.length ? " is waiting for another job: " : " is up next: "), j.task));
  }
  if (j.status === "waiting" || j.status === "blocked") return needsYou(j);
  const tiles = j.status === "done" ? (j.tiles || []) : [];
  const did = (j.did || []).filter((d: any) => ["hook", "memory", "skill", "place"].includes(d.kind)).map((d: any) => d.label);
  return h("div", { class: `msg bot ${j.status === "failed" ? "err" : ""}` },
    h("div", { class: "who" }, face(t, 22, "idle"), h("b", null, t.name), h("small", { class: "jobmeta" }, metaLine(j))),
    tiles.length && (j.how === "skill" || j.how === "workflow") ? null : richText(j.status === "failed" ? `Couldn't do “${j.task}”: ${j.result || "it failed"}` : j.result || "Done."),
    tiles.map(tile),
    did.length ? h("div", { class: "did-line" }, icon("check", 12), did.join(" · ")) : null);
}

function metaLine(j: any) {
  if (j.how === "skill" || j.how === "workflow") {
    const n = (j.skillId ? S.skills.find((x) => x.id === j.skillId) : S.workflows.find((x) => x.id === j.workflowId))?.name;
    return `${n ? `used ${n} · ` : ""}${secs(j.durationMs)} · ${money(j.costUsd)}`;
  }
  return [j.escalated ? "escalated" : null, secs(j.durationMs), money(j.costUsd)].filter(Boolean).join(" · ");
}

function secs(ms?: number) {
  if (!ms) return "";
  return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`;
}

function money(c: number | null | undefined) {
  return c === null || c === undefined ? "$?" : c === 0 ? "$0" : c < 0.01 ? "<$0.01" : `$${c.toFixed(2)}`;
}

/** Muse-style: tap Hearth's face for the activity log of the main conversation. */
function openWork() {
  S.panel = "activity";
  openSheet("Activity", h("div", { id: "agents-body" }), { onClose: () => { S.panel = null; } });
  drawAgents();
}

// ---------------- a teammate's page ----------------

async function loadMate(id: string) {
  try {
    const [d] = await Promise.all([call(`/api/teammates/${id}`), loadRoster()]);
    S.mateView = d;
    drawMate();
  } catch (e) { if (e instanceof ApiError && e.status === 404) { location.hash = ""; return; } handleError(e); }
}

function renderMate(id: string) {
  S.mateView = null;
  clear(app,
    h("header", { class: "top chat-top", id: "top" }),
    h("main", { class: "thread", id: "thread" }),
    h("footer", { class: "dock" }, h("div", { class: "composer-wrap", id: "composerwrap" })),
  );
  drawHeader();
  renderComposer();
}

function drawMate(stick = true) {
  const el = document.getElementById("thread");
  const d = S.mateView;
  if (!el || !d) return;
  drawHeader();
  const t = rosterEntry(d.teammate.id);
  // Each piece of work reads top to bottom: who asked, then what came of it.
  const items: { at: string; node: Node[] }[] = [];
  const direct = new Set(d.messages.map((m: any) => m.id));
  for (const m of d.messages) if (!d.jobs.some((j: any) => j.messageId === m.id)) items.push({ at: m.createdAt, node: [message(m)] });
  for (const j of d.jobs) {
    const ask = direct.has(j.messageId)
      ? message(d.messages.find((m: any) => m.id === j.messageId))
      : h("div", { class: "event asked" }, face(mate("hearth"), 18, "idle"), h("span", null, h("b", null, "Hearth"), " asked: ", j.task));
    items.push({ at: j.createdAt, node: [ask, j.status === "queued" && !direct.has(j.messageId) ? null : jobItem(j)].filter(Boolean) as Node[] });
  }
  items.sort((a, b) => a.at.localeCompare(b.at));
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  clear(el,
    h("div", { class: "mate-hero" }, face(t, 72, t.state), h("h2", null, t.name), h("p", null, t.description || role(t)),
      d.routines.length ? h("div", { class: "routines" }, h("small", null, "Routines"), d.routines.map((r: any) =>
        h("button", { class: `routine ${r.status}`, on: { click: () => openHook(r) } }, icon(r.trigger.type === "at" ? "clock" : "repeat", 14), h("span", null, r.title), h("small", null, r.status === "paused" ? "paused" : r.when)))) : null),
    items.length ? items.flatMap((x) => x.node) : h("p", { class: "muted center" }, `Nothing yet. Message ${t.name} directly, or ramble to Hearth and it'll hand things over.`));
  if (stick || atBottom) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}

function chatMenu() {
  openSheet("Hearth", [
    h("p", { class: "muted" }, "Clearing the conversation deletes its messages and results. Reminders and routines keep working."),
    h("div", { class: "stack" },
      h("button", { class: "btn danger-ghost", on: { click: () => confirmSheet("Clear the conversation?", "Messages and job results are deleted.", "Clear", async () => { await call(`/api/threads/main`, { method: "DELETE" }); location.hash = ""; }) } }, icon("trash", 16), "Clear conversation")),
  ]);
}

// ---------------- composer & voice ----------------

function renderComposer() {
  const wrap = document.getElementById("composerwrap");
  if (!wrap) return;
  const r = route();
  const who = r.view === "mate" ? mate(r.id).name : "Hearth";
  const placeholder = S.conn === "offline" ? "Hub is offline" : r.view === "mate" ? `Message ${who}` : "Tell Hearth anything…";
  const box = h("textarea", { id: "composer", rows: 1, value: sessionStorage.getItem("hearth.draft") || "", placeholder, enterKeyHint: "send",
    on: {
      input: () => { autosize(box); sessionStorage.setItem("hearth.draft", box.value); swap(); },
      keydown: (e: KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer: coarse)").matches) { e.preventDefault(); send(box.value); } },
    } });
  const action = h("button", { class: "act", id: "act", "aria-label": "Hold to talk" });
  const swap = () => {
    const hasText = !!box.value.trim();
    action.classList.toggle("send", hasText);
    clear(action, icon(hasText ? "send" : "mic", 20));
    action.setAttribute("aria-label", hasText ? "Send" : "Hold to talk");
  };
  action.addEventListener("pointerdown", (e) => { if (box.value.trim()) return; e.preventDefault(); onMicDown(); });
  action.addEventListener("pointerup", () => { if (recording) onMicUp(); });
  action.addEventListener("pointerleave", () => { if (recording && Date.now() - pressAt > 350) onMicUp(); });
  action.addEventListener("click", () => { if (box.value.trim()) send(box.value); });
  clear(wrap, h("div", { class: "rec", id: "rec", hidden: true }), h("div", { class: "composer", id: "composerbox" }, box, action));
  swap();
  autosize(box);
}

async function send(text: string) {
  const t = text.trim();
  if (!t) return;
  const box = document.getElementById("composer") as HTMLTextAreaElement | null;
  if (box) { box.value = ""; box.dispatchEvent(new Event("input")); }
  sessionStorage.removeItem("hearth.draft");
  const r = route();
  try {
    if (r.view === "mate") {
      await call(`/api/teammates/${r.id}/messages`, { body: { text: t } });
      loadMate(r.id);
      return;
    }
    const res = await call("/api/threads/main/messages", { body: { text: t } }).catch(async (e) => {
      if (e instanceof ApiError && e.status === 400 && /No such chat/.test(e.message)) return call("/api/threads", { body: { text: t } });
      throw e;
    });
    S.planning = true;
    if (r.view !== "hearth") { location.hash = "#hearth"; return; }
    if (S.thread && !S.thread.messages.some((m: any) => m.id === res.message.id)) S.thread.messages.push(res.message);
    drawMain();
  } catch (e) {
    if (box) { box.value = t; box.dispatchEvent(new Event("input")); }
    handleError(e);
  }
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

/** One compact row for anything waiting on you: an Approve, or "I'm stuck". */
function needsYou(j: any) {
  const t = mate(j.teammateId);
  if (j.status === "blocked" && j.blocked) {
    return h("div", { class: "needs" },
      h("div", { class: "who" }, face(t, 22, j.status === "blocked" ? "blocked" : "waiting"), h("b", null, t.name), h("span", { class: "tag warn" }, "stuck")),
      h("p", null, h("b", null, j.blocked.need), j.blocked.why ? ` · ${j.blocked.why}` : ""),
      h("div", { class: "needsrow" }, h("span", null, j.blocked.unblock),
        h("button", { class: "btn primary small", on: { click: async () => { try { await call(`/api/jobs/${j.id}/retry`, { body: {} }); } catch (e) { handleError(e); } } } }, "Try again")));
  }
  const aps = [...(S.thread?.approvals || []), ...(S.mateView?.approvals || [])].filter((a: any) => a.jobId === j.id && a.status === "pending");
  return h("div", { class: "needs" },
    h("div", { class: "who" }, face(t, 22, j.status === "blocked" ? "blocked" : "waiting"), h("b", null, t.name), h("span", { class: "tag warn" }, "needs your OK")),
    aps.map((a: any) => {
      const decide = async (yes: boolean) => { try { await call(`/api/approvals/${a.id}/${yes ? "approve" : "reject"}`, { body: {} }); } catch (e) { handleError(e); } };
      return h("div", { class: "needsrow" }, h("span", null, a.summary),
        h("span", { class: "btns" }, h("button", { class: "btn ghost small", on: { click: () => decide(false) } }, "No"), h("button", { class: "btn primary small", on: { click: () => decide(true) } }, "Approve")));
    }));
}

/** The side panel: every agent on this chat, live. */
function drawAgents() {
  const targets = [document.getElementById("agents-body")].filter(Boolean) as HTMLElement[];
  if (!targets.length || !S.thread) return;
  const all = S.thread.jobs || [];
  const top = all.filter((j: any) => !j.parentId);
  const groups: [string, any[]][] = [
    ["Working", top.filter((j: any) => j.status === "working" || j.status === "queued")],
    ["Needs you", top.filter((j: any) => j.status === "waiting" || j.status === "blocked")],
    ["Done", top.filter((j: any) => j.status === "done" || j.status === "failed")],
  ];
  const spent = top.reduce((n: number, j: any) => n + (j.costUsd || 0), 0);
  for (const el of targets) {
    clear(el,
      h("div", { class: "agentshead" }, h("b", null, "What everyone is doing"), top.length ? h("small", null, `${top.length} jobs · ${money(spent)}`) : null,
        null),
      !top.length ? h("p", { class: "muted small" }, "When you ramble, the jobs and who's on them show up here.") : null,
      groups.filter(([, list]) => list.length).map(([title, list]) => [h("h4", null, title), list.map((j) => agentRow(j, all.filter((x: any) => x.parentId === j.id)))]),
      saveWorkflowButton(top),
      h("button", { class: "link danger", on: { click: chatMenu } }, "Clear conversation"));
  }
}

/** When a ramble's jobs are all done, save the whole thing as a workflow for next time (no model). */
function saveWorkflowButton(top: any[]) {
  const last = [...(S.thread?.messages || [])].reverse().find((m: any) => m.jobIds?.length);
  if (!last) return null;
  const mine = top.filter((j: any) => last.jobIds.includes(j.id));
  if (!mine.length || !mine.every((j: any) => j.status === "done")) return null;
  return h("button", { class: "btn ghost", on: { click: async (e: Event) => {
    const b = e.currentTarget as HTMLButtonElement; b.disabled = true;
    try { const wf = await call("/api/workflows/from-ramble", { body: { messageId: last.id } }); toast(`Saved workflow ${wf.name}. Say “run ${wf.name}” any time.`); loadSkills(); b.textContent = "Saved as workflow"; }
    catch (err) { b.disabled = false; handleError(err); }
  } } }, icon("repeat", 16), "Save as workflow");
}

function agentRow(j: any, subs: any[]) {
  const t = mate(j.teammateId);
  const st = j.status;
  const skill = j.skillId ? S.skills.find((x) => x.id === j.skillId) : null;
  const wf = j.workflowId ? S.workflows.find((x) => x.id === j.workflowId) : null;
  const status = st === "working" ? (j.tier === "heavy" ? "working · heavy" : "working") : st === "queued" ? (j.dependsOn?.length ? "waiting for another job" : "queued")
    : st === "waiting" ? "needs your OK" : st === "blocked" ? "stuck" : st === "failed" ? "failed"
    : j.how === "skill" || j.how === "workflow" ? `used ${(skill || wf)?.name || j.how} · ${secs(j.durationMs)} · ${money(j.costUsd)}`
    : `${j.how === "repaired" ? "fixed a skill · " : ""}${j.escalated ? "escalated · " : ""}${secs(j.durationMs)} · ${money(j.costUsd)}`;
  const canSave = st === "done" && (j.how === "fresh" || j.how === "repaired") && !(j.did || []).some((d: any) => d.kind === "skill");
  return h("div", { class: `agent ${st}` },
    h("div", { class: "agentline" }, face(t, 30, st === "working" ? "working" : st === "queued" ? "thinking" : st === "waiting" ? "waiting" : st === "blocked" ? "blocked" : "idle"),
      h("span", { class: "grow" }, h("b", null, t.name), h("small", null, status)),
      st === "working" || st === "queued" ? h("i", { class: "spin" }) : st === "done" ? h("span", { class: "ok" }, icon("check", 14)) : null),
    h("div", { class: "agenttask" }, j.task),
    subs.length ? h("div", { class: "subs" }, subs.map((x: any) => h("div", { class: "sub" }, face(mate(x.teammateId), 16, x.status === "working" ? "working" : "idle"), h("span", null, x.task), x.status === "done" ? icon("check", 12) : h("i", { class: "spin small" })))) : null,
    canSave ? h("button", { class: "link", on: { click: async (e: Event) => {
      const b = e.currentTarget as HTMLButtonElement; b.disabled = true; b.textContent = "Saving…";
      try { const sk = await call(`/api/jobs/${j.id}/save-skill`, { body: {} }); toast(`Saved skill ${sk.name}`); b.textContent = "Saved as skill"; loadSkills(); }
      catch (err) { b.disabled = false; b.textContent = "Save as skill"; handleError(err); }
    } } }, "Save as skill") : null);
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
    const box = document.getElementById("composer") as HTMLTextAreaElement;
    box.placeholder = "Transcribing…";
    try {
      const hub = activeHub()!;
      const res = await fetch(hub.url + "/api/transcribe", { method: "POST", headers: { Authorization: `Bearer ${hub.token}`, "Content-Type": blob.type }, body: blob });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Transcription failed");
      if (data.text) send(data.text); else toast("I didn't catch that", "err");
    } catch (e) { handleError(e); }
    finally { box.placeholder = "Ramble. I'll sort it out."; }
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
      item("chat", "Talk to Hearth", "The main conversation", () => { location.hash = "#hearth"; }),
      item("bell", "Plans", "Reminders, routines, watches", openPlans),
      item("brain", "Memory", "What I know about you", openMemory),
      item("users", "Teammates", "Who the orchestrator can hand work to", openTeammates),
      item("sparkle", "Skills", "What the team already knows how to do", openSkills),
      item("brain", "Brains", "Which harness and model does what", openBrains),
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
