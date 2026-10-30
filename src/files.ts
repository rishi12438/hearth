import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { sha256 } from "./auth.ts";
import type { Store } from "./store/index.ts";
import type { StoredFile } from "./types.ts";

// Files you attach and files teammates make, stored on the hub next to your data (<data>/files/<id>).
// Downloads are always served as attachments with a sandbox CSP, so a file can never run inside the app.

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
const TYPES: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json", ".ics": "text/calendar",
  ".html": "text/html", ".xml": "application/xml", ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic", ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".mp4": "video/mp4", ".mov": "video/quicktime",
  ".webm": "video/webm", ".m4v": "video/mp4", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".aac": "audio/aac",
  ".flac": "audio/flac", ".avif": "image/avif", ".tsv": "text/tab-separated-values", ".log": "text/plain", ".yaml": "text/plain",
  ".yml": "text/plain", ".toml": "text/plain", ".ini": "text/plain", ".sh": "text/plain", ".py": "text/plain", ".js": "text/plain",
  ".ts": "text/plain", ".css": "text/plain", ".sql": "text/plain", ".go": "text/plain", ".rs": "text/plain", ".swift": "text/plain",
  ".zip": "application/zip", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
/** Types a teammate can read as text in its prompt. */
const TEXTY = /^(text\/|application\/(json|xml))/;

export function cleanName(raw: string) {
  const name = basename(String(raw || "file")).replace(/[^\w.\- ()]/g, "_").replace(/^\.+/, "").slice(0, 120);
  return name || "file";
}

export function mimeFor(name: string) {
  return TYPES[extname(name).toLowerCase()] || "application/octet-stream";
}

export class Files {
  readonly dir: string;
  constructor(private store: Store, dataDir: string) {
    this.dir = join(dataDir, "files");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  async save(bytes: Uint8Array, meta: { name: string; source: StoredFile["source"]; threadId?: string; jobId?: string; teammateId?: string }) {
    if (bytes.length > MAX_FILE_BYTES) return { error: "That file is over 15 MB." };
    const name = cleanName(meta.name);
    const id = randomUUID();
    writeFileSync(join(this.dir, id), bytes, { mode: 0o600 });
    const f = await this.store.put<StoredFile>("files", {
      id, createdAt: new Date().toISOString(), name, mime: mimeFor(name), size: bytes.length, sha256: sha256(bytes),
      source: meta.source, threadId: meta.threadId, jobId: meta.jobId, teammateId: meta.teammateId,
    });
    return { value: f };
  }

  /** Picks up a file a script wrote in its working folder (name only; nothing outside that folder). */
  async adopt(workDir: string, rawName: string, meta: Omit<Parameters<Files["save"]>[1], "name">) {
    const name = basename(String(rawName || "").trim());
    const path = join(workDir, name);
    if (!name || !existsSync(path) || !statSync(path).isFile()) return { error: `No file called ${name}.` };
    const r = await this.save(readFileSync(path), { ...meta, name });
    rmSync(path, { force: true });
    return r;
  }

  bytes(id: string) {
    const p = join(this.dir, id.replace(/[^\w-]/g, ""));
    return existsSync(p) ? readFileSync(p) : null;
  }

  /** Text a teammate can read: text-like files up to 40 KB. */
  textOf(f: StoredFile) {
    if (!TEXTY.test(f.mime) || f.size > 40_000) return null;
    return this.bytes(f.id)?.toString("utf8") ?? null;
  }

  async remove(id: string) {
    rmSync(join(this.dir, id.replace(/[^\w-]/g, "")), { force: true });
    return this.store.remove("files", id);
  }
}

/** Scripts print "@file name.ext" for each file they wrote in their working folder. */
export function extractFiles(output: string) {
  const names: string[] = [];
  const lines = output.split("\n").filter((l) => {
    if (!l.startsWith("@file ")) return true;
    names.push(l.slice(6).trim());
    return false;
  });
  return { text: lines.join("\n"), names: names.slice(0, 5) };
}
