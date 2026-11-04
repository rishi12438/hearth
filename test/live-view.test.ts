import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchLive, type Frame } from "../src/brains/live-view.ts";

const png = (n: number) => new Uint8Array(200).fill(n);
const keep = async (p: Uint8Array): Promise<Frame> => ({ data: p, mime: "image/png" });

/** A stand-in tool: lists one live session for its owner, and (browser) writes a screenshot when asked. */
function fakeTool(dir: string, name: string, sessionId: string, screenshotFile?: string) {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh
[ "$ENKIDU_OWNER" = "hearth-run-test" ] || { echo '{"sessions":[]}'; exit 0; }
if [ "$2" = "list" ]; then echo '{"sessions":[{"id":"${sessionId}","state":"running"},{"id":"old","state":"succeeded"}]}'; exit 0; fi
if [ "$4" = "screenshot" ]; then printf 'x%.0s' $(seq 1 300) > "${screenshotFile}"; echo '{"ok":true,"result":{"file":"${screenshotFile}"}}'; exit 0; fi
echo '{}'
`);
  chmodSync(path, 0o755);
  return path;
}

test("live view: a browser page gets a fresh screenshot, which is then cleaned up", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-live-"));
  const evidence = join(dir, "evidence");
  mkdirSync(join(evidence, "hearth-shop-abcd", "screens"), { recursive: true });
  const shot = join(evidence, "hearth-shop-abcd", "screens", "0007.png");
  const browser = fakeTool(dir, "browser", "hearth-shop-abcd", shot);
  const frames: Frame[] = [];
  const stop = watchLive("hearth-run-test", (f) => frames.push(f), { browser, cua: null, evidenceDir: evidence, everyMs: 30, shrink: keep });
  for (let i = 0; i < 100 && !frames.length; i++) await Bun.sleep(10);
  stop();
  expect(frames.length).toBe(1); // the same picture again isn't sent twice
  expect(frames[0].data.length).toBe(300);
  expect(existsSync(shot)).toBe(false);
});

test("live view: an app window shows the job's own newest picture and never asks for one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-live-"));
  const evidence = join(dir, "evidence");
  const screens = join(evidence, "hearth-notes-wxyz", "screens");
  mkdirSync(screens, { recursive: true });
  const cua = fakeTool(dir, "cua", "hearth-notes-wxyz", join(dir, "should-not-exist.png"));
  writeFileSync(join(screens, "0001.png"), png(1));
  const frames: Frame[] = [];
  const stop = watchLive("hearth-run-test", (f) => frames.push(f), { browser: null, cua, evidenceDir: evidence, everyMs: 30, shrink: keep });
  for (let i = 0; i < 100 && !frames.length; i++) await Bun.sleep(10);
  await Bun.sleep(30);
  writeFileSync(join(screens, "0002.png"), png(2));
  for (let i = 0; i < 100 && frames.length < 2; i++) await Bun.sleep(10);
  stop();
  expect(frames.map((f) => f.data[0])).toEqual([1, 2]);
  expect(existsSync(join(dir, "should-not-exist.png"))).toBe(false);
});

test("live view: another owner's sessions are invisible, and no tools means no watching", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hearth-live-"));
  const browser = fakeTool(dir, "browser", "hearth-x-abcd", join(dir, "s.png"));
  const frames: Frame[] = [];
  const stop = watchLive("hearth-run-other", (f) => frames.push(f), { browser, cua: null, evidenceDir: join(dir, "e"), everyMs: 20, shrink: keep });
  await Bun.sleep(120);
  stop();
  expect(frames).toEqual([]);
  expect(typeof watchLive("o", () => {}, { browser: null, cua: null })).toBe("function");
});
