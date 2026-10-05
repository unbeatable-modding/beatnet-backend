import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

try {
  const [name, ...extra] = process.argv.slice(2);
  if (!name || extra.length) { throw new Error("usage: bun run removeUser <username or user id>"); }
  let serviceDir: string | undefined;
  if (process.platform === "linux") {
    const service = Bun.spawnSync(["systemctl", "show", "beatnet", "-p", "WorkingDirectory", "-p", "Environment"]);
    const text = service.stdout.toString();
    if (text.includes(`WorkingDirectory=${resolve(import.meta.dir, "..")}\n`)) {
      serviceDir = /(?:^|\s)DATA_DIR=(\S+)/.exec(text)?.[1];
    }
  }
  const root = resolve(process.env.DATA_DIR ?? serviceDir ?? join(homedir(), ".local", "share", "beatnet"));
  const db = new Database(join(root, "beatnet.sqlite"), { create: false, strict: true });
  try {
    db.run("PRAGMA foreign_keys = ON");
    db.run("PRAGMA busy_timeout = 5000");
    const removed = db.transaction(() => {
      const user = db.query<{ id: string; username: string }, [string]>("SELECT id, username FROM users WHERE username = ?").get(name.normalize("NFC"))
        ?? db.query<{ id: string; username: string }, [string]>("SELECT id, username FROM users WHERE id = ?").get(name);
      if (!user) { throw new Error("user not found"); }
      db.run("DELETE FROM users WHERE id = ?", [user.id]);
      return user.username;
    }).immediate();
    console.log(`removed user ${removed}`);
  } finally { db.close(); }
} catch (error) {
  console.error(error instanceof Error ? error.message : "cannot remove user");
  process.exitCode = 1;
}
