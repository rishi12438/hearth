#!/usr/bin/env bun

// The Docker boxes' front door. Boxes sit on an internal network with no route in or out; this container sits on that
// network and the host's, published on 127.0.0.1 only, so only the hub on the same machine can reach it. It forwards
// /b/<link id>/... to that box and nothing else; each box still checks its own secret, which only the hub has.

const ID = /^\/b\/([0-9a-f]{24})(\/.*)$/;
const PASS = ["content-type", "x-box-secret", "x-visitor", "x-visitor-ip"];

export async function forward(req: Request, resolve = (id: string) => `http://hearth-box-${id}:8080`) {
  const url = new URL(req.url);
  const m = url.pathname.match(ID);
  if (!m) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  for (const h of PASS) { const v = req.headers.get(h); if (v) headers.set(h, v.slice(0, 200)); }
  try {
    const res = await fetch(`${resolve(m[1])}${m[2]}${url.search}`, {
      method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
      signal: AbortSignal.timeout(300_000),
    });
    return new Response(res.body, { status: res.status, headers: { "Content-Type": res.headers.get("content-type") || "application/json" } });
  } catch { return new Response(JSON.stringify({ error: "That box isn't running." }), { status: 502, headers: { "Content-Type": "application/json" } }); }
}

if (import.meta.main) {
  const port = Number(process.env.GATEWAY_PORT || 8080);
  Bun.serve({ port, hostname: "0.0.0.0", fetch: (req, server) => { server.timeout(req, 0); return forward(req); } });
  console.log(`gateway on :${port}`);
}
