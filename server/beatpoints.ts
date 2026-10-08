import type { Database } from "bun:sqlite";
import { digest, metadata, OnlineError, type Profile } from "./accounts";
import { maxChartScore, scoreSettings, type ChartScoring } from "./chartScore";
import type { Scores } from "./scores";

export const bpSettings = {
  formula: 1, base: 100, referenceLevel: 10, doublingLevels: 5, minimumRatio: 0.5, power: 3,
};

export function calculateBp(level: number, score: number, maximum: number, settings = bpSettings) {
  if (!Number.isFinite(level) || level <= 0 || !Number.isFinite(score) || score < 0 || !Number.isFinite(maximum) || maximum <= 0) { return 0; }
  const ratio = Math.min(1, score / maximum);
  const performance = Math.max(0, (ratio - settings.minimumRatio) / (1 - settings.minimumRatio)) ** settings.power;
  const points = settings.base * 2 ** ((level - settings.referenceLevel) / settings.doublingLevels) * performance;
  return Number.isFinite(points) && points <= Number.MAX_SAFE_INTEGER ? points : 0;
}

export class Beatpoints {
  constructor(private readonly db: Database, private readonly settings = bpSettings) {}

  private totals(userId?: string) {
    const rows = this.db.query<{ userId: string; projectId: string; difficulty: string; score: number; level: number | null; scoring: string | null; modifiers: string }, string[]>(
      `SELECT s.user_id AS userId, s.project_id AS projectId, s.difficulty, s.score,
        COALESCE(json_extract(c.value, '$.level'), json_extract(p.chart_info, '$.levels.' || s.difficulty)) AS level,
        json_extract(c.value, '$.scoring') AS scoring, s.modifiers
      FROM scores s JOIN projects p ON p.id = s.project_id JOIN json_each(p.chart_info, '$.charts') c
        ON json_extract(c.value, '$.hash') = s.chart AND json_extract(c.value, '$.difficulty') = s.difficulty
      WHERE s.revision_id = p.current_revision_id AND s.cleared = 1 AND s.modifiers IN ('\\Classic', '\\Critical')
        ${userId === undefined ? "" : "AND s.user_id = ?"}`)
      .all(...(userId === undefined ? [] : [userId]));
    const best = new Map<string, { userId: string; points: number }>();
    for (const row of rows) {
      const key = JSON.stringify([row.userId, row.projectId, row.difficulty]);
      const scoring = row.scoring ? JSON.parse(row.scoring) as ChartScoring : null;
      const points = calculateBp(row.level ?? 0, row.score, maxChartScore(scoring, row.modifiers === "\\Critical"), this.settings);
      if (points > (best.get(key)?.points ?? 0)) { best.set(key, { userId: row.userId, points }); }
    }
    const totals = new Map<string, number>();
    for (const row of best.values()) { totals.set(row.userId, (totals.get(row.userId) ?? 0) + row.points); }
    return totals;
  }

  own(user: Profile) {
    return { bp: this.totals(user.id).get(user.id) ?? 0, version: digest(JSON.stringify([this.settings, scoreSettings])) };
  }

  submit(scores: Scores, input: Record<string, unknown>, user: Profile) {
    const before = this.own(user).bp;
    const result = scores.submit(input, user);
    const current = this.own(user);
    return { ...result, ...current, bpBefore: before, bpGain: Math.max(0, current.bp - before) };
  }

  list(input: Record<string, unknown>, user: Profile | null) {
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > 1_000_000
      || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 50) { throw new OnlineError("invalid_query"); }
    const totals = this.totals();
    const users = this.db.query<{ userId: string; username: string; avatar: string | null; profile: string | null }, []>(
      `SELECT u.id AS userId, u.username, u.avatar, p.metadata AS profile
      FROM users u LEFT JOIN user_profiles p ON p.user_id = u.id`).all();
    const ranked = users.map(row => ({ ...row, profile: metadata(row.profile), bp: totals.get(row.userId) ?? 0 }))
      .sort((a, b) => b.bp - a.bp || a.userId.localeCompare(b.userId))
      .map((row, index) => ({ ...row, rank: index + 1 }));
    return { items: ranked.slice(offset as number, (offset as number) + (limit as number)),
      own: user ? ranked.find(row => row.userId === user.id) ?? null : null,
      total: ranked.length, offset, version: digest(JSON.stringify([this.settings, scoreSettings])) };
  }
}
