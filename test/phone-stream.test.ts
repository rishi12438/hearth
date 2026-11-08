import { expect, test } from "bun:test";
import { encodeInput, streamCommand, SCRCPY } from "../src/phone-stream.ts";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

test("touch: scrcpy's 32-byte inject-touch message, as a finger, pressure 0 on lift", () => {
  const down = encodeInput({ t: "touch", a: 0, x: 100, y: 200, w: 590, h: 1280 });
  expect(down.length).toBe(32);
  expect(hex(down)).toBe("0200" + "fffffffffffffffe" + "00000064" + "000000c8" + "024e" + "0500" + "ffff" + "00000000" + "00000000");
  const up = encodeInput({ t: "touch", a: 1, x: 100, y: 200, w: 590, h: 1280 });
  expect(hex(up.slice(22, 24))).toBe("0000");
});

test("key: down then up; text: length-prefixed UTF-8, never cut mid-character; scroll: 21 bytes", () => {
  expect(hex(encodeInput({ t: "key", k: "KEYCODE_BACK" }))).toBe("0000" + "00000004" + "00000000" + "00000000" + "0001" + "00000004" + "00000000" + "00000000");
  expect(hex(encodeInput({ t: "text", s: "a&b" }))).toBe("01" + "00000003" + "612662");
  const long = encodeInput({ t: "text", s: "é".repeat(200) });
  expect(new DataView(long.buffer).getUint32(1)).toBe(300);
  const sc = encodeInput({ t: "scroll", x: 1, y: 2, w: 590, h: 1280, dx: 0, dy: 16 });
  expect(sc.length).toBe(21);
  expect(hex(sc.slice(13, 17))).toBe("0000" + "7fff");
});

test("only touches, scrolls, keys and text get through; bad numbers are refused", () => {
  expect(() => encodeInput({ t: "clipboard", s: "x" })).toThrow();
  expect(() => encodeInput({ t: "key", k: "KEYCODE_POWER" })).toThrow();
  expect(() => encodeInput({ t: "touch", a: 7, x: 1, y: 1, w: 1, h: 1 })).toThrow();
  expect(() => encodeInput({ t: "touch", a: 0, x: "nope", y: 1, w: 1, h: 1 })).toThrow();
  expect(() => encodeInput({ t: "text", s: "" })).toThrow();
});

test("stream command: pinned scrcpy (checksummed), pushed each time, and only the bridge writes to stdout", () => {
  const c = streamCommand("127.0.0.1:5555", "/tmp/mark");
  expect(c).toContain(SCRCPY.sha256);
  expect(c).toContain("sha256sum -c");
  expect(c).toContain("adb push");
  expect(c).toMatch(/scid=[0-7][0-9a-f]{7} /);
  expect(c.split("\n")[1]).toBe("exec 3>&1 1>/dev/null");
  expect(c.trim().split("\n").at(-1)).toMatch(/^exec python3 .* 1>&3 3>&-$/);
});
