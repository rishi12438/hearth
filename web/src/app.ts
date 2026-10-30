import { h, clear, icon, richText, relTime, shortAgo, clockTime, dayLabel, greeting, toast } from "./dom.ts";
import { activeHub, call, hubs, pair, removeHub, setActive, stream, normalizeUrl, ApiError, type HubRef } from "./api.ts";

declare const __BUILD__: string;

// Home is one big + and your recent chats. In a chat you ramble (type or hold to talk); the orchestrator
// splits it into jobs, hands each to the right teammate, and the job cards tick over as they finish.
// Everything else (plans, memory, teammates, brains, settings) is behind the menu.

const S = {
  state: null as any,
  threads: [] as any[],
  thread: null as any,          // { thread, messages, jobs } when a chat is open
  teammates: [] as any[],
  skills: [] as any[],
  workflows: [] as any[],
  hooks: [] as any[],
  memory: null as any,
  memoryQuery: "",
  plansFilter: "",
  today: null as any,
  conn: "connecting" as "live" | "connecting" | "offline",
  planning: null as null | string, // thread id the orchestrator is reading
  updateReady: false,
  sheetOpen: false,
  panel: null as null | "plans" | "memory" | "skills",
};

let live: ReturnType<typeof stream> | null = null;
const app = document.getElementById("app")!;
const route = () => { const m = location.hash.match(/^#chat\/([\w-]+)/); return m ? m[1] : null; };

// ---------------- boot ----------------

async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  const pairCode = new URLSearchParams(location.hash.slice(1)).get("pair");
  if (!activeHub() || pairCode) return renderPairing(pairCode || "");
  await Promise.all([refreshState(), loadTeammates(), loadSkills()]);
  await show();
  connect();
  if (localStorage.getItem("hearth.autoLocation") === "1") shareLocation(true);
  window.addEventListener("hashchange", show);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { checkForUpdate(); refresh(); live?.restart(); } });
  setInterval(checkForUpdate, 5 * 60_000);
}

async function show() {
  const id = route();
  if (id) { S.thread = null; renderChat(); await loadThread(id); }
  else { S.thread = null; renderHome(); await loadThreads(); }
}

function refresh() { const id = route(); if (id) loadThread(id); else loadThreads(); }

function connect() {
  live?.stop();
  live = stream(onEvent, (s) => { S.conn = s; renderTop(); });
}

function onEvent(e: { type: string; data?: any }) {
  const open = S.thread?.thread?.id;
  switch (e.type) {
    case "hello": if (e.data?.build && e.data.build !== __BUILD__) markUpdate(); return;
    case "unpaired": toast("This device was signed out of the hub.", "err"); removeHub(activeHub()!.id); location.reload(); return;
    case "thinking": S.planning = e.data?.threadId || null; if (open) renderMessages(); return;
    case "message":
      if (open && e.data.threadId === open) { if (!S.thread.messages.some((m: any) => m.id === e.data.id)) S.thread.messages.push(e.data); renderMessages(); }
      else if (!open) loadThreads();
      else if (e.data.proactive) toast(`${e.data.proactive.title}`);
      return;
    case "job":
      if (open && e.data.threadId === open) {
        const i = S.thread.jobs.findIndex((j: any) => j.id === e.data.id);
        if (i >= 0) S.thread.jobs[i] = e.data; else S.thread.jobs.push(e.data);
        renderMessages(false);
      }
      return;
    case "threads":
      if (!open) loadThreads();
      else call("/api/threads").then((list: any[]) => { const t = list.find((x) => x.id === open); if (t && S.thread) { S.thread.thread.title = t.title; renderTop(); } }).catch(() => {});
      return;
    case "teammates": loadTeammates(); return;
    case "skills": loadSkills(); return;
    case "approval":
      if (open && e.data.threadId === open) {
        const list = S.thread.approvals || (S.thread.approvals = []);
        const i = list.findIndex((a: any) => a.id === e.data.id);
        if (i >= 0) list[i] = e.data; else list.push(e.data);
        renderMessages(false);
      } else if (e.data.status === "pending") toast(`Needs your OK: ${e.data.summary}`);
      return;
    case "hooks": if (S.panel === "plans") loadHooks(); return;
    case "memory": if (S.panel === "memory") loadMemory(); return;
    case "scripts": refreshState(); return;
    case "reset": refresh(); return;
  }
}

async function refreshState() {
  try { S.state = await call("/api/state"); renderTop(); } catch (e) { handleError(e); }
}

async function loadSkills() {
  try { const r = await call("/api/skills"); S.skills = r.skills; S.workflows = r.workflows; if (S.panel === ("skills" as any)) drawSkills(); } catch {}
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
  if (err instanceof TypeError) { S.conn = "offline"; renderTop(); return; }
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
  renderTop();
}

const mate = (id?: string) => S.teammates.find((t) => t.id === (id || "hearth")) || { id: "hearth", name: "Hearth", color: "#F5A524", description: "" };

function dot(t: any, size = 44) {
  return h("span", { class: "dot", style: `--c:${t.color};--s:${size}px` }, t.name[0]);
}

// ---------------- top bar ----------------

function renderTop() {
  const top = document.getElementById("top");
  if (!top) return;
  const pending = S.state?.pendingScripts || 0;
  const inChat = !!route();
  clear(top,
    inChat
      ? h("button", { class: "iconbtn", "aria-label": "Back", on: { click: () => { location.hash = ""; } } }, icon("back", 22))
      : h("button", { class: "iconbtn menu", "aria-label": "Menu", on: { click: openMenu } }, icon("menu", 22), pending ? h("i", { class: "badge" }) : null),
    h("button", { class: "title", on: { click: inChat ? () => {} : openHubs } },
      h("i", { class: `status ${S.conn}` }), h("span", null, inChat ? (S.thread?.thread?.title || "…") : (S.state?.hub?.name || activeHub()?.name || "Hearth"))),
    S.updateReady ? h("button", { class: "pill", on: { click: () => location.reload() } }, "Update")
      : inChat ? h("button", { class: "iconbtn", "aria-label": "Chat options", on: { click: chatMenu } }, icon("more", 20)) : h("span", { class: "iconbtn" }),
  );
}

// ---------------- home ----------------

async function loadThreads() {
  try { S.threads = await call("/api/threads"); if (!route()) drawThreads(); } catch (e) { handleError(e); }
}

function renderHome() {
  clear(app,
    h("header", { class: "top", id: "top" }),
    h("main", { class: "home" },
      h("div", { class: "hero" },
        h("h1", null, greeting(S.state?.prefs?.userName)),
        h("p", null, "Just ramble. I'll sort out who does what."),
        h("button", { class: "bigplus", "aria-label": "New ramble", on: { click: newRamble } }, icon("plus", 40)),
        h("div", { class: "team" }, S.teammates.slice(0, 6).map((t) => dot(t, 26)), h("small", null, `${S.teammates.length} teammates ready`))),
      h("section", { class: "recent", id: "recent" })),
  );
  renderTop();
  drawThreads();
}

function drawThreads() {
  const el = document.getElementById("recent");
  if (!el) return;
  if (!S.threads.length) return clear(el);
  clear(el, h("h3", null, "Recent"), h("div", { class: "threads" }, S.threads.slice(0, 30).map((t) =>
    h("button", { class: "thread-row", on: { click: () => { location.hash = `#chat/${t.id}`; } } },
      h("span", { class: "grow" }, h("b", null, t.title), t.preview ? h("small", null, t.preview) : null),
      h("time", null, shortAgo(t.updatedAt))))));
}

function newRamble() {
  location.hash = "#chat/new";
}

// ---------------- chat ----------------

async function loadThread(id: string) {
  if (id === "new") { S.thread = { thread: { id: "new", title: "New ramble" }, messages: [], jobs: [] }; renderTop(); renderMessages(); setTimeout(() => document.getElementById("composer")?.focus(), 80); return; }
  try { S.thread = await call(`/api/threads/${id}`); renderTop(); renderMessages(); }
  catch (e) { if (e instanceof ApiError && e.status === 404) { location.hash = ""; return; } handleError(e); }
}

function renderChat() {
  clear(app,
    h("header", { class: "top", id: "top" }),
    h("main", { class: "thread", id: "thread" }),
    h("footer", { class: "dock" }, h("div", { class: "composer-wrap", id: "composerwrap" })),
  );
  renderTop();
  renderComposer();
}

function renderMessages(stick = true) {
  const el = document.getElementById("thread");
  if (!el || !S.thread) return;
  const { messages, jobs } = S.thread;
  if (!messages.length) {
    clear(el, h("div", { class: "hello" },
      h("h2", null, "What's on your mind?"),
      h("p", null, "Say it however it comes out. Several things at once is fine."),
      h("div", { class: "starters" }, [
        "Remind me at 6 to call mom, and find somewhere cheap for dinner tonight",
        "I want to get to the gym 3 times a week, nag me if I don't",
        "Rent's due on the 1st, remind me 3 days before every month",
      ].map((s) => h("button", { on: { click: () => send(s) } }, s)))));
    return;
  }
  const nodes: Node[] = [];
  let lastDay = "";
  for (const m of messages) {
    const day = new Date(m.createdAt).toDateString();
    if (day !== lastDay) { nodes.push(h("div", { class: "day" }, dayLabel(m.createdAt))); lastDay = day; }
    nodes.push(message(m, jobs));
  }
  if (S.planning === S.thread.thread.id) nodes.push(h("div", { class: "msg bot" }, h("div", { class: "who" }, dot(mate("hearth"), 18), h("b", null, "Hearth")), h("div", { class: "thinking" }, h("i"), h("i"), h("i"), h("span", null, "Sorting out who does what…"))));
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  clear(el, nodes);
  if (stick || atBottom) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}

function message(m: any, jobs: any[]) {
  if (m.role === "user") return h("div", { class: "msg me" }, h("div", { class: "bubble" }, m.text), h("time", null, clockTime(m.createdAt)));
  const t = mate(m.teammateId);
  const parts: (Node | null)[] = [
    h("div", { class: "who" }, dot(t, 18), h("b", null, t.name), m.proactive ? h("span", { class: "tag" }, icon("bell", 11), m.proactive.title) : null, h("time", null, clockTime(m.createdAt))),
    richText(m.text),
  ];
  if (m.proactive) {
    const why = h("div", { class: "why", hidden: true }, m.proactive.why, h("br"), h("small", null, `Trigger: ${m.proactive.trigger}`));
    parts.push(h("button", { class: "whybtn", on: { click: () => { why.hidden = !why.hidden; } } }, "Why did I get this?"), why);
  }
  const mine = (m.jobIds || []).map((id: string) => jobs.find((j) => j.id === id)).filter(Boolean);
  if (mine.length) parts.push(h("div", { class: "cards" }, mine.map(jobCard)));
  if (m.did?.length) parts.push(h("div", { class: "chips" }, m.did.map((d: any) => h("span", { class: "chip" }, icon("check", 12), d.label))));
  return h("div", { class: `msg bot ${m.error ? "err" : ""}` }, parts);
}

function secs(ms?: number) {
  if (!ms) return "";
  return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.round(ms / 60_000)}m`;
}

function money(c: number | null | undefined) {
  return c === null || c === undefined ? "$?" : c === 0 ? "$0" : c < 0.01 ? "<$0.01" : `$${c.toFixed(2)}`;
}

function jobCard(j: any) {
  const t = mate(j.teammateId);
  const st = j.status;
  const state = st === "done" ? h("span", { class: "st done" }, icon("check", 14))
    : st === "failed" ? h("span", { class: "st failed" }, icon("x", 14))
    : st === "waiting" ? h("span", { class: "st waiting" }, icon("lock", 13))
    : st === "blocked" ? h("span", { class: "st blocked" }, icon("pause", 13))
    : h("span", { class: `st ${st}` }, h("i"));
  const label = st === "queued" ? "queued" : st === "working" ? (j.tier === "heavy" ? "working (heavy)…" : "working…")
    : st === "waiting" ? "needs your OK" : st === "blocked" ? "stuck, needs you" : j.escalated ? "escalated to heavy" : "";
  const approvals = (S.thread?.approvals || []).filter((a: any) => a.jobId === j.id);
  const skill = j.skillId ? S.skills.find((x) => x.id === j.skillId) : null;
  const wf = j.workflowId ? S.workflows.find((x) => x.id === j.workflowId) : null;
  const savedSkill = (j.did || []).some((d: any) => d.kind === "skill");
  const meta = st === "done" || st === "failed" || st === "waiting" ? (
    j.how === "skill" || j.how === "workflow"
      ? `Used ${j.how} ${(skill || wf)?.name || ""} · ${secs(j.durationMs)} · ${money(j.costUsd)}`
      : j.how === "repaired" ? `Skill failed, worked it out · ${secs(j.durationMs)} · ${money(j.costUsd)}`
      : `Worked it out · ${secs(j.durationMs)} · ${money(j.costUsd)}`) : "";
  return h("div", { class: `card ${st}` },
    h("div", { class: "cardhead" }, dot(t, 22), h("span", { class: "grow" }, h("b", null, t.name), label ? h("em", null, label) : null), state),
    h("div", { class: "task" }, j.task),
    j.result && st !== "working" ? h("div", { class: "result" }, richText(j.result)) : null,
    j.blocked ? h("div", { class: "blocked" },
      h("b", null, j.blocked.need), j.blocked.why ? h("p", null, j.blocked.why) : null, h("p", { class: "unblock" }, icon("chevron", 14), j.blocked.unblock),
      h("button", { class: "btn primary small", on: { click: async () => { try { await call(`/api/jobs/${j.id}/retry`, { body: {} }); } catch (e) { handleError(e); } } } }, "Try again")) : null,
    approvals.map(approvalBox),
    j.did?.length ? h("div", { class: "chips" }, j.did.filter((d: any) => d.kind !== "approval" && d.kind !== "blocked").map((d: any) => h("span", { class: "chip" }, icon(d.kind === "skill" ? "sparkle" : d.kind === "blocked" ? "pause" : "check", 12), d.label))) : null,
    meta ? h("div", { class: "meta" }, h("span", null, meta),
      st === "done" && (j.how === "fresh" || j.how === "repaired") && !savedSkill
        ? h("button", { class: "link", on: { click: async (e: Event) => {
            const b = e.currentTarget as HTMLButtonElement; b.disabled = true; b.textContent = "Saving…";
            try { const sk = await call(`/api/jobs/${j.id}/save-skill`, { body: {} }); toast(`Saved skill ${sk.name}`); b.textContent = "Saved"; loadSkills(); }
            catch (err) { b.disabled = false; b.textContent = "Save as skill?"; handleError(err); }
          } } }, "Save as skill?") : null) : null);
}

function approvalBox(a: any) {
  const decide = async (yes: boolean) => { try { await call(`/api/approvals/${a.id}/${yes ? "approve" : "reject"}`, { body: {} }); } catch (e) { handleError(e); } };
  return h("div", { class: `approval ${a.status}` },
    h("div", { class: "aphead" }, icon("lock", 14), h("b", null, a.summary)),
    a.details ? h("p", null, a.details) : null,
    h("small", null, `Runs ${a.action.script}${a.action.args.length ? ` ${a.action.args.join(" ")}` : ""}`),
    a.status === "pending"
      ? h("div", { class: "apbtns" }, h("button", { class: "btn ghost small", on: { click: () => decide(false) } }, "No"), h("button", { class: "btn primary small", on: { click: () => decide(true) } }, "Approve"))
      : h("div", { class: "apdone" }, a.status === "done" ? "Approved and done" : a.status === "failed" ? `Approved, but it failed: ${a.result || ""}` : a.status === "rejected" ? "You said no" : "Running…"));
}

function chatMenu() {
  const t = S.thread?.thread;
  if (!t || t.id === "new") return;
  openSheet(t.title, [
    h("div", { class: "stack" },
      h("button", { class: "btn danger-ghost", on: { click: () => confirmSheet("Delete this chat?", "Its messages and job results are deleted. Reminders it set keep working.", "Delete", async () => { await call(`/api/threads/${t.id}`, { method: "DELETE" }); location.hash = ""; }) } }, icon("trash", 16), "Delete chat")),
  ]);
}

// ---------------- composer & voice ----------------

let recording = false;
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let pressAt = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function renderComposer() {
  const wrap = document.getElementById("composerwrap");
  if (!wrap) return;
  const box = h("textarea", { id: "composer", rows: 1, value: sessionStorage.getItem("hearth.draft") || "", placeholder: S.conn === "offline" ? "Hub is offline" : "Ramble. I'll sort it out.", enterKeyHint: "send",
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

async function send(text: string) {
  const t = text.trim();
  if (!t || !S.thread) return;
  const box = document.getElementById("composer") as HTMLTextAreaElement | null;
  if (box) { box.value = ""; box.dispatchEvent(new Event("input")); }
  sessionStorage.removeItem("hearth.draft");
  const id = S.thread.thread.id;
  try {
    const r = id === "new" ? await call("/api/threads", { body: { text: t } }) : await call(`/api/threads/${id}/messages`, { body: { text: t } });
    if (id === "new") {
      S.thread = { thread: r.thread, messages: [r.message], jobs: [] };
      history.replaceState(null, "", `#chat/${r.thread.id}`);
      renderTop();
    } else if (!S.thread.messages.some((m: any) => m.id === r.message.id)) S.thread.messages.push(r.message);
    S.planning = r.thread.id;
    renderMessages();
  } catch (e) {
    if (box) { box.value = t; box.dispatchEvent(new Event("input")); }
    handleError(e);
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
      dot(t, 34), h("span", { class: "grow" }, h("b", null, t.name), h("small", { class: "sub" }, t.description)),
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
    S.skills.length ? h("div", { class: "list" }, S.skills.map((sk) => h("button", { class: "item", on: { click: () => openSkill(sk) } },
      h("span", { class: "hicon" }, icon(sk.kind === "script" ? "code" : "sparkle", 16)),
      h("span", { class: "grow" },
        h("b", null, sk.name, sk.status === "proposed" ? h("span", { class: "tag" }, "needs approval") : null),
        h("small", { class: "sub" }, sk.description),
        h("small", { class: "sub" }, [`${sk.runs} use${sk.runs === 1 ? "" : "s"}`, sk.lastUsedAt ? `last ${shortAgo(sk.lastUsedAt)}` : null, sk.lastFixedAt ? `fixed ${shortAgo(sk.lastFixedAt)}` : null, sk.avgMs ? `~${secs(sk.avgMs)}` : null].filter(Boolean).join(" · "))))))
      : h("p", { class: "empty" }, "No skills yet. They appear as your team finishes jobs."),
    wfs.length ? [h("h4", null, "Workflows"), h("div", { class: "list" }, wfs.map((w) => h("div", { class: "item" },
      h("span", { class: "grow" }, h("b", null, w.name, w.status === "proposed" ? h("span", { class: "tag" }, "proposed") : null),
        h("small", { class: "sub" }, w.description), h("small", { class: "sub" }, w.steps.map((x: any) => x.skill).join(" → "))),
      w.status === "proposed" ? h("button", { class: "btn small primary", on: { click: async () => { await call(`/api/workflows/${w.id}/activate`, { body: {} }); toast("Switched on"); } } }, "Switch on") : null,
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
    h("span", { class: "dotwrap" }, dot(mate(hk.teammateId), 30)),
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
