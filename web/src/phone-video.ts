/**
 * The phone's live video (scrcpy H.264 relayed by the hub), decoded here with WebCodecs and drawn on a canvas. The
 * stream: codec id (u32), then 12-byte headers: a session header (top bit set: width, height) whenever the size
 * changes, else a packet header (config/key flags, PTS, size) and the packet. Input goes back as JSON (see
 * src/phone-stream.ts). Returns null where the browser can't decode video (the caller keeps using pictures).
 */
export function phoneVideo(canvas: HTMLCanvasElement, connect: () => Promise<WebSocket>, on: { first(): void; end(): void }) {
  const VD = (window as any).VideoDecoder, Chunk = (window as any).EncodedVideoChunk;
  if (!VD || !Chunk) return null;
  const ctx = canvas.getContext("2d")!;
  let ws: WebSocket | null = null, dec: any = null, ended = false, shown = false, cfg: Uint8Array | null = null, needKey = true;
  let buf = new Uint8Array(0), haveCodec = false;
  const size = { w: 0, h: 0 };
  const end = () => { if (ended) return; ended = true; try { ws?.close(); } catch {} try { dec?.close(); } catch {} on.end(); };
  const decoder = () => {
    try { dec?.close(); } catch {}
    dec = new VD({
      output: (frame: any) => {
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) { canvas.width = frame.displayWidth; canvas.height = frame.displayHeight; canvas.style.aspectRatio = `${frame.displayWidth} / ${frame.displayHeight}`; }
        ctx.drawImage(frame, 0, 0);
        frame.close();
        if (!shown) { shown = true; on.first(); }
      },
      error: () => end(),
    });
  };
  // The H.264 profile and level, from the SPS in the config packet: "avc1.PPCCLL".
  const codecOf = (c: Uint8Array) => {
    for (let i = 0; i + 4 < c.length; i++) if (c[i] === 0 && c[i + 1] === 0 && c[i + 2] === 1 && (c[i + 3] & 0x1f) === 7) return "avc1." + [c[i + 4], c[i + 5], c[i + 6]].map((b) => b.toString(16).padStart(2, "0")).join("");
    return "avc1.42e01f";
  };
  const packet = (flags: number, pts: number, data: Uint8Array) => {
    if (flags & 0x40) { // config: SPS/PPS, given again with the next key frame
      cfg = data.slice();
      decoder();
      dec.configure({ codec: codecOf(cfg), optimizeForLatency: true });
      needKey = true;
      return;
    }
    const key = !!(flags & 0x20);
    if (!dec || dec.state !== "configured" || (needKey && !key)) return;
    needKey = false;
    let d = data;
    if (key && cfg) { d = new Uint8Array(cfg.length + data.length); d.set(cfg); d.set(data, cfg.length); }
    // Behind (a slow computer): skip to the next key frame rather than fall further behind.
    if (dec.decodeQueueSize > 8 && !key) { needKey = true; return; }
    dec.decode(new Chunk({ type: key ? "key" : "delta", timestamp: pts, data: d }));
  };
  const feed = (chunk: Uint8Array) => {
    const b = new Uint8Array(buf.length + chunk.length); b.set(buf); b.set(chunk, buf.length); buf = b;
    let i = 0;
    if (!haveCodec) { if (buf.length < 4) return; haveCodec = true; i = 4; }
    while (buf.length - i >= 12) {
      const v = new DataView(buf.buffer, buf.byteOffset + i, 12);
      const b0 = buf[i];
      if (b0 & 0x80) { size.w = v.getUint32(4); size.h = v.getUint32(8); i += 12; continue; }
      const len = v.getUint32(8);
      if (buf.length - i < 12 + len) break;
      const pts = (v.getUint32(0) & 0x1fffffff) * 2 ** 32 + v.getUint32(4);
      try { packet(b0, pts, buf.subarray(i + 12, i + 12 + len)); } catch { end(); return; }
      i += 12 + len;
    }
    buf = buf.slice(i);
  };
  (async () => {
    try {
      const sock = await connect();
      if (ended) { sock.close(); return; }
      ws = sock;
      ws.binaryType = "arraybuffer";
      ws.onmessage = (e) => { if (e.data instanceof ArrayBuffer) feed(new Uint8Array(e.data)); };
      ws.onclose = () => end();
      ws.onerror = () => end();
    } catch { end(); }
  })();
  return {
    size,
    send(m: Record<string, unknown>) { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); },
    close: end,
  };
}
