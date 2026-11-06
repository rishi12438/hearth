import { test, expect, afterAll } from "bun:test";
import { chromePath, sendInPage } from "../src/browser.ts";
import { badChatLink, webSender } from "../src/connectors/web-senders.ts";

// A stand-in chat page: a message box and a Send button that adds the message to the conversation.
const page = (sendsOn: "button" | "enter") => `<!doctype html><html><body>
<div id="log"><p>Earlier message</p></div>
<div role="textbox" contenteditable="true" id="box" style="min-height:20px;border:1px solid"></div>
<button id="send" ${sendsOn === "enter" ? "style=display:none" : ""}>Send</button>
<script>
  const box = document.getElementById("box"), log = document.getElementById("log");
  const go = () => { const t = box.innerText.trim(); if (!t) return; const p = document.createElement("p"); p.innerText = t; log.append(p); box.innerHTML = ""; };
  document.getElementById("send").onclick = go;
  box.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go(); } });
</script></body></html>`;
const server = Bun.serve({ port: 0, fetch: (req) => new Response(page(new URL(req.url).pathname.includes("enter") ? "enter" : "button"), { headers: { "Content-Type": "text/html" } }) });
afterAll(() => server.stop(true));
const opts = { cookies: [], composer: ["div[role='textbox'][contenteditable='true']"], signedOut: /\/login/ };

test.skipIf(!chromePath())("types a message into the chat, presses Send, and checks it went out", async () => {
  await sendInPage(`http://127.0.0.1:${server.port}/chat`, "Running 10 minutes late", { ...opts, sendButton: ["#send"] });
}, 70_000);

test.skipIf(!chromePath())("a site that sends on Enter works too", async () => {
  await sendInPage(`http://127.0.0.1:${server.port}/enter`, "On my way", opts);
}, 70_000);

test.skipIf(!chromePath())("no message box on the page: says so, sends nothing", async () => {
  await expect(sendInPage(`http://127.0.0.1:${server.port}/chat`, "x", { ...opts, composer: ["#nope"], timeoutMs: 15_000 })).rejects.toThrow(/message box/);
}, 70_000);

test("Instagram and X take a link to an existing conversation; LinkedIn its link or its name", async () => {
  expect(badChatLink("instagram", "https://www.instagram.com/direct/t/340282366841710300/")).toBeNull();
  expect(badChatLink("linkedin", "https://www.linkedin.com/messaging/thread/2-ZmFrZQ==/")).toBeNull();
  expect(badChatLink("x", "https://x.com/messages/123-456")).toBeNull();
  expect(badChatLink("instagram", "@priya")).toContain("conversation's link");
  expect(badChatLink("x", "https://evil.example/messages/1")).toContain("conversation's link");
  expect(badChatLink("linkedin", "Kashyab Ambarani")).toBeNull();
  // The inbox page itself isn't a conversation (that's what the read used to hand out for every row).
  expect(badChatLink("linkedin", "https://www.linkedin.com/messaging/")).toContain("conversation's name");
  const sent: { url: string; text: string; open?: any }[] = [];
  const s = webSender("linkedin", () => [{ name: "li_at", value: "v", domain: ".linkedin.com" }], async (url, text, o) => { sent.push({ url, text, open: o.open }); });
  expect(s.connected()).toBe(true);
  await s.send("https://www.linkedin.com/messaging/thread/2-abc/", "hi");
  await s.send("● Sam Lee", "hello");
  expect(sent[0]).toEqual({ url: "https://www.linkedin.com/messaging/thread/2-abc/", text: "hi", open: undefined });
  expect(sent[1].url).toBe("https://www.linkedin.com/messaging/");
  expect(sent[1].open.name).toBe("Sam Lee");
  expect(webSender("x", () => [], async () => {}).connected()).toBe(false);
});

// LinkedIn-like inbox: rows with no links, the newest chat already open (so typing straight away would reach the wrong
// person), a search box, and a header that names the open chat. The page reports where each message landed.
const landed: string[] = [];
const inbox = Bun.serve({ port: 0, fetch(req) {
  const u = new URL(req.url);
  if (u.pathname === "/landed") { landed.push(u.searchParams.get("v")!); return new Response("ok"); }
  return new Response(`<!doctype html><input id=search-conversations><ul id=l></ul>
  <span class="msg-entity-lockup__entity-title" id=hd></span><div id=log></div>
  <div role="textbox" contenteditable="true" id="box" style="min-height:20px;border:1px solid"></div>
  <script>
    const all = ["Nikita Garg", "Jason Hanks", "Kashyab Ambarani", "Kashyab Ambarani", "Kashyab Amb"]; let open = 0, q = "";
    const draw = () => { document.getElementById("l").innerHTML = all.map((n, i) => [n, i]).filter(([n]) => n.toLowerCase().includes(q))
      .map(([n, i]) => '<li class="msg-conversation-listitem"><div class="msg-conversation-listitem__link" tabindex=0 data-i=' + i + '><h3 class="msg-conversation-listitem__participant-names">' + n + '</h3><p>hi</p></div></li>').join("");
      document.querySelectorAll(".msg-conversation-listitem__link").forEach((e) => e.onclick = () => setTimeout(() => { open = +e.dataset.i; document.getElementById("hd").innerText = all[open]; }, 300)); };
    document.getElementById("hd").innerText = all[0];
    document.getElementById("search-conversations").addEventListener("keydown", (e) => { if (e.key === "Enter") setTimeout(() => { q = e.target.value.toLowerCase(); draw(); }, 200); });
    const box = document.getElementById("box");
    box.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); const t = box.innerText.trim();
      fetch("/landed?v=" + encodeURIComponent(open + ":" + t)); const p = document.createElement("p"); p.innerText = t; document.getElementById("log").append(p); box.innerHTML = ""; } });
    setTimeout(draw, 200);
  </script>`, { headers: { "Content-Type": "text/html" } });
} });
afterAll(() => inbox.stop(true));

test.skipIf(!chromePath())("LinkedIn by name: searches, opens that exact conversation, checks its header, then sends", async () => {
  const { SITES } = await import("../src/connectors/web-senders.ts");
  const { inbox: _, ...how } = SITES.linkedin.byName!;
  const base = { cookies: [], composer: ["div[role='textbox'][contenteditable='true']"], signedOut: /\/login/, timeoutMs: 60_000 };
  await sendInPage(`http://127.0.0.1:${inbox.port}/`, "Hey, we are meeting tmr?", { ...base, open: { ...how, name: "kashyab  ambarani" } });
  await Bun.sleep(300);
  expect(landed).toEqual(["2:Hey, we are meeting tmr?"]); // the newest of his chats, not Nikita's open one
  await expect(sendInPage(`http://127.0.0.1:${inbox.port}/`, "x", { ...base, open: { ...how, name: "Kashyab" } })).rejects.toThrow(/No conversation named "Kashyab".*Kashyab Ambarani/);
  expect(landed.length).toBe(1);
}, 120_000);
