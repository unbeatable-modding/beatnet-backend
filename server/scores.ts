import type { Database } from "bun:sqlite";
import { metadata, OnlineError, region, type Profile } from "./accounts";

export class Scores {
  constructor(private readonly db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS scores (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      revision_id TEXT NOT NULL, chart TEXT NOT NULL, difficulty TEXT NOT NULL, modifiers TEXT NOT NULL,
      score INTEGER NOT NULL, accuracy REAL NOT NULL, max_combo INTEGER NOT NULL,
      cleared INTEGER NOT NULL, no_miss INTEGER NOT NULL, full_combo INTEGER NOT NULL, perfect_combo INTEGER NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, project_id, chart, difficulty, modifiers))`);
    db.run("CREATE INDEX IF NOT EXISTS score_boards ON scores(project_id, chart, difficulty, modifiers, score DESC)");
    db.run(`CREATE TRIGGER IF NOT EXISTS reset_revision_scores AFTER UPDATE OF current_revision_id ON projects
      WHEN OLD.current_revision_id != NEW.current_revision_id BEGIN
      DELETE FROM scores WHERE project_id = NEW.id; END`);
  }

  private board(input: Record<string, unknown>) {
    const { projectId, revisionId, chart, difficulty, modifiers } = input;
    if (typeof projectId !== "string" || typeof revisionId !== "string" || typeof chart !== "string"
        || chart.length > 512 || chart.startsWith("/") || chart.includes("\\") || chart.split("/").some(p => p === ".." || p === ".")
        || typeof difficulty !== "string" || typeof modifiers !== "string" || !/^\\(?:Classic|(?:[A-Za-z]+)(?:&[A-Za-z]+)*)$/.test(modifiers) || modifiers.length > 128) {
      throw new OnlineError("invalid_board");
    }
    const project = this.db.query<{ current_revision_id: string; difficulties: string | null; chart_info: string | null }, [string]>(
      "SELECT current_revision_id, difficulties, chart_info FROM projects WHERE id = ?").get(projectId);
    if (!project) { throw new OnlineError("beatmap_removed"); }
    if (project.current_revision_id !== revisionId) { throw new OnlineError("revision_changed"); }
    if (!(JSON.parse(project.difficulties ?? "[]") as string[]).includes(difficulty)) { throw new OnlineError("invalid_difficulty"); }
    const info = JSON.parse(project.chart_info ?? "{}") as { charts?: { hash: string; difficulty: string }[] };
    if (!info.charts?.some(item => item.hash === chart && item.difficulty === difficulty)) { throw new OnlineError("invalid_chart"); }
    return [projectId, revisionId, chart, difficulty, modifiers];
  }

  submit(input: Record<string, unknown>, user: Profile) {
    const [projectId, revisionId, chart, difficulty, modifiers] = this.board(input) as [string, string, string, string, string];
    const { score, accuracy, maxCombo, cleared, noMiss, fullCombo, perfectCombo } = input;
    if (!Number.isSafeInteger(score) || (score as number) < 0 || (score as number) > 2147483647
      || typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 1
      || !Number.isSafeInteger(maxCombo) || (maxCombo as number) < 0 || (maxCombo as number) > 10_000_000
      || typeof cleared !== "boolean" || typeof noMiss !== "boolean" || typeof fullCombo !== "boolean" || typeof perfectCombo !== "boolean") { throw new OnlineError("invalid_score"); }
    this.db.run(`INSERT INTO scores VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, project_id, chart, difficulty, modifiers) DO UPDATE SET
      score = excluded.score, accuracy = excluded.accuracy, max_combo = excluded.max_combo,
      cleared = excluded.cleared, no_miss = excluded.no_miss, full_combo = excluded.full_combo, perfect_combo = excluded.perfect_combo, updated_at = excluded.updated_at
      WHERE excluded.cleared > scores.cleared OR (excluded.cleared = scores.cleared AND
        (excluded.score > scores.score OR (excluded.score = scores.score AND excluded.accuracy > scores.accuracy)))`,
      [user.id, projectId, revisionId, chart, difficulty, modifiers, score as number, accuracy, maxCombo as number,
        Number(cleared), Number(noMiss), Number(fullCombo), Number(perfectCombo), new Date().toISOString()]);
    return { success: true };
  }

  list(input: Record<string, unknown>, user: Profile | null) {
    const board = this.board(input);
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 10;
    if (!Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > 1_000_000
      || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 25
      || input.sorting !== undefined && input.sorting !== 0 && input.sorting !== 1 && input.sorting !== 2) { throw new OnlineError("invalid_query"); }
    if (input.sorting === 2) { return { items: [], own: null, total: 0 }; }
    const requested = input.region ?? "global";
    const selected = requested === "regional" || requested === "local" ? user?.profile.region ?? "" : requested;
    const filter = selected === "global" ? null : region(selected);
    const parameters = filter === null ? board : [...board, filter];
    const order = "score DESC, accuracy DESC";
    const query = `SELECT u.id AS userId, u.username, u.avatar, p.metadata AS profile, s.score, s.accuracy, s.max_combo AS maxCombo,
      s.cleared, s.no_miss AS noMiss, s.full_combo AS fullCombo, s.perfect_combo AS perfectCombo, ROW_NUMBER() OVER (ORDER BY ${order}, updated_at, s.user_id) AS rank
      FROM scores s JOIN users u ON u.id = s.user_id
      LEFT JOIN user_profiles p ON p.user_id = u.id
      WHERE project_id = ? AND revision_id = ? AND chart = ? AND difficulty = ? AND modifiers = ?${filter === null ? "" : " AND p.region = ?"}`;
    const own = user ? this.db.query(`SELECT * FROM (${query}) WHERE userId = ?`).get(...parameters, user.id) as { rank: number; profile: string | null } | null : null;
    const start = input.sorting === 1 && own ? Math.max(0, own.rank - 1 - Math.floor((limit as number) / 2) + (offset as number)) : offset as number;
    const items = this.db.query(`SELECT * FROM (${query}) ORDER BY rank LIMIT ? OFFSET ?`).all(...parameters, limit as number, start) as { profile: string | null }[];
    const total = this.db.query<{ total: number }, string[]>(`SELECT COUNT(*) AS total FROM (${query})`).get(...parameters)!.total;
    return { items: items.map(item => ({ ...item, profile: metadata(item.profile) })),
      own: own ? { ...own, profile: metadata(own.profile) } : null, total, offset: start };
  }

  highscores(input: Record<string, unknown>) {
    const { projectId, revisionId, modifiers } = input;
    if (typeof projectId !== "string" || typeof revisionId !== "string" || typeof modifiers !== "string"
      || !/^\\(?:Classic|(?:[A-Za-z]+)(?:&[A-Za-z]+)*)$/.test(modifiers) || modifiers.length > 128) { throw new OnlineError("invalid_board"); }
    const project = this.db.query<{ current_revision_id: string; chart_info: string | null }, [string]>(
      "SELECT current_revision_id, chart_info FROM projects WHERE id = ?").get(projectId);
    if (!project) { throw new OnlineError("beatmap_removed"); }
    if (project.current_revision_id !== revisionId) { throw new OnlineError("revision_changed"); }
    const charts = (JSON.parse(project.chart_info ?? "{}") as { charts?: { hash: string; difficulty: string }[] }).charts ?? [];
    const rows = this.db.query<{ difficulty: string; chart: string; score: number; accuracy: number; noMiss: number; cleared: number }, [string, string, string, string]>(
      `SELECT difficulty, chart, score, accuracy, noMiss, cleared FROM (
        SELECT difficulty, chart, score, accuracy, no_miss AS noMiss, cleared,
          ROW_NUMBER() OVER (PARTITION BY difficulty ORDER BY score DESC, accuracy DESC, updated_at, user_id, chart) AS position
        FROM scores WHERE project_id = ? AND revision_id = ? AND modifiers = ?
          AND EXISTS (SELECT 1 FROM json_each(?) WHERE json_extract(value, '$.hash') = scores.chart
            AND json_extract(value, '$.difficulty') = scores.difficulty)
      ) WHERE position = 1 ORDER BY difficulty`).all(projectId, revisionId, modifiers, JSON.stringify(charts));
    return { revisionId, items: rows.map(({ chart, noMiss, cleared, ...row }) => ({ ...row, noMiss: Boolean(noMiss), cleared: Boolean(cleared) })) };
  }
}
