import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import type { Attachment, StoredFile, Submission } from "./submissions";

type Manifest = { submissionId: string; files: StoredFile[] };

export function checkAttachment(attachment: Attachment, maxBytes: number) {
  if (!/^\d{17,20}$/.test(attachment.id) || !/\.zip$/i.test(attachment.name)) {
    throw new Error("Invalid ZIP attachment");
  }
  if (!Number.isSafeInteger(attachment.size) || attachment.size < 22 || attachment.size > maxBytes) {
    throw new Error("ZIP exceeds the upload limit or is empty");
  }
  const url = new URL(attachment.url);
  if (url.protocol !== "https:" || !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)
    || url.port || url.username || url.password
    || !new RegExp(`^/attachments/\\d{17,20}/${attachment.id}/[^/]+$`).test(url.pathname)) {
    throw new Error("Invalid Discord attachment URL");
  }
}

export async function checkZip(path: string) {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    async function read(position: number, length: number) {
      if (position < 0 || position + length > size) throw new Error("Incomplete ZIP archive");
      const data = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await file.read(data, offset, length - offset, position + offset);
        if (!bytesRead) throw new Error("Incomplete ZIP archive");
        offset += bytesRead;
      }
      return data;
    }
    if (size < 22 || (await read(0, 4)).readUInt32LE(0) !== 0x04034b50) throw new Error("Invalid ZIP archive");
    const tailOffset = Math.max(0, size - 22 - 65535);
    const tail = await read(tailOffset, size - tailOffset);
    let end = tail.length - 22;
    while (end >= 0) {
      if (tail.readUInt32LE(end) === 0x06054b50 && end + 22 + tail.readUInt16LE(end + 20) === tail.length) break;
      end--;
    }
    if (end < 0) throw new Error("Incomplete ZIP archive");
    const count = tail.readUInt16LE(end + 10);
    const offset = tail.readUInt32LE(end + 16);
    const length = tail.readUInt32LE(end + 12);
    if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6)
      || tail.readUInt16LE(end + 8) !== count || !count || count > 10000 || length > 8 * 1024 * 1024
      || offset + length !== tailOffset + end) throw new Error("Unsupported ZIP archive");
    const data = await read(offset, length);
    let cursor = 0;
    const paths = new Set<string>();
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > length || data.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Invalid ZIP directory");
      const nameLength = data.readUInt16LE(cursor + 28);
      const next = cursor + 46 + nameLength + data.readUInt16LE(cursor + 30) + data.readUInt16LE(cursor + 32);
      if (next > length) throw new Error("Invalid ZIP entry");
      const nameBytes = data.subarray(cursor + 46, cursor + 46 + nameLength);
      const name = nameBytes.toString("utf8").replaceAll("\\", "/");
      const parts = name.replace(/\/$/, "").split("/");
      if (!name || name.startsWith("/") || /[:\x00-\x1f]/.test(name) || parts.some((part) => !part || part === "." || part === "..")
        || paths.has(name.toLowerCase())) throw new Error("Unsafe or duplicate ZIP path");
      paths.add(name.toLowerCase());
      if ((data.readUInt16LE(cursor + 8) & 1) || ![0, 8].includes(data.readUInt16LE(cursor + 10))
        || ((data.readUInt32LE(cursor + 38) >>> 16) & 0xf000) === 0xa000) throw new Error("Unsupported ZIP entry");
      const local = data.readUInt32LE(cursor + 42);
      if (local + 30 > offset) throw new Error("Invalid ZIP entry data");
      const header = await read(local, 30);
      if (header.readUInt32LE(0) !== 0x04034b50) throw new Error("Invalid ZIP entry data");
      const localNameLength = header.readUInt16LE(26);
      const start = local + 30 + localNameLength + header.readUInt16LE(28);
      if (start + data.readUInt32LE(cursor + 20) > offset
        || !(await read(local + 30, localNameLength)).equals(nameBytes)
        || header.readUInt16LE(8) !== data.readUInt16LE(cursor + 10)
        || header.readUInt16LE(6) !== data.readUInt16LE(cursor + 8)) throw new Error("Incomplete ZIP entry data");
      cursor = next;
    }
    if (cursor !== length) throw new Error("Invalid ZIP directory size");
  } finally {
    await file.close();
  }
}

export async function openUploads(root: string, config: Pick<Config, "maxUploadBytes" | "uploadTimeoutMs">, fetchFile: typeof fetch = fetch) {
  const staging = join(root, "staging");
  const accepted = join(root, "accepted");
  await mkdir(staging, { recursive: true, mode: 0o700 });
  await mkdir(accepted, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(staging, { withFileTypes: true })) {
    if (entry.isDirectory() && /^[0-9a-f-]{36}-[a-zA-Z0-9]{6}$/.test(entry.name)) {
      await rm(join(staging, entry.name), { recursive: true, force: true });
    }
  }
  let active = false;

  function directory(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid submission ID");
    return join(accepted, id);
  }

  async function stored(submission: Submission): Promise<Manifest | null> {
    const folder = directory(submission.id);
    let text: string;
    try {
      text = await readFile(join(folder, "manifest.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const manifest = JSON.parse(text) as Manifest;
    const attachments = JSON.parse(submission.attachments) as Attachment[];
    if (manifest.submissionId !== submission.id || !Array.isArray(manifest.files) || manifest.files.length !== attachments.length) {
      throw new Error("Stored submission is incomplete");
    }
    for (let i = 0; i < attachments.length; i++) {
      const source = attachments[i]!;
      const file = manifest.files[i]!;
      if (file.id !== source.id || file.size !== source.size || file.name !== source.name || file.file !== `${source.id}.zip`) {
        throw new Error("Stored attachment does not match the submission");
      }
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of Bun.file(join(folder, file.file)).stream()) {
        size += chunk.length;
        hash.update(chunk);
      }
      if (size !== file.size || hash.digest("hex") !== file.sha256) throw new Error("Stored ZIP failed verification");
    }
    return manifest;
  }

  async function save(submission: Submission, attachments: Attachment[]) {
    if (active) throw new Error("Another upload is running, try Accept again shortly");
    active = true;
    let temporary: string | undefined;
    try {
      const existing = await stored(submission);
      if (existing) return existing;
      const original = JSON.parse(submission.attachments) as Attachment[];
      if (!original.length || original.length !== attachments.length) throw new Error("ZIP attachments changed after submission");
      let total = 0;
      for (let i = 0; i < original.length; i++) {
        const attachment = attachments[i]!;
        const source = original[i]!;
        checkAttachment(attachment, config.maxUploadBytes);
        if (attachment.id !== source.id || attachment.name !== source.name || attachment.size !== source.size) {
          throw new Error("ZIP attachments changed after submission");
        }
        total += attachment.size;
      }
      if (total > config.maxUploadBytes) throw new Error("Submission exceeds the upload limit");
      temporary = await mkdtemp(join(staging, `${submission.id}-`));
      const files: StoredFile[] = [];
      const signal = AbortSignal.timeout(config.uploadTimeoutMs);
      for (const attachment of attachments) {
        const response = await fetchFile(attachment.url, {
          redirect: "error", signal,
        });
        if (!response.ok || !response.body) throw new Error("Discord attachment download failed");
        const filename = `${attachment.id}.zip`;
        const path = join(temporary, filename);
        const file = await open(path, "wx", 0o600);
        const hash = createHash("sha256");
        let size = 0;
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > attachment.size || size > config.maxUploadBytes) throw new Error("ZIP download exceeds the declared size");
            hash.update(value);
            await file.writeFile(value);
          }
          if (size !== attachment.size) throw new Error("ZIP download is incomplete");
          await file.sync();
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
          await file.close();
        }
        await checkZip(path);
        files.push({ id: attachment.id, name: attachment.name, size, sha256: hash.digest("hex"), file: filename });
      }
      const manifest: Manifest = { submissionId: submission.id, files };
      const file = await open(join(temporary, "manifest.json"), "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(manifest, null, 2));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, directory(submission.id));
      temporary = undefined;
      return manifest;
    } finally {
      active = false;
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }

  return { save, stored, isReady: async () => {
    try {
      await access(staging, constants.R_OK | constants.W_OK);
      await access(accepted, constants.R_OK | constants.W_OK);
      return true;
    } catch {
      return false;
    }
  } };
}

export type Uploads = Awaited<ReturnType<typeof openUploads>>;
