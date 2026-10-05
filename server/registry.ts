import type { Database } from "bun:sqlite";
import { createRatings } from "./ratings";

export type Metadata = {
  title: string;
  artist: string;
  creator: string;
  search: string;
  difficulties?: string[];
  chartInfo?: {
    levels: Record<string, number>;
    labels: Record<string, string>;
    charts?: { hash: string; difficulty: string }[];
    preview?: { fileId: string; path: string; start: number };
    cover?: { fileId: string; path: string } | null;
  };
};
export type Project = {
  id: string;
  title: string;
  artist: string;
  creator: string;
  submitter: string;
  current_revision_id: string;
  number: number;
  metadata_ready: number;
  difficulties: string | null;
  chart_info: string | null;
  rating: number;
  rating_count: number;
  created_at: string;
  updated_at: string;
};
export type Revision = {
  id: string;
  project_id: string;
  number: number;
  submission_id: string;
  title: string;
  artist: string;
  creator: string;
  changelog: string;
  reviewer_id: string;
  created_at: string;
};
type UpdateTarget = {
  id: string;
  target_project_id: string | null;
  base_revision_id: string | null;
};

type LegacySubmission = {
  id: string;
  attachments: string;
  author_name: string | null;
};

type SubmissionAuthor = {
  author_name: string | null;
  author_id: string;
  reviewer_id: string | null;
  content: string;
};

type SubmissionOrigin = {
  guild_id: string;
  channel_id: string;
  message_id: string;
  source: string;
};

function searchText(value: string) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

export class Registry {
  private readonly projectQuery = `SELECT p.id, p.title, p.artist, p.creator, p.submitter, p.current_revision_id,
    r.number, p.metadata_ready, p.difficulties, p.chart_info, p.created_at, p.updated_at,
    COALESCE((SELECT AVG(value) FROM ratings WHERE project_id = p.id), 0) AS rating,
    (SELECT COUNT(*) FROM ratings WHERE project_id = p.id) AS rating_count
    FROM projects p JOIN revisions r ON r.id = p.current_revision_id`;

  constructor(private readonly db: Database) {
    this.db.transaction(() => this.createTables()).immediate();
    if (!this.db.query("SELECT 1 FROM migrations WHERE version = 2").get()) {
      this.db.transaction(() => this.importLegacy()).immediate();
    }
  }

  private createTables() {
    createRatings(this.db);
    this.db.run(`CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL, creator TEXT NOT NULL,
      submitter TEXT NOT NULL, submitter_id TEXT NOT NULL, search_text TEXT NOT NULL, current_revision_id TEXT NOT NULL,
      metadata_ready INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    const projectColumns = this.db.query<{ name: string }, []>("PRAGMA table_info(projects)").all();
    if (!projectColumns.some((column) => column.name === "difficulties")) {
      this.db.run("ALTER TABLE projects ADD COLUMN difficulties TEXT");
    }
    if (!projectColumns.some((column) => column.name === "chart_info")) {
      this.db.run("ALTER TABLE projects ADD COLUMN chart_info TEXT");
    }
    const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(submissions)").all();
    const additions = {
      target_project_id: "TEXT REFERENCES projects(id)",
      base_revision_id: "TEXT",
      assignment_version: "INTEGER NOT NULL DEFAULT 0",
      source: "TEXT NOT NULL DEFAULT 'discord'",
    };
    for (const [name, type] of Object.entries(additions)) {
      if (!columns.some((column) => column.name === name)) {
        this.db.run(`ALTER TABLE submissions ADD COLUMN ${name} ${type}`);
      }
    }
    this.db.run(`CREATE TABLE IF NOT EXISTS revisions (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), number INTEGER NOT NULL,
      submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(id), title TEXT NOT NULL,
      artist TEXT NOT NULL, creator TEXT NOT NULL, changelog TEXT NOT NULL,
      reviewer_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (project_id, number)
    )`);
    this.db.run("CREATE INDEX IF NOT EXISTS submissions_target ON submissions(target_project_id)");
    if (!this.db.query("SELECT 1 FROM migrations WHERE version = 1").get()) {
      this.db.run("UPDATE submissions SET dirty = 1, version = version + 1 WHERE status IN ('pending', 'failed') AND source = 'discord'");
      this.db.run("INSERT INTO migrations VALUES (1, ?)", [new Date().toISOString()]);
    }
  }

  private importLegacy() {
    const legacy = this.db
      .query<LegacySubmission, []>(
        "SELECT id, attachments, author_name FROM submissions WHERE status = 'accepted' AND id NOT IN (SELECT submission_id FROM revisions)",
      )
      .all();
    for (const submission of legacy) {
      const attachments = JSON.parse(submission.attachments) as { name: string }[];
      const title = attachments[0]?.name.replace(/\.zip$/i, "") || "Untitled beatmap";
      this.publish(
        submission.id,
        { title, artist: "", creator: submission.author_name ?? "", search: attachments.map((file) => file.name).join(" ") },
        true,
      );
    }
    this.db.run("INSERT INTO migrations VALUES (2, ?)", [new Date().toISOString()]);
  }

  get(id: string) {
    return this.db.query<Project, [string]>(`${this.projectQuery} WHERE p.id = ?`).get(id);
  }

  revision(id: string) {
    return this.db.query<Revision, [string]>("SELECT * FROM revisions WHERE submission_id = ?").get(id);
  }

  checkTarget(id: string) {
    const submission = this.db
      .query<UpdateTarget, [string]>("SELECT id, target_project_id, base_revision_id FROM submissions WHERE id = ?")
      .get(id);
    if (!submission) {
      throw new Error("Submission not found");
    }
    if (submission.target_project_id) {
      const current = this.get(submission.target_project_id);
      if (!current) {
        throw new Error("The selected beatmap was not found");
      }
      if (current.current_revision_id !== submission.base_revision_id) {
        throw new Error("A newer revision is available");
      }
    }
    return submission;
  }

  publish(id: string, metadata: Metadata, legacy = false) {
    const submission = this.checkTarget(id);
    const origin = this.db
      .query<SubmissionAuthor, [string]>("SELECT author_name, author_id, reviewer_id, content FROM submissions WHERE id = ?")
      .get(id)!;
    const now = new Date().toISOString();
    const projectId = submission.target_project_id ?? crypto.randomUUID();
    const previous = submission.target_project_id ? this.get(projectId) : null;
    const revisionId = crypto.randomUUID();
    const number = (previous?.number ?? 0) + 1;
    const submitter = previous?.submitter ?? origin.author_name ?? origin.author_id;
    const oldSearch = previous
      ? this.db.query<{ search_text: string }, [string]>("SELECT search_text FROM projects WHERE id = ?").get(projectId)!.search_text
      : "";
    const search = searchText(
      `${metadata.title} ${metadata.artist} ${metadata.creator} ${metadata.search} ${submitter} ${oldSearch}`,
    ).slice(0, 65_536);
    if (!previous) {
      this.db.run(
        `INSERT INTO projects (id, title, artist, creator, submitter, submitter_id, search_text,
        current_revision_id, metadata_ready, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          projectId,
          metadata.title,
          metadata.artist,
          metadata.creator,
          submitter,
          origin.author_id,
          search,
          revisionId,
          legacy ? 0 : 1,
          now,
          now,
        ],
      );
    }
    this.db.run("INSERT INTO revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      revisionId,
      projectId,
      number,
      id,
      metadata.title,
      metadata.artist,
      metadata.creator,
      origin.content.slice(0, 4000),
      origin.reviewer_id ?? "server admin",
      now,
    ]);
    this.db.run(
      `UPDATE projects SET title = ?, artist = ?, creator = ?, search_text = ?,
       current_revision_id = ?, updated_at = ?, metadata_ready = ?, difficulties = ?, chart_info = ? WHERE id = ?`,
      [metadata.title, metadata.artist, metadata.creator, search, revisionId, now, legacy ? 0 : 1,
        legacy ? null : JSON.stringify(metadata.difficulties ?? []), legacy ? null : JSON.stringify(metadata.chartInfo ?? { levels: {}, labels: {} }), projectId],
    );
    this.db.run(
      `UPDATE submissions SET dirty = 1, version = version + 1
       WHERE target_project_id = ? AND status IN ('pending', 'failed') AND source = 'discord'`,
      [projectId],
    );
    return this.revision(id)!;
  }

  list(query = "", offset = 0, limit = 10, submitter = "", sorting = "title", difficulties: string[] = []) {
    const terms = searchText(query.trim()).split(/\s+/).filter(Boolean).slice(0, 8);
    const conditions = terms.map(() => "p.search_text LIKE ? ESCAPE '\\'");
    const args = terms.map((term) => `%${term.replace(/[\\%_]/g, "\\$&")}%`);
    if (submitter) {
      conditions.push("p.submitter_id = ?");
      args.push(submitter);
    }
    if (difficulties.length) {
      conditions.push(`EXISTS (SELECT 1 FROM json_each(COALESCE(p.difficulties, '[]')) WHERE value IN (${difficulties.map(() => "?").join(",")}))`);
      args.push(...difficulties);
    }
    const where = conditions.length ? conditions.join(" AND ") : "1 = 1";
    const total = this.db
      .query<{ count: number }, string[]>(`SELECT count(*) AS count FROM projects p WHERE ${where}`)
      .get(...args)!.count;
    const items = this.db
      .query<Project, (string | number)[]>(`${this.projectQuery} WHERE ${where} ORDER BY ${sorting === "rating" ? "rating DESC, " : ""}p.title COLLATE NOCASE, p.id LIMIT ? OFFSET ?`)
      .all(...args, Math.max(1, Math.min(25, limit)), Math.max(0, offset));
    return { items, total };
  }

  assign(id: string, projectId: string | null, expected: number, revisionId: string | null) {
    return this.db.transaction(() => this.applyAssignment(id, projectId, expected, revisionId)).immediate();
  }

  private applyAssignment(id: string, projectId: string | null, expected: number, revisionId: string | null) {
    const current = projectId ? this.get(projectId) : null;
    if (projectId && !current) {
      throw new Error("Beatmap not found");
    }
    if (current && current.current_revision_id !== revisionId) {
      throw new Error("The beatmap changed, search again to review its current revision");
    }
    const result = this.db.run(
      `UPDATE submissions SET target_project_id = ?, base_revision_id = ?,
      assignment_version = assignment_version + 1, version = version + 1, dirty = 1, error = NULL, updated_at = ?
      WHERE id = ? AND assignment_version = ? AND status IN ('pending', 'failed')`,
      [projectId, current?.current_revision_id ?? null, new Date().toISOString(), id, expected],
    );
    if (result.changes !== 1) {
      throw new Error("This review changed or is already being processed, open it again");
    }
  }

  byRevision(id: string) {
    return this.db.query<Revision, [string]>("SELECT * FROM revisions WHERE id = ?").get(id);
  }

  obsolete(projectId?: string) {
    return this.db.query<{ submission_id: string }, [string | null, string | null]>(
      `SELECT r.submission_id FROM revisions r JOIN projects p ON p.id = r.project_id
       WHERE r.id != p.current_revision_id AND (? IS NULL OR p.id = ?)
       AND EXISTS (SELECT 1 FROM files f WHERE f.submission_id = r.submission_id)`,
    ).all(projectId ?? null, projectId ?? null);
  }

  origin(id: string) {
    return this.db
      .query<SubmissionOrigin, [string]>(
        `SELECT s.guild_id, s.channel_id, s.message_id, s.source
         FROM submissions s JOIN revisions r ON r.submission_id = s.id
         WHERE r.project_id = ? ORDER BY r.number LIMIT 1`,
      )
      .get(id);
  }

  needsMetadata() {
    return this.db.query<Project, []>(`${this.projectQuery} WHERE p.metadata_ready = 0 OR p.difficulties IS NULL OR p.chart_info IS NULL
      OR json_type(p.chart_info, '$.cover') IS NULL OR json_type(p.chart_info, '$.charts') IS NULL`).all();
  }

  enrich(id: string, metadata: Metadata) {
    return this.db.transaction(() => this.updateMetadata(id, metadata)).immediate();
  }

  private updateMetadata(id: string, metadata: Metadata) {
    const current = this.db.query<Project, [string]>(`${this.projectQuery} WHERE r.submission_id = ?`).get(id);
    if (current?.metadata_ready === 1) {
      this.db.run("UPDATE projects SET chart_info = ? WHERE id = ? AND (chart_info IS NULL OR json_type(chart_info, '$.cover') IS NULL OR json_type(chart_info, '$.charts') IS NULL)", [
        JSON.stringify(metadata.chartInfo ?? { levels: {}, labels: {} }), current.id,
      ]);
      this.db.run("UPDATE projects SET difficulties = ? WHERE id = ? AND difficulties IS NULL", [
        JSON.stringify(metadata.difficulties ?? []), current.id,
      ]);
      return;
    }
    this.db.run(
      `UPDATE projects SET title = ?, artist = ?, creator = ?, search_text = ?, metadata_ready = 1, difficulties = ?, chart_info = ?
        WHERE metadata_ready = 0 AND current_revision_id IN (SELECT id FROM revisions WHERE submission_id = ?)`,
      [
        metadata.title,
        metadata.artist,
        metadata.creator,
        searchText(`${metadata.title} ${metadata.artist} ${metadata.creator} ${metadata.search}`),
        JSON.stringify(metadata.difficulties ?? []),
        JSON.stringify(metadata.chartInfo ?? { levels: {}, labels: {} }),
        id,
      ],
    );
    this.db.run("UPDATE revisions SET title = ?, artist = ?, creator = ? WHERE submission_id = ?", [
      metadata.title,
      metadata.artist,
      metadata.creator,
      id,
    ]);
  }
}
