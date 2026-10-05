import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";

export class OnlineError extends Error {
  constructor(readonly code: string) { super(code); }
}

export function username(value: unknown) {
  if (typeof value !== "string" || !value.trim() || [...value].length > 32 || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    throw new OnlineError("invalid_username");
  }
  const name = value.normalize("NFC");
  if ([...name].length > 32) { throw new OnlineError("invalid_username"); }
  return name;
}

type User = { id: string; username: string; password: string; avatar: string | null };
export type Metadata = {
  region: string; topTitle: string; middleTitle: string; bottomTitle: string; badgeTitle: string;
  playerAccuracy: number; playerProgression: number; playerRank: number;
};
export type Profile = Pick<User, "id" | "username" | "avatar"> & { profile: Metadata };
export function region(value: unknown) {
  if (typeof value !== "string" || !/^[a-z0-9_-]{2,16}$/i.test(value) || /^(global|regional|local)$/i.test(value)) {
    throw new OnlineError("invalid_region");
  }
  return value.toLowerCase();
}
export function metadata(value: string | null): Metadata {
  return { region: "", topTitle: "", middleTitle: "", bottomTitle: "", badgeTitle: "",
    playerAccuracy: 0, playerProgression: 0, playerRank: 0, ...JSON.parse(value ?? "{}") };
}
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export class Accounts {
  private readonly dummy: Promise<string>;

  constructor(readonly db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL,
      avatar TEXT, created_at TEXT NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL)`);
    db.run(`CREATE TABLE IF NOT EXISTS user_profiles (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      region TEXT NOT NULL, metadata TEXT NOT NULL)`);
    db.run("CREATE INDEX IF NOT EXISTS profile_regions ON user_profiles(region)");
    this.dummy = Bun.password.hash(randomBytes(32).toString("hex"), { algorithm: "argon2id", memoryCost: 65536, timeCost: 3 });
  }

  private profile(user: User): Profile {
    const saved = this.db.query<{ metadata: string }, [string]>("SELECT metadata FROM user_profiles WHERE user_id = ?").get(user.id);
    return { id: user.id, username: user.username, avatar: user.avatar, profile: metadata(saved?.metadata ?? null) };
  }

  update(input: Record<string, unknown>, user: Profile) {
    if (!input.profile || typeof input.profile !== "object" || Array.isArray(input.profile)) { throw new OnlineError("invalid_profile"); }
    const value = input.profile as Record<string, unknown>;
    const next = { ...user.profile };
    for (const field of ["topTitle", "middleTitle", "bottomTitle", "badgeTitle"] as const) {
      if (value[field] === undefined) { continue; }
      if (typeof value[field] !== "string" || [...value[field]].length > 256 || /[\x00-\x1f\x7f<>]/.test(value[field])) { throw new OnlineError("invalid_profile"); }
      next[field] = value[field];
    }
    for (const field of ["playerAccuracy", "playerProgression", "playerRank"] as const) {
      if (value[field] === undefined) { continue; }
      const number = value[field];
      const max = field === "playerAccuracy" ? 1 : 1000;
      if (typeof number !== "number" || !Number.isFinite(number) || number < 0 || number > max) { throw new OnlineError("invalid_profile"); }
      next[field] = number;
    }
    if (value.region !== undefined) { next.region = region(value.region); }
    this.db.run(`INSERT INTO user_profiles VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
      region = excluded.region, metadata = excluded.metadata`, [user.id, next.region, JSON.stringify(next)]);
    return { user: { ...user, profile: next } };
  }

  async authenticate(input: Record<string, unknown>, register: boolean) {
    const name = username(input.username);
    if (typeof input.password !== "string" || !/^[0-9a-f]{64}$/.test(input.password)) {
      throw new OnlineError("invalid_password");
    }
    let user = this.db.query<User, [string]>("SELECT * FROM users WHERE username = ?").get(name);
    if (register) {
      if (user) { throw new OnlineError("username_taken"); }
      const password = await Bun.password.hash(input.password, { algorithm: "argon2id", memoryCost: 65536, timeCost: 3 });
      user = { id: crypto.randomUUID(), username: name, password, avatar: this.avatar(input.avatar) };
      const result = this.db.run("INSERT OR IGNORE INTO users VALUES (?, ?, ?, ?, ?)",
        [user.id, name, password, user.avatar, new Date().toISOString()]);
      if (!result.changes) { throw new OnlineError("username_taken"); }
    } else {
      const valid = await Bun.password.verify(input.password, user?.password ?? await this.dummy);
      if (!user || !valid) { throw new OnlineError("invalid_credentials"); }
      const avatar = this.avatar(input.avatar);
      if (avatar) {
        this.db.run("UPDATE users SET avatar = ? WHERE id = ?", [avatar, user.id]);
        user.avatar = avatar;
      }
    }
    const key = randomBytes(32).toString("hex");
    this.db.run("INSERT INTO sessions VALUES (?, ?, ?)", [digest(key), user.id, new Date().toISOString()]);
    return { key, user: this.profile(user) };
  }

  user(key: unknown): Profile {
    if (typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key)) { throw new OnlineError("unauthorized"); }
    const user = this.db.query<User, [string]>(
      "SELECT u.* FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.token = ?").get(digest(key));
    if (!user) { throw new OnlineError("unauthorized"); }
    return this.profile(user);
  }

  logout(key: unknown) {
    this.user(key);
    this.db.run("DELETE FROM sessions WHERE token = ?", [digest(key as string)]);
    return { success: true };
  }

  private avatar(value: unknown) {
    return typeof value === "string" && /^https:\/\/avatars\.(?:steamstatic\.com|akamai\.steamstatic\.com)\/[0-9a-f]{40}(?:_(?:full|medium))?\.jpg$/i.test(value) ? value : null;
  }
}
