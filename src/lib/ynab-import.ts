import { parse } from "csv-parse/sync";
import type { AccountType } from "./budget-math";

// YNAB's own fixed system labels — identical across every export, not user data.
const RTA_GROUP = "Inflow";
const CREDIT_PAYMENTS_GROUP = "Credit Card Payments";
const HIDDEN_GROUP = "Hidden Categories";
const TRANSFER_PREFIX = "Transfer : ";

const MONTH_ABBREVIATIONS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function parseAmount(raw: string): number {
  const trimmed = raw.trim();
  const match = trimmed.match(/^(-)?[A-Za-z]{1,5}\s*(-)?([\d,]+(?:\.\d{1,2})?)$/);
  if (!match) throw new Error(`Unrecognized amount format: "${raw}"`);
  const negative = Boolean(match[1] || match[2]);
  const numeric = Number(match[3].replace(/,/g, ""));
  const minorUnits = Math.round(numeric * 100);
  return negative ? -minorUnits : minorUnits;
}

/** DD.MM.YYYY -> YYYY-MM-DD */
export function parseDate(raw: string): string {
  const [day, month, year] = raw.trim().split(".");
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/** "Jul 2020" -> "2020-07" */
export function parsePlanMonth(raw: string): string {
  const [abbreviation, year] = raw.trim().split(" ");
  const index = MONTH_ABBREVIATIONS.indexOf(abbreviation);
  if (index === -1) throw new Error(`Unrecognized month: "${raw}"`);
  return `${year}-${String(index + 1).padStart(2, "0")}`;
}

export interface RegisterRow {
  Account: string;
  Flag: string;
  Date: string;
  Payee: string;
  "Category Group/Category": string;
  "Category Group": string;
  Category: string;
  Memo: string;
  Outflow: string;
  Inflow: string;
  Cleared: string;
}

export interface PlanRow {
  Month: string;
  "Category Group/Category": string;
  "Category Group": string;
  Category: string;
  Assigned: string;
  Activity: string;
  Available: string;
}

function parseCsv<T>(csvBuffer: Buffer): T[] {
  return parse(csvBuffer, {
    columns: true,
    bom: true,
    relax_column_count: true,
    skip_empty_lines: true,
  }) as T[];
}

export function parseRegisterCsv(csvBuffer: Buffer): RegisterRow[] {
  return parseCsv<RegisterRow>(csvBuffer);
}

export function parsePlanCsv(csvBuffer: Buffer): PlanRow[] {
  return parseCsv<PlanRow>(csvBuffer);
}

export interface ImportedAccount {
  name: string;
  type: AccountType;
  sort: number;
}

export interface ImportedCategoryGroup {
  name: string;
  hidden: boolean;
  sort: number;
}

export interface ImportedCategory {
  groupName: string;
  name: string;
  hidden: boolean;
  sort: number;
}

export interface ImportedTransaction {
  accountName: string;
  date: string;
  payee: string;
  groupName: string | null;
  categoryName: string | null;
  memo: string;
  amount: number;
  cleared: boolean;
  transferAccountName: string | null;
}

export interface ImportedAssignment {
  month: string;
  groupName: string;
  categoryName: string;
  amount: number;
}

export interface PlanAvailableEntry {
  month: string;
  groupName: string;
  categoryName: string;
  assigned: number;
  activity: number;
  available: number;
}

export interface CreditCardLink {
  accountName: string;
  paymentGroupName: string;
  paymentCategoryName: string;
}

export interface ImportResult {
  accounts: ImportedAccount[];
  categoryGroups: ImportedCategoryGroup[];
  categories: ImportedCategory[];
  transactions: ImportedTransaction[];
  assignments: ImportedAssignment[];
  planAvailable: PlanAvailableEntry[];
  creditCardLinks: CreditCardLink[];
}

function isBlank(value: string): boolean {
  return value.trim() === "";
}

/**
 * An account is "on-budget" if it ever received Ready-to-Assign income or
 * had its own categorized spending. Everything else is a tracking account —
 * its incoming transfers get categorized on the *other* (on-budget) side
 * instead, and it never funds the budget directly.
 */
function detectAccountTypes(registerRows: RegisterRow[]): Map<string, AccountType> {
  const allAccounts = new Set<string>();
  const hasRta = new Set<string>();
  const hasOwnCategory = new Set<string>();

  for (const row of registerRows) {
    allAccounts.add(row.Account);
    const group = row["Category Group"];
    if (isBlank(group)) continue;
    if (group === RTA_GROUP) {
      hasRta.add(row.Account);
    } else {
      hasOwnCategory.add(row.Account);
    }
  }

  const types = new Map<string, AccountType>();
  for (const account of allAccounts) {
    const onBudget = hasRta.has(account) || hasOwnCategory.has(account);
    types.set(account, onBudget ? "checking" : "tracking");
  }
  return types;
}

interface CategoryKeyParts {
  groupName: string;
  categoryName: string;
}

function categoryKey({ groupName, categoryName }: CategoryKeyParts): string {
  return `${groupName}::${categoryName}`;
}

function collectCategories(
  registerRows: RegisterRow[],
  planRows: PlanRow[]
): ImportedCategoryGroup[] {
  const groupOrder: string[] = [];
  const groupHidden = new Map<string, boolean>();

  const record = (group: string) => {
    if (isBlank(group) || group === RTA_GROUP) return;
    if (!groupHidden.has(group)) {
      groupOrder.push(group);
      groupHidden.set(group, group === HIDDEN_GROUP);
    }
  };

  for (const row of registerRows) record(row["Category Group"]);
  for (const row of planRows) record(row["Category Group"]);

  return groupOrder.map((name, sort) => ({
    name,
    hidden: groupHidden.get(name) ?? false,
    sort,
  }));
}

function collectCategoriesWithinGroups(
  registerRows: RegisterRow[],
  planRows: PlanRow[],
  groups: ImportedCategoryGroup[]
): ImportedCategory[] {
  const groupHiddenByName = new Map(groups.map((g) => [g.name, g.hidden]));
  const seen = new Set<string>();
  const categories: ImportedCategory[] = [];
  const sortByGroup = new Map<string, number>();

  const record = (groupName: string, categoryName: string) => {
    if (isBlank(groupName) || groupName === RTA_GROUP || isBlank(categoryName)) return;
    const key = categoryKey({ groupName, categoryName });
    if (seen.has(key)) return;
    seen.add(key);
    const sort = sortByGroup.get(groupName) ?? 0;
    sortByGroup.set(groupName, sort + 1);
    categories.push({
      groupName,
      name: categoryName,
      hidden: groupHiddenByName.get(groupName) ?? false,
      sort,
    });
  };

  for (const row of registerRows) record(row["Category Group"], row.Category);
  for (const row of planRows) record(row["Category Group"], row.Category);

  return categories;
}

/**
 * Categories that ever recorded Activity in Plan.csv, keyed by "group category".
 * Used to distinguish a genuine (possibly closed) credit account's payment
 * category — which is fed by every card purchase, so it always has activity —
 * from a category that merely happens to share a name with an account.
 */
function collectCategoriesWithActivity(planRows: PlanRow[]): Set<string> {
  const withActivity = new Set<string>();
  for (const row of planRows) {
    const groupName = row["Category Group"];
    const categoryName = row.Category;
    if (isBlank(groupName) || isBlank(categoryName)) continue;
    if (parseAmount(row.Activity || "0") !== 0) {
      withActivity.add(categoryKey({ groupName, categoryName }));
    }
  }
  return withActivity;
}

/**
 * Link on-budget accounts to their credit-card payment category. The
 * canonical case is YNAB's own "Credit Card Payments" group. Accounts closed
 * long ago sometimes have their payment category filed under "Hidden
 * Categories" instead — still detected generically: the category name
 * matches the account name and, unlike a same-named category that's just a
 * coincidence, it actually carries activity (every card purchase feeds it).
 */
function buildCreditCardLinks(
  categories: ImportedCategory[],
  accountNames: Set<string>,
  categoriesWithActivity: Set<string>
): CreditCardLink[] {
  const links: CreditCardLink[] = [];
  for (const category of categories) {
    if (!accountNames.has(category.name)) continue;
    const isCanonicalGroup = category.groupName === CREDIT_PAYMENTS_GROUP;
    const isHiddenWithActivity =
      category.groupName === HIDDEN_GROUP &&
      categoriesWithActivity.has(categoryKey({ groupName: category.groupName, categoryName: category.name }));
    if (!isCanonicalGroup && !isHiddenWithActivity) continue;
    links.push({
      accountName: category.name,
      paymentGroupName: category.groupName,
      paymentCategoryName: category.name,
    });
  }
  return links;
}

function resolveTransactionCategory(
  groupName: string,
  categoryName: string
): { groupName: string | null; categoryName: string | null } {
  if (isBlank(groupName) || groupName === RTA_GROUP) {
    return { groupName: null, categoryName: null };
  }
  return { groupName, categoryName };
}

function buildTransactions(registerRows: RegisterRow[], accountNames: Set<string>): ImportedTransaction[] {
  return registerRows.map((row) => {
    const outflow = parseAmount(row.Outflow || "0");
    const inflow = parseAmount(row.Inflow || "0");
    const amount = inflow - outflow;
    const { groupName, categoryName } = resolveTransactionCategory(
      row["Category Group"],
      row.Category
    );

    let transferAccountName: string | null = null;
    if (row.Payee.startsWith(TRANSFER_PREFIX)) {
      const candidate = row.Payee.slice(TRANSFER_PREFIX.length).trim();
      if (accountNames.has(candidate)) transferAccountName = candidate;
    }

    return {
      accountName: row.Account,
      date: parseDate(row.Date),
      payee: row.Payee,
      groupName,
      categoryName,
      memo: row.Memo,
      amount,
      cleared: row.Cleared === "Cleared",
      transferAccountName,
    };
  });
}

function buildAssignments(planRows: PlanRow[]): ImportedAssignment[] {
  const assignments: ImportedAssignment[] = [];
  for (const row of planRows) {
    const groupName = row["Category Group"];
    const categoryName = row.Category;
    if (isBlank(groupName) || isBlank(categoryName) || groupName === RTA_GROUP) continue;
    assignments.push({
      month: parsePlanMonth(row.Month),
      groupName,
      categoryName,
      amount: parseAmount(row.Assigned || "0"),
    });
  }
  return assignments;
}

function buildPlanAvailable(planRows: PlanRow[]): PlanAvailableEntry[] {
  const entries: PlanAvailableEntry[] = [];
  for (const row of planRows) {
    const groupName = row["Category Group"];
    const categoryName = row.Category;
    if (isBlank(groupName) || isBlank(categoryName) || groupName === RTA_GROUP) continue;
    entries.push({
      month: parsePlanMonth(row.Month),
      groupName,
      categoryName,
      assigned: parseAmount(row.Assigned || "0"),
      activity: parseAmount(row.Activity || "0"),
      available: parseAmount(row.Available || "0"),
    });
  }
  return entries;
}

/** YYYY-MM-DD minus N months (calendar subtraction, UTC). */
function subtractMonths(isoDate: string, months: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 - months, day));
  return date.toISOString().slice(0, 10);
}

/**
 * Accounts to auto-close on import: zero balance and no activity in the 12
 * months before the export's last transaction date — i.e. dead accounts
 * nobody remembered to close in YNAB. Fully generic (dates + amounts only,
 * no hardcoded names).
 */
export function detectAutoCloseAccounts(
  accountNames: string[],
  transactions: ImportedTransaction[]
): string[] {
  let lastDate: string | null = null;
  const lastDateByAccount = new Map<string, string>();
  const balanceByAccount = new Map<string, number>();

  for (const txn of transactions) {
    if (lastDate === null || txn.date > lastDate) lastDate = txn.date;
    const prev = lastDateByAccount.get(txn.accountName);
    if (prev == null || txn.date > prev) lastDateByAccount.set(txn.accountName, txn.date);
    balanceByAccount.set(txn.accountName, (balanceByAccount.get(txn.accountName) ?? 0) + txn.amount);
  }
  if (lastDate === null) return [];
  const cutoff = subtractMonths(lastDate, 12);

  return accountNames.filter((name) => {
    if ((balanceByAccount.get(name) ?? 0) !== 0) return false;
    const accountLastDate = lastDateByAccount.get(name);
    return accountLastDate == null || accountLastDate < cutoff;
  });
}

export function buildImportResult(registerRows: RegisterRow[], planRows: PlanRow[]): ImportResult {
  const accountTypes = detectAccountTypes(registerRows);
  const accountNames = new Set(accountTypes.keys());

  const categoryGroups = collectCategories(registerRows, planRows);
  const categories = collectCategoriesWithinGroups(registerRows, planRows, categoryGroups);
  const categoriesWithActivity = collectCategoriesWithActivity(planRows);
  const creditCardLinks = buildCreditCardLinks(categories, accountNames, categoriesWithActivity);
  const creditAccountNames = new Set(creditCardLinks.map((l) => l.accountName));

  const accounts: ImportedAccount[] = Array.from(accountNames).map((name, sort) => ({
    name,
    type: creditAccountNames.has(name) ? "credit" : (accountTypes.get(name) as AccountType),
    sort,
  }));

  const transactions = buildTransactions(registerRows, accountNames);
  const assignments = buildAssignments(planRows);
  const planAvailable = buildPlanAvailable(planRows);

  return {
    accounts,
    categoryGroups,
    categories,
    transactions,
    assignments,
    planAvailable,
    creditCardLinks,
  };
}
