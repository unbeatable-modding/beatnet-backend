import { Database } from "bun:sqlite";
import { chmod, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Registry, type Metadata } from "./registry";

export type Attachment = {
  id: string;
  name: string;
  size: number;
  url: string;
};
export type SubmissionStatus = "pending" | "uploading" | "accepted" | "rejected" | "failed";
export type StoredFile = {
  id: string;
  name: string;
  size: number;
  sha256: string;
  file: string;
};
export type FileRecord = {
  id: string;
  name: string;
  size: number;
  sha256: string;
  storage_key: string;
};
export type Submission = {
  id: string;
  guild_id: string;
  channel_id: string;
  message_id: string;
  attachment_id: string;
  author_id: string;
  author_name: string | null;
  author_avatar: string | null;
  channel_name: string | null;
  content: string;
  attachments: string;
  review_id: string | null;
  status: SubmissionStatus;
  reviewer_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  dirty: number;
  target_project_id: string | null;
  base_revision_id: string | null;
  assignment_version: number;
  source: string;
};

export class Submissions {
  readonly registry: Registry;

  constructor(
    readonly root: string,
    private readonly db: Database,
  ) {
    this.registry = new Registry(db);
  }

  get(id: string) {
    return this.db.query<Submission, [string]>("SELECT * FROM submissions WHERE id = ?").get(id);
  }

  files(id: string) {
    return this.db.query<FileRecord, [string]>(
      "SELECT attachment_id AS id, name, size, sha256, storage_key FROM files WHERE submission_id = ? ORDER BY attachment_id",
    ).all(id);
  }

  record(input: {
    guildId: string;
    channelId: string;
    messageId: string;
    authorId: string;
    content: string;
    attachment: Attachment;
  }) {
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO submissions (id, guild_id, channel_id, message_id, attachment_id, author_id, content, attachments, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT (guild_id, message_id, attachment_id) DO NOTHING`,
      [
        crypto.randomUUID(),
        input.guildId,
        input.channelId,
        input.messageId,
        input.attachment.id,
        input.authorId,
        input.content,
        JSON.stringify([input.attachment]),
        now,
        now,
      ],
    );
    return this.db
      .query<Submission, [string, string, string]>("SELECT * FROM submissions WHERE guild_id = ? AND message_id = ? AND attachment_id = ?")
      .get(input.guildId, input.messageId, input.attachment.id)!;
  }

  attachReview(id: string, reviewId: string) {
    this.db.run("UPDATE submissions SET review_id = ?, dirty = 1, version = version + 1 WHERE id = ? AND review_id IS NULL", [
      reviewId,
      id,
    ]);
  }

  setAuthor(id: string, name: string, avatar: string, channel: string) {
    this.db.run("UPDATE submissions SET author_name = ?, author_avatar = ?, channel_name = ? WHERE id = ?", [name, avatar, channel, id]);
  }

  decide(id: string, reviewId: string, reviewerId: string, action: "accept" | "reject", assignmentVersion: number) {
    if (action === "accept") {
      this.registry.checkTarget(id);
    }
    return (
      this.db.run(
        `UPDATE submissions SET status = ?, reviewer_id = ?, error = NULL, updated_at = ?, dirty = 1, version = version + 1
       WHERE id = ? AND review_id = ? AND assignment_version = ? AND status IN ('pending', 'failed')`,
        [action === "accept" ? "uploading" : "rejected", reviewerId, new Date().toISOString(), id, reviewId, assignmentVersion],
      ).changes === 1
    );
  }

  complete(id: string, files: StoredFile[], metadata: Metadata) {
    return this.db.transaction(() => this.saveFiles(id, files, metadata)).immediate();
  }

  private saveFiles(id: string, files: StoredFile[], metadata: Metadata) {
    if (this.get(id)?.status !== "uploading") {
      throw new Error("Submission is not uploading");
    }
    for (const file of files) {
      this.db.run("INSERT INTO files (submission_id, attachment_id, name, size, sha256, storage_key) VALUES (?, ?, ?, ?, ?, ?)", [
        id,
        file.id,
        file.name,
        file.size,
        file.sha256,
        `beatmaps/${id}/${file.file}`,
      ]);
    }
    this.db.run("UPDATE submissions SET status = 'accepted', error = NULL, updated_at = ?, dirty = 1, version = version + 1 WHERE id = ?", [
      new Date().toISOString(),
      id,
    ]);
    return this.registry.publish(id, metadata);
  }

  fail(id: string, error: string) {
    this.db.run(
      "UPDATE submissions SET status = 'failed', error = ?, updated_at = ?, dirty = 1, version = version + 1 WHERE id = ? AND status = 'uploading'",
      [error.slice(0, 500), new Date().toISOString(), id],
    );
  }

  interrupted() {
    return this.db.query<Submission, []>("SELECT * FROM submissions WHERE status = 'uploading'").all();
  }

  rejected() {
    return this.db.query<{ id: string }, []>("SELECT id FROM submissions WHERE status = 'rejected'").all();
  }

  outstanding() {
    return this.db.query<Submission, []>("SELECT * FROM submissions WHERE dirty = 1 AND source = 'discord'").all();
  }

  notified(id: string, version: number) {
    return this.db.run("UPDATE submissions SET dirty = 0 WHERE id = ? AND version = ?", [id, version]);
  }

  isReady() {
    try {
      return this.db.query("SELECT 1").get() !== null;
    } catch {
      return false;
    }
  }

  close() {
    return this.db.close();
  }
}

const submissionSchema = `(
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_name TEXT,
  author_avatar TEXT,
  channel_name TEXT,
  content TEXT NOT NULL,
  attachments TEXT NOT NULL,
  review_id TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'uploading', 'accepted', 'rejected', 'failed')),
  reviewer_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  dirty INTEGER NOT NULL DEFAULT 1,
  target_project_id TEXT REFERENCES projects(id),
  base_revision_id TEXT,
  assignment_version INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'discord',
  UNIQUE (guild_id, message_id, attachment_id)
)`;

function migrateAttachments(db: Database) {
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(submissions)").all();
  if (!columns.some((column) => column.name === "attachment_id")) {
    db.run("PRAGMA foreign_keys = OFF");
    try {
      db.transaction(() => {
        db.run(`CREATE TABLE submissions_new ${submissionSchema}`);
        const names = columns.map((column) => `"${column.name.replaceAll('"', '""')}"`).join(", ");
        db.run(`INSERT INTO submissions_new (${names}, attachment_id)
          SELECT ${names}, COALESCE(CASE WHEN json_array_length(attachments) = 1 THEN json_extract(attachments, '$[0].id') END, '') FROM submissions`);
        db.run("DROP TABLE submissions");
        db.run("ALTER TABLE submissions_new RENAME TO submissions");
        db.run("UPDATE submissions SET dirty = 1, version = version + 1 WHERE source = 'discord'");
      }).immediate();
    } finally {
      db.run("PRAGMA foreign_keys = ON");
    }
  }
}

export async function openSubmissions(dataDir: string) {
  const root = resolve(dataDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const db = new Database(join(root, "beatnet.sqlite"), { create: true, strict: true });
  await chmod(join(root, "beatnet.sqlite"), 0o600);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = FULL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE IF NOT EXISTS submissions ${submissionSchema}`);
  migrateAttachments(db);
  db.run(`CREATE TABLE IF NOT EXISTS files (
    submission_id TEXT NOT NULL REFERENCES submissions(id),
    attachment_id TEXT NOT NULL,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,
    PRIMARY KEY (submission_id, attachment_id)
  )`);
  return new Submissions(root, db);
}
