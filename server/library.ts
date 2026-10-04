import { readMetadata } from "./metadata";
import type { Attachment, Submission, Submissions } from "./submissions";
import type { Uploads } from "./uploads";

export class Library {
  private queue = Promise.resolve();
  private stopping = false;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly submissions: Submissions,
    private readonly uploads: Uploads,
  ) {}

  exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopping) {
      return Promise.reject(new Error("Backend is stopping"));
    }
    const task = this.queue.then(work).finally(() => this.notifyListeners());
    this.queue = task.then(() => {}).catch(() => {});
    return task;
  }

  private notifyListeners() {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        console.error("notification sync failed");
      }
    }
  }

  watch(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  accept(
    id: string,
    reviewId: string,
    reviewerId: string,
    assignmentVersion: number,
    getAttachments: () => Promise<Attachment[]>,
    onChange: () => Promise<void>,
  ) {
    return this.exclusive(async () => {
      if (!this.submissions.decide(id, reviewId, reviewerId, "accept", assignmentVersion)) {
        throw new Error("This review changed or was already processed");
      }

      await onChange().catch(() => {});
      try {
        const submission = this.submissions.get(id)!;
        const attachments = await getAttachments();
        const manifest = await this.uploads.save(submission, attachments);
        const metadata = await readMetadata(this.uploads, manifest, submission.author_name ?? "");
        const revision = this.submissions.complete(id, manifest.files, metadata);
        await this.removeOldFiles(revision.project_id);
        return revision;
      } catch (error) {
        this.submissions.fail(id, error instanceof Error ? error.message : "Upload failed");
        throw error;
      }
    });
  }

  reject(id: string, reviewId: string, reviewerId: string, assignmentVersion: number) {
    return this.exclusive(async () => {
      if (!this.submissions.decide(id, reviewId, reviewerId, "reject", assignmentVersion)) {
        throw new Error("This review changed or was already processed");
      }
      await this.uploads.remove(id);
    });
  }

  recover() {
    return this.exclusive(() => this.recoverStorage());
  }

  private async removeOldFiles(projectId?: string) {
    for (const revision of this.submissions.registry.obsolete(projectId)) {
      try {
        await this.uploads.remove(revision.submission_id);
        this.submissions.removeOldFiles(revision.submission_id);
      } catch {
        console.warn(`cannot remove old beatmap files ${revision.submission_id}`);
      }
    }
  }

  private async recoverStorage() {
    for (const submission of this.submissions.rejected()) {
      await this.uploads.remove(submission.id);
    }
    for (const submission of this.submissions.interrupted()) {
      await this.recoverSubmission(submission);
    }

    for (const project of this.submissions.registry.needsMetadata()) {
      const revision = this.submissions.registry.byRevision(project.current_revision_id)!;
      const submission = this.submissions.get(revision.submission_id)!;
      try {
        const manifest = await this.uploads.stored(submission);
        if (manifest) {
          const metadata = await readMetadata(this.uploads, manifest, submission.author_name ?? "");
          this.submissions.registry.enrich(submission.id, metadata);
        }
      } catch {
        console.warn(`cannot restore metadata for ${project.title}`);
        continue;
      }
    }
    await this.removeOldFiles();
  }

  private async recoverSubmission(submission: Submission) {
    try {
      const manifest = await this.uploads.stored(submission);
      if (!manifest) {
        this.submissions.fail(submission.id, "Upload interrupted by a restart, press Accept to retry");
        return;
      }

      const metadata = await readMetadata(this.uploads, manifest, submission.author_name ?? "");
      this.submissions.complete(submission.id, manifest.files, metadata);
    } catch (error) {
      this.submissions.fail(submission.id, error instanceof Error ? error.message : "Recovery failed");
    }
  }

  async stop() {
    this.stopping = true;
    await this.queue;
    this.listeners.clear();
  }
}
