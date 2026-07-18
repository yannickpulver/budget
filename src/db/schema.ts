import {
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

export const accounts = sqliteTable("accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  type: text("type", {
    enum: ["checking", "savings", "cash", "credit", "tracking"],
  }).notNull(),
  closed: integer("closed", { mode: "boolean" }).notNull().default(false),
  sort: integer("sort").notNull().default(0),
  // For type "credit": the category that categorized spend on this account
  // feeds, so the payment is always funded. Null for non-credit accounts.
  paymentCategoryId: integer("payment_category_id").references(
    (): typeof categories.id => categories.id
  ),
});

export const categoryGroups = sqliteTable("category_groups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  sort: integer("sort").notNull().default(0),
  hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
});

export const categories = sqliteTable("categories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  groupId: integer("group_id")
    .notNull()
    .references(() => categoryGroups.id),
  name: text("name").notNull(),
  sort: integer("sort").notNull().default(0),
  hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
  // Rappen (minor units). Null = no monthly assignment goal.
  monthlyTarget: integer("monthly_target"),
});

export const transactions = sqliteTable("transactions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id")
    .notNull()
    .references(() => accounts.id),
  date: text("date").notNull(), // ISO YYYY-MM-DD
  payee: text("payee").notNull().default(""),
  categoryId: integer("category_id").references(() => categories.id),
  memo: text("memo").notNull().default(""),
  amount: integer("amount").notNull(), // Rappen, +inflow / -outflow
  cleared: integer("cleared", { mode: "boolean" }).notNull().default(false),
  transferAccountId: integer("transfer_account_id").references(
    (): typeof accounts.id => accounts.id
  ),
  importHash: text("import_hash"),
});

export const assignments = sqliteTable(
  "assignments",
  {
    month: text("month").notNull(), // YYYY-MM
    categoryId: integer("category_id")
      .notNull()
      .references(() => categories.id),
    amount: integer("amount").notNull().default(0), // Rappen
  },
  (table) => [primaryKey({ columns: [table.month, table.categoryId] })]
);

export const holdings = sqliteTable("holdings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id")
    .notNull()
    .references(() => accounts.id),
  symbol: text("symbol").notNull(),
  name: text("name").notNull().default(""),
  quantity: real("quantity").notNull().default(0),
});

export const prices = sqliteTable("prices", {
  symbol: text("symbol").primaryKey(),
  // Always in the budget's currency minor units (converted at fetch time if
  // the quote's native currency differs — see `currency`/`fxRate` below).
  priceRappen: integer("price_rappen").notNull(),
  fetchedAt: text("fetched_at").notNull(),
  // Native quote currency reported by the price source, e.g. "USD". Null
  // until first successfully fetched.
  currency: text("currency"),
  // Native -> budget-currency rate applied to produce priceRappen. Null when
  // the quote's currency already matches the budget currency.
  fxRate: real("fx_rate"),
  // Set when the most recent fetch attempt failed; priceRappen/fetchedAt
  // keep the last successful value so the UI can show a stale/error hint
  // without losing the cached price. Cleared on the next successful fetch.
  fetchError: text("fetch_error"),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
