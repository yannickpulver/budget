import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import * as schema from "./schema";

// Configurable so the Docker image (and tests) can point at a different
// SQLite file without code changes. Defaults to the local dev location.
const dbPath = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(process.cwd(), "data", "budget.db");

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

// Bootstrap the schema when the database file has no tables yet, so a fresh
// clone or a fresh Docker volume works immediately without a manual
// `pnpm db:push` step (this is what makes empty-state onboarding possible).
// Never touches a database that already has an `accounts` table — existing
// installs (including local dev's data/budget.db) keep managing schema
// changes via `pnpm db:push`, untouched.
const hasSchema = sqlite
  .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'accounts'")
  .get();
if (!hasSchema) {
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
}

export { sqlite };
