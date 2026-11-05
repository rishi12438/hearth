import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, realpathSync, readdirSync, lstatSync } from "node:fs";
import { join, basename, extname, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { sha256 } from "./auth.ts";
import type { Store } from "./store/index.ts";
import type { StoredFile } from "./types.ts";

// Files you attach and files teammates make, stored on the hub next to your data (<data>/files/<id>).
// Downloads are always served as attachments with a sandbox CSP, so a file can never run inside the app.

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
/** What an agent can hand over from its workspace (a rendered video, say): bigger than what you can upload. */
export const MAX_AGENT_FILE_BYTES = 50 * 1024 * 1024;
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
/** What an agent's workspace file must look like to be shown to the user without asking: a finished thing to open. */
const SHOWN = /\.(mp4|mov|m4v|webm|mp3|m4a|wav|aac|flac|ogg|png|jpe?g|gif|webp|avif|heic|svg|pdf|docx|xlsx|pptx|csv|tsv|zip|ics)$/i;
/** A workspace's own folders (see workspaceNote in brain.ts): never shown by themselves. */
const SKIP_DIRS = new Set(["data", "scripts", "history", "archive", "skills", "attachments", "node_modules"]);
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

  async save(bytes: Uint8Array, meta: { name: string; source: StoredFile["source"]; threadId?: string; jobId?: string; teammateId?: string; origin?: string }, max = MAX_FILE_BYTES) {
    if (bytes.length > max) return { error: `That file is over ${Math.round(max / 1024 / 1024)} MB.` };
    const name = cleanName(meta.name);
    const id = randomUUID();
    writeFileSync(join(this.dir, id), bytes, { mode: 0o600 });
    const f = await this.store.put<StoredFile>("files", {
      id, createdAt: new Date().toISOString(), name, mime: mimeFor(name), size: bytes.length, sha256: sha256(bytes),
      source: meta.source, threadId: meta.threadId, jobId: meta.jobId, teammateId: meta.teammateId,
      ...(meta.origin ? { origin: meta.origin } : {}),
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

  /**
   * Copies a file an agent made in its workspace (e.g. "out/preview.mp4") into the thread, for the user to open. The
   * workspace keeps its copy. Only paths inside the workspace, links resolved, so nothing else on the hub can be sent.
   */
  async share(root: string, relPath: string, meta: Omit<Parameters<Files["save"]>[1], "name" | "origin">): Promise<{ error: string } | { value: StoredFile; path: string; status: "new" | "updated" | "same" }> {
    const want = String(relPath || "").trim().replace(/^["'`]|["'`]$/g, "");
    if (!want) return { error: "No file named." };
    let base: string, path: string;
    try {
      base = realpathSync(root);
      path = realpathSync(resolve(base, want));
    } catch { return { error: `No file called ${want} in the workspace.` }; }
    if (!path.startsWith(base + sep)) return { error: `${want} isn't in the workspace.` };
    const st = statSync(path);
    if (!st.isFile()) return { error: `${want} isn't a file.` };
    if (st.size > MAX_AGENT_FILE_BYTES) return { error: `${want} is over ${MAX_AGENT_FILE_BYTES / 1024 / 1024} MB.` };
    const bytes = readFileSync(path);
    // The same workspace file sent to this thread before: unchanged is that file again; changed is an update.
    const before = (await this.store.all<StoredFile>("files")).filter((f) => f.origin === path && f.threadId === meta.threadId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (before && before.sha256 === sha256(bytes)) return { value: before, path, status: "same" };
    const r = await this.save(bytes, { ...meta, name: basename(path), origin: path }, MAX_AGENT_FILE_BYTES);
    return "error" in r ? { error: r.error! } : { value: r.value, path, status: before ? "updated" : "new" };
  }

  /**
   * Files an agent made or changed in its workspace since `since` (ms) that look like something to hand over: media,
   * documents, spreadsheets. Not in _scratchpad/ (or any _ or . folder) or the workspace's own bookkeeping folders.
   */
  recent(root: string, since: number, max = 8): string[] {
    const found: { rel: string; at: number }[] = [];
    let seen = 0;
    const walk = (dir: string, rel: string, depth: number) => {
      let names: string[];
      try { names = readdirSync(dir); } catch { return; }
      for (const n of names) {
        if (++seen > 3000) return;
        if (n.startsWith(".") || n.startsWith("_")) continue;
        const p = join(dir, n), r = rel ? `${rel}/${n}` : n;
        let st;
        try { st = lstatSync(p); } catch { continue; }
        if (st.isDirectory()) { if (depth < 4 && !(depth === 0 && SKIP_DIRS.has(n))) walk(p, r, depth + 1); continue; }
        if (st.isFile() && st.mtimeMs >= since && SHOWN.test(n) && st.size > 0 && st.size <= MAX_AGENT_FILE_BYTES) found.push({ rel: r, at: st.mtimeMs });
      }
    };
    walk(root, "", 0);
    return found.sort((a, b) => a.at - b.at).slice(-max).map((f) => f.rel);
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
