import { createHash } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { open } from "yauzl-promise";

const pending = new Map<string, Promise<string | null>>();
const waiting: Array<() => void> = [];
let active = 0;

export function validCoverPath(path: string) {
  return !path.startsWith("/") && !path.includes("\\")
    && path.split("/").every((part) => part.length > 0 && part !== "." && part !== ".." && !part.includes(":"))
    && /(?:^|\/)cover\.(png|jpe?g)$/i.test(path);
}

export async function prepareCover(archivePath: string, checksum: string, entryPath: string) {
  if (!validCoverPath(entryPath)) {
    return null;
  }
  const key = createHash("sha256").update(checksum + entryPath).digest("hex");
  const path = join(dirname(archivePath), `.cover-v1-${key}.jpg`);
  if (await Bun.file(path).exists()) {
    return path;
  }
  let task = pending.get(path);
  if (!task) {
    task = createCover(archivePath, entryPath, path).finally(() => pending.delete(path));
    pending.set(path, task);
  }
  return task;
}

async function createCover(archivePath: string, entryPath: string, path: string) {
  if (active >= 2) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else {
    active++;
  }
  const source = `${path}.${crypto.randomUUID()}.source`;
  const output = `${source}.jpg`;
  try {
    const archive = await open(archivePath);
    let found = false;
    try {
      for await (const entry of archive) {
        if (entry.filename.replace(/\\/g, "/") !== entryPath) {
          continue;
        }
        if (entry.uncompressedSize <= 0 || entry.uncompressedSize > 33_554_432) {
          return null;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of await entry.openReadStream()) {
          size += chunk.length;
          if (size > 33_554_432) {
            return null;
          }
          chunks.push(Buffer.from(chunk));
        }
        if (size !== entry.uncompressedSize) {
          return null;
        }
        await Bun.write(source, Buffer.concat(chunks));
        found = true;
        break;
      }
    } finally {
      await archive.close();
    }
    if (!found) {
      return null;
    }
    const probe = Bun.spawn([
      "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", source,
    ], { stdout: "pipe", stderr: "ignore" });
    const probeTimer = setTimeout(() => probe.kill(), 10_000);
    const [description, probeCode] = await Promise.all([new Response(probe.stdout).text(), probe.exited])
      .finally(() => clearTimeout(probeTimer));
    const dimensions = (JSON.parse(description) as { streams?: Array<{ width: number; height: number }> }).streams?.[0];
    if (probeCode !== 0 || !dimensions || !Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height)
      || dimensions.width <= 0 || dimensions.height <= 0 || dimensions.width * dimensions.height > 16_777_216) {
      return null;
    }
    for (const quality of [6, 10, 16]) {
      const process = Bun.spawn([
        "ffmpeg", "-v", "error", "-nostdin", "-y", "-threads", "1", "-i", source,
        "-vf", "scale=w='min(512,iw)':h='min(512,ih)':force_original_aspect_ratio=decrease",
        "-frames:v", "1", "-q:v", String(quality), "-threads", "1", output,
      ], { stdout: "ignore", stderr: "ignore" });
      const timer = setTimeout(() => process.kill(), 20_000);
      const code = await process.exited.finally(() => clearTimeout(timer));
      if (code === 0 && Bun.file(output).size > 0 && Bun.file(output).size <= 98304) {
        await rename(output, path);
        return path;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await Promise.allSettled([rm(source, { force: true }), rm(output, { force: true })]);
    const next = waiting.shift();
    if (next) {
      next();
    } else {
      active--;
    }
  }
}

export async function streamCover(request: Request, path: string) {
  const file = Bun.file(path);
  const etag = `"${path.split(/[\\/]/).pop()}"`;
  const headers = new Headers({
    "Content-Type": "image/jpeg",
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    ETag: etag,
  });
  if (request.headers.get("If-None-Match")?.split(",").some((tag) => tag.trim() === "*" || tag.trim().replace(/^W\//, "") === etag)) {
    return new Response(null, { status: 304, headers });
  }
  headers.set("Content-Length", String(file.size));
  return new Response(request.method === "HEAD" ? null : file, { headers });
}
