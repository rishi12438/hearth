import { h, clear, icon, richText, relTime, shortAgo, clockTime, dayLabel, greeting, toast } from "./dom.ts";
import { activeHub, call, hubs, pair, removeHub, setActive, stream, normalizeUrl, ApiError, type HubRef } from "./api.ts";

declare const __BUILD__: string;

type Tab = "today" | "chat" | "plans" | "memory" | "you";
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "today", label: "Today", icon: "sun" },
  { id: "chat", label: "Chat", icon: "chat" },
  { id: "plans", label: "Plans", icon: "bell" },
  { id: "memory", label: "Memory", icon: "brain" },
  { id: "you", label: "You", icon: "user" },
];

const S = {
  tab: "today" as Tab,
  state: null as any,
  today: null as any,
  messages: [] as any[],
  hooks: [] as any[],
  memory: null as any,
  memoryQuery: "",
  plansFilter: "",
  conn: "connecting" as "live" | "connecting" | "offline",
  thinking: false,
  updateReady: false,
  sheetOpen: false,
  hasOlder: true,
};

let live: ReturnType<typeof stream> | null = null;
const app = document.getElementById("app")!;

// ---------------- boot ----------------

async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  const pairCode = new URLSearchParams(location.hash.slice(1)).get("pair");
  if (!activeHub() || pairCode) return renderPairing(pairCode || "");
  S.tab = (TABS.find((t) => `#${t.id}` === location.hash)?.id) || "today";
  renderShell();
  await refreshState();
  connect();
  if (localStorage.getItem("hearth.autoLocation") === "1") shareLocation(true);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { checkForUpdate(); refreshView(); live?.restart(); } });
  setInterval(checkForUpdate, 5 * 60_000);
  window.addEventListener("hashchange", () => { const t = TABS.find((x) => `#${x.id}` === location.hash); if (t) go(t.id); });
  setInterval(() => { if (S.tab === "today" || S.tab === "plans") renderView(); }, 60_000); // keep "in 5 min" honest
}

function connect() {
  live?.stop();
  live = stream((e) => onEvent(e), (s) => { S.conn = s; renderTopbar(); if (s === "live") refreshView(); });
}

function onEvent(e: { type: string; data?: any }) {
  switch (e.type) {
    case "hello": if (e.data?.build && e.data.build !== __BUILD__) markUpdate(); S.thinking = !!e.data?.thinking; break;
    case "unpaired": toast("This device was signed out of the hub.", "err"); removeHub(activeHub()!.id); location.reload(); return;
    case "message":
      if (!S.messages.some((m) => m.id === e.data.id)) S.messages.push(e.data);
      if (S.tab === "chat") renderChat(true); else if (e.data.role === "assistant") badge("chat", true);
      if (e.data.proactive) refreshToday();
      return;
    case "thinking": S.thinking = !!e.data; if (S.tab === "chat") renderChat(true); renderTopbar(); return;
    case "hooks": loadHooks(); refreshToday(); return;
    case "memory": if (S.tab === "memory") loadMemory(); return;
    case "scripts": refreshState(); return;
    case "activity": if (S.tab === "today") refreshToday(); return;
    case "reset": refreshView(); return;
  }
}

async function refreshState() {
  try { S.state = await call("/api/state"); renderTopbar(); if (S.tab === "you" || S.tab === "today") renderView(); }
  catch (err) { handleError(err); }
}

function handleError(err: unknown) {
  if (err instanceof ApiError && err.status === 401) {
    toast("This device isn't paired with the hub any more.", "err");
    removeHub(activeHub()!.id);
    setTimeout(() => location.reload(), 1200);
    return;
  }
  if (err instanceof TypeError) { S.conn = "offline"; renderTopbar(); return; }
  toast(err instanceof Error ? err.message : "Something went wrong", "err");
}

// ---------------- updates (like the Enkidu phone app: reload when idle) ----------------

async function checkForUpdate() {
  try {
    const hub = activeHub();
    if (!hub) return;
    const r = await fetch(hub.url + "/api/health", { cache: "no-store" }).then((r) => r.json());
    if (r.build && r.build !== __BUILD__) markUpdate();
  } catch {}
}

function markUpdate() {
  const busy = S.sheetOpen || !!(document.getElementById("composer") as HTMLTextAreaElement | null)?.value.trim();
  if (!busy && hubs().length && activeHub()!.url === location.origin) { location.reload(); return; }
  S.updateReady = true;
  renderTopbar();
}

// ---------------- shell ----------------

function renderShell() {
  clear(app,
    h("header", { class: "topbar", id: "topbar" }),
    h("main", { id: "view", class: "view" }),
    h("nav", { class: "tabs", id: "tabs" }, TABS.map((t) =>
      h("button", { class: `tab ${S.tab === t.id ? "on" : ""}`, "data-tab": t.id, "aria-label": t.label, on: { click: () => go(t.id) } },
        icon(t.icon, 22), h("span", null, t.label), h("i", { class: "dot" })),
    )),
  );
  renderTopbar();
  renderView();
}

function go(tab: Tab) {
  if (S.tab === tab) { document.getElementById("view")!.scrollTo({ top: 0, behavior: "smooth" }); return; }
  S.tab = tab;
  history.replaceState(null, "", `#${tab}`);
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("on", (b as HTMLElement).dataset.tab === tab));
  badge(tab, false);
  renderView();
  refreshView();
}

function badge(tab: Tab, on: boolean) {
  document.querySelector(`.tab[data-tab="${tab}"]`)?.classList.toggle("badge", on);
}

function renderTopbar() {
  const bar = document.getElementById("topbar");
  if (!bar) return;
  const hub = activeHub();
  const label = S.conn === "live" ? (S.thinking ? "Thinking…" : "Connected") : S.conn === "connecting" ? "Connecting…" : "Hub offline";
  clear(bar,
    h("button", { class: "hubpill", on: { click: openHubs }, "aria-label": "Switch hub" },
      h("i", { class: `status ${S.conn} ${S.thinking ? "thinking" : ""}` }),
      h("span", { class: "hubname" }, S.state?.hub?.name || hub?.name || "Hub"),
      icon("chevron", 14)),
    S.updateReady ? h("button", { class: "update", on: { click: () => location.reload() } }, "Update ready") : h("span", { class: "connlabel" }, label),
  );
}

function refreshView() {
  if (S.tab === "today") refreshToday();
  else if (S.tab === "chat") loadMessages();
  else if (S.tab === "plans") loadHooks();
  else if (S.tab === "memory") loadMemory();
  else refreshState();
}

function renderView() {
  const v = document.getElementById("view");
  if (!v) return;
  v.className = `view view-${S.tab}`;
  if (S.tab === "today") renderToday();
  else if (S.tab === "chat") renderChat();
  else if (S.tab === "plans") renderPlans();
  else if (S.tab === "memory") renderMemory();
  else renderYou();
}

// ---------------- sheets ----------------

function openSheet(title: string, body: Node | (Node | null)[], opts: { onClose?: () => void } = {}) {
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

// ---------------- pairing ----------------

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

// ---------------- Today ----------------

async function refreshToday() {
  try { S.today = await call("/api/today"); if (S.tab === "today") renderToday(); } catch (e) { handleError(e); }
}

function hookIcon(hk: any) {
  const t = hk.trigger?.type;
  return t === "at" ? (hk.trigger.repeat !== "none" ? "repeat" : "clock") : t === "schedule" ? "repeat" : t === "place" ? "pin" : t === "silence" ? "moon" : "eye";
}

function renderToday() {
  const v = document.getElementById("view")!;
  const t = S.today;
  const name = S.state?.prefs?.userName;
  const date = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  if (!t) return clear(v, h("div", { class: "hero" }, h("h1", null, greeting(name)), h("p", { class: "muted" }, date)), skeleton(3));
  const [next, ...rest] = t.upcoming;
  const pending = S.state?.pendingScripts || 0;
  clear(v,
    h("div", { class: "hero" },
      h("h1", null, greeting(name)),
      h("p", { class: "muted" }, date, t.upcoming.length ? ` · ${t.upcoming.length} coming up` : "", t.watching.length ? ` · watching ${t.watching.length}` : "")),
    pending ? h("button", { class: "banner", on: { click: openScripts } }, icon("code", 18), h("span", null, `${pending} script${pending > 1 ? "s" : ""} waiting for your approval`), icon("chevron", 16)) : null,
    next
      ? h("button", { class: "nextup", on: { click: () => openHook(next) } },
          h("div", { class: "eyebrow" }, "Next up"),
          h("div", { class: "nexttitle" }, next.title),
          h("div", { class: "nextwhen" }, icon(hookIcon(next), 16), `${dayLabel(next.nextAt)} ${clockTime(next.nextAt)} · ${relTime(next.nextAt)}`),
          next.why ? h("div", { class: "nextwhy" }, next.why) : null)
      : null,
    h("button", { class: "askbar", on: { click: () => { go("chat"); setTimeout(() => document.getElementById("composer")?.focus(), 50); } } },
      icon("sparkle", 18), h("span", null, "Ask, or tell me something to remember…")),
    !next && !t.proactive.length && !t.watching.length ? starter() : null,
    rest.length ? section("Coming up", h("div", { class: "list" }, rest.map((hk: any) =>
      h("button", { class: "item", on: { click: () => openHook(hk) } },
        h("div", { class: "time" }, h("b", null, clockTime(hk.nextAt)), h("small", null, dayLabel(hk.nextAt))),
        h("div", { class: "grow" }, h("div", { class: "title" }, hk.title), h("div", { class: "sub" }, hk.trigger.type === "at" ? (hk.trigger.repeat === "none" ? hk.why : hk.when) : hk.when)))))) : null,
    t.watching.length ? section("Watching for you", h("div", { class: "chips" }, t.watching.map((hk: any) =>
      h("button", { class: "chip", on: { click: () => openHook(hk) } }, icon(hookIcon(hk), 15), hk.title)))) : null,
    t.proactive.length ? section("I reached out", h("div", { class: "list" }, t.proactive.map((m: any) =>
      h("button", { class: "item reached", on: { click: () => go("chat") } },
        h("div", { class: "grow" },
          h("div", { class: "title" }, m.proactive.title, h("small", { class: "when" }, ` · ${relTime(m.createdAt)}`)),
          h("div", { class: "sub clamp" }, m.text),
          h("div", { class: "why" }, "Why: ", m.proactive.why)))))) : null,
    t.activity.length ? section("On your hub", h("div", { class: "activity" }, t.activity.slice(0, 6).map((a: any) =>
      h("div", { class: "act" }, h("span", { class: "acttime" }, shortAgo(a.createdAt)), h("span", null, a.text)))),
      h("button", { class: "link", on: { click: openActivity } }, "See everything")) : null,
  );
}

function starter() {
  const ideas = [
    ["clock", "Remind me at 6pm to call mom"],
    ["repeat", "Every weekday at 8, give me a short brief"],
    ["brain", "Remember my sister's birthday is 12 December"],
    ["eye", "Check the weather every morning and tell me if it'll rain"],
  ];
  return section("Try saying", h("div", { class: "ideas" }, ideas.map(([ic, text]) =>
    h("button", { class: "idea", on: { click: () => sendFromIdea(text) } }, icon(ic, 18), h("span", null, text)))));
}

function sendFromIdea(text: string) {
  go("chat");
  setTimeout(() => { const c = document.getElementById("composer") as HTMLTextAreaElement; if (c) { c.value = text; c.dispatchEvent(new Event("input")); c.focus(); } }, 60);
}

function section(title: string, ...body: any[]) {
  return h("section", { class: "section" }, h("h3", null, title), ...body);
}

function skeleton(n: number) {
  return h("div", { class: "list" }, Array.from({ length: n }, () => h("div", { class: "item skel" }, h("div", { class: "bar" }), h("div", { class: "bar short" }))));
}

// ---------------- Chat ----------------

async function loadMessages() {
  try { S.messages = await call("/api/messages?limit=60"); S.hasOlder = S.messages.length >= 60; if (S.tab === "chat") renderChat(); } catch (e) { handleError(e); }
}

async function loadOlder() {
  if (!S.hasOlder || !S.messages.length) return;
  const older = await call(`/api/messages?limit=40&before=${encodeURIComponent(S.messages[0].createdAt)}`);
  S.hasOlder = older.length >= 40;
  const list = document.getElementById("messages");
  const prev = list ? list.scrollHeight : 0;
  S.messages = [...older, ...S.messages];
  renderChat();
  if (list) { const l = document.getElementById("messages")!; l.scrollTop = l.scrollHeight - prev; }
}

function renderChat(keepComposer = false) {
  const v = document.getElementById("view")!;
  let composer = document.getElementById("composer") as HTMLTextAreaElement | null;
  const draft = composer?.value ?? sessionStorage.getItem("hearth.draft") ?? "";
  const list = h("div", { class: "messages", id: "messages", on: { scroll: (e: Event) => { if ((e.target as HTMLElement).scrollTop < 40) loadOlder(); } } });
  let lastDay = "";
  if (!S.messages.length) {
    list.appendChild(h("div", { class: "emptychat" },
      h("img", { src: "/icon.svg", alt: "", width: 56, height: 56 }),
      h("h2", null, "What's on your mind?"),
      h("p", { class: "muted" }, "I can remind you, remember things, keep watch, and check in when it matters."),
      h("div", { class: "ideas" }, ["Remind me in 10 minutes to stretch", "Remember I don't take meetings before 10", "Every Sunday at 7pm, help me plan the week"].map((t) =>
        h("button", { class: "idea small", on: { click: () => send(t) } }, t)))));
  }
  for (const m of S.messages) {
    const day = new Date(m.createdAt).toDateString();
    if (day !== lastDay) { list.appendChild(h("div", { class: "daysep" }, dayLabel(m.createdAt))); lastDay = day; }
    list.appendChild(bubble(m));
  }
  if (S.thinking) list.appendChild(h("div", { class: "msg assistant typing" }, h("div", { class: "bubble" }, h("i"), h("i"), h("i"))));

  if (!keepComposer || !composer) {
    composer = h("textarea", { id: "composer", class: "composer", rows: 1, placeholder: S.conn === "offline" ? "Hub is offline" : "Message", value: draft, enterKeyHint: "send",
      on: {
        input: () => { autosize(composer!); sessionStorage.setItem("hearth.draft", composer!.value); },
        keydown: (e: KeyboardEvent) => { if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer: coarse)").matches) { e.preventDefault(); send(composer!.value); } },
      } });
    const sendBtn = h("button", { class: "sendbtn", "aria-label": "Send", on: { click: () => send(composer!.value) } }, icon("send", 20));
    clear(v, list, h("div", { class: "composerbar" }, composer, sendBtn));
    autosize(composer);
  } else {
    v.replaceChild(list, document.getElementById("messages")!);
  }
  requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
}

function autosize(t: HTMLTextAreaElement) { t.style.height = "auto"; t.style.height = Math.min(160, t.scrollHeight) + "px"; }

function bubble(m: any) {
  const isUser = m.role === "user";
  const parts: Node[] = [];
  if (m.proactive) {
    const why = h("div", { class: "whybox", hidden: true },
      h("div", null, h("b", null, "Why I messaged: "), m.proactive.why),
      h("div", null, h("b", null, "Trigger: "), m.proactive.trigger));
    parts.push(h("div", { class: "prohead" }, icon("bell", 14), h("span", null, m.proactive.title),
      h("button", { class: "whybtn", on: { click: () => { why.hidden = !why.hidden; } } }, "Why?")), why);
  }
  parts.push(isUser ? h("div", { class: "plain" }, m.text) : richText(m.text));
  if (m.did?.length) parts.push(h("div", { class: "did" }, m.did.map((d: any) => h("span", { class: `didchip ${d.kind}` }, icon(d.kind === "memory" ? "brain" : d.kind === "script" ? "code" : d.kind === "place" ? "pin" : "check", 13), d.label))));
  if (m.used?.length) parts.push(h("button", { class: "used", on: { click: () => { go("memory"); } } }, icon("brain", 12), `Used ${m.used.length} memor${m.used.length > 1 ? "ies" : "y"}`));
  return h("div", { class: `msg ${isUser ? "user" : "assistant"} ${m.proactive ? "proactive" : ""} ${m.error ? "err" : ""}` },
    h("div", { class: "bubble" }, parts),
    h("div", { class: "stamp" }, clockTime(m.createdAt)));
}

async function send(text: string) {
  const t = text.trim();
  if (!t) return;
  const c = document.getElementById("composer") as HTMLTextAreaElement | null;
  if (c) { c.value = ""; autosize(c); }
  sessionStorage.removeItem("hearth.draft");
  try {
    const m = await call("/api/messages", { body: { text: t } });
    if (!S.messages.some((x) => x.id === m.id)) S.messages.push(m);
    S.thinking = true;
    renderChat(true);
  } catch (e) {
    if (c) c.value = t;
    handleError(e);
  }
}

// ---------------- Plans (hooks) ----------------

async function loadHooks() {
  try { S.hooks = await call("/api/hooks"); if (S.tab === "plans") renderPlans(); } catch (e) { handleError(e); }
}

function groupOf(hk: any) {
  if (hk.status === "done") return "done";
  const t = hk.trigger.type;
  if (t === "at" && hk.trigger.repeat === "none") return "upcoming";
  if (t === "at" || t === "schedule") return "repeating";
  return "watching";
}

function renderPlans() {
  const v = document.getElementById("view")!;
  const groups: Record<string, any[]> = { upcoming: [], repeating: [], watching: [], done: [] };
  for (const hk of S.hooks) groups[groupOf(hk)].push(hk);
  groups.upcoming.sort((a, b) => (a.nextAt || "").localeCompare(b.nextAt || ""));
  groups.done.sort((a, b) => (b.lastFiredAt || "").localeCompare(a.lastFiredAt || ""));
  const labels: Record<string, string> = { upcoming: "Upcoming", repeating: "Routines", watching: "Watching", done: "Done" };
  const blurbs: Record<string, string> = {
    upcoming: "One-off reminders and follow-ups.",
    repeating: "Things I do on a schedule.",
    watching: "Conditions I keep an eye on, and only speak up when they're met.",
    done: "Finished reminders.",
  };
  if (!S.plansFilter) S.plansFilter = ["upcoming", "repeating", "watching"].find((k) => groups[k].some((x) => x.source !== "system")) || "upcoming";
  const items = groups[S.plansFilter];
  clear(v,
    h("div", { class: "pagehead" },
      h("div", null, h("h1", null, "Plans"), h("p", { class: "muted" }, "When I'll speak up, and why.")),
      h("button", { class: "fab", "aria-label": "New", on: { click: openNewPlan } }, icon("plus", 22))),
    h("div", { class: "segmented" }, Object.keys(groups).map((k) =>
      h("button", { class: S.plansFilter === k ? "on" : "", on: { click: () => { S.plansFilter = k; renderPlans(); } } },
        labels[k], groups[k].length && k !== "done" ? h("small", null, String(groups[k].length)) : null))),
    h("p", { class: "muted small pad" }, blurbs[S.plansFilter]),
    items.length
      ? h("div", { class: "list" }, items.map((hk) => h("button", { class: `item hook ${hk.status}`, on: { click: () => openHook(hk) } },
          h("div", { class: `hicon ${hk.trigger.type}` }, icon(hookIcon(hk), 18)),
          h("div", { class: "grow" },
            h("div", { class: "title" }, hk.title,
              hk.status === "paused" ? h("span", { class: "tag" }, "Paused") : null,
              hk.source === "system" ? h("span", { class: "tag" }, "System") : null,
              hk.source === "assistant" ? h("span", { class: "tag soft" }, "Suggested") : null),
            h("div", { class: "sub" }, hk.status === "done" ? `Done ${hk.lastFiredAt ? relTime(hk.lastFiredAt) : ""}` : hk.nextAt ? `${dayLabel(hk.nextAt)} ${clockTime(hk.nextAt)} · ${hk.when}` : hk.when),
            hk.why ? h("div", { class: "why" }, hk.why) : null))))
      : h("div", { class: "empty" }, h("p", null, S.plansFilter === "watching" ? "Nothing to watch yet. Try: “every 2 hours, check if tickets are on sale and tell me only if they are.”" : "Nothing here yet."),
          h("button", { class: "btn ghost", on: { click: () => sendFromIdea(S.plansFilter === "repeating" ? "Every weekday at 8am, give me a short brief" : "Remind me tomorrow at 9 to ") } }, "Ask in chat")),
  );
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
            toast("Routine added"); closeSheet(); S.plansFilter = "repeating"; loadHooks();
          } catch (e) { handleError(e); }
        } } }, "Add routine"));
    }
  };
  draw();
  openSheet("New plan", body);
}

// ---------------- Memory ----------------

async function loadMemory() {
  try { S.memory = await call(`/api/memory?q=${encodeURIComponent(S.memoryQuery)}`); if (S.tab === "memory") renderMemory(); } catch (e) { handleError(e); }
}

function renderMemory() {
  const v = document.getElementById("view")!;
  const m = S.memory;
  const searchBox = h("div", { class: "search" }, icon("search", 18), h("input", { placeholder: "Search memory", value: S.memoryQuery, type: "search",
    on: { input: debounce((e: Event) => { S.memoryQuery = (e.target as HTMLInputElement).value; loadMemory(); }, 250) } }));
  const head = h("div", { class: "pagehead" },
    h("div", null, h("h1", null, "Memory"), h("p", { class: "muted" }, "What I know about you. Yours to edit or delete.")),
    h("button", { class: "fab", "aria-label": "Add memory", on: { click: () => openFact(null) } }, icon("plus", 22)));
  if (!m) return clear(v, head, searchBox, skeleton(4));
  const core = m.facts.filter((f: any) => f.importance === 3);
  const byBook = new Map<string, any[]>();
  for (const f of m.facts.filter((f: any) => f.importance !== 3)) { if (!byBook.has(f.notebook)) byBook.set(f.notebook, []); byBook.get(f.notebook)!.push(f); }
  const summaries = new Map<string, string>(m.notebooks.map((n: any) => [n.name, n.summary]));
  const focused = document.activeElement?.closest?.(".search");
  clear(v, head, searchBox,
    !m.facts.length ? h("div", { class: "empty" }, h("p", null, S.memoryQuery ? "Nothing matches." : "Nothing yet. Tell me things in chat (“remember I'm vegetarian”) or add them here. I'll also pick up durable facts as we talk.")) : null,
    core.length ? section("Always in mind", h("p", { class: "muted small" }, "Core facts I keep in every conversation."), h("div", { class: "list" }, core.map(factRow))) : null,
    [...byBook.entries()].sort().map(([book, facts]) => section(book[0].toUpperCase() + book.slice(1),
      summaries.get(book) ? h("p", { class: "summary" }, summaries.get(book)!) : null,
      h("div", { class: "list" }, facts.map(factRow)))),
    m.history.length ? h("p", { class: "muted small center" }, `${m.history.length} older version${m.history.length > 1 ? "s" : ""} kept as history. Open a fact to see what changed.`) : null,
  );
  if (focused) { const i = v.querySelector(".search input") as HTMLInputElement; i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
}

function factRow(f: any) {
  const meta = [f.source === "you" ? "You told me" : "Learned in chat", f.useCount ? `used ${f.useCount}×` : null, f.expiresAt ? `until ${dayLabel(f.expiresAt)}` : null].filter(Boolean).join(" · ");
  return h("div", { class: "item fact" },
    h("button", { class: "grow left", on: { click: () => openFact(f) } }, h("div", { class: "title" }, f.fact), h("div", { class: "sub" }, meta)),
    h("button", { class: `star ${f.importance === 3 ? "on" : ""}`, "aria-label": f.importance === 3 ? "Remove from core" : "Keep always in mind",
      on: { click: async () => { await call(`/api/memory/${f.id}`, { method: "PATCH", body: { importance: f.importance === 3 ? 2 : 3 } }); loadMemory(); } } }, icon("star", 18)));
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

// ---------------- You (settings) ----------------

function renderYou() {
  const v = document.getElementById("view")!;
  const st = S.state;
  if (!st) return clear(v, h("div", { class: "pagehead" }, h("h1", null, "You")), skeleton(4));
  const p = st.prefs;
  const pushOk = "PushManager" in window && "serviceWorker" in navigator;
  const autoLoc = localStorage.getItem("hearth.autoLocation") === "1";
  const row = (ic: string, title: string, sub: string | Node | null, on: () => void, extra?: Node | null) =>
    h("button", { class: "row-item", on: { click: on } }, h("span", { class: "ricon" }, icon(ic, 18)), h("span", { class: "grow left" }, h("span", { class: "title" }, title), sub ? h("span", { class: "sub" }, sub) : null), extra || icon("chevron", 16));
  const toggle = (on: boolean) => h("span", { class: `switch ${on ? "on" : ""}` }, h("i"));
  clear(v,
    h("div", { class: "pagehead" }, h("div", null, h("h1", null, p.userName || "You"), h("p", { class: "muted" }, `${p.tz} · paired as ${st.device.name}`))),
    h("div", { class: "hubcard", on: { click: openHubs } },
      h("div", { class: "hubicon" }, icon("server", 22)),
      h("div", { class: "grow" }, h("div", { class: "title" }, st.hub.name), h("div", { class: "sub" }, `Brain: ${st.hub.brain} · Storage: ${st.hub.storage} · v${st.hub.version}`)),
      h("i", { class: `status ${S.conn}` })),
    section("Profile", h("div", { class: "group" },
      row("user", "Name and time zone", `${p.userName || "Not set"} · ${p.tz}`, openProfile))),
    section("Speaking up", h("div", { class: "group" },
      row("bell", "Notifications", st.push.subscribed ? "On for this device" : pushOk ? "Off" : "Add to Home Screen first", () => togglePush(st.push.subscribed), toggle(st.push.subscribed)),
      row("moon", "Quiet hours", `${p.quietStart} – ${p.quietEnd}. Reminders you set still come through.`, openQuiet),
      row("sparkle", "Daily limit", `Up to ${p.maxProactivePerDay} unprompted messages a day (${p.proactiveToday?.n || 0} today)`, openQuiet))),
    section("Location", h("div", { class: "group" },
      row("pin", "Share my location now", "Used for place reminders and “near me”", () => shareLocation(false)),
      row("pin", "Share when I open the app", autoLoc ? "On" : "Off", () => { localStorage.setItem("hearth.autoLocation", autoLoc ? "0" : "1"); if (!autoLoc) shareLocation(false); renderYou(); }, toggle(autoLoc)),
      row("pin", "Places", "Home, office… for arrive/leave hooks", openPlaces))),
    section("Abilities", h("div", { class: "group" },
      row("code", "Scripts", st.pendingScripts ? h("span", { class: "warn" }, `${st.pendingScripts} waiting for approval`) : "What your assistant can run", openScripts))),
    section("Security", h("div", { class: "group" },
      row("phone", "Devices", "Who can talk to this hub", openDevices))),
    section("Your data", h("div", { class: "group" },
      row("download", "Export everything", "One JSON file with all of it", exportData),
      row("eye", "Activity log", "Everything the hub did", openActivity),
      row("trash", "Delete my data", "Wipe chats, memory, plans and places", openWipe))),
    h("p", { class: "muted small center foot" }, "Hearth is open source (MIT). Your data never leaves your hub unless your brain needs it to answer.", h("br"), `app ${__BUILD__} · hub ${st.hub.build}`),
  );
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
      try { await call("/api/wipe", { body: { confirm: "delete my data" } }); toast("Deleted"); closeSheet(); S.messages = []; refreshView(); } catch (e) { handleError(e); }
    } } }, "Delete everything"),
  ]);
}

// ---------------- hubs ----------------

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
