/**
 * Ongoing per-account CSV import (bank-statement converter output in YNAB
 * Register column format). Distinct from the one-time YNAB migration in
 * `ynab-import.ts` — reuses its money/date parsers but is tolerant of a
 * looser, partial column set and never assumes a full YNAB export.
 *
 * Pure parsing/hashing logic only, no DB access — see `queries.ts` for the
 * DB-backed preview/commit steps (category matching, duplicate lookup).
 */
import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { parseMoneyInput } from "./currency";
import { parseAmount, parseDate } from "./ynab-import";

const REQUIRED_HEADERS = ["Date", "Payee", "Outflow", "Inflow"];

const READY_TO_ASSIGN_NAMES = new Set(["ready to assign", "inflow: ready to assign"]);

export interface ImportRowError {
  /** 1-based source line, or 0 for a whole-file error. */
  line: number;
  message: string;
}

export interface ParsedImportRow {
  line: number;
  date: string;
  payee: string;
  memo: string;
  /** Signed minor units (negative = outflow, positive = inflow). */
  amount: number;
  /** Raw category name parsed from the row, or null if blank/absent. */
  categoryName: string | null;
}

export type ParseCsvResult =
  | { ok: true; rows: ParsedImportRow[] }
  | { ok: false; errors: ImportRowError[] };

/**
 * Amount parser that accepts either YNAB's currency-prefixed format
 * ("CHF 12.34", "-CHF 79.60") or a plain number ("12.34", "-79.60"),
 * reusing the two existing generic parsers rather than adding a third.
 * Blank input is treated as zero (bank exports commonly leave one of
 * Outflow/Inflow empty).
 */
export function parseGenericAmount(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === "") return 0;
  try {
    return parseAmount(trimmed);
  } catch {
    const parsed = parseMoneyInput(trimmed);
    if (parsed == null) throw new Error(`Unrecognized amount: "${raw}"`);
    return parsed;
  }
}

function extractRawCategory(record: Record<string, string>): string | null {
  const direct = record["Category"]?.trim();
  if (direct) return direct;
  const combined = record["Category Group/Category"]?.trim();
  if (combined) return combined;
  return null;
}

export interface ResolvedCategoryName {
  /** True when the row's category is YNAB's "Inflow: Ready to Assign" — maps to categoryId null with RTA semantics. */
  isReadyToAssign: boolean;
  /** Bare category name (group prefix stripped), or null if the row carried none. */
  name: string | null;
}

/**
 * Resolve a raw category cell into a bare name, detecting YNAB's
 * "Inflow: Ready to Assign" (combined column) / "Ready to Assign" (bare
 * Category column) special case generically — no hardcoded group column
 * dependency.
 */
export function resolveCategoryName(raw: string | null): ResolvedCategoryName {
  if (!raw) return { isReadyToAssign: false, name: null };
  const trimmed = raw.trim();
  if (trimmed === "") return { isReadyToAssign: false, name: null };
  if (READY_TO_ASSIGN_NAMES.has(trimmed.toLowerCase())) {
    return { isReadyToAssign: true, name: "Ready to Assign" };
  }
  const colon = trimmed.indexOf(":");
  const bare = colon === -1 ? trimmed : trimmed.slice(colon + 1).trim();
  if (READY_TO_ASSIGN_NAMES.has(bare.toLowerCase())) {
    return { isReadyToAssign: true, name: "Ready to Assign" };
  }
  return { isReadyToAssign: false, name: bare || trimmed };
}

/**
 * Parse a bank-statement CSV in YNAB Register column format. Tolerates and
 * ignores Account/Flag columns; Category Group/Category columns are
 * optional. Any structural problem (missing required columns, no data rows)
 * or per-row parse failure (bad date/amount) fails the whole file — nothing
 * is ever partially imported.
 */
export function parseImportCsv(buffer: Buffer): ParseCsvResult {
  let records: Array<Record<string, string>>;
  try {
    records = parse(buffer, {
      columns: true,
      bom: true,
      relax_column_count: true,
      skip_empty_lines: true,
    }) as Array<Record<string, string>>;
  } catch (error) {
    return {
      ok: false,
      errors: [{ line: 0, message: error instanceof Error ? error.message : "Could not parse CSV." }],
    };
  }

  if (records.length === 0) {
    return { ok: false, errors: [{ line: 0, message: "CSV has no data rows." }] };
  }

  const headers = Object.keys(records[0]);
  const missing = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
  if (missing.length > 0) {
    return { ok: false, errors: [{ line: 1, message: `Missing required column(s): ${missing.join(", ")}` }] };
  }

  const rows: ParsedImportRow[] = [];
  const errors: ImportRowError[] = [];

  records.forEach((record, index) => {
    const line = index + 2; // header consumes line 1
    try {
      const dateRaw = record.Date ?? "";
      if (dateRaw.trim() === "") throw new Error("Date is required.");
      let date: string;
      try {
        date = parseDate(dateRaw);
      } catch {
        throw new Error(`Invalid date "${dateRaw}" (expected DD.MM.YYYY).`);
      }

      const outflow = parseGenericAmount(record.Outflow ?? "");
      const inflow = parseGenericAmount(record.Inflow ?? "");
      const amount = inflow - outflow;
      if (amount === 0) throw new Error("Enter an outflow or inflow amount.");

      rows.push({
        line,
        date,
        payee: (record.Payee ?? "").trim(),
        memo: (record.Memo ?? "").trim(),
        amount,
        categoryName: extractRawCategory(record),
      });
    } catch (error) {
      errors.push({ line, message: error instanceof Error ? error.message : "Could not parse row." });
    }
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, rows };
}

/** Stable hash of the fields that define a duplicate: account + date + amount + payee. */
export function computeImportHash(accountId: number, date: string, amount: number, payee: string): string {
  return createHash("sha256").update(`${accountId}|${date}|${amount}|${payee}`).digest("hex");
}
