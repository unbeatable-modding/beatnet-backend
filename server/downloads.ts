import type { Database } from "bun:sqlite";
import { OnlineError, type Profile } from "./accounts";

export function createDownloads(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS downloads (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, PRIMARY KEY (project_id, user_id))`);
}

export class Downloads {
  constructor(private readonly db: Database) { createDownloads(db); }

  track(input: Record<string, unknown>, user: Profile) {
    if (typeof input.projectId !== "string" || typeof input.revisionId !== "string") {
      throw new OnlineError("invalid_query");
    }
    return this.db.transaction(() => {
      if (!this.db.query("SELECT 1 FROM projects WHERE id = ?").get(input.projectId as string)) {
        throw new OnlineError("beatmap_removed");
      }
      if (!this.db.query(`SELECT 1 FROM revisions r JOIN submissions s ON s.id = r.submission_id
        WHERE r.id = ? AND r.project_id = ? AND s.status = 'accepted'`).get(input.revisionId as string, input.projectId as string)) {
        throw new OnlineError("invalid_revision");
      }
      this.db.run("INSERT OR IGNORE INTO downloads VALUES (?, ?, ?)",
        [input.projectId as string, user.id, new Date().toISOString()]);
      return this.db.query<{ downloadCount: number }, [string]>(
        "SELECT COUNT(*) AS downloadCount FROM downloads WHERE project_id = ?").get(input.projectId as string)!;
    }).immediate();
  }
}
