"use server";

import { db } from "@/db";
import { parseImportCsv, type ImportRowError } from "@/lib/csv-import";
import { buildImportPreview, commitImport, type ImportPreviewRow } from "@/lib/queries";
import { refresh } from "../refresh";

export type ImportRowErrorDto = ImportRowError;
export type ImportPreviewRowDto = ImportPreviewRow;

export type PreviewImportResult =
  | { ok: true; rows: ImportPreviewRowDto[] }
  | { ok: false; errors: ImportRowErrorDto[] };

/** Parse + preview a bank-statement CSV for one account. Never writes to the DB. */
export async function previewImportAction(accountId: number, formData: FormData): Promise<PreviewImportResult> {
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return { ok: false, errors: [{ line: 0, message: "No file uploaded." }] };
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const parsed = parseImportCsv(buffer);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };

  const rows = buildImportPreview(db, accountId, parsed.rows);
  return { ok: true, rows };
}

export interface ImportRowInput {
  date: string;
  payee: string;
  memo: string;
  amount: number;
  categoryId: number | null;
  importHash: string;
}

export type ConfirmImportResult = { ok: true; count: number } | { ok: false; error: string };

/** Insert the rows the user kept checked in the preview. */
export async function confirmImportAction(accountId: number, rows: ImportRowInput[]): Promise<ConfirmImportResult> {
  if (rows.length === 0) return { ok: false, error: "No rows selected." };
  const count = commitImport(db, accountId, rows);
  refresh(accountId);
  return { ok: true, count };
}
