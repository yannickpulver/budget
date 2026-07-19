import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Empty-state onboarding: a brand-new SQLite file (no tables at all) must
 * bootstrap itself and every query the sidebar/budget page rely on must
 * return an empty/zero result rather than throwing. Points `DATABASE_PATH`
 * at a scratch file in a temp directory — never touches the real
 * data/budget.db. See `src/db/index.ts` for the auto-bootstrap logic.
 */

let tmpDir: string;
let dbPath: string;
const originalDatabasePath = process.env.DATABASE_PATH;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "newbudget-onboarding-"));
  dbPath = path.join(tmpDir, "scratch.db");
  process.env.DATABASE_PATH = dbPath;
  vi.resetModules();
});

afterEach(() => {
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
  vi.resetModules();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("fresh database bootstrap", () => {
  it("creates the schema for a brand-new file and every empty-DB query returns empty/zero, not a crash", async () => {
    const { db, sqlite } = await import("@/db");
    const { getSidebarData, getBudgetView, currentMonth, listAccounts, listCategoryGroupsAdmin } = await import(
      "@/lib/queries"
    );

    expect(fs.existsSync(dbPath)).toBe(true);

    const sidebar = getSidebarData(db);
    expect(sidebar.budget).toEqual([]);
    expect(sidebar.tracking).toEqual([]);
    expect(sidebar.closed).toEqual([]);
    expect(sidebar.netWorth).toBe(0);

    const view = getBudgetView(currentMonth());
    expect(view.groups).toEqual([]);
    expect(view.readyToAssign).toBe(0);

    expect(listAccounts(db)).toEqual([]);
    expect(listCategoryGroupsAdmin(db)).toEqual([]);

    sqlite.close();
  });

  it("re-opening an already-bootstrapped file is a no-op (no duplicate-table crash)", async () => {
    const first = await import("@/db");
    first.sqlite.close();

    vi.resetModules();
    const second = await import("@/db");
    const { getSidebarData } = await import("@/lib/queries");

    expect(getSidebarData(second.db).netWorth).toBe(0);
    second.sqlite.close();
  });

  it("creating the first account seeds the starter categories and the budget/sidebar views reflect it", async () => {
    const { db, sqlite } = await import("@/db");
    const { createAccount, getSidebarData, getBudgetView, currentMonth, listCategoryGroupsAdmin } = await import(
      "@/lib/queries"
    );

    const accountId = createAccount(db, {
      name: "Checking",
      type: "checking",
      startingBalance: 100000,
      date: "2026-01-01",
    });

    const sidebar = getSidebarData(db);
    expect(sidebar.budget).toHaveLength(1);
    expect(sidebar.budget[0].id).toBe(accountId);
    expect(sidebar.netWorth).toBe(100000);

    const groups = listCategoryGroupsAdmin(db);
    expect(groups.length).toBeGreaterThan(0);
    expect(groups.map((g) => g.name)).toContain("Spending");

    const view = getBudgetView(currentMonth());
    expect(view.groups.length).toBeGreaterThan(0);

    sqlite.close();
  });

  it("giftcard accounts get their own sidebar section but stay folded into the Budget/net-worth totals", async () => {
    const { db, sqlite } = await import("@/db");
    const { createAccount, getSidebarData } = await import("@/lib/queries");

    const checkingId = createAccount(db, {
      name: "Checking",
      type: "checking",
      startingBalance: 100000,
      date: "2026-01-01",
    });
    const giftcardId = createAccount(db, {
      name: "Amazon Giftcard",
      type: "giftcard",
      startingBalance: 5000,
      date: "2026-01-01",
    });

    const sidebar = getSidebarData(db);

    // Own compact section, not mixed into the plain Budget list.
    expect(sidebar.budget.map((a) => a.id)).toEqual([checkingId]);
    expect(sidebar.giftcards.map((a) => a.id)).toEqual([giftcardId]);
    expect(sidebar.giftcardsTotal).toBe(5000);

    // Still on-budget funds: counted in the Budget subtotal and net worth.
    expect(sidebar.budgetTotal).toBe(105000);
    expect(sidebar.netWorth).toBe(105000);

    sqlite.close();
  });

  it("omits the giftcards section entirely when no giftcard account exists", async () => {
    const { db, sqlite } = await import("@/db");
    const { createAccount, getSidebarData } = await import("@/lib/queries");

    createAccount(db, { name: "Checking", type: "checking", startingBalance: 0, date: "2026-01-01" });

    expect(getSidebarData(db).giftcards).toEqual([]);
    sqlite.close();
  });
});
