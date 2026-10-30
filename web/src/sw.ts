/// <reference lib="webworker" />
// Service worker: keeps the app shell available offline and shows push notifications from your hub.
declare const __BUILD__: string;
const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `hearth-${__BUILD__}`;
const SHELL = ["/", "/app.js", "/styles.css", "/icon.svg", "/manifest.webmanifest"];

sw.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => sw.skipWaiting()));
});

sw.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await sw.clients.claim();
  })());
});

sw.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // Network first so a new build shows up at once; cache when the hub is unreachable.
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok) (await caches.open(CACHE)).put(e.request, res.clone());
      return res;
    } catch {
      return (await caches.match(e.request)) || (await caches.match("/")) || Response.error();
    }
  })());
});

sw.addEventListener("push", (e) => {
  let data: any = {};
  try { data = e.data?.json() ?? {}; } catch { data = { title: "Hearth", body: e.data?.text() }; }
  e.waitUntil(sw.registration.showNotification(data.title || "Hearth", {
    body: data.body || "", tag: data.tag, icon: "/icon-192.png", badge: "/icon-192.png", data: { url: data.url || "/#chat" },
  }));
});

sw.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = e.notification.data?.url || "/#chat";
  e.waitUntil((async () => {
    const wins = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
    const w = wins[0] as WindowClient | undefined;
    if (w) { await w.focus(); return w.navigate(target); }
    return sw.clients.openWindow(target);
  })());
});
