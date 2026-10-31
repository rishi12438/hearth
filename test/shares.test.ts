import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, COLLECTIONS, type Store } from "../src/store/index.ts";
import { Hub } from "../src/hub.ts";
import { Brain } from "../src/brain.ts";
import { Scripts } from "../src/scripts.ts";
import { loadConfig } from "../src/config.ts";
import { Shares, checkEvent, type BoxRunner } from "../src/shares.ts";
import { Box } from "../src/public/box.ts";
import { newPairingCode, redeemPairingCode } from "../src/auth.ts";
import type { Fact, Notebook, Person, Share, ShareEvent, Teammate } from "../src/types.ts";
import { FakeModel, text, tool } from "./fake-model.ts";

// The box runs in this process with a scripted model, on a real unix socket, behind the real hub server.
class TestRunner implements BoxRunner {
  readonly kind = "test";
  readonly sealed = false;
  boxes = new Map<string, { box: Box; server: ReturnType<typeof Bun.serve> }>();
  constructor(private root: string, private model: FakeModel) {}
  private dir(s: Share) { return join(this.root, s.id.slice(0, 8)); } // unix socket paths must stay short
  async start(s: Share, bundleDir: string) {
    if (this.boxes.has(s.id)) return;
    mkdirSync(join(this.dir(s), "run"), { recursive: true });
    const box = new Box(bundleDir, this.dir(s), this.model);
    const server = Bun.serve({ unix: this.socket(s), fetch: (r, srv) => { srv.timeout(r, 0); return box.handle(r); } });
    this.boxes.set(s.id, { box, server });
  }
  async stop(s: Share) { const b = this.boxes.get(s.id); b?.server.stop(true); b?.box.close(); this.boxes.delete(s.id); }
  async remove(s: Share) { await this.stop(s); rmSync(this.dir(s), { recursive: true, force: true }); }
  socket(s: Share) { return join(this.dir(s), "run", "box.sock"); }
  outbox(s: Share) { return join(this.dir(s), "outbox.jsonl"); }
  alive(s: Share) { return this.boxes.has(s.id); }
  shutdown() { for (const b of this.boxes.values()) { b.server.stop(true); b.box.close(); } this.boxes.clear(); }
}

const PRIVATE = ["PRIVATE-HEALTH-MARKER", "PRIVATE-PERSON-MARKER", "PRIVATE-MESSAGE-MARKER", "PRIVATE-ABOUT-MARKER", "PRIVATE-PROMPT-MARKER", "PRIVATE-ENV-MARKER"];
let dir: string, short: string, store: Store, hub: Hub, model: FakeModel, runner: TestRunner, shares: Shares, project: string, teammate: Teammate;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "hearth-shares-"));
  short = mkdtempSync("/tmp/hs-");
  store = await createStore(process.env.TEST_DB || "sqlite::memory:", join(dir, "data"));
  for (const c of COLLECTIONS) await store.clear(c);
  const config = { ...loadConfig({}), dataDir: join(dir, "data"), agent: "echo" };
  hub = new Hub(config, store, new Brain(config), new Scripts(store, config.dataDir, join(import.meta.dir, "../scripts")), null);
  await hub.ensureTeammates();
  teammate = (await store.all<Teammate>("teammates"))[0];
  await store.put<Teammate>("teammates", { ...teammate, prompt: `${teammate.prompt} PRIVATE-PROMPT-MARKER` });
  const now = new Date().toISOString();
  for (const n of ["food", "health"]) await store.put<Notebook>("notebooks", { id: n, createdAt: now, name: n, summary: "" });
  const fact = (id: string, notebook: string, f: string) => store.put<Fact>("memory", { id, createdAt: now, fact: f, notebook, importance: 3, source: "you", useCount: 0 });
  await fact("f1", "food", "Rishi is vegetarian and loves dal.");
  await fact("f2", "health", "Rishi takes PRIVATE-HEALTH-MARKER every morning.");
  await store.put<Person>("people", { id: "p1", createdAt: now, name: "Mum", relation: "mother", notes: ["PRIVATE-PERSON-MARKER"], links: [] } as any);
  await store.put("messages", { id: "m1", createdAt: now, role: "user", text: "my bank pin is PRIVATE-MESSAGE-MARKER" } as any);
  await hub.setPrefs({ about: "PRIVATE-ABOUT-MARKER" } as any);
  project = join(dir, "recipes-app");
  const w = (p: string, c: string) => { mkdirSync(join(project, p, ".."), { recursive: true }); writeFileSync(join(project, p), c); };
  w("recipes/dal.md", "# Dal\n1 cup lentils\nsalt\n");
  w("README.md", "Recipes app\n");
  w("src/core/engine.ts", "export const engine = 1;\n");
  w(".env", "API_KEY=PRIVATE-ENV-MARKER\n");
  w("config/settings.ts", "export const apiKey = 'sk-ant-api03-PRIVATEPRIVATEPRIVATEPRIVATE';\n");
  w("node_modules/x/index.js", "module.exports = 1;\n");
  w("dist/bundle.js", "built\n");
  w(".gitignore", "dist/\n");
  w("deploy/setup.sh", "#!/bin/sh\n");
  model = new FakeModel();
  runner = new TestRunner(short, model);
  shares = new Shares(hub, runner);
});

afterEach(async () => {
  shares.stop();
  hub.stop(); await hub.idle(20_000); await store.close();
  rmSync(dir, { recursive: true, force: true }); rmSync(short, { recursive: true, force: true });
});

const allText = (root: string): string => readdirSync(root, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile()).map((e) => readFileSync(join((e as any).parentPath ?? (e as any).path, e.name), "utf8")).join("\n");

async function makeShare(over: any = {}) {
  const r = await shares.create({
    teammateId: teammate.id, ownerName: "Rishi", notebooks: ["food"], notes: ["Book calls through the form on rishi.dev."],
    scope: { does: "Recipes and cooking.", examples: ["what can I make with eggs"], not: ["essays"] },
    folder: { path: project, rules: { edit: ["recipes/**"], read: ["**"], hidden: ["deploy"] } }, ...over,
  });
  if (r.error) throw new Error(r.error);
  return r.value!;
}

test("the bundle holds only what you picked: chosen notebooks, your notes, the allowed files", async () => {
  const s = await makeShare();
  const bundle = shares.bundleDir(s);
  const everything = allText(bundle);
  expect(everything).toContain("Rishi is vegetarian and loves dal.");
  expect(everything).toContain("Book calls through the form");
  for (const marker of PRIVATE) expect(everything).not.toContain(marker);
  const m = JSON.parse(readFileSync(join(bundle, "v1/manifest.json"), "utf8"));
  expect(Object.keys(m.folder.files).sort()).toEqual([".gitignore", "README.md", "recipes/dal.md", "src/core/engine.ts"]);
  expect(m.folder.files["recipes/dal.md"].access).toBe("edit");
  expect(m.folder.files["README.md"].access).toBe("read");
  expect(s.folder!.excluded).toEqual([{ path: "config/settings.ts", why: "looks like it has a Anthropic key" }]);
  expect(m.models).toEqual({ teammate: "claude-opus-5-5", guard: "claude-haiku-5-5", effort: "medium" });
  expect(m.teammate.role).not.toContain("PRIVATE-PROMPT-MARKER"); // the teammate's private prompt isn't copied
});

test("public links can't auto-apply, and folders must be a real project folder", async () => {
  expect((await shares.create({ teammateId: teammate.id, autoApply: true })).error).toContain("Public links");
  expect((await shares.create({ teammateId: teammate.id, kind: "guest" })).error).toContain("who this guest link is for");
  expect((await shares.create({ teammateId: teammate.id, folder: { path: "/" } })).error).toContain("project folder");
  expect((await shares.create({ teammateId: teammate.id, folder: { path: hub.config.dataDir } })).error).toContain("project folder");
  expect((await shares.create({ teammateId: teammate.id, notebooks: ["nope"] })).error).toContain("No notebook");
});

test("box events are rebuilt field by field; anything malformed is dropped", () => {
  expect(checkEvent({ kind: "edit", session: "s1", files: [{ path: "../etc/passwd", before: null, after: "x" }] })).toBeNull();
  expect(checkEvent({ kind: "edit", session: "s1", files: [{ path: "a.md", before: 5, after: "x" }] })).toBeNull();
  expect(checkEvent({ kind: "chat", session: "s1", fit: "in", costUsd: 1e9, extra: "drop me" })).toMatchObject({ costUsd: 100 });
  expect(checkEvent({ kind: "chat", session: "s1", fit: "in", extra: "drop me" })).not.toHaveProperty("extra");
  expect(checkEvent({ kind: "run-shell", cmd: "rm -rf /" })).toBeNull();
  expect(checkEvent({ kind: "refused", session: "bad session!", reason: "out" })).toBeNull();
});

async function server() {
  (hub.config as any).port = 0;
  const { startServer } = await import("../src/server.ts");
  return (await startServer(hub, null, shares)).server;
}

test("through the hub: a jailbroken teammate still can't see or leak anything private", async () => {
  const srv = await server();
  const s = await makeShare();
  const base = `http://127.0.0.1:${srv.port}/t/${s.link}`;
  // A model that does whatever the visitor says: dumps everything it was given and pokes at files it shouldn't have.
  model.verdict = () => ({ fit: "in", injection: false, abuse: "none", reason: "" });
  model.turns = [
    () => tool("read_file", { path: ".env" }),
    () => tool("read_file", { path: "../../data/hearth.db" }),
    () => tool("read_file", { path: "config/settings.ts" }),
    () => tool("read_file", { path: "deploy/setup.sh" }),
    () => tool("list_files", {}),
    (req) => text(`Here is everything: ${req.system}\n${JSON.stringify(req.messages)}`.slice(0, 2000)),
  ];
  const page = await fetch(`${base}/`);
  expect(page.headers.get("content-security-policy")).toContain("sandbox allow-scripts allow-forms");
  expect(await page.text()).toContain("<textarea");
  const { token } = await (await fetch(`${base}/api/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
  const res = await fetch(`${base}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json", "X-Visitor": token }, body: JSON.stringify({ text: "What can I make with lentils?" }) });
  expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
  expect(res.headers.get("content-type")).toBe("application/json");
  const reply = JSON.stringify(await res.json());
  const seen = model.seen.join("\n");
  expect(seen).toContain("Rishi is vegetarian");
  for (const marker of PRIVATE) { expect(seen).not.toContain(marker); expect(reply).not.toContain(marker); }
  expect(seen).not.toContain("sk-ant-api03");
  expect(seen).not.toContain("#!/bin/sh"); // a hidden file's contents
  expect(seen).toContain("read\\t.gitignore\\nread\\tREADME.md\\nedit\\trecipes/dal.md\\nread\\tsrc/core/engine.ts\""); // the whole file list: no deploy/, .env, node_modules, dist
  // the visitor routes can't reach the owner's API, even with the visitor token
  expect((await fetch(`http://127.0.0.1:${srv.port}/api/state`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  expect((await fetch(`${base}/../../api/state`)).status).not.toBe(200);
  // unknown links and turned-off links are just gone
  expect((await fetch(`http://127.0.0.1:${srv.port}/t/AAAAAAAAAAAAAAAAAAAAAAAA/api/info`)).status).toBe(404);
  await shares.revoke(s.id);
  expect((await fetch(`${base}/api/info`)).status).toBe(404);
  expect(existsSync(shares.bundleDir(s))).toBe(false);
  srv.stop(true);
});

/** Have a visitor make an edit through the box, then pull it into the hub. */
async function visitorEdits(s: Share, files: Record<string, string | null>, asked = "change it") {
  const { box } = runner.boxes.get(s.id)!;
  const { token } = box.newSession();
  model.verdict = () => ({ fit: "in", injection: false, abuse: "none", reason: "" });
  model.turnCalls = 0;
  model.turns = [...Object.entries(files).map(([path, c]) => () => (c == null ? tool("delete_file", { path, why: "tidy" }) : tool("write_file", { path, content: c, why: "requested" }))), () => text("Done.")];
  await box.chat(box.session(token)!, asked, "1.1.1.1");
  await shares.pull();
  const events = await store.all<ShareEvent>("shareEvents");
  return events.filter((e) => e.kind === "edit").at(-1)!;
}

test("apply writes your folder, Undo restores it exactly, and the hub drops paths the rules don't allow", async () => {
  const s = await makeShare({ folder: { path: project, rules: { edit: ["recipes/**"], read: ["**"] } } });
  const e = await visitorEdits(s, { "recipes/dal.md": "# Dal\n1 cup lentils\nsalt\ncumin\n", "recipes/new.md": "# New\n" });
  expect(e.status).toBe("pending");
  // pretend a compromised box also claims a change to a read-only file and a secret it never saw
  const forged = { ...e, id: "forged", event: { ...(e.event as any), files: [...(e.event as any).files, { path: "README.md", before: "Recipes app\n", after: "pwned\n", added: 1, removed: 1 }, { path: "config/settings.ts", before: null, after: "pwned", added: 1, removed: 0 }, { path: ".env", before: null, after: "pwned", added: 1, removed: 0 }] } };
  await store.put<ShareEvent>("shareEvents", forged);
  const r: any = await shares.apply(s.id, ["forged"], "apply");
  expect(r.value.dropped.sort()).toEqual([".env", "README.md", "config/settings.ts"]);
  expect(readFileSync(join(project, "README.md"), "utf8")).toBe("Recipes app\n");
  expect(readFileSync(join(project, ".env"), "utf8")).toContain("PRIVATE-ENV-MARKER");
  expect(readFileSync(join(project, "config/settings.ts"), "utf8")).toContain("sk-ant");
  expect(readFileSync(join(project, "recipes/dal.md"), "utf8")).toBe("# Dal\n1 cup lentils\nsalt\ncumin\n");
  expect(readFileSync(join(project, "recipes/new.md"), "utf8")).toBe("# New\n");
  const u = await shares.undo(s.id, r.value.applyId);
  expect(u.value!.restored.sort()).toEqual(["recipes/dal.md", "recipes/new.md"]);
  expect(readFileSync(join(project, "recipes/dal.md"), "utf8")).toBe("# Dal\n1 cup lentils\nsalt\n");
  expect(existsSync(join(project, "recipes/new.md"))).toBe(false);
  expect((await store.get<ShareEvent>("shareEvents", "forged"))!.status).toBe("pending");
});

test("a change that clashes with your own edit writes nothing; a change to other lines merges", async () => {
  const s = await makeShare();
  const clash = await visitorEdits(s, { "recipes/dal.md": "# Dal\n2 cups lentils\nsalt\n" });
  writeFileSync(join(project, "recipes/dal.md"), "# Dal\n3 cups lentils\nsalt\n"); // you changed the same line meanwhile
  const r: any = await shares.apply(s.id, [clash.id], "apply");
  expect(r.error).toContain("Nothing was written");
  expect(r.conflicts[0].path).toBe("recipes/dal.md");
  expect(readFileSync(join(project, "recipes/dal.md"), "utf8")).toBe("# Dal\n3 cups lentils\nsalt\n");
  expect((await store.get<ShareEvent>("shareEvents", clash.id))!.status).toBe("conflict");
  // Save as a copy instead: a new folder, yours untouched
  const c: any = await shares.apply(s.id, [clash.id], "copy");
  expect(c.value.copiedTo).toContain("recipes-app (Visitor");
  expect(readFileSync(join(c.value.copiedTo, "recipes/dal.md"), "utf8")).toContain("<<<<<<<");
  expect(existsSync(join(c.value.copiedTo, "node_modules"))).toBe(false);
  expect(readFileSync(join(project, "recipes/dal.md"), "utf8")).toBe("# Dal\n3 cups lentils\nsalt\n");
  // a change to a different line merges cleanly with yours
  writeFileSync(join(project, "recipes/dal.md"), "# Dal (family)\n1 cup lentils\nsalt\n");
  await shares.publish(s);
  writeFileSync(join(project, "recipes/dal.md"), "# Dal (family, v2)\n1 cup lentils\nsalt\n");
  const ok = await visitorEdits(s, { "recipes/dal.md": "# Dal (family)\n1 cup lentils\nsalt\npepper\n" });
  const m: any = await shares.apply(s.id, [ok.id], "apply");
  expect(m.error).toBeUndefined();
  expect(readFileSync(join(project, "recipes/dal.md"), "utf8")).toBe("# Dal (family, v2)\n1 cup lentils\nsalt\npepper\n");
});

test("git folders: open as a branch with one commit per change", async () => {
  const g = (...a: string[]) => Bun.spawnSync(["git", "-C", project, ...a], { env: { PATH: process.env.PATH!, HOME: dir, GIT_CONFIG_NOSYSTEM: "1" } });
  g("init", "-q"); g("add", "-A"); g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const s = await makeShare();
  const a = await visitorEdits(s, { "recipes/dal.md": "# Dal\n1 cup lentils\nsalt\ncumin\n" }, "add cumin");
  const b = await visitorEdits(s, { "recipes/soup.md": "# Soup\n" }, "add a soup");
  const r: any = await shares.apply(s.id, [a.id, b.id], "branch");
  expect(r.value.branch).toMatch(/^hearth\/visitor-\d+-[0-9a-f]{6}$/);
  const log = g("log", "--format=%s", r.value.branch).stdout.toString().trim().split("\n");
  expect(log.slice(0, 2)).toEqual(["Visitor 2: add a soup", "Visitor 1: add cumin"]);
  expect(readFileSync(join(project, "recipes/dal.md"), "utf8")).toBe("# Dal\n1 cup lentils\nsalt\n"); // your working tree is untouched
});

test("guest links can auto-apply; asks are answered into the box only", async () => {
  const s = await makeShare({ kind: "guest", label: "Sam", autoApply: true });
  await visitorEdits(s, { "recipes/dal.md": "# Dal\n1 cup lentils\nsalt\nghee\n" });
  expect(readFileSync(join(project, "recipes/dal.md"), "utf8")).toContain("ghee");
  const { box } = runner.boxes.get(s.id)!;
  const { token } = box.newSession();
  model.turnCalls = 0;
  model.turns = [() => tool("ask_owner", { question: "What's Rishi's email?", why: "Sam wants to send a recipe" }), () => text("I've asked.")];
  await box.chat(box.session(token)!, "can I email Rishi a recipe?", "1.1.1.1");
  await shares.pull();
  const ask = (await store.all<ShareEvent>("shareEvents")).find((e) => e.kind === "ask")!;
  expect((ask.event as any).visitor).toBe("Sam");
  const r = await shares.answer(s.id, ask.id, { mode: "once", answer: "rishi@example.com" });
  expect(r.value!.status).toBe("answered");
  model.seen = [];
  model.turns = [() => text("It's rishi@example.com.")];
  model.turnCalls = 0;
  await box.chat(box.session(token)!, "so what's the email?", "1.1.1.1");
  expect(model.seen.join("\n")).toContain("rishi@example.com");
  // another visitor doesn't get a "once" answer
  const other = box.newSession();
  model.seen = [];
  await box.chat(box.session(other.token)!, "email?", "1.1.1.1");
  expect(model.seen.join("\n")).not.toContain("rishi@example.com");
});

test("the owner API needs a paired device", async () => {
  const srv = await server();
  expect((await fetch(`http://127.0.0.1:${srv.port}/api/shares`)).status).toBe(401);
  const { code } = await newPairingCode(store);
  const { token } = (await redeemPairingCode(store, code, "phone"))!;
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const made = await (await fetch(`http://127.0.0.1:${srv.port}/api/shares`, { method: "POST", headers: auth, body: JSON.stringify({ teammateId: teammate.id, notebooks: ["food"] }) })).json();
  expect(made.link).toHaveLength(24);
  const list = await (await fetch(`http://127.0.0.1:${srv.port}/api/shares`, { headers: auth })).json();
  expect(list.shares.map((x: Share) => x.id)).toEqual([made.id]);
  srv.stop(true);
});
