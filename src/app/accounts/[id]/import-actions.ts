"use server";

import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { parseImportCsv, type ImportRowError } from "@/lib/csv-import";
import { buildImportPreview, commitImport, findTransferAccountErrors, type ImportPreviewRow } from "@/lib/queries";
import { withUndoStep } from "@/lib/undo";
import { refresh } from "../refresh";

export type ImportRowErrorDto = ImportRowError;
export type ImportPreviewRowDto = ImportPreviewRow;

export type PreviewImportResult =
  | { ok: true; rows: ImportPreviewRowDto[]; batchId: string }
  | { ok: false; errors: ImportRowErrorDto[] };

/**
 * Parse + preview a bank-statement CSV for one account. Never writes to the
 * DB. Mints a `batchId` that the client must carry through to
 * `confirmImportAction` — it's what makes a retried/resubmitted confirm
 * idempotent instead of double-booking every row.
 */
export async function previewImportAction(accountId: number, formData: FormData): Promise<PreviewImportResult> {
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return { ok: false, errors: [{ line: 0, message: "No file uploaded." }] };
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const parsed = parseImportCsv(buffer);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };

  // Reject the file outright when a Transfer column names an account we can't
  // resolve — importing those rows as ordinary transactions would leave the
  // counterpart account short.
  const transferErrors = findTransferAccountErrors(db, accountId, parsed.rows);
  if (transferErrors.length > 0) return { ok: false, errors: transferErrors };

  const rows = buildImportPreview(db, accountId, parsed.rows);
  return { ok: true, rows, batchId: randomUUID() };
}

export interface ImportRowInput {
  date: string;
  payee: string;
  memo: string;
  amount: number;
  categoryId: number | null;
  importHash: string;
  transferAccountId?: number | null;
  /**
   * Set when the preview matched this row to an existing transaction the bank
   * restated: commit updates that row's amount instead of inserting.
   */
  existingId?: number | null;
}

export type ConfirmImportResult = { ok: true; count: number } | { ok: false; error: string };

/**
 * Commit the rows the user kept checked in the preview: rows carrying an
 * `existingId` update that transaction's amount, the rest insert. `batchId`
 * comes from the preceding `previewImportAction` call — passing the same
 * batchId twice (e.g. a client retry after a dropped response) commits once
 * and returns the original count both times.
 */
export async function confirmImportAction(
  accountId: number,
  rows: ImportRowInput[],
  batchId: string
): Promise<ConfirmImportResult> {
  if (rows.length === 0) return { ok: false, error: "No rows selected." };
  const inserts = rows.filter((r) => r.existingId == null);
  const revisions = rows
    .filter((r) => r.existingId != null)
    .map((r) => ({ id: r.existingId!, amount: r.amount, importHash: r.importHash }));
  const label =
    revisions.length === 0
      ? `Import ${inserts.length} transactions`
      : inserts.length === 0
        ? `Update ${revisions.length} transactions`
        : `Import ${inserts.length} transactions, update ${revisions.length}`;
  const count = withUndoStep(label, () => commitImport(db, accountId, inserts, batchId, revisions));
  refresh(accountId);
  return { ok: true, count };
}
