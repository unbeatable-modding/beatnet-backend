import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { open } from "yauzl-promise";

const pending = new Map<string, Promise<string | null>>();

export async function extractAudio(archivePath: string, checksum: string, entryPath: string) {
  const extension = extname(entryPath).toLowerCase();
  if (![".mp3", ".ogg", ".wav", ".flac"].includes(extension)) {
    return null;
  }
  const key = createHash("sha256").update(checksum + entryPath).digest("hex");
  const path = join(dirname(archivePath), `.preview-${key}${extension}`);
  if (await Bun.file(path).exists()) {
    return path;
  }
  let task = pending.get(path);
  if (!task) {
    task = extract(archivePath, entryPath, path).finally(() => pending.delete(path));
    pending.set(path, task);
  }
  return task;
}

export async function previewClip(audioPath: string, start: number) {
  const path = `${audioPath}.${start}.15pct.preview.mp3`;
  if (await Bun.file(path).exists()) {
    return path;
  }
  let task = pending.get(path);
  if (!task) {
    task = encodeClip(audioPath, start, path).finally(() => pending.delete(path));
    pending.set(path, task);
  }
  return task;
}

async function encodeClip(audioPath: string, start: number, path: string) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const duration = await audioDuration(audioPath);
    const fallback = duration * 0.15;
    const offset = Number.isFinite(start) && start > 0 && start < duration ? start : fallback;
    for (const position of offset === fallback ? [fallback] : [offset, fallback]) {
      const process = Bun.spawn([
        "ffmpeg", "-v", "error", "-nostdin", "-y", "-ss", String(position), "-i", audioPath,
        "-t", "30", "-vn", "-ac", "2", "-ar", "44100", "-b:a", "128k", "-f", "mp3", temporary,
      ], { stdout: "ignore", stderr: "ignore" });
      const timer = setTimeout(() => process.kill(), 30_000);
      const code = await process.exited.finally(() => clearTimeout(timer));
      if (code === 0 && Bun.file(temporary).size > 1024) {
        await rename(temporary, path);
        return path;
      }
    }
    throw new Error("Cannot prepare audio preview");
  } finally {
    await rm(temporary, { force: true });
  }
}

async function audioDuration(path: string) {
  const process = Bun.spawn([
    "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path,
  ], { stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => process.kill(), 10_000);
  try {
    const [output, code] = await Promise.all([new Response(process.stdout).text(), process.exited]);
    const duration = Number(output.trim());
    if (code !== 0 || !Number.isFinite(duration) || duration <= 0) {
      throw new Error("Cannot read audio duration");
    }
    return duration;
  } finally {
    clearTimeout(timer);
  }
}

async function extract(archivePath: string, entryPath: string, path: string) {
  const archive = await open(archivePath);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    for await (const entry of archive) {
      if (entry.filename.replace(/\\/g, "/") !== entryPath) {
        continue;
      }
      if (entry.uncompressedSize <= 0 || entry.uncompressedSize > 536_870_912) {
        return null;
      }
      await pipeline(await entry.openReadStream(), createWriteStream(temporary, { flags: "wx", mode: 0o600 }));
      if (Bun.file(temporary).size !== entry.uncompressedSize) {
        throw new Error("Audio size does not match");
      }
      await rename(temporary, path);
      return path;
    }
    return null;
  } finally {
    await archive.close();
    await rm(temporary, { force: true });
  }
}

export async function streamAudio(request: Request, path: string) {
  const file = Bun.file(path);
  const types: Record<string, string> = { ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav", ".flac": "audio/flac" };
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Content-Type": types[extname(path)]!,
    "Cache-Control": "public, max-age=86400, immutable",
    "X-Content-Type-Options": "nosniff",
  });
  const range = request.headers.get("Range");
  let start = 0;
  let end = file.size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      headers.set("Content-Range", `bytes */${file.size}`);
      return new Response(null, { status: 416, headers });
    }
    start = match[1] ? Number(match[1]) : Math.max(0, file.size - Number(match[2]));
    end = match[1] && match[2] ? Math.min(end, Number(match[2])) : end;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= file.size || (!match[1] && Number(match[2]) <= 0)) {
      headers.set("Content-Range", `bytes */${file.size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set("Content-Range", `bytes ${start}-${end}/${file.size}`);
  }
  headers.set("Content-Length", String(end - start + 1));
  return new Response(request.method === "HEAD" ? null : file.slice(start, end + 1), { status: range ? 206 : 200, headers });
}
