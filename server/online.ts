import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, createHmac, createPublicKey, generateKeyPairSync, privateDecrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { Accounts, digest, OnlineError } from "./accounts";
import { Scores } from "./scores";
import { Ratings } from "./ratings";

type Envelope = { key?: string; iv: string; data: string; mac: string };

export function seal(value: unknown, key: Buffer): Envelope {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", key.subarray(0, 32), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const mac = createHmac("sha256", key.subarray(32)).update(iv).update(data).digest("base64");
  return { iv: iv.toString("base64"), data: data.toString("base64"), mac };
}

export function unseal(value: Envelope, key: Buffer) {
  const iv = Buffer.from(value.iv, "base64");
  const data = Buffer.from(value.data, "base64");
  const mac = Buffer.from(value.mac, "base64");
  const expected = createHmac("sha256", key.subarray(32)).update(iv).update(data).digest();
  if (iv.length !== 16 || mac.length !== expected.length || !timingSafeEqual(mac, expected)) { throw new OnlineError("invalid_envelope"); }
  const cipher = createDecipheriv("aes-256-cbc", key.subarray(0, 32), iv);
  return JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString("utf8")) as Record<string, unknown>;
}

export class Online {
  readonly accounts: Accounts;
  readonly scores: Scores;
  readonly ratings: Ratings;
  readonly publicKey: { modulus: string; exponent: string };
  private readonly limits = new Map<string, { until: number; count: number }>();
  private active = 0;
  private revisionVersion = -1;
  private revisionState: { version: string; items: { id: string; revisionId: string }[] };
  private readonly watchers = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly db: Database, private readonly privateKey: string) {
    this.accounts = new Accounts(db);
    this.scores = new Scores(db);
    this.ratings = new Ratings(db);
    db.run("CREATE TABLE IF NOT EXISTS online_requests (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)");
    db.run("CREATE TABLE IF NOT EXISTS revision_changes (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL)");
    db.run("INSERT OR IGNORE INTO revision_changes VALUES (1, 0)");
    db.run("CREATE TRIGGER IF NOT EXISTS revisions_added AFTER INSERT ON projects BEGIN UPDATE revision_changes SET version = version + 1 WHERE id = 1; END");
    db.run("CREATE TRIGGER IF NOT EXISTS revisions_updated AFTER UPDATE OF current_revision_id ON projects WHEN OLD.current_revision_id IS NOT NEW.current_revision_id BEGIN UPDATE revision_changes SET version = version + 1 WHERE id = 1; END");
    db.run("CREATE TRIGGER IF NOT EXISTS revisions_removed AFTER DELETE ON projects BEGIN UPDATE revision_changes SET version = version + 1 WHERE id = 1; END");
    const jwk = createPublicKey(privateKey).export({ format: "jwk" });
    this.publicKey = { modulus: Buffer.from(jwk.n!, "base64url").toString("base64"), exponent: Buffer.from(jwk.e!, "base64url").toString("base64") };
    this.revisionState = this.readRevisions();
  }

  private readRevisions() {
    const version = this.db.query<{ version: number }, []>("SELECT version FROM revision_changes WHERE id = 1").get()!.version;
    if (version === this.revisionVersion) { return this.revisionState; }
    const items = this.db.query<{ id: string; revisionId: string }, []>("SELECT id, current_revision_id AS revisionId FROM projects ORDER BY id").all();
    this.revisionVersion = version;
    return { version: digest(JSON.stringify(items)), items };
  }

  private async watchRevisions(input: Record<string, unknown>, signal: AbortSignal) {
    if (!Array.isArray(input.ids) || input.ids.length > 1024 || input.ids.some(id => typeof id !== "string") || typeof input.version !== "string") {
      throw new OnlineError("invalid_query");
    }
    const current = this.readRevisions();
    if (current.version !== this.revisionState.version) {
      this.revisionState = current;
      for (const notify of [...this.watchers]) { notify(); }
    }
    if (input.version === this.revisionState.version && !signal.aborted) {
      if (this.watchers.size >= 256) { throw new OnlineError("try_again_later"); }
      await new Promise<void>(resolve => {
        const finish = () => {
          clearTimeout(timeout);
          signal.removeEventListener("abort", finish);
          this.watchers.delete(finish);
          if (this.watchers.size === 0) { clearInterval(this.timer); this.timer = undefined; }
          resolve();
        };
        const timeout = setTimeout(finish, 20000);
        this.watchers.add(finish);
        signal.addEventListener("abort", finish, { once: true });
        if (!this.timer) {
          this.timer = setInterval(() => {
            const state = this.readRevisions();
            if (state.version !== this.revisionState.version) {
              this.revisionState = state;
              for (const notify of [...this.watchers]) { notify(); }
            }
          }, 250);
        }
      });
    }
    const ids = new Set(input.ids as string[]);
    return { version: this.revisionState.version, items: this.revisionState.items.filter(item => ids.has(item.id)) };
  }

  stop() {
    for (const notify of [...this.watchers]) { notify(); }
    clearInterval(this.timer);
  }

  async handle(request: Request, ip: string) {
    if (new URL(request.url).pathname === "/api/online/key" && request.method === "GET") {
      return Response.json(this.publicKey, { headers: { "Cache-Control": "no-store" } });
    }
    if (request.method !== "POST" || new URL(request.url).pathname !== "/api/online") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const now = Date.now();
    if (this.limits.size > 10000) {
      for (const [key, limit] of this.limits) { if (limit.until < now) { this.limits.delete(key); } }
      if (this.limits.size > 10000) { return Response.json({ error: "try_again_later" }, { status: 429 }); }
    }
    const limit = this.limits.get(ip) ?? { until: now + 60000, count: 0 };
    if (limit.until < now) { limit.until = now + 60000; limit.count = 0; }
    this.limits.set(ip, limit);
    if (++limit.count > 120) { return Response.json({ error: "try_again_later" }, { status: 429 }); }
    let counted = false;
    let key: Buffer | undefined;
    try {
      const raw = await request.text();
      if (raw.length > 65536) { throw new OnlineError("request_too_large"); }
      const envelope = JSON.parse(raw) as Envelope;
      key = privateDecrypt({ key: this.privateKey, oaepHash: "sha1" }, Buffer.from(envelope.key!, "base64"));
      if (key.length !== 64) { throw new OnlineError("invalid_envelope"); }
      const input = unseal(envelope, key);
      if (typeof input.requestId !== "string" || !/^[0-9a-f]{32}$/.test(input.requestId)
        || typeof input.time !== "number" || Math.abs(now - input.time) > 120000) { throw new OnlineError("expired_request"); }
      this.db.run("DELETE FROM online_requests WHERE created_at < ?", [now - 120000]);
      if (!this.db.run("INSERT OR IGNORE INTO online_requests VALUES (?, ?)", [input.requestId, now]).changes) { throw new OnlineError("replayed_request"); }
      if (input.action !== "revisions") {
        if (this.active >= 8) { throw new OnlineError("try_again_later"); }
        this.active++;
        counted = true;
      }
      let result: unknown;
      if (input.action === "register" || input.action === "login") {
        const auth = this.limits.get("auth:" + ip) ?? { until: now + 60000, count: 0 };
        if (auth.until < now) { auth.until = now + 60000; auth.count = 0; }
        this.limits.set("auth:" + ip, auth);
        if (++auth.count > 10) { throw new OnlineError("try_again_later"); }
        result = await this.accounts.authenticate(input, input.action === "register");
      } else if (input.action === "revisions") {
        result = await this.watchRevisions(input, request.signal);
      } else if (input.action === "me") { result = { user: this.accounts.user(input.key) }; }
      else if (input.action === "profile") { result = this.accounts.update(input, this.accounts.user(input.key)); }
      else if (input.action === "logout") { result = this.accounts.logout(input.key); }
      else if (input.action === "submit") { result = this.scores.submit(input, this.accounts.user(input.key)); }
      else if (input.action === "leaderboard") { result = this.scores.list(input, input.key ? this.accounts.user(input.key) : null); }
      else if (input.action === "highscores") { result = this.scores.highscores(input); }
      else if (input.action === "rating") { result = this.ratings.get(input, input.key ? this.accounts.user(input.key) : null); }
      else if (input.action === "ratings") { result = this.ratings.list(this.accounts.user(input.key)); }
      else if (input.action === "rate") { result = this.ratings.rate(input, this.accounts.user(input.key)); }
      else { throw new OnlineError("invalid_action"); }
      return Response.json(seal(result, key), { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const body = { error: error instanceof OnlineError ? error.code : "invalid_request" };
      return Response.json(key?.length === 64 ? seal(body, key) : body, { status: key?.length === 64 ? 200 : 400, headers: { "Cache-Control": "no-store" } });
    } finally { if (counted) { this.active--; } }
  }
}

export async function openOnline(root: string) {
  const path = join(root, "online.pem");
  if (!await Bun.file(path).exists()) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072,
      publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    await Bun.write(path, privateKey);
    await chmod(path, 0o600);
  }
  const db = new Database(join(root, "beatnet.sqlite"), { create: false, strict: true });
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  const online = new Online(db, await Bun.file(path).text());
  return { online, close: () => { online.stop(); db.close(); } };
}
