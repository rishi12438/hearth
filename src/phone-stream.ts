/**
 * Live video of the phone for the owner's screen in the app, and real touches back: scrcpy's server runs on the
 * Android (pushed each time: it deletes itself when it starts), a small bridge on the box joins its video socket to
 * stdout and its control socket to stdin, and the hub relays both over one SSH session to the app's WebSocket.
 * The app decodes the H.264 itself (WebCodecs). Protocol: scrcpy v5.0.1 (doc/develop.md, app/src/control_msg.c);
 * server and protocol must match, hence the pinned version.
 */

export const SCRCPY = {
  version: "5.0.1",
  url: "https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/scrcpy-server-v5.0.1",
  sha256: "764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536",
  path: "/opt/hearth-scrcpy/scrcpy-server-v5.0.1",
};

/** Small enough for the phone's software encoder to keep up at 30 fps, sharp enough to read. */
const MAX_SIZE = 1280;
const BIT_RATE = 4_000_000;
const PORT = 27183;

/**
 * On the box: video socket → stdout, stdin → control socket. Waits for scrcpy to listen (its first byte on the
 * video socket says so), touches the idle mark while streaming, and exits (closing both sockets, which stops scrcpy)
 * as soon as either side ends.
 */
const BRIDGE = `
import socket, sys, threading, time, os
port = int(sys.argv[1]); mark = sys.argv[2]
def connect():
    end = time.time() + 15
    while time.time() < end:
        try:
            s = socket.create_connection(("127.0.0.1", port), timeout=3)
            if s.recv(1) == b"\\x00": return s
            s.close()
        except OSError: pass
        time.sleep(0.2)
    sys.stderr.write("scrcpy didn't start\\n"); os._exit(3)
v = connect(); v.settimeout(None)
c = socket.create_connection(("127.0.0.1", port))
out = sys.stdout.buffer
def video():
    while True:
        d = v.recv(262144)
        if not d: os._exit(0)
        out.write(d); out.flush()
def drain():
    while c.recv(65536): pass
    os._exit(0)
def mark_loop():
    while True:
        try: os.utime(mark, None)
        except OSError: open(mark, "a").close()
        time.sleep(30)
for f in (video, drain, mark_loop): threading.Thread(target=f, daemon=True).start()
inp = sys.stdin.buffer
while True:
    d = inp.read1(65536)
    if not d: os._exit(0)
    c.sendall(d)
`;

/** The shell command the hub runs over SSH to start a stream. Nothing but video may reach stdout. */
export function streamCommand(serial: string, idleMark: string, sudo = "sudo ") {
  const scid = (Math.floor(Math.random() * 0x7fffffff) + 1).toString(16).padStart(8, "0");
  const b64 = Buffer.from(BRIDGE).toString("base64");
  const J = SCRCPY.path;
  return [
    `export ANDROID_SERIAL=${serial}`,
    `exec 3>&1 1>/dev/null`, // stdout is the video: everything before the bridge writes elsewhere
    `touch ${idleMark} 2>/dev/null`,
    `if [ ! -f ${J} ]; then ${sudo}mkdir -p $(dirname ${J}) && ${sudo}curl -fsSL -o ${J}.tmp ${SCRCPY.url} && echo "${SCRCPY.sha256}  ${J}.tmp" | sha256sum -c - >&2 && ${sudo}mv ${J}.tmp ${J} || { echo "couldn't fetch scrcpy" >&2; exit 4; }; fi`,
    `adb shell pkill -f com.genymobile.scrcpy </dev/null 2>/dev/null`,
    `adb push ${J} /data/local/tmp/hearth-scrcpy.jar </dev/null 2>&1`,
    `adb forward tcp:${PORT} localabstract:scrcpy_${scid} </dev/null`,
    `(adb shell CLASSPATH=/data/local/tmp/hearth-scrcpy.jar app_process / com.genymobile.scrcpy.Server ${SCRCPY.version} scid=${scid} tunnel_forward=true audio=false control=true cleanup=false send_device_meta=false max_size=${MAX_SIZE} max_fps=30 video_bit_rate=${BIT_RATE} </dev/null >/tmp/hearth-scrcpy.log 2>&1 &)`,
    `exec python3 -u -c "$(echo ${b64} | base64 -d)" ${PORT} ${idleMark} 1>&3 3>&-`,
  ].join("\n");
}

/** Android key codes the owner's screen may send. */
export const KEYS: Record<string, number> = {
  KEYCODE_HOME: 3, KEYCODE_BACK: 4, KEYCODE_DPAD_UP: 19, KEYCODE_DPAD_DOWN: 20, KEYCODE_DPAD_LEFT: 21, KEYCODE_DPAD_RIGHT: 22,
  KEYCODE_TAB: 61, KEYCODE_SPACE: 62, KEYCODE_ENTER: 66, KEYCODE_DEL: 67, KEYCODE_FORWARD_DEL: 112, KEYCODE_APP_SWITCH: 187,
};

const int = (v: unknown, lo: number, hi: number) => { const n = Math.round(Number(v)); if (!Number.isFinite(n) || n < lo || n > hi) throw new Error("Out of range."); return n; };
const GENERIC_FINGER = -2n; // scrcpy: a finger, not the mouse

/**
 * One input from the app, as scrcpy control bytes. Only touches, scrolls, keys and text: nothing else scrcpy can do
 * (clipboard, apps, power) is reachable from here.
 *   touch {a: 0 down | 1 up | 2 move, x, y, w, h}   (w×h: the video size the app sees, as scrcpy expects)
 *   scroll {x, y, w, h, dx, dy}                       (dx, dy in -16..16; positive dy scrolls up)
 *   key {k: "KEYCODE_BACK"}                           (down and up)
 *   text {s}                                          (up to 300 bytes)
 */
export function encodeInput(m: any): Uint8Array {
  if (m?.t === "touch") {
    const b = new DataView(new ArrayBuffer(32));
    const a = int(m.a, 0, 2);
    b.setUint8(0, 2); b.setUint8(1, a);
    b.setBigInt64(2, GENERIC_FINGER);
    b.setInt32(10, int(m.x, 0, 8192)); b.setInt32(14, int(m.y, 0, 8192));
    b.setUint16(18, int(m.w, 1, 8192)); b.setUint16(20, int(m.h, 1, 8192));
    b.setUint16(22, a === 1 ? 0 : 0xffff);
    return new Uint8Array(b.buffer);
  }
  if (m?.t === "scroll") {
    const b = new DataView(new ArrayBuffer(21));
    const fp = (v: unknown) => { const f = Math.max(-1, Math.min(1, Number(v) / 16 || 0)); return Math.max(-0x8000, Math.min(0x7fff, Math.round(f * 0x8000))); };
    b.setUint8(0, 3);
    b.setInt32(1, int(m.x, 0, 8192)); b.setInt32(5, int(m.y, 0, 8192));
    b.setUint16(9, int(m.w, 1, 8192)); b.setUint16(11, int(m.h, 1, 8192));
    b.setInt16(13, fp(m.dx)); b.setInt16(15, fp(m.dy));
    return new Uint8Array(b.buffer);
  }
  if (m?.t === "key") {
    const code = KEYS[String(m.k)];
    if (!code) throw new Error("Not a key you can press from here.");
    const out = new Uint8Array(28), b = new DataView(out.buffer);
    for (const [i, action] of [[0, 0], [14, 1]]) { b.setUint8(i, 0); b.setUint8(i + 1, action); b.setUint32(i + 2, code); }
    return out;
  }
  if (m?.t === "text") {
    let str = String(m.s ?? "").slice(0, 300), s = new TextEncoder().encode(str);
    while (s.length > 300) { str = str.slice(0, -1); s = new TextEncoder().encode(str); } // never cut a character in half
    if (!s.length) throw new Error("Nothing to type.");
    const out = new Uint8Array(5 + s.length);
    out[0] = 1; new DataView(out.buffer).setUint32(1, s.length); out.set(s, 5);
    return out;
  }
  throw new Error("Not something you can do from here.");
}
