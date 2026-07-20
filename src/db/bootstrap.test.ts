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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "budget-onboarding-"));
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

  it("creating a giftcard auto-adds a matching budget category with its balance assigned, leaving RTA unchanged", async () => {
    const { db, sqlite } = await import("@/db");
    const { createAccount, getAccountDetail, getBudgetView } = await import("@/lib/queries");

    createAccount(db, { name: "Checking", type: "checking", startingBalance: 100000, date: "2026-01-01" });
    const giftcardId = createAccount(db, {
      name: "Amazon Giftcard",
      type: "giftcard",
      startingBalance: 5000,
      date: "2026-01-01",
    });

    const view = getBudgetView("2026-01");

    const giftcardGroup = view.groups.find((g) => g.name === "Giftcards");
    expect(giftcardGroup).toBeDefined();
    const giftcardCategory = giftcardGroup?.categories.find((c) => c.name === "Amazon Giftcard");
    expect(giftcardCategory).toBeDefined();

    // Starting balance moved out of Ready to Assign and into the category.
    expect(giftcardCategory?.assigned).toBe(5000);
    expect(giftcardCategory?.available).toBe(5000);

    // RTA reflects only the checking inflow — the giftcard's inflow and its
    // assignment cancel out.
    expect(view.readyToAssign).toBe(100000);

    // The account is linked to its category so new spend defaults there.
    expect(getAccountDetail(giftcardId, db)?.linkedCategoryId).toBe(giftcardCategory?.id);

    sqlite.close();
  });

  it("converting an existing account to a giftcard creates and links its category, assigning the current balance", async () => {
    const { db, sqlite } = await import("@/db");
    const { createAccount, setAccountType, getAccountDetail, getBudgetView, currentMonth } = await import(
      "@/lib/queries"
    );

    const id = createAccount(db, { name: "Cash Card", type: "cash", startingBalance: 3000, date: "2026-01-01" });
    expect(getAccountDetail(id, db)?.linkedCategoryId).toBeNull();

    setAccountType(db, id, "giftcard");

    const linkedId = getAccountDetail(id, db)?.linkedCategoryId;
    expect(linkedId).not.toBeNull();

    const view = getBudgetView(currentMonth());
    const giftcardGroup = view.groups.find((g) => g.name === "Giftcards");
    const category = giftcardGroup?.categories.find((c) => c.id === linkedId);
    expect(category?.name).toBe("Cash Card");
    expect(category?.assigned).toBe(3000);

    sqlite.close();
  });

  it("converting to giftcard is idempotent — an already-linked account keeps its single category", async () => {
    const { db, sqlite } = await import("@/db");
    const { createAccount, setAccountType, getAccountDetail, getBudgetView } = await import("@/lib/queries");

    const id = createAccount(db, { name: "Voucher", type: "giftcard", startingBalance: 1000, date: "2026-01-01" });
    const originalLinked = getAccountDetail(id, db)?.linkedCategoryId;

    // Flip away and back — must reuse the existing category, not spawn a second.
    setAccountType(db, id, "cash");
    setAccountType(db, id, "giftcard");

    expect(getAccountDetail(id, db)?.linkedCategoryId).toBe(originalLinked);
    const giftcardGroup = getBudgetView("2026-01").groups.find((g) => g.name === "Giftcards");
    expect(giftcardGroup?.categories.filter((c) => c.name === "Voucher")).toHaveLength(1);

    sqlite.close();
  });

  it("files every giftcard under one shared Giftcards group and skips assignment for a zero balance", async () => {
    const { db, sqlite } = await import("@/db");
    const { createAccount, getBudgetView } = await import("@/lib/queries");

    createAccount(db, { name: "Amazon", type: "giftcard", startingBalance: 5000, date: "2026-01-01" });
    createAccount(db, { name: "Apple", type: "giftcard", startingBalance: 0, date: "2026-01-01" });

    const view = getBudgetView("2026-01");
    const giftcardGroups = view.groups.filter((g) => g.name === "Giftcards");
    expect(giftcardGroups).toHaveLength(1);
    expect(giftcardGroups[0].categories.map((c) => c.name)).toEqual(
      expect.arrayContaining(["Amazon", "Apple"])
    );

    const apple = giftcardGroups[0].categories.find((c) => c.name === "Apple");
    expect(apple?.assigned).toBe(0);

    sqlite.close();
  });

  it("omits the giftcards section entirely when no giftcard account exists", async () => {
    const { db, sqlite } = await import("@/db");
    const { createAccount, getSidebarData } = await import("@/lib/queries");

    createAccount(db, { name: "Checking", type: "checking", startingBalance: 0, date: "2026-01-01" });

    expect(getSidebarData(db).giftcards).toEqual([]);
    sqlite.close();
  });

  it("a monthly goal shows only the capped target as 'to go' after money is pulled out", async () => {
    const { db, sqlite } = await import("@/db");
    const { createAccount, getBudgetView } = await import("@/lib/queries");
    const schema = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");

    createAccount(db, { name: "Checking", type: "checking", startingBalance: 1000000, date: "2026-01-01" });
    const cat = db.select().from(schema.categories).all()[0];
    db.update(schema.categories).set({ monthlyTarget: 50000 }).where(eq(schema.categories.id, cat.id)).run();
    // Pulled 955 out this month (assigned -955), goal not yet funded.
    db.insert(schema.assignments)
      .values({ month: "2026-01", categoryId: cat.id, amount: -95500, goalFunded: false })
      .run();

    const found = getBudgetView("2026-01").groups.flatMap((g) => g.categories).find((c) => c.id === cat.id);
    // Capped at the 500 target, not 500 + the 955 pulled out.
    expect(found?.assigned).toBe(-95500);
    expect(found?.goal).toEqual({ met: false, remaining: 50000 });

    sqlite.close();
  });

  it("a monthly goal funded this month reads as met even when net assigned is still negative", async () => {
    const { db, sqlite } = await import("@/db");
    const { createAccount, getBudgetView } = await import("@/lib/queries");
    const schema = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");

    createAccount(db, { name: "Checking", type: "checking", startingBalance: 1000000, date: "2026-01-01" });
    const cat = db.select().from(schema.categories).all()[0];
    db.update(schema.categories).set({ monthlyTarget: 50000 }).where(eq(schema.categories.id, cat.id)).run();
    // Pulled 955 out then funded one month's 500 → net -455, marked funded.
    db.insert(schema.assignments)
      .values({ month: "2026-01", categoryId: cat.id, amount: -45500, goalFunded: true })
      .run();

    const found = getBudgetView("2026-01").groups.flatMap((g) => g.categories).find((c) => c.id === cat.id);
    expect(found?.assigned).toBe(-45500);
    expect(found?.goal).toEqual({ met: true, remaining: 0 });

    sqlite.close();
  });

  it("new accounts default to a null icon (type default) until one is set", async () => {
    const { db, sqlite } = await import("@/db");
    const { createAccount, getAccountDetail, getSidebarData, setAccountIcon } = await import("@/lib/queries");

    const accountId = createAccount(db, { name: "Checking", type: "checking", startingBalance: 0, date: "2026-01-01" });

    expect(getAccountDetail(accountId, db)?.icon).toBeNull();
    expect(getSidebarData(db).budget[0].icon).toBeNull();

    setAccountIcon(db, accountId, "🏦");
    expect(getAccountDetail(accountId, db)?.icon).toBe("🏦");
    expect(getSidebarData(db).budget[0].icon).toBe("🏦");

    sqlite.close();
  });
});
