export type ChartScoring = { notes: number; hits: number; dodges: number };

export const scoreSettings = { weight: 1_500_000, note: 2000, accuracyBonus: 500, bonus: 0.05, critical: 1.3 };

export function readScoring(text: string): ChartScoring | null {
  let section = "";
  let side = 0;
  let previousSide = -1;
  let previousType = "";
  let freestyleSide = -1;
  let notes = 0;
  let hits = 0;
  let dodges = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("//")) { continue; }
    if (line.startsWith("[") && line.endsWith("]")) { section = line.toLowerCase(); continue; }
    if (section !== "[hitobjects]") { continue; }
    const fields = line.split(",");
    if (fields.length < 6 || fields.slice(0, 5).some(value => !/^[+-]?\d+$/.test(value.trim()))) { continue; }
    const lane = Math.trunc(Number(fields[0]) * 6 / 512) + 1;
    const type = Number(fields[3]) & 129;
    const sound = Number(fields[4]);
    if (lane === 5) { if (sound !== 2) { side = 1 - side; } continue; }
    if (lane === 1 || lane === 2) { continue; }
    let kind: string;
    if (lane === 3 || lane === 4) {
      const sample = fields.slice(5).join(",").split(":");
      const brawl = sample.length < 6 ? sample[0] === "3" : sample[1] === "3";
      if (brawl) { kind = "normal"; }
      else if (type === 1 && sound === 2) { kind = "dodge"; }
      else if (type === 1 && [4, 6, 10, 12].includes(sound)) { kind = "unused"; }
      else if (type === 1 && [0, 8].includes(sound) || type === 128 && [0, 2, 8].includes(sound)) { kind = "normal"; }
      else { continue; }
    } else if (lane === 6) {
      if (type === 1 && sound === 0) { kind = "freestyle"; }
      else if (type === 1 && sound === 2) { kind = "unused"; }
      else if (type === 128 && sound === 4) { kind = "normal"; }
      else { continue; }
    } else { continue; }
    if (kind !== "freestyle" || previousType !== "freestyle" || previousSide !== side) {
      notes++;
      if (kind === "dodge") { dodges++; }
    }
    if (kind === "freestyle") {
      if (freestyleSide !== side) { hits++; }
      freestyleSide = side;
    } else if (kind !== "unused") {
      hits++;
      freestyleSide = -1;
    }
    previousType = kind;
    previousSide = side;
  }
  return notes > 0 ? { notes, hits, dodges } : null;
}

export function maxChartScore(scoring: ChartScoring | null, critical: boolean) {
  if (!scoring || ![scoring.notes, scoring.hits, scoring.dodges].every(Number.isSafeInteger)
    || scoring.notes <= 0 || scoring.hits <= 0 || scoring.hits > scoring.notes || scoring.dodges < 0 || scoring.dodges > scoring.hits) { return 0; }
  const { note, accuracyBonus, bonus, weight } = scoreSettings;
  const multiplier = critical ? scoreSettings.critical : 1;
  const base = (scoring.hits - scoring.dodges) * (note + accuracyBonus) * multiplier + scoring.dodges * note;
  const bonuses = scoring.hits * note * bonus * (scoring.hits >= 3 ? 3 : 2);
  const denominator = scoring.notes * (note + accuracyBonus + note * bonus * 3);
  return (base + bonuses) / denominator * weight;
}
