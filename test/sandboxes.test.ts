import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { E2bSandbox, type E2bApi } from "../src/sandboxes.ts";
import type { Share } from "../src/types.ts";

test("E2B: the key and secret go over stdin, never into a command; the box URL comes from the sandbox; pause and kill", async () => {
  const cmds: { cmd: string; stdin?: string }[] = [];
  const calls: string[] = [];
  const sb = { sandboxId: "sbx1", host: (p: number) => `127.0.0.1:${server.port}`, run: async (cmd: string, stdin?: string) => { cmds.push({ cmd, stdin }); return { code: 0, stderr: "" }; } };
  const api: E2bApi = {
    create: async () => { calls.push("create"); return sb; }, connect: async () => { calls.push("connect"); return sb; },
    pause: async () => void calls.push("pause"), kill: async () => void calls.push("kill"),
  };
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", tls: undefined, fetch: (r) => (r.headers.get("x-box-secret") === "s".repeat(43) ? Response.json({}) : new Response("", { status: 404 })) });
  const bundle = mkdtempSync(join(tmpdir(), "e2b-bundle-"));
  mkdirSync(join(bundle, "v1")); writeFileSync(join(bundle, "current.json"), '{"version":1}');
  const e2b = new E2bSandbox(() => "e2b_key", api);
  (e2b as any).url = (s: Share) => `http://127.0.0.1:${server.port}`; // the real one is https on e2b.app
  const share = { id: "x".repeat(24), secret: "s".repeat(43), sandbox: "e2b" } as Share;
  const key = "sk-ant-api03-" + "k".repeat(40);
  const orig = globalThis.fetch;
  globalThis.fetch = ((u: any, i: any) => orig(String(u).replace("https://", "http://"), i)) as typeof fetch;
  try {
    const got = await e2b.start(share, bundle, { key, secret: share.secret });
    expect(got.sandboxId).toBe("sbx1");
    expect(calls).toEqual(["create"]);
    for (const c of cmds) { expect(c.cmd).not.toContain(key); expect(c.cmd).not.toContain(share.secret); }
    expect(cmds.some((c) => c.stdin === `${key}\n${share.secret}\n`)).toBe(true);
    await e2b.stop({ ...share, sandboxId: "sbx1" });
    await e2b.remove({ ...share, sandboxId: "sbx1" });
    expect(calls).toEqual(["create", "pause", "kill"]);
    expect(await new E2bSandbox(() => "", api).start(share, bundle, { key, secret: share.secret }).catch((e) => e.message)).toContain("E2B key");
  } finally { globalThis.fetch = orig; server.stop(true); }
});

test("minting a subscription token: the hub gets the link, sends back your code, keeps only the token", async () => {
  const { TokenMint } = await import("../src/tokenmint.ts");
  // Stands in for `claude setup-token`: prints the sign-in link, waits for the code, prints a token.
  const fake = `process.stdout.write("Browser didn't open? Use the url below\\r\\nhttps://claude.com/cai/oauth/authorize?code=true&scope=user%3Ainference&state=abc\\r\\nPaste code here if prompted > ");
for await (const line of console) { if (line.trim() === "good-code-123#state") { console.log("Your token: \\x1b[1msk-ant-oat01-" + "t".repeat(40) + "\\x1b[0m"); process.exit(0); } else { console.log("Invalid code"); process.exit(1); } }`;
  const m = new TokenMint([process.execPath, "-e", fake]);
  const { url } = await m.start();
  expect(new URL(url).searchParams.get("scope")).toBe("user:inference");
  expect(await m.finish("good-code-123#state")).toBe("sk-ant-oat01-" + "t".repeat(40));
  expect(m.busy).toBe(false);
  const m2 = new TokenMint([process.execPath, "-e", fake]);
  await m2.start();
  expect(await m2.finish("wrong-code-456").catch((e) => e.message)).toContain("didn't accept");
});
