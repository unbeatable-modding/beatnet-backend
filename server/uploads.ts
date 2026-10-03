import { createHash } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import type { Attachment, StoredFile, Submission } from "./submissions";

export type Manifest = {
  submissionId: string;
  files: StoredFile[];
};

export class Uploads {
  constructor(
    private readonly staging: string,
    private readonly beatmaps: string,
    private readonly config: Pick<Config, "maxUploadBytes" | "uploadTimeoutMs">,
    private readonly fetchFile: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  ) {}

  private directory(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) {
      throw new Error("Invalid submission ID");
    }
    return join(this.beatmaps, id);
  }

  async stored(submission: Submission): Promise<Manifest | null> {
    const folder = this.directory(submission.id);
    let text: string;
    try {
      text = await readFile(join(folder, "manifest.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    const manifest = JSON.parse(text) as Manifest;
    const attachments = JSON.parse(submission.attachments) as Attachment[];
    if (manifest.submissionId !== submission.id || !Array.isArray(manifest.files) || manifest.files.length !== attachments.length) {
      throw new Error("Stored submission is incomplete");
    }
    for (let index = 0; index < attachments.length; index++) {
      const source = attachments[index]!;
      const file = manifest.files[index]!;
      if (file.id !== source.id || file.size !== source.size || file.name !== source.name || file.file !== `${source.id}.zip`) {
        throw new Error("Stored attachment does not match the submission");
      }
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of Bun.file(join(folder, file.file)).stream()) {
        size += chunk.length;
        hash.update(chunk);
      }
      if (size !== file.size || hash.digest("hex") !== file.sha256) {
        throw new Error("Stored ZIP failed verification");
      }
    }
    return manifest;
  }

  async save(submission: Submission, attachments: Attachment[]) {
    let existing: Manifest | null = null;
    try {
      existing = await this.stored(submission);
    } catch {
      await this.remove(submission.id);
      console.log("stored upload needs a retry");
    }

    if (existing) {
      return existing;
    }

    this.validateAttachments(submission, attachments);

    let temporary: string | undefined;
    try {
      temporary = await mkdtemp(join(this.staging, `${submission.id}-`));
      const files: StoredFile[] = [];
      const signal = AbortSignal.timeout(this.config.uploadTimeoutMs);
      for (const attachment of attachments) {
        files.push(await this.downloadAttachment(attachment, temporary, signal));
      }

      const manifest: Manifest = { submissionId: submission.id, files };
      await this.writeManifest(temporary, manifest);
      await rename(temporary, this.directory(submission.id));
      temporary = undefined;
      return manifest;
    } finally {
      if (temporary) {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  }

  private validateAttachments(submission: Submission, attachments: Attachment[]) {
    const original = JSON.parse(submission.attachments) as Attachment[];
    if (!original.length || original.length !== attachments.length) {
      throw new Error("ZIP attachments changed after submission");
    }

    let total = 0;
    for (let index = 0; index < original.length; index++) {
      const attachment = attachments[index]!;
      const source = original[index]!;
      if (attachment.size > this.config.maxUploadBytes) {
        throw new Error("ZIP exceeds the upload limit");
      }
      if (attachment.id !== source.id || attachment.name !== source.name || attachment.size !== source.size) {
        throw new Error("ZIP attachments changed after submission");
      }
      total += attachment.size;
    }

    if (total > this.config.maxUploadBytes) {
      throw new Error("Submission exceeds the upload limit");
    }
  }

  private async downloadAttachment(attachment: Attachment, folder: string, signal: AbortSignal): Promise<StoredFile> {
    const response = await this.fetchFile(attachment.url, { redirect: "error", signal });
    if (!response.ok || !response.body) {
      throw new Error("Discord attachment download failed");
    }

    const filename = `${attachment.id}.zip`;
    const file = await open(join(folder, filename), "wx", 0o600);
    const hash = createHash("sha256");
    const reader = response.body.getReader();
    let size = 0;

    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        size += value.length;
        if (size > attachment.size) {
          throw new Error("ZIP download exceeds the declared size");
        }

        hash.update(value);
        await file.writeFile(value);
      }

      if (size !== attachment.size) {
        throw new Error("ZIP download is incomplete");
      }
      await file.sync();
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      await file.close();
    }

    return { id: attachment.id, name: attachment.name, size, sha256: hash.digest("hex"), file: filename };
  }

  private async writeManifest(folder: string, manifest: Manifest) {
    const file = await open(join(folder, "manifest.json"), "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(manifest, null, 2));
      await file.sync();
    } finally {
      await file.close();
    }
  }

  async remove(id: string) {
    const folder = this.directory(id);
    await rm(folder, { recursive: true, force: true });
  }

  path(id: string, name: string) {
    if (!/^[0-9a-f-]{36}\.zip$/.test(name) && !/^\d{17,20}\.zip$/.test(name)) {
      throw new Error("Invalid stored ZIP name");
    }
    return join(this.directory(id), name);
  }

  async isReady() {
    try {
      await access(this.staging, constants.R_OK | constants.W_OK);
      await access(this.beatmaps, constants.R_OK | constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
}

export async function openUploads(
  root: string,
  config: Pick<Config, "maxUploadBytes" | "uploadTimeoutMs">,
  fetchFile: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
) {
  const staging = join(root, "staging");
  const beatmaps = join(root, "beatmaps");
  await mkdir(staging, { recursive: true, mode: 0o700 });
  await mkdir(beatmaps, { recursive: true, mode: 0o700 });
  for (const folder of [staging, beatmaps]) {
    const entry = await lstat(folder);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("Upload storage must use real directories");
    }
  }
  for (const entry of await readdir(staging, { withFileTypes: true })) {
    if (entry.isDirectory() && /^[0-9a-f-]{36}-[a-zA-Z0-9]{6}$/.test(entry.name)) {
      await rm(join(staging, entry.name), { recursive: true, force: true });
    }
  }
  return new Uploads(staging, beatmaps, config, fetchFile);
}
