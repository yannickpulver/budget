import path from "node:path";

/**
 * Where the SQLite file lives. Mirrors the resolution in db/index.ts, kept in a
 * side-effect-free module so route handlers can locate data files without
 * opening the database.
 */
export function dbPath(): string {
  return process.env.DATABASE_PATH
    ? path.resolve(process.env.DATABASE_PATH)
    : path.join(process.cwd(), "data", "budget.db");
}

/**
 * Directory for persisted data files, alongside the database. In Docker that is
 * the mounted /data volume — anything written relative to `process.cwd()`
 * instead would be lost on every image rebuild.
 */
export function dataDir(): string {
  return path.dirname(dbPath());
}
