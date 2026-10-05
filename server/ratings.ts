import type { Database } from "bun:sqlite";
import { OnlineError, type Profile } from "./accounts";

export function createRatings(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS ratings (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    value INTEGER NOT NULL CHECK(value BETWEEN 1 AND 10), updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, project_id))`);
  db.run("CREATE INDEX IF NOT EXISTS rating_maps ON ratings(project_id)");
}

export class Ratings {
  constructor(private readonly db: Database) { createRatings(db); }

  private project(input: Record<string, unknown>) {
    if (typeof input.projectId !== "string") { throw new OnlineError("invalid_query"); }
    if (!this.db.query("SELECT 1 FROM projects WHERE id = ?").get(input.projectId)) { throw new OnlineError("beatmap_removed"); }
    return input.projectId;
  }

  summary(id: string) {
    return this.db.query<{ average: number; count: number }, [string]>(
      "SELECT COALESCE(AVG(value), 0) AS average, COUNT(*) AS count FROM ratings WHERE project_id = ?").get(id)!;
  }

  get(input: Record<string, unknown>, user: Profile | null) {
    const id = this.project(input);
    const value = user ? this.db.query<{ value: number }, [string, string]>(
      "SELECT value FROM ratings WHERE user_id = ? AND project_id = ?").get(user.id, id)?.value ?? null : null;
    const available = user !== null && this.db.query("SELECT 1 FROM scores WHERE user_id = ? AND project_id = ? LIMIT 1").get(user.id, id) !== null;
    return { ...this.summary(id), value, available };
  }

  list(user: Profile) {
    const items = this.db.query<{ projectId: string; value: number | null; available: number }, [string, string, string, string]>(`
      SELECT p.project_id AS projectId, r.value,
        EXISTS (SELECT 1 FROM scores s WHERE s.project_id = p.project_id AND s.user_id = ?) AS available
      FROM (SELECT project_id FROM scores WHERE user_id = ? UNION SELECT project_id FROM ratings WHERE user_id = ?) p
      LEFT JOIN ratings r ON r.project_id = p.project_id AND r.user_id = ?`).all(user.id, user.id, user.id, user.id);
    return { items: items.map(item => ({ ...item, available: Boolean(item.available) })) };
  }

  rate(input: Record<string, unknown>, user: Profile) {
    const id = this.project(input);
    if (!Number.isInteger(input.value) || (input.value as number) < 1 || (input.value as number) > 10) { throw new OnlineError("invalid_rating"); }
    if (!this.get(input, user).available) { throw new OnlineError("rating_unavailable"); }
    this.db.run(`INSERT INTO ratings VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, project_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [user.id, id, input.value as number, new Date().toISOString()]);
    return this.get(input, user);
  }
}
