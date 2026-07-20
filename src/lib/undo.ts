import type BetterSqlite3 from "better-sqlite3";
import { sqlite } from "@/db";

/**
 * Global undo/redo, adapted from https://www.sqlite.org/undoredo.html.
 *
 * TEMP triggers on every tracked table record the *inverse* SQL of each row
 * change into `undo_log`, grouped into `undo_steps`. Undoing replays a step's
 * inverse statements in reverse order; because the triggers are still live,
 * those replayed statements record *their* inverses into a fresh step on the
 * opposite (redo) stack — the classic sqlite.org capture-redirect technique.
 *
 * The triggers are installed lazily from here (never from src/db/index.ts) so
 * the CLI scripts, which import the db singleton directly, are never tracked.
 *
 * Only `accounts`, `category_groups`, `categories`, `transactions`,
 * `assignments`, `holdings`, `import_batches` and `imported_statement_rows`
 * are tracked — the pure caches (prices, payee_icons, settings) are not.
 */

const TRACKED_TABLES = [
  "accounts",
  "category_groups",
  "categories",
  "transactions",
  "assignments",
  "holdings",
  "import_batches",
  "imported_statement_rows",
] as const;

/** Keep at most this many undo steps; older ones (and their log rows) are pruned. */
const STEP_CAP = 100;

export interface UndoState {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
}

export interface UndoResult {
  ok: boolean;
  label?: string;
}

/** Double-quote an identifier for safe interpolation into SQL. */
function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Build the undo/redo manager bound to one connection. The app uses the
 * singleton exported below; tests build their own against a fresh connection.
 */
export function createUndo(conn: BetterSqlite3.Database) {
  let initialized = false;
  // Guards undo()/redo() against re-entrancy — while a replay runs the live
  // triggers keep firing, and we must not start a second replay on top.
  let replaying = false;

  function installTriggersFor(table: string): void {
    const cols = (
      conn.prepare(`PRAGMA table_info(${ident(table)})`).all() as { name: string }[]
    ).map((c) => c.name);
    // Absent table (e.g. a test fixture with a subset schema) — nothing to track.
    if (cols.length === 0) return;

    const t = ident(table);
    // DELETE inverse: re-INSERT every column (incl. rowid so foreign keys that
    // referenced the row still resolve). quote() round-trips NULLs, strings
    // with quotes, and blobs exactly.
    const insertCols = ["rowid", ...cols].map(ident).join(",");
    const insertVals = ["old.rowid", ...cols.map((c) => `quote(old.${ident(c)})`)].join(
      " || ',' || "
    );
    // UPDATE inverse: restore every column to its old value.
    const updateSet = cols
      .map((c) => `'${ident(c)}=' || quote(old.${ident(c)})`)
      .join(` || ',' || `);

    conn.exec(`
      CREATE TEMP TRIGGER IF NOT EXISTS _undo_${table}_insert AFTER INSERT ON ${t} BEGIN
        INSERT INTO undo_log (step_id, sql)
        SELECT step_id, 'DELETE FROM ${t} WHERE rowid=' || new.rowid
        FROM undo_active WHERE step_id IS NOT NULL;
      END;
      CREATE TEMP TRIGGER IF NOT EXISTS _undo_${table}_delete AFTER DELETE ON ${t} BEGIN
        INSERT INTO undo_log (step_id, sql)
        SELECT step_id,
          'INSERT INTO ${t}(${insertCols}) VALUES(' || ${insertVals} || ')'
        FROM undo_active WHERE step_id IS NOT NULL;
      END;
      CREATE TEMP TRIGGER IF NOT EXISTS _undo_${table}_update AFTER UPDATE ON ${t} BEGIN
        INSERT INTO undo_log (step_id, sql)
        SELECT step_id,
          'UPDATE ${t} SET ' || ${updateSet} || ' WHERE rowid=' || old.rowid
        FROM undo_active WHERE step_id IS NOT NULL;
      END;
    `);
  }

  function ensureUndoTriggers(): void {
    if (initialized) return;

    // Persistent history — survives a server restart so undo works after one.
    conn.exec(`
      CREATE TABLE IF NOT EXISTS undo_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        created_at TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('undo', 'redo'))
      );
      CREATE TABLE IF NOT EXISTS undo_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        step_id INTEGER NOT NULL,
        sql TEXT NOT NULL
      );
    `);

    // Per-connection pointer to the step currently being captured (NULL when
    // none is open). TEMP: no step is ever mid-flight across a restart, and the
    // triggers read it to know where to file their inverse SQL.
    conn.exec(`
      CREATE TEMP TABLE IF NOT EXISTS undo_active (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        step_id INTEGER
      );
      INSERT OR IGNORE INTO undo_active (id, step_id) VALUES (1, NULL);
    `);

    for (const table of TRACKED_TABLES) installTriggersFor(table);
    initialized = true;
  }

  function activeStep(): number | null {
    const row = conn.prepare(`SELECT step_id FROM undo_active WHERE id = 1`).get() as
      | { step_id: number | null }
      | undefined;
    return row?.step_id ?? null;
  }

  function setActiveStep(stepId: number | null): void {
    conn.prepare(`UPDATE undo_active SET step_id = ? WHERE id = 1`).run(stepId);
  }

  function topStep(kind: "undo" | "redo"): { id: number; label: string } | undefined {
    return conn
      .prepare(`SELECT id, label FROM undo_steps WHERE kind = ? ORDER BY id DESC LIMIT 1`)
      .get(kind) as { id: number; label: string } | undefined;
  }

  function deleteStep(id: number): void {
    conn.prepare(`DELETE FROM undo_log WHERE step_id = ?`).run(id);
    conn.prepare(`DELETE FROM undo_steps WHERE id = ?`).run(id);
  }

  function clearRedo(): void {
    conn.exec(`
      DELETE FROM undo_log WHERE step_id IN (SELECT id FROM undo_steps WHERE kind = 'redo');
      DELETE FROM undo_steps WHERE kind = 'redo';
    `);
  }

  function pruneSteps(): void {
    const stale = conn
      .prepare(`SELECT id FROM undo_steps WHERE kind = 'undo' ORDER BY id DESC LIMIT -1 OFFSET ?`)
      .all(STEP_CAP) as { id: number }[];
    for (const s of stale) deleteStep(s.id);
  }

  function beginStep(kind: "undo" | "redo", label: string): number {
    const info = conn
      .prepare(`INSERT INTO undo_steps (label, created_at, kind) VALUES (?, ?, ?)`)
      .run(label, new Date().toISOString(), kind);
    const stepId = Number(info.lastInsertRowid);
    setActiveStep(stepId);
    return stepId;
  }

  function endStep(stepId: number): void {
    setActiveStep(null);
    // Drop no-op steps (the action changed nothing tracked).
    const logged = conn.prepare(`SELECT 1 FROM undo_log WHERE step_id = ? LIMIT 1`).get(stepId);
    if (!logged) conn.prepare(`DELETE FROM undo_steps WHERE id = ?`).run(stepId);
  }

  /**
   * Run `fn` as one undoable step. A new step clears the redo stack. Nested
   * calls (or calls during a replay) just run `fn` without opening a step, so
   * the whole action stays in a single step. The step and its writes are
   * atomic — if `fn` throws, everything rolls back.
   */
  function withUndoStep<T>(label: string, fn: () => T): T {
    ensureUndoTriggers();
    if (replaying || activeStep() != null) return fn();

    return conn.transaction(() => {
      clearRedo();
      const stepId = beginStep("undo", label);
      try {
        return fn();
      } finally {
        endStep(stepId);
        pruneSteps();
      }
    })();
  }

  /** Replay the top step of `from`, capturing its inverse onto the opposite stack. */
  function apply(from: "undo" | "redo"): UndoResult {
    ensureUndoTriggers();
    if (replaying) return { ok: false };
    const top = topStep(from);
    if (!top) return { ok: false };
    const to = from === "undo" ? "redo" : "undo";

    replaying = true;
    try {
      conn.transaction(() => {
        // Open the opposite-stack step first so the triggers fired by the
        // replay below file their inverses into it.
        const target = beginStep(to, top.label);
        const rows = conn
          .prepare(`SELECT sql FROM undo_log WHERE step_id = ? ORDER BY seq DESC`)
          .all(top.id) as { sql: string }[];
        for (const r of rows) conn.exec(r.sql);
        setActiveStep(null);
        deleteStep(top.id);
        // A step that captured nothing (shouldn't happen) leaves no dangling row.
        endStep(target);
      })();
    } finally {
      replaying = false;
    }
    return { ok: true, label: top.label };
  }

  function undo(): UndoResult {
    return apply("undo");
  }

  function redo(): UndoResult {
    return apply("redo");
  }

  function undoState(): UndoState {
    ensureUndoTriggers();
    const u = topStep("undo");
    const r = topStep("redo");
    return { canUndo: !!u, canRedo: !!r, undoLabel: u?.label, redoLabel: r?.label };
  }

  return { ensureUndoTriggers, withUndoStep, undo, redo, undoState };
}

// App-wide manager bound to the shared connection. Triggers install lazily on
// first use, so importing this module has no side effects beyond opening the db
// (which src/db already does).
const appUndo = createUndo(sqlite);

export const withUndoStep = appUndo.withUndoStep;
export const undo = appUndo.undo;
export const redo = appUndo.redo;
export const undoState = appUndo.undoState;
