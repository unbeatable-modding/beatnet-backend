import { Database } from "bun:sqlite";
import { chmod, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export type Attachment = { id: string; name: string; size: number; url: string };
export type SubmissionStatus = "pending" | "uploading" | "accepted" | "rejected" | "failed";
export type StoredFile = { id: string; name: string; size: number; sha256: string; file: string };
export type Submission = {
  id: string;
  guild_id: string;
  channel_id: string;
  message_id: string;
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
};

export async function openSubmissions(dataDir: string) {
  const root = resolve(dataDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const db = new Database(join(root, "beatnet.sqlite"), { create: true, strict: true });
  await chmod(join(root, "beatnet.sqlite"), 0o600);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = FULL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA foreign_keys = ON");
  db.run(`CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
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
    UNIQUE (guild_id, message_id)
  )`);
  const columns = db.query<{ name: string }, []>("PRAGMA table_info(submissions)").all();
  for (const name of ["author_name", "author_avatar", "channel_name"]) {
    if (!columns.some((column) => column.name === name)) {
      db.run(`ALTER TABLE submissions ADD COLUMN ${name} TEXT`);
    }
  }
  db.run(`CREATE TABLE IF NOT EXISTS files (
    submission_id TEXT NOT NULL REFERENCES submissions(id),
    attachment_id TEXT NOT NULL,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,
    PRIMARY KEY (submission_id, attachment_id)
  )`);

  function get(id: string) {
    return db.query<Submission, [string]>("SELECT * FROM submissions WHERE id = ?").get(id);
  }

  function record(input: {
    guildId: string;
    channelId: string;
    messageId: string;
    authorId: string;
    content: string;
    attachments: Attachment[];
  }) {
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO submissions (id, guild_id, channel_id, message_id, author_id, content, attachments, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT (guild_id, message_id) DO NOTHING`,
      [crypto.randomUUID(), input.guildId, input.channelId, input.messageId, input.authorId, input.content,
        JSON.stringify(input.attachments), now, now],
    );
    return db.query<Submission, [string, string]>(
      "SELECT * FROM submissions WHERE guild_id = ? AND message_id = ?",
    ).get(input.guildId, input.messageId)!;
  }

  function attachReview(id: string, reviewId: string) {
    db.run("UPDATE submissions SET review_id = ?, dirty = 1, version = version + 1 WHERE id = ? AND review_id IS NULL", [reviewId, id]);
  }

  function setAuthor(id: string, name: string, avatar: string, channel: string) {
    db.run("UPDATE submissions SET author_name = ?, author_avatar = ?, channel_name = ? WHERE id = ?", [name, avatar, channel, id]);
  }

  function decide(id: string, reviewId: string, reviewerId: string, action: "accept" | "reject") {
    return db.run(
      `UPDATE submissions SET status = ?, reviewer_id = ?, error = NULL, updated_at = ?, dirty = 1, version = version + 1
       WHERE id = ? AND review_id = ? AND status IN ('pending', 'failed')`,
      [action === "accept" ? "uploading" : "rejected", reviewerId, new Date().toISOString(), id, reviewId],
    ).changes === 1;
  }

  const complete = db.transaction((id: string, files: StoredFile[]) => {
    if (get(id)?.status !== "uploading") throw new Error("Submission is not uploading");
    for (const file of files) {
      db.run("INSERT INTO files (submission_id, attachment_id, name, size, sha256, storage_key) VALUES (?, ?, ?, ?, ?, ?)",
        [id, file.id, file.name, file.size, file.sha256, `accepted/${id}/${file.file}`]);
    }
    db.run("UPDATE submissions SET status = 'accepted', error = NULL, updated_at = ?, dirty = 1, version = version + 1 WHERE id = ?",
      [new Date().toISOString(), id]);
  });

  function fail(id: string, error: string) {
    db.run(
      "UPDATE submissions SET status = 'failed', error = ?, updated_at = ?, dirty = 1, version = version + 1 WHERE id = ? AND status = 'uploading'",
      [error.slice(0, 500), new Date().toISOString(), id],
    );
  }

  return {
    root, get, record, attachReview, setAuthor, decide, complete, fail,
    files: (id: string) => db.query("SELECT * FROM files WHERE submission_id = ?").all(id),
    interrupted: () => db.query<Submission, []>("SELECT * FROM submissions WHERE status = 'uploading'").all(),
    outstanding: () => db.query<Submission, []>("SELECT * FROM submissions WHERE dirty = 1").all(),
    notified: (id: string, version: number) => db.run("UPDATE submissions SET dirty = 0 WHERE id = ? AND version = ?", [id, version]),
    isReady: () => {
      try {
        return db.query("SELECT 1").get() !== null;
      } catch {
        return false;
      }
    },
    close: () => db.close(),
  };
}

export type Submissions = Awaited<ReturnType<typeof openSubmissions>>;
