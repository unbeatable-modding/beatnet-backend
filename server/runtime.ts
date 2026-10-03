import { chmod, mkdir, open, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

async function writeLock(path: string, owner: string) {
  const file = await open(path, "wx", 0o600);

  try {
    await file.writeFile(owner);
    await file.sync();
  } finally {
    await file.close();
  }
}

async function readLockPid(path: string): Promise<number> {
  let pid: number;

  try {
    const lock = JSON.parse(await readFile(path, "utf8")) as { pid: number };
    pid = lock.pid;
  } catch {
    throw new Error("Runtime lock is invalid");
  }

  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Runtime lock has an invalid process ID");
  }

  return pid;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }

    throw error;
  }
}

async function removeStaleLock(path: string) {
  const pid = await readLockPid(path);

  if (isProcessRunning(pid)) {
    throw new Error("Another backend process is using this directory");
  }

  await rm(path);
}

async function releaseLock(path: string, owner: string) {
  const currentOwner = await readFile(path, "utf8").catch(() => "");

  if (currentOwner === owner) {
    await rm(path, { force: true });
  }
}

export async function acquireRuntime(dataDir: string) {
  const root = resolve(dataDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);

  const path = join(root, "runtime.lock");
  const owner = JSON.stringify({ pid: process.pid, instance: crypto.randomUUID() });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeLock(path, owner);
      return () => releaseLock(path, owner);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }

    await removeStaleLock(path);
  }

  throw new Error("Could not get the runtime lock");
}
