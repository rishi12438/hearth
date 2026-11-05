import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, COLLECTIONS, type Store } from "../src/store/index.ts";
import { Hub } from "../src/hub.ts";
import { Brain, saveFiles, filesNote, pictures, type BrainInput } from "../src/brain.ts";
import { Scripts } from "../src/scripts.ts";
import { loadConfig } from "../src/config.ts";
import type { Job, Message } from "../src/types.ts";

const FIXTURE = join(import.meta.dir, "fixtures/fake-agent.ts");
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const b64 = (s: string) => Buffer.from(s).toString("base64");
let store: Store | null = null, hub: Hub | null = null;

afterEach(async () => { hub?.stop(); await hub?.idle(20_000); await store?.close(); hub = null; store = null; });

test("attached files of every type are saved in the run's folder, never overwriting a different one with the same name", () => {
  const cwd = mkdtempSync(join(tmpdir(), "hearth-att-"));
  const a = saveFiles(cwd, [{ name: "Screenshot.png", mime: "image/png", data: b64("one") }, { name: "Screenshot.png", mime: "image/png", data: b64("two") }]);
  expect(a.map((p) => p.slice(cwd.length + 1))).toEqual(["attachments/Screenshot.png", "attachments/Screenshot-2.png"]);
  expect(readFileSync(a[1], "utf8")).toBe("two");
  // The same file again (a retry on a bigger model) reuses its file.
  expect(saveFiles(cwd, [{ name: "Screenshot.png", mime: "image/png", data: b64("one") }])).toEqual([a[0]]);
  // Any type: archives, documents, things Hearth has no name for.
  const more = saveFiles(cwd, [
    { name: "Family 2.zip", mime: "application/zip", data: b64("PK zip") },
    { name: "report.pdf", mime: "application/pdf", data: b64("%PDF") },
    { name: "export.weird", mime: "application/octet-stream", data: b64("??") },
    { name: "image", mime: "image/jpeg", data: b64("jpg") }, // a paste without an extension
  ]);
  expect(more.map((p) => p.slice(cwd.length + 1))).toEqual(["attachments/Family 2.zip", "attachments/report.pdf", "attachments/export.weird", "attachments/image.jpg"]);
  expect(readFileSync(more[0], "utf8")).toBe("PK zip");
  // A name that tries to leave the folder, or hide as a dotfile, stays inside.
  expect(saveFiles(cwd, [{ name: "../../evil.sh", mime: "text/x-sh", data: b64("e") }])[0]).toBe(join(cwd, "attachments", "evil.sh"));
  expect(saveFiles(cwd, [{ name: ".bashrc", mime: "text/plain", data: b64("e") }])[0]).toBe(join(cwd, "attachments", "bashrc"));
  expect(readdirSync(join(cwd, "attachments")).sort()).toEqual(["Family 2.zip", "Screenshot-2.png", "Screenshot.png", "bashrc", "evil.sh", "export.weird", "image.jpg", "report.pdf"]);
  expect(pictures([...a, ...more])).toEqual([...a, more[3]]);
  const note = filesNote([a[0], more[0]], cwd, "claude");
  expect(note).toContain("attachments/Screenshot.png, attachments/Family 2.zip");
  expect(note).toContain("unzip");
  expect(note).toContain("Read tool");
  expect(filesNote([more[0]], cwd, "claude")).not.toContain("picture with your Read tool");
  expect(filesNote([], cwd, "claude")).toBe("");
});

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "hearth-img-hub-"));
  store = await createStore(process.env.TEST_DB || "sqlite::memory:", dir);
  for (const c of COLLECTIONS) await store.clear(c);
  const config = { ...loadConfig({ HEARTH_AGENT: "custom", HEARTH_AGENT_CMD: JSON.stringify([process.execPath, FIXTURE]) }), dataDir: dir };
  const brain = new Brain(config);
  const seen: BrainInput[] = [];
  const think = brain.think.bind(brain);
  brain.think = ((b: BrainInput, ...rest: any[]) => { seen.push(b); return (think as any)(b, ...rest); }) as any;
  hub = new Hub(config, store, brain, new Scripts(store, dir, join(import.meta.dir, "../scripts")), null);
  await hub.setPrefs({ tz: "UTC" });
  await hub.ensureTeammates();
  process.env.FAKE_LOG = join(dir, "calls.log");
  process.env.FAKE_MS = "50";
  return { seen, working: () => seen.filter((b) => (b.mode === "job" || b.mode === "legwork") && b.files?.length) };
}
const until = async (fn: () => Promise<boolean>, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end && !(await fn())) await Bun.sleep(25); };
const settled = async () => (await store!.all<Job>("jobs")).every((j) => j.status === "done" || j.status === "failed");

test("every file sent with a ramble reaches the teammate doing the job", async () => {
  const { working } = await setup();
  process.env.FAKE_PLAN = JSON.stringify({ title: "t", reply: "On it", jobs: [{ task: "fix what's in the screenshot", teammate: "Scout" }] });
  const shot = (await hub!.files.save(PNG, { name: "Screenshot 2026-11-04 at 01.30.00.png", source: "you" })).value!;
  const doc = (await hub!.files.save(new TextEncoder().encode("notes"), { name: "notes.txt", source: "you" })).value!;
  const zip = (await hub!.files.save(new TextEncoder().encode("PK chat"), { name: "Family 2.zip", source: "you" })).value!;
  await hub!.ramble("this is broken", undefined, [shot.id, doc.id, zip.id]);
  await until(async () => (await store!.all<Job>("jobs")).length === 1 && (await settled()));
  const b = working()[0];
  expect(b.files).toEqual([
    { name: shot.name, mime: "image/png", data: Buffer.from(PNG).toString("base64") },
    { name: "notes.txt", mime: "text/plain", data: b64("notes") },
    { name: "Family 2.zip", mime: "application/zip", data: b64("PK chat") },
  ]);
  expect(b.input).toContain(`### ${shot.name} (a picture`);
  expect(b.input).toContain("### notes.txt\nnotes"); // small text still comes inline too
  expect(b.input).toContain("### Family 2.zip (application/zip, 0 KB; saved in your working folder's attachments/");
  expect(b.input).not.toContain("can't open this type");
});

test("a reply in a task's thread can be just a pasted screenshot, and the next turn sees it", async () => {
  const { working } = await setup();
  process.env.FAKE_PLAN = JSON.stringify({ title: "t", reply: "On it", jobs: [{ task: "build the page", teammate: "Scout" }] });
  await hub!.ramble("build me a page");
  await until(async () => (await store!.all<Job>("jobs")).length === 1 && (await settled()));
  const root = (await store!.all<Job>("jobs"))[0];
  expect(working()).toHaveLength(0);
  const shot = (await hub!.files.save(PNG, { name: "Screenshot.png", source: "you" })).value!;
  const r = await hub!.replyToJob(root.id, "", { fileIds: [shot.id] });
  expect(r.error).toBeUndefined();
  const m = await store!.get<Message>("messages", r.value!.message.id);
  expect(m?.fileIds).toEqual([shot.id]);
  expect(m?.text).toBe("Have a look at this.");
  expect((await hub!.files.bytes(shot.id))?.length).toBe(PNG.length);
  await until(async () => (await store!.all<Job>("jobs")).length === 2 && (await settled()));
  expect(working()).toHaveLength(1);
  expect(working()[0].files?.[0].name).toBe("Screenshot.png");
  // Still refused when there's nothing at all.
  expect((await hub!.replyToJob(root.id, "  ")).error).toBe("Say something first.");
});
