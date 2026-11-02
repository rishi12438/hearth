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

test("Instagram, LinkedIn and X only take a link to an existing conversation", async () => {
  expect(badChatLink("instagram", "https://www.instagram.com/direct/t/340282366841710300/")).toBeNull();
  expect(badChatLink("linkedin", "https://www.linkedin.com/messaging/thread/2-ZmFrZQ==/")).toBeNull();
  expect(badChatLink("x", "https://x.com/messages/123-456")).toBeNull();
  expect(badChatLink("instagram", "@priya")).toContain("conversation's link");
  expect(badChatLink("x", "https://evil.example/messages/1")).toContain("conversation's link");
  const sent: string[] = [];
  const s = webSender("linkedin", () => [{ name: "li_at", value: "v", domain: ".linkedin.com" }], async (url, text) => { sent.push(`${url} ${text}`); });
  expect(s.connected()).toBe(true);
  await expect(s.send("Sam", "hi")).rejects.toThrow(/conversation's link/);
  await s.send("https://www.linkedin.com/messaging/thread/2-abc/", "hi");
  expect(sent).toEqual(["https://www.linkedin.com/messaging/thread/2-abc/ hi"]);
  expect(webSender("x", () => [], async () => {}).connected()).toBe(false);
});
