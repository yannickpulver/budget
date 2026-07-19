/**
 * One-off post-migration Ready to Assign alignment.
 *
 * YNAB's Ready to Assign is a path-dependent running ledger whose credit-card
 * internals aren't part of the CSV export, so after a migration our
 * from-scratch `funds − Σ available` RTA can differ from YNAB's by a fixed
 * amount even though every category available matches exactly. This script
 * snaps the app's Ready to Assign for a given month to the value YNAB shows,
 * by storing a flat adjustment (see `rta_adjustment` in queries.ts). It never
 * touches a category, an account balance, or the migration verification.
 *
 *   pnpm align:rta <target> <month>
 *   pnpm align:rta 328.95 2026-07
 *
 * <target> is the Ready to Assign amount YNAB shows for <month>, in major
 * units (e.g. 328.95). The adjustment applies to <month> and every later
 * month. Re-running replaces the previous adjustment (it never compounds).
 */
import { db } from "../src/db";
import { formatMoney } from "../src/lib/currency";
import {
  computeAlignmentAdjustment,
  getBudgetView,
  invalidateBudgetCache,
  setRtaAdjustment,
} from "../src/lib/queries";

const MONTH_RE = /^\d{4}-\d{2}$/;

function fail(message: string): never {
  console.error(`\n${message}\n`);
  console.error("Usage: pnpm align:rta <target-amount> <month>");
  console.error("  e.g. pnpm align:rta 328.95 2026-07\n");
  process.exit(1);
}

function main() {
  const [targetArg, month] = process.argv.slice(2);

  if (targetArg == null || month == null) fail("Both a target amount and a month (YYYY-MM) are required.");

  const targetMajor = Number(targetArg);
  if (!Number.isFinite(targetMajor)) fail(`Target amount "${targetArg}" is not a finite number.`);
  if (!MONTH_RE.test(month)) fail(`Month "${month}" is not in YYYY-MM format.`);

  const targetMinor = Math.round(targetMajor * 100);

  // Current app RTA for the month, with any existing adjustment already folded
  // in — subtracting the applied part recovers the raw RTA so re-aligning is
  // idempotent.
  const before = getBudgetView(month);
  const appliedAdjustment =
    before.rtaAdjustment && month >= before.rtaAdjustment.month ? before.rtaAdjustment.amount : 0;
  const adjustment = computeAlignmentAdjustment(targetMinor, before.readyToAssign, appliedAdjustment);

  setRtaAdjustment(db, adjustment, month);
  invalidateBudgetCache();

  const after = getBudgetView(month);

  console.log("\n=== RTA alignment ===");
  console.log(`Month:                ${month} (and every later month)`);
  console.log(`Ready to Assign before: ${formatMoney(before.readyToAssign)}`);
  console.log(`Target (YNAB):          ${formatMoney(targetMinor)}`);
  console.log(`Adjustment stored:      ${formatMoney(adjustment)}`);
  console.log(`Ready to Assign after:  ${formatMoney(after.readyToAssign)}`);
  console.log("");
}

main();
