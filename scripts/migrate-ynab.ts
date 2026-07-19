import fs from "node:fs";
import path from "node:path";
import { sqlite, db } from "../src/db";
import {
  accounts,
  assignments,
  categories,
  categoryGroups,
  transactions,
} from "../src/db/schema";
import {
  buildImportResult,
  detectAutoCloseAccounts,
  parsePlanCsv,
  parseRegisterCsv,
  type ImportResult,
} from "../src/lib/ynab-import";
import {
  computeMonthSnapshot,
  monthKey,
  type AccountInfo,
  type TxnInput,
} from "../src/lib/budget-math";
import { adjustAssignment, setAccountClosed } from "../src/lib/queries";
import { computePaymentCategoryAdjustments, type PaymentCategoryAdjustment } from "../src/lib/reconciliation";

const PLAN_DIR = path.join(process.cwd(), "plan");
const BATCH_SIZE = 300;

/** True once anything has ever been imported/entered — the migration is about to wipe it all. */
function hasExistingData(): boolean {
  const row = sqlite.prepare("SELECT COUNT(*) AS c FROM transactions").get() as { c: number };
  return row.c > 0;
}

function findCsv(pattern: RegExp): string {
  const files = fs.readdirSync(PLAN_DIR);
  const match = files.find((f) => pattern.test(f));
  if (!match) {
    throw new Error(`No file matching ${pattern} found in ${PLAN_DIR}`);
  }
  return path.join(PLAN_DIR, match);
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

interface ResolvedTxn extends TxnInput {
  date: string;
}

function runImport(result: ImportResult) {
  sqlite.exec("DELETE FROM transactions");
  sqlite.exec("DELETE FROM assignments");
  sqlite.exec("DELETE FROM holdings");
  sqlite.exec("DELETE FROM accounts");
  sqlite.exec("DELETE FROM categories");
  sqlite.exec("DELETE FROM category_groups");

  const groupIdByName = new Map<string, number>();
  for (const group of result.categoryGroups) {
    const [inserted] = db
      .insert(categoryGroups)
      .values({ name: group.name, hidden: group.hidden, sort: group.sort })
      .returning({ id: categoryGroups.id })
      .all();
    groupIdByName.set(group.name, inserted.id);
  }

  const categoryIdByKey = new Map<string, number>();
  for (const category of result.categories) {
    const groupId = groupIdByName.get(category.groupName);
    if (groupId == null) continue;
    const [inserted] = db
      .insert(categories)
      .values({
        groupId,
        name: category.name,
        hidden: category.hidden,
        sort: category.sort,
      })
      .returning({ id: categories.id })
      .all();
    categoryIdByKey.set(`${category.groupName}::${category.name}`, inserted.id);
  }

  const paymentCategoryIdByAccount = new Map<string, number>();
  for (const link of result.creditCardLinks) {
    const categoryId = categoryIdByKey.get(`${link.paymentGroupName}::${link.paymentCategoryName}`);
    if (categoryId != null) paymentCategoryIdByAccount.set(link.accountName, categoryId);
  }

  const accountIdByName = new Map<string, number>();
  for (const account of result.accounts) {
    const [inserted] = db
      .insert(accounts)
      .values({
        name: account.name,
        type: account.type,
        sort: account.sort,
        paymentCategoryId: paymentCategoryIdByAccount.get(account.name) ?? null,
      })
      .returning({ id: accounts.id })
      .all();
    accountIdByName.set(account.name, inserted.id);
  }

  const resolvedTransactions: ResolvedTxn[] = [];
  for (const batch of chunk(result.transactions, BATCH_SIZE)) {
    const rows = batch.map((txn) => {
      const accountId = accountIdByName.get(txn.accountName);
      if (accountId == null) throw new Error(`Unknown account: ${txn.accountName}`);
      const categoryId =
        txn.groupName != null && txn.categoryName != null
          ? categoryIdByKey.get(`${txn.groupName}::${txn.categoryName}`) ?? null
          : null;
      const transferAccountId =
        txn.transferAccountName != null ? accountIdByName.get(txn.transferAccountName) ?? null : null;

      resolvedTransactions.push({ accountId, categoryId, amount: txn.amount, date: txn.date, transferAccountId });

      return {
        accountId,
        date: txn.date,
        payee: txn.payee,
        categoryId,
        memo: txn.memo,
        amount: txn.amount,
        cleared: txn.cleared,
        transferAccountId,
        transferPairId: txn.transferPairId,
      };
    });
    db.insert(transactions).values(rows).run();
  }

  const resolvedAssignments = new Map<string, number>();
  for (const batch of chunk(result.assignments, BATCH_SIZE)) {
    const rows = batch
      .map((a) => {
        const categoryId = categoryIdByKey.get(`${a.groupName}::${a.categoryName}`);
        if (categoryId == null) return null;
        resolvedAssignments.set(`${a.month}:${categoryId}`, a.amount);
        return { month: a.month, categoryId, amount: a.amount };
      })
      .filter((r): r is { month: string; categoryId: number; amount: number } => r != null);
    if (rows.length > 0) db.insert(assignments).values(rows).run();
  }

  // Auto-close: zero balance, no activity in the 12 months before the
  // export's last transaction date — a dead account nobody closed in YNAB.
  const autoClosedAccountNames = detectAutoCloseAccounts(
    result.accounts.map((a) => a.name),
    result.transactions
  );
  for (const name of autoClosedAccountNames) {
    const id = accountIdByName.get(name);
    if (id != null) setAccountClosed(db, id, true);
  }

  return {
    groupIdByName,
    categoryIdByKey,
    accountIdByName,
    paymentCategoryIdByAccount,
    resolvedTransactions,
    resolvedAssignments,
    autoClosedAccountNames,
  };
}

interface MonthWalk {
  availableByMonth: Map<string, Map<number, number>>;
  rtaByMonth: Map<string, number>;
}

/**
 * Walk every month forward once, computing each category's Available and
 * Ready to Assign. Shared by the reconciliation step and the verification
 * report so both read from the exact same replay.
 */
function walkAllMonths(
  months: string[],
  categoryIds: number[],
  accountInfoById: Map<number, AccountInfo>,
  resolvedAssignments: Map<string, number>,
  txnsByMonth: Map<string, ResolvedTxn[]>
): MonthWalk {
  let prevAvailable = new Map<number, number>();
  let cumulativeFunds = 0;
  const availableByMonth = new Map<string, Map<number, number>>();
  const rtaByMonth = new Map<string, number>();

  for (const month of months) {
    const assignedByCategory = new Map<number, number>();
    for (const categoryId of categoryIds) {
      const amount = resolvedAssignments.get(`${month}:${categoryId}`);
      if (amount != null) assignedByCategory.set(categoryId, amount);
    }
    const snapshot = computeMonthSnapshot({
      categoryIds,
      prevAvailable,
      assignedByCategory,
      monthTransactions: txnsByMonth.get(month) ?? [],
      cumulativeOnBudgetFundsThroughPrevMonth: cumulativeFunds,
      accounts: accountInfoById,
    });
    prevAvailable = new Map(
      Array.from(snapshot.categories.entries()).map(([id, s]) => [id, s.available])
    );
    cumulativeFunds = snapshot.cumulativeOnBudgetFunds;
    availableByMonth.set(month, new Map(prevAvailable));
    rtaByMonth.set(month, snapshot.readyToAssign);
  }

  return { availableByMonth, rtaByMonth };
}

interface Diff {
  month: string;
  groupName: string;
  categoryName: string;
  expected: number;
  actual: number;
  diff: number;
  isCreditPayment: boolean;
}

function buildVerificationDiffs(
  result: ImportResult,
  categoryIdByKey: Map<string, number>,
  paymentCategoryIds: Set<number>,
  availableByMonth: Map<string, Map<number, number>>,
  last12Months: string[]
) {
  const diffs: Diff[] = [];
  for (const entry of result.planAvailable) {
    if (!last12Months.includes(entry.month)) continue;
    const categoryId = categoryIdByKey.get(`${entry.groupName}::${entry.categoryName}`);
    if (categoryId == null) continue;
    const actual = availableByMonth.get(entry.month)?.get(categoryId) ?? 0;
    const diff = actual - entry.available;
    diffs.push({
      month: entry.month,
      groupName: entry.groupName,
      categoryName: entry.categoryName,
      expected: entry.available,
      actual,
      diff,
      isCreditPayment: paymentCategoryIds.has(categoryId),
    });
  }

  const regular = diffs.filter((d) => !d.isCreditPayment);
  const creditPayment = diffs.filter((d) => d.isCreditPayment);
  const regularMatches = regular.filter((d) => d.diff === 0);
  const regularMismatches = regular.filter((d) => d.diff !== 0);
  const creditMismatches = creditPayment.filter((d) => d.diff !== 0);

  const worst = [...regularMismatches]
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
    .slice(0, 5);
  const worstCreditPayment = [...creditMismatches]
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
    .slice(0, 5);

  return {
    regularTotal: regular.length,
    regularMatches: regularMatches.length,
    regularMismatches: regularMismatches.length,
    creditPaymentTotal: creditPayment.length,
    creditMismatches: creditMismatches.length,
    worst,
    worstCreditPayment,
  };
}

function computeAccountBalances(
  accountIdByName: Map<string, number>,
  resolvedTransactions: ResolvedTxn[]
): Map<string, number> {
  const accountBalances = new Map<number, number>();
  for (const txn of resolvedTransactions) {
    accountBalances.set(txn.accountId, (accountBalances.get(txn.accountId) ?? 0) + txn.amount);
  }
  const balanceByAccountName = new Map<string, number>();
  for (const [name, id] of accountIdByName) {
    balanceByAccountName.set(name, accountBalances.get(id) ?? 0);
  }
  return balanceByAccountName;
}

function formatRappen(amount: number): string {
  return (amount / 100).toFixed(2);
}

function main() {
  const force = process.argv.includes("--force");
  if (!force && hasExistingData()) {
    console.error(
      "\nRefusing to run: the database already has transactions.\n\n" +
        "This script is a ONE-TIME YNAB migration — it WIPES every transaction,\n" +
        "account, category, group, and assignment, then replaces them with a\n" +
        "fresh import from the CSVs in plan/. It's meant to be run once, before\n" +
        "you start using newbudget day to day, not as an ongoing sync.\n\n" +
        "If you're sure you want to discard the current data and re-import,\n" +
        "re-run with --force:\n\n" +
        "  pnpm migrate:ynab --force\n"
    );
    process.exitCode = 1;
    return;
  }

  const registerPath = findCsv(/register\.csv$/i);
  const planPath = findCsv(/plan\.csv$/i);

  console.log(`Register: ${registerPath}`);
  console.log(`Plan:     ${planPath}`);

  const registerRows = parseRegisterCsv(fs.readFileSync(registerPath));
  const planRows = parsePlanCsv(fs.readFileSync(planPath));
  const result = buildImportResult(registerRows, planRows);

  const {
    categoryIdByKey,
    accountIdByName,
    paymentCategoryIdByAccount,
    resolvedTransactions,
    resolvedAssignments,
    autoClosedAccountNames,
  } = sqlite.transaction(() => runImport(result))();

  console.log("\n=== Import summary ===");
  console.log(`Accounts:     ${result.accounts.length}`);
  console.log(`  on-budget:  ${result.accounts.filter((a) => a.type !== "tracking").length}`);
  console.log(`  tracking:   ${result.accounts.filter((a) => a.type === "tracking").length}`);
  console.log(`  credit:     ${result.accounts.filter((a) => a.type === "credit").length}`);
  console.log(`Category groups: ${result.categoryGroups.length}`);
  console.log(`Categories:      ${result.categories.length}`);
  console.log(`Transactions:    ${result.transactions.length}`);
  console.log(`Assignments:     ${result.assignments.length}`);

  console.log("\n=== Auto-closed accounts ===");
  if (autoClosedAccountNames.length > 0) {
    for (const name of autoClosedAccountNames) console.log(`  ${name}`);
  } else {
    console.log("  none");
  }

  // --- Reconciliation: snap every credit-payment category's Available at
  // the export's final month to YNAB's own Plan.csv value, booked as an
  // additional assignment. Only ever touches the final month.
  const accountInfoById = new Map<number, AccountInfo>();
  for (const account of result.accounts) {
    const id = accountIdByName.get(account.name)!;
    accountInfoById.set(id, {
      id,
      type: account.type,
      paymentCategoryId: paymentCategoryIdByAccount.get(account.name) ?? null,
    });
  }

  const allCategoryIds = Array.from(categoryIdByKey.values());
  const paymentCategoryIds = new Set(paymentCategoryIdByAccount.values());

  const txnsByMonth = new Map<string, ResolvedTxn[]>();
  for (const txn of resolvedTransactions) {
    const m = monthKey(txn.date);
    const list = txnsByMonth.get(m) ?? [];
    list.push(txn);
    txnsByMonth.set(m, list);
  }

  const months = Array.from(new Set(result.planAvailable.map((p) => p.month))).sort();
  const finalMonth = months.at(-1);

  let adjustments: PaymentCategoryAdjustment[] = [];
  let rtaBefore = 0;
  let rtaAfter = 0;
  let walkAfterAvailable = new Map<string, Map<number, number>>();

  if (finalMonth != null) {
    const walkBefore = walkAllMonths(months, allCategoryIds, accountInfoById, resolvedAssignments, txnsByMonth);
    rtaBefore = walkBefore.rtaByMonth.get(finalMonth) ?? 0;

    adjustments = computePaymentCategoryAdjustments({
      creditCardLinks: result.creditCardLinks,
      categoryIdByKey,
      planAvailable: result.planAvailable,
      ourAvailableAtMonth: walkBefore.availableByMonth.get(finalMonth) ?? new Map(),
      month: finalMonth,
    });

    for (const adjustment of adjustments) {
      adjustAssignment(db, adjustment.month, adjustment.categoryId, adjustment.delta);
      resolvedAssignments.set(
        `${adjustment.month}:${adjustment.categoryId}`,
        (resolvedAssignments.get(`${adjustment.month}:${adjustment.categoryId}`) ?? 0) + adjustment.delta
      );
    }

    const walkAfter = walkAllMonths(months, allCategoryIds, accountInfoById, resolvedAssignments, txnsByMonth);
    rtaAfter = walkAfter.rtaByMonth.get(finalMonth) ?? 0;
    walkAfterAvailable = walkAfter.availableByMonth;
  }

  console.log(`\n=== Reconciliation (${finalMonth ?? "n/a"}) ===`);
  console.log(`Ready to Assign before: ${formatRappen(rtaBefore)}`);
  if (adjustments.length > 0) {
    for (const a of adjustments) {
      console.log(
        `  ${a.accountName}: plan available ${formatRappen(a.planAvailable)}, ours was ${formatRappen(a.ourAvailable)}, adjustment ${formatRappen(a.delta)}`
      );
    }
  } else {
    console.log("  no adjustments (all payment categories already matched Plan.csv)");
  }
  console.log(`Ready to Assign after:  ${formatRappen(rtaAfter)}`);

  const last12Months = months.slice(-12);
  const report = buildVerificationDiffs(
    result,
    categoryIdByKey,
    paymentCategoryIds,
    walkAfterAvailable,
    last12Months
  );
  const balanceByAccountName = computeAccountBalances(accountIdByName, resolvedTransactions);

  console.log("\n=== Verification report (last 12 months) ===");
  console.log(`Months checked: ${last12Months[0]} .. ${last12Months.at(-1)}`);
  console.log(
    `Non-credit-payment category-months: ${report.regularTotal} total, ${report.regularMatches} matching, ${report.regularMismatches} mismatching` +
      ` (${((report.regularMatches / report.regularTotal) * 100).toFixed(2)}% match rate)`
  );
  console.log(
    `Credit-payment category-months: ${report.creditPaymentTotal} total, ${report.creditMismatches} mismatching (informational, not gating)`
  );

  if (report.worst.length > 0) {
    console.log("\nWorst 5 non-credit-payment diffs:");
    for (const d of report.worst) {
      console.log(
        `  ${d.month} ${d.groupName}: ${d.categoryName} — expected ${formatRappen(d.expected)}, got ${formatRappen(d.actual)} (diff ${formatRappen(d.diff)})`
      );
    }
  } else {
    console.log("\nNo mismatches on non-credit-payment categories.");
  }

  if (report.worstCreditPayment.length > 0) {
    console.log("\nWorst 5 credit-payment diffs (informational, not gating):");
    for (const d of report.worstCreditPayment) {
      console.log(
        `  ${d.month} ${d.groupName}: ${d.categoryName} — expected ${formatRappen(d.expected)}, got ${formatRappen(d.actual)} (diff ${formatRappen(d.diff)})`
      );
    }
  }

  console.log("\n=== Account balances ===");
  for (const account of result.accounts) {
    console.log(`  ${account.name}: ${formatRappen(balanceByAccountName.get(account.name) ?? 0)}`);
  }

  // The migration wipes budget data but deliberately leaves the `settings`
  // table alone (currency, etc.). A leftover RTA alignment adjustment from a
  // previous migration would silently apply to this freshly imported data and
  // almost certainly be wrong now — warn so it gets re-run or cleared. It does
  // NOT double-count with the reconciliation above: reconciliation books
  // payment-category deltas as assignments (moving category Available), while
  // the adjustment is a flat offset on Ready to Assign only — and the RTA
  // figures printed above are computed without it.
  const rtaAdjustmentRow = sqlite
    .prepare("SELECT value FROM settings WHERE key = 'rta_adjustment'")
    .get() as { value: string } | undefined;
  if (rtaAdjustmentRow != null) {
    console.warn(
      "\n=== Note: stale RTA alignment adjustment present ===\n" +
        `  A previous 'rta_adjustment' setting (${formatRappen(Number(rtaAdjustmentRow.value))}) survived this\n` +
        "  migration and will apply to the freshly imported data. If your Ready to\n" +
        "  Assign still differs from YNAB, re-run 'pnpm align:rta <target> <month>'\n" +
        "  to recompute it; otherwise clear the 'rta_adjustment' setting."
    );
  }

  if (report.regularMismatches > 0) {
    console.error(
      `\nFAILED: ${report.regularMismatches} non-credit-payment category-months did not match Plan.csv.`
    );
    process.exitCode = 1;
  } else {
    console.log("\nOK: all non-credit-payment categories match Plan.csv for the last 12 months.");
  }
}

main();
