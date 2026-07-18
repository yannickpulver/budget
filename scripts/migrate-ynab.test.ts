import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression coverage for the migration's safety guard: `migrate-ynab.ts`
 * wipes and replaces the entire database, so it must refuse to run against a
 * DB that already has transactions unless `--force` is passed. Exercises the
 * real script as a child process (via the project's own tsx binary) against
 * a throwaway scratch DB and a plan/-less temp cwd — never touches the real
 * data/budget.db or the real plan/ directory.
 */

const repoRoot = path.resolve(__dirname, "..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
const scriptPath = path.join(repoRoot, "scripts", "migrate-ynab.ts");

let tmpDir: string;
let dbPath: string;
const originalDatabasePath = process.env.DATABASE_PATH;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "newbudget-migrate-guard-"));
  dbPath = path.join(tmpDir, "scratch.db");
});

afterEach(() => {
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Bootstraps the scratch DB (via the app's own db module) and seeds one transaction. */
async function seedExistingTransaction() {
  process.env.DATABASE_PATH = dbPath;
  vi.resetModules();
  const { db, sqlite } = await import("@/db");
  sqlite.exec(`
    INSERT INTO accounts (id, name, type) VALUES (1, 'Checking', 'checking');
    INSERT INTO transactions (account_id, date, amount) VALUES (1, '2025-01-01', 1000);
  `);
  void db;
  sqlite.close();
}

const tsconfigPath = path.join(repoRoot, "tsconfig.json");

function runScript(args: string[]) {
  return spawnSync(tsxBin, ["--tsconfig", tsconfigPath, scriptPath, ...args], {
    cwd: tmpDir, // no plan/ subdirectory here — isolates the guard from CSV-reading concerns
    env: { ...process.env, DATABASE_PATH: dbPath },
    encoding: "utf-8",
  });
}

describe("migrate-ynab guard", () => {
  it("refuses to run against a DB that already has transactions, without --force", async () => {
    await seedExistingTransaction();

    const result = runScript([]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/refusing to run/i);
    expect(result.stderr).toMatch(/one-time/i);
    expect(result.stderr).toMatch(/--force/);
  });

  it("proceeds past the guard with --force (fails later for an unrelated reason: no plan/ dir here)", async () => {
    await seedExistingTransaction();

    const result = runScript(["--force"]);

    // Must NOT be refused by the guard...
    expect(result.stderr).not.toMatch(/refusing to run/i);
    // ...it should instead fail trying to find the CSVs, proving it got past
    // the guard and attempted the real import.
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/plan/i);
  });

  it("runs without --force against a fresh (empty) DB", async () => {
    // Bootstraps the schema but seeds nothing — an empty DB is not "existing data".
    process.env.DATABASE_PATH = dbPath;
    vi.resetModules();
    const { sqlite } = await import("@/db");
    sqlite.close();

    const result = runScript([]);

    expect(result.stderr).not.toMatch(/refusing to run/i);
    // Still fails (no plan/ dir), but for the CSV-discovery reason, not the guard.
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/plan/i);
  });
});
