import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/db/schema";
import {
  createAccount,
  createCategory,
  createCategoryGroup,
  createTransaction,
  deleteCategory,
  deleteCategoryGroup,
  listCategoryGroupsAdmin,
  moveCategoryToGroup,
  renameCategory,
  renameCategoryGroup,
  reorderCategories,
  reorderCategoryGroups,
  seedDefaultCategoriesIfEmpty,
  setCategoryGroupHidden,
  setCategoryHiddenFrom,
} from "./queries";

/**
 * Category settings (`/settings/categories`) and the empty-DB starter
 * category seed, against a throwaway in-memory SQLite fixture (never the
 * real data/budget.db), following the pattern in queries.test.ts.
 */

let sqlite: Database.Database;

function makeDb() {
  return drizzle(sqlite, { schema });
}

const DDL = `
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  payment_category_id INTEGER,
  linked_category_id INTEGER,
  icon TEXT,
  hidden_from TEXT
);
CREATE TABLE category_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  hidden_from TEXT,
  monthly_target INTEGER,
  target_type TEXT NOT NULL DEFAULT 'monthly',
  target_date TEXT
);
CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  payee TEXT NOT NULL DEFAULT '',
  category_id INTEGER,
  memo TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL,
  cleared INTEGER NOT NULL DEFAULT 0,
  transfer_account_id INTEGER,
  import_hash TEXT,
  transfer_pair_id TEXT
);
CREATE TABLE assignments (
  month TEXT NOT NULL,
  category_id INTEGER NOT NULL,
  amount INTEGER NOT NULL DEFAULT 0,
  goal_funded INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (month, category_id)
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(DDL);
});

afterEach(() => {
  sqlite.close();
});

describe("seedDefaultCategoriesIfEmpty", () => {
  it("seeds a starter set of groups/categories against an empty categories table", () => {
    const dbi = makeDb();
    seedDefaultCategoriesIfEmpty(dbi);

    const groups = listCategoryGroupsAdmin(dbi);
    expect(groups.map((g) => g.name)).toEqual(["Spending", "Bills", "Saving"]);
    expect(groups.find((g) => g.name === "Spending")?.categories.map((c) => c.name)).toEqual([
      "Groceries",
      "Eating Out",
      "Transport",
      "Fun",
      "Home",
    ]);
    expect(groups.every((g) => g.categories.every((c) => c.hiddenFrom == null && !c.referenced))).toBe(true);
  });

  it("is a no-op once any category exists, even a user-created one", () => {
    const dbi = makeDb();
    const groupId = createCategoryGroup(dbi, "Custom");
    createCategory(dbi, groupId, "My category");

    seedDefaultCategoriesIfEmpty(dbi);

    const groups = listCategoryGroupsAdmin(dbi);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("Custom");
  });

  it("runs automatically the first time an account is created", () => {
    const dbi = makeDb();
    createAccount(dbi, { name: "Checking", type: "checking", startingBalance: 0, date: "2026-01-01" });

    const groups = listCategoryGroupsAdmin(dbi);
    expect(groups.length).toBeGreaterThan(0);

    // Creating a second account never seeds again / never duplicates.
    createAccount(dbi, { name: "Savings", type: "savings", startingBalance: 0, date: "2026-01-01" });
    expect(listCategoryGroupsAdmin(dbi)).toHaveLength(groups.length);
  });
});

describe("category group CRUD", () => {
  it("creates, renames, and hides a group", () => {
    const dbi = makeDb();
    const id = createCategoryGroup(dbi, "  Spending  ");
    renameCategoryGroup(dbi, id, "Everyday Spending");
    setCategoryGroupHidden(dbi, id, true);

    const groups = listCategoryGroupsAdmin(dbi);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("Everyday Spending");
    expect(groups[0].hidden).toBe(true);
  });

  it("deletes an empty group but blocks deleting a group with categories", () => {
    const dbi = makeDb();
    const emptyId = createCategoryGroup(dbi, "Empty");
    const fullId = createCategoryGroup(dbi, "Full");
    createCategory(dbi, fullId, "Something");

    expect(deleteCategoryGroup(dbi, emptyId)).toEqual({ ok: true });
    expect(listCategoryGroupsAdmin(dbi).find((g) => g.id === emptyId)).toBeUndefined();

    const blocked = deleteCategoryGroup(dbi, fullId);
    expect(blocked.ok).toBe(false);
    expect(listCategoryGroupsAdmin(dbi).find((g) => g.id === fullId)).toBeDefined();
  });
});

describe("category CRUD", () => {
  it("creates, renames, and hides a category", () => {
    const dbi = makeDb();
    const groupId = createCategoryGroup(dbi, "Spending");
    const catId = createCategory(dbi, groupId, "  Groceries  ");
    renameCategory(dbi, catId, "Food");
    setCategoryHiddenFrom(dbi, catId, "2026-01");

    const category = listCategoryGroupsAdmin(dbi)[0].categories[0];
    expect(category.name).toBe("Food");
    expect(category.hiddenFrom).toBe("2026-01");
  });

  it("deletes an unreferenced category outright", () => {
    const dbi = makeDb();
    const groupId = createCategoryGroup(dbi, "Spending");
    const catId = createCategory(dbi, groupId, "Groceries");

    expect(deleteCategory(dbi, catId)).toEqual({ ok: true });
    expect(listCategoryGroupsAdmin(dbi)[0].categories).toHaveLength(0);
  });

  it("blocks deleting a category referenced by a transaction", () => {
    const dbi = makeDb();
    const accountId = createAccount(dbi, {
      name: "Checking",
      type: "checking",
      startingBalance: 0,
      date: "2026-01-01",
    });
    // createAccount auto-seeds categories on an empty table — start fresh instead.
    sqlite.exec("DELETE FROM categories; DELETE FROM category_groups;");
    const groupId = createCategoryGroup(dbi, "Spending");
    const catId = createCategory(dbi, groupId, "Groceries");
    createTransaction(dbi, {
      accountId,
      date: "2026-01-05",
      payee: "Store",
      categoryId: catId,
      memo: "",
      amount: -1000,
      cleared: true,
    });

    const result = deleteCategory(dbi, catId);
    expect(result.ok).toBe(false);
    expect(listCategoryGroupsAdmin(dbi)[0].categories[0].referenced).toBe(true);
  });

  it("blocks deleting a category referenced by an assignment", () => {
    const dbi = makeDb();
    const groupId = createCategoryGroup(dbi, "Spending");
    const catId = createCategory(dbi, groupId, "Groceries");
    sqlite
      .prepare("INSERT INTO assignments (month, category_id, amount) VALUES (?, ?, ?)")
      .run("2026-01", catId, 10000);

    expect(deleteCategory(dbi, catId).ok).toBe(false);
  });

  it("blocks deleting a category used as a credit account's payment category", () => {
    const dbi = makeDb();
    const groupId = createCategoryGroup(dbi, "Bills");
    const catId = createCategory(dbi, groupId, "Credit Card Payment");
    sqlite.exec(`INSERT INTO accounts (name, type, payment_category_id) VALUES ('Visa', 'credit', ${catId})`);

    expect(deleteCategory(dbi, catId).ok).toBe(false);
  });
});

describe("reordering", () => {
  it("reindexes group sort to match the given order", () => {
    const dbi = makeDb();
    const a = createCategoryGroup(dbi, "A");
    const b = createCategoryGroup(dbi, "B");
    const c = createCategoryGroup(dbi, "C");
    expect(listCategoryGroupsAdmin(dbi).map((g) => g.id)).toEqual([a, b, c]);

    reorderCategoryGroups(dbi, [c, a, b]);

    const groups = listCategoryGroupsAdmin(dbi);
    expect(groups.map((g) => g.id)).toEqual([c, a, b]);
    expect(groups.map((g) => g.sort)).toEqual([0, 1, 2]);
  });

  it("reindexes category sort within a group to match the given order", () => {
    const dbi = makeDb();
    const groupId = createCategoryGroup(dbi, "Spending");
    const x = createCategory(dbi, groupId, "X");
    const y = createCategory(dbi, groupId, "Y");
    const z = createCategory(dbi, groupId, "Z");

    reorderCategories(dbi, groupId, [z, x, y]);

    const categories = listCategoryGroupsAdmin(dbi)[0].categories;
    expect(categories.map((c) => c.id)).toEqual([z, x, y]);
    expect(categories.map((c) => c.sort)).toEqual([0, 1, 2]);
  });

  it("moves a category to another group, appended at the end", () => {
    const dbi = makeDb();
    const groupA = createCategoryGroup(dbi, "A");
    const groupB = createCategoryGroup(dbi, "B");
    const moving = createCategory(dbi, groupA, "Moving");
    createCategory(dbi, groupB, "Existing 1");
    createCategory(dbi, groupB, "Existing 2");

    moveCategoryToGroup(dbi, moving, groupB);

    const groups = listCategoryGroupsAdmin(dbi);
    const fromGroup = groups.find((g) => g.id === groupA)!;
    const toGroup = groups.find((g) => g.id === groupB)!;
    expect(fromGroup.categories).toHaveLength(0);
    expect(toGroup.categories.map((c) => c.name)).toEqual(["Existing 1", "Existing 2", "Moving"]);
    expect(toGroup.categories.find((c) => c.name === "Moving")?.sort).toBe(2);
  });

  it("appends to an empty target group at sort 0", () => {
    const dbi = makeDb();
    const groupA = createCategoryGroup(dbi, "A");
    const groupB = createCategoryGroup(dbi, "B");
    const moving = createCategory(dbi, groupA, "Moving");

    moveCategoryToGroup(dbi, moving, groupB);

    const toGroup = listCategoryGroupsAdmin(dbi).find((g) => g.id === groupB)!;
    expect(toGroup.categories).toHaveLength(1);
    expect(toGroup.categories[0].sort).toBe(0);
  });
});
