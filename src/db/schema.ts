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
    enum: ["checking", "savings", "cash", "credit", "giftcard", "tracking"],
  }).notNull(),
  closed: integer("closed", { mode: "boolean" }).notNull().default(false),
  sort: integer("sort").notNull().default(0),
  // For type "credit": the category that categorized spend on this account
  // feeds, so the payment is always funded. Null for non-credit accounts.
  paymentCategoryId: integer("payment_category_id").references(
    (): typeof categories.id => categories.id
  ),
  // Optional emoji override (1-2 chars, free text) shown instead of the
  // type's default lucide icon. Null = use the type default.
  icon: text("icon"),
  // Display-only: the month (YYYY-MM) from which this account is hidden in the
  // sidebar. Viewing any earlier month still shows it. Null = never hidden.
  // Purely cosmetic — budget math and totals ignore this flag.
  hiddenFrom: text("hidden_from"),
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
  // Stable link between a transfer's two legs (crypto.randomUUID()). Null for
  // legacy rows created before this column existed and for non-transfer rows
  // — `findMirrorLeg` in queries.ts falls back to the old
  // account/date/amount heuristic for those.
  transferPairId: text("transfer_pair_id"),
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

// Idempotency ledger for the ongoing per-account CSV import's commit step.
// `id` is a client-supplied uuid minted once at preview time; a retried or
// resubmitted confirm with the same id is a no-op (see `commitImport` in
// queries.ts) rather than re-inserting every row a second time. Deliberately
// not a uniqueness constraint on transaction content — legitimate duplicate
// transactions are real data and must stay importable.
export const importBatches = sqliteTable("import_batches", {
  id: text("id").primaryKey(),
  accountId: integer("account_id")
    .notNull()
    .references(() => accounts.id),
  count: integer("count").notNull(),
  committedAt: text("committed_at").notNull(),
});

// Cache of downloaded favicons per distinct payee. Populated on demand by the
// "Fetch payee icons" action (the register avatar falls back to the payee's
// initial when there's no "ok" row). `domain` records which guessed domain
// produced the icon; the icon bytes live on disk under data/payee-icons/,
// keyed by a hash of the payee (see src/lib/payee-icons.ts). A "none" row
// remembers a miss so it isn't re-fetched on every click.
export const payeeIcons = sqliteTable("payee_icons", {
  payee: text("payee").primaryKey(),
  // The domain that produced the icon (e.g. "migros.ch"); null for misses.
  domain: text("domain"),
  status: text("status", { enum: ["ok", "none"] }).notNull(),
  fetchedAt: text("fetched_at").notNull(), // ISO timestamp
});

// Per-row idempotency ledger for the Swissquote statement importer. Statement
// rows carry a bank-issued reference number (or, for the few row types that
// don't — fees, opening/closing balances — a derived composite key); this
// table remembers every previously-committed row's hash so re-importing a
// statement whose period *overlaps* an earlier one (e.g. a yearly summary
// after several monthlies) flags the already-applied rows as duplicates
// instead of double-booking them. Complements `import_batches`, which is
// reused for whole-statement idempotency keyed on account+period — see
// `commitSwissquoteImport` in queries.ts.
export const importedStatementRows = sqliteTable("imported_statement_rows", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  accountId: integer("account_id")
    .notNull()
    .references(() => accounts.id),
  importHash: text("import_hash").notNull(),
  committedAt: text("committed_at").notNull(),
});
