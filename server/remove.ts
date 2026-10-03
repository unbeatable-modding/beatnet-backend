import { Database } from "bun:sqlite";
import { lstat, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { acquireRuntime } from "./runtime";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
//we removin' beatmaps with this one :fire:
function service() {
  if (process.platform !== "linux") {
    return null;
  }
  const result = Bun.spawnSync(["systemctl", "show", "beatnet", "-p", "WorkingDirectory", "-p", "Environment", "-p", "ActiveState"]);
  if (result.exitCode !== 0) {
    return null;
  }
  const values = Object.fromEntries(result.stdout.toString().trim().split("\n").map((line) => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  if (values.WorkingDirectory !== resolve(import.meta.dir, "..")) {
    return null;
  }
  const dataDir = /(?:^|\s)DATA_DIR=(\S+)/.exec(values.Environment ?? "")?.[1];
  return dataDir ? { dataDir: resolve(dataDir), state: values.ActiveState } : null;
}

function controlService(action: "stop" | "start") {
  const result = Bun.spawnSync(["sudo", "-n", "systemctl", action, "beatnet"]);
  if (result.exitCode !== 0) {
    throw new Error(`cannot ${action} beatnet`);
  }
}

async function storagePaths(root: string, ids: string[]) {
  const paths: string[] = [];
  for (const name of ["beatmaps", "staging"]) {
    const folder = join(root, name);
    const entry = await lstat(folder).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (!entry) {
      continue;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("upload storage must use real directories (this should never get triggered tbh)");
    }
    if (name === "beatmaps") {
      paths.push(...ids.map((id) => join(folder, id)));
    } else {
      const entries = await readdir(folder);
      const selected = new Set(ids);
      for (const name of entries) {
        if (/^[0-9a-f-]{36}-[a-zA-Z0-9]{6}$/.test(name) && selected.has(name.slice(0, 36))) {
          paths.push(join(folder, name));
        }
      }
    }
  }
  return paths;
}

async function removeMap(id: string, root: string) {
  const release = await acquireRuntime(root);
  let db: Database | undefined;
  try {
    db = new Database(join(root, "beatnet.sqlite"), { create: false, strict: true });
    db.run("PRAGMA foreign_keys = ON");
    db.run("PRAGMA busy_timeout = 5000");
    db.run("BEGIN IMMEDIATE");
    const project = db.query<{ title: string }, [string]>("SELECT title FROM projects WHERE id = ?").get(id);
    if (!project) {
      throw new Error("beatmap not found");
    }
    const submissions = db.query<{ id: string }, [string, string]>(
      "SELECT id FROM submissions WHERE target_project_id = ? OR id IN (SELECT submission_id FROM revisions WHERE project_id = ?)",
    ).all(id, id);
    const ids = submissions.map((submission) => submission.id);
    if (ids.some((id) => !uuid.test(id))) {
      throw new Error("invalid stored submission id");
    }
    const paths = await storagePaths(root, ids);
    db.run(
      `UPDATE submissions SET base_revision_id = NULL, assignment_version = assignment_version + 1,
       version = version + 1, dirty = 1 WHERE base_revision_id IN (SELECT id FROM revisions WHERE project_id = ?)`,
      [id],
    );
    for (const submissionId of ids) {
      db.run("DELETE FROM files WHERE submission_id = ?", [submissionId]);
    }
    db.run("DELETE FROM revisions WHERE project_id = ?", [id]);
    for (const submissionId of ids) {
      db.run("DELETE FROM submissions WHERE id = ?", [submissionId]);
    }
    db.run("DELETE FROM projects WHERE id = ?", [id]);
    for (const path of paths) {
      await rm(path, { recursive: true, force: true });
    }
    db.run("COMMIT");
    console.log(`removed ${project.title}`);
  } finally {
    db?.close();
    await release();
  }
}

async function main() {
  const [id, ...extra] = process.argv.slice(2);
  if (!id || !uuid.test(id) || extra.length) {
    throw new Error("usage: bun run remove <beatmap id>");
  }
  const backend = service();
  const root = resolve(process.env.DATA_DIR ?? backend?.dataDir ?? join(homedir(), ".local", "share", "beatnet"));
  const db = new Database(join(root, "beatnet.sqlite"), { readonly: true, create: false });
  try {
    if (!db.query("SELECT id FROM projects WHERE id = ?").get(id)) {
      throw new Error("beatmap not found");
    }
  } finally {
    db.close();
  }
  const managed = backend?.dataDir === root;
  if (managed && backend.state !== "active" && backend.state !== "inactive" && backend.state !== "failed") {
    throw new Error("beatnet is changing state, pls wait");
  }
  const restart = managed && backend.state === "active";
  if (restart) {
    controlService("stop");
  }
  try {
    await removeMap(id, root);
  } finally {
    if (restart) {
      controlService("start");
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "cannot remove beatmap");
  process.exitCode = 1;
}