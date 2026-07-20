import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUndo } from "./undo";

/**
 * Unit tests for the SQLite trigger-based undo/redo log. Each test uses a
 * throwaway in-memory database (never the real data/budget.db) with a subset
 * DDL, and drives the public API (withUndoStep/undo/redo/undoState) directly.
 */

// Subset of the real schema — just the tracked tables these tests exercise,
// plus one untracked table (settings) to prove it isn't logged.
const DDL = `
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  icon TEXT
);
CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  monthly_target INTEGER
);
CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  payee TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL,
  memo TEXT
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

let sqlite: Database.Database;
let undoApi: ReturnType<typeof createUndo>;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(DDL);
  undoApi = createUndo(sqlite);
});

afterEach(() => {
  sqlite.close();
});

function accounts() {
  return sqlite.prepare(`SELECT * FROM accounts ORDER BY id`).all() as {
    id: number;
    name: string;
    type: string;
    icon: string | null;
  }[];
}

describe("withUndoStep + undo/redo", () => {
  it("undoes and redoes an insert", () => {
    const { withUndoStep, undo, redo } = undoApi;
    withUndoStep("Add account", () => {
      sqlite.prepare(`INSERT INTO accounts (name, type) VALUES ('Checking', 'checking')`).run();
    });
    expect(accounts()).toHaveLength(1);

    const undone = undo();
    expect(undone).toEqual({ ok: true, label: "Add account" });
    expect(accounts()).toHaveLength(0);

    const redone = redo();
    expect(redone).toEqual({ ok: true, label: "Add account" });
    // Restored with its original id.
    expect(accounts()).toEqual([{ id: 1, name: "Checking", type: "checking", icon: null }]);
  });

  it("undoes an update, restoring old values including NULL and quotes", () => {
    const { withUndoStep, undo } = undoApi;
    // Seed a row whose name contains a single quote and whose icon is NULL.
    sqlite.prepare(`INSERT INTO accounts (name, type, icon) VALUES ('O''Brien', 'cash', NULL)`).run();

    withUndoStep("Edit account", () => {
      sqlite.prepare(`UPDATE accounts SET name = 'Renamed', icon = '💰' WHERE id = 1`).run();
    });
    expect(accounts()[0]).toEqual({ id: 1, name: "Renamed", type: "cash", icon: "💰" });

    undo();
    // Exact restoration — the apostrophe survives, icon goes back to NULL.
    expect(accounts()[0]).toEqual({ id: 1, name: "O'Brien", type: "cash", icon: null });
  });

  it("undoes a delete, restoring the row exactly", () => {
    const { withUndoStep, undo } = undoApi;
    sqlite
      .prepare(`INSERT INTO transactions (account_id, payee, amount, memo) VALUES (1, 'Store ''X''', -1250, NULL)`)
      .run();
    const before = sqlite.prepare(`SELECT * FROM transactions`).all();

    withUndoStep("Delete transaction", () => {
      sqlite.prepare(`DELETE FROM transactions WHERE id = 1`).run();
    });
    expect(sqlite.prepare(`SELECT * FROM transactions`).all()).toHaveLength(0);

    undo();
    expect(sqlite.prepare(`SELECT * FROM transactions`).all()).toEqual(before);
  });

  it("treats a multi-statement step atomically on undo", () => {
    const { withUndoStep, undo } = undoApi;
    withUndoStep("Add transfer", () => {
      sqlite.prepare(`INSERT INTO transactions (account_id, amount) VALUES (1, -500)`).run();
      sqlite.prepare(`INSERT INTO transactions (account_id, amount) VALUES (2, 500)`).run();
    });
    expect(sqlite.prepare(`SELECT COUNT(*) c FROM transactions`).get()).toEqual({ c: 2 });

    undo();
    // Both legs vanish in one undo.
    expect(sqlite.prepare(`SELECT COUNT(*) c FROM transactions`).get()).toEqual({ c: 0 });
  });

  it("supports redo after undo, then undo again", () => {
    const { withUndoStep, undo, redo, undoState } = undoApi;
    withUndoStep("Add account", () => {
      sqlite.prepare(`INSERT INTO accounts (name, type) VALUES ('A', 'cash')`).run();
    });
    undo();
    expect(undoState().canUndo).toBe(false);
    expect(undoState().canRedo).toBe(true);

    redo();
    expect(accounts()).toHaveLength(1);
    expect(undoState().canUndo).toBe(true);
    expect(undoState().canRedo).toBe(false);

    undo();
    expect(accounts()).toHaveLength(0);
  });

  it("clears the redo stack when a new step runs", () => {
    const { withUndoStep, undo, redo, undoState } = undoApi;
    withUndoStep("Add A", () => {
      sqlite.prepare(`INSERT INTO accounts (name, type) VALUES ('A', 'cash')`).run();
    });
    undo();
    expect(undoState().canRedo).toBe(true);

    // A fresh action invalidates the redo stack.
    withUndoStep("Add B", () => {
      sqlite.prepare(`INSERT INTO accounts (name, type) VALUES ('B', 'cash')`).run();
    });
    expect(undoState().canRedo).toBe(false);
    expect(redo()).toEqual({ ok: false });
    expect(accounts().map((a) => a.name)).toEqual(["B"]);
  });

  it("drops no-op steps that change nothing tracked", () => {
    const { withUndoStep, undoState } = undoApi;
    withUndoStep("No-op", () => {
      // touches nothing
    });
    expect(undoState().canUndo).toBe(false);
  });

  it("does not log untracked tables", () => {
    const { withUndoStep, undoState, undo } = undoApi;
    withUndoStep("Set setting", () => {
      sqlite.prepare(`INSERT INTO settings (key, value) VALUES ('k', 'v')`).run();
    });
    // The step captured nothing → nothing to undo.
    expect(undoState().canUndo).toBe(false);
    expect(undo()).toEqual({ ok: false });
    // The untracked write itself stands.
    expect(sqlite.prepare(`SELECT value FROM settings WHERE key = 'k'`).get()).toEqual({ value: "v" });
  });

  it("prunes to the most recent 100 steps", () => {
    const { withUndoStep, undo } = undoApi;
    for (let i = 0; i < 130; i++) {
      withUndoStep(`Step ${i}`, () => {
        sqlite.prepare(`INSERT INTO accounts (name, type) VALUES (?, 'cash')`).run(`acc-${i}`);
      });
    }
    const stepCount = sqlite.prepare(`SELECT COUNT(*) c FROM undo_steps WHERE kind = 'undo'`).get() as {
      c: number;
    };
    expect(stepCount.c).toBe(100);
    // Orphaned log rows are pruned too — every remaining log row maps to a step.
    const orphans = sqlite
      .prepare(`SELECT COUNT(*) c FROM undo_log WHERE step_id NOT IN (SELECT id FROM undo_steps)`)
      .get() as { c: number };
    expect(orphans.c).toBe(0);

    // The 30 oldest are gone; undoing 100 times exhausts the stack.
    for (let i = 0; i < 100; i++) expect(undo().ok).toBe(true);
    expect(undo()).toEqual({ ok: false });
    // Only the 30 pruned (oldest) accounts remain — their steps were dropped.
    expect(accounts()).toHaveLength(30);
    expect(accounts().map((a) => a.name)).toEqual(
      Array.from({ length: 30 }, (_, i) => `acc-${i}`)
    );
  });
});
