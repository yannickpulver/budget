"use server";

import { db } from "@/db";
import {
  buildSwissquotePreview,
  commitSwissquoteImport,
  type SwissquotePreviewRow,
  type SwissquoteRowInput,
} from "@/lib/queries";
import { extractStatementText, parseStatementText } from "@/lib/swissquote-import";
import { withUndoStep } from "@/lib/undo";
import { refresh } from "../refresh";

export type StatementPreviewRowDto = SwissquotePreviewRow;

export type PreviewStatementResult =
  | { ok: true; rows: StatementPreviewRowDto[] }
  | { ok: false; errors: { file: string; message: string }[] };

/**
 * Parse + preview one or more Swissquote Kontoauszug PDFs for a tracking
 * account. Never writes to the DB. A parse failure (unreadable PDF or a
 * statement whose internal balance doesn't reconcile) on ANY file refuses
 * the whole batch — the task explicitly wants "parse incomplete" to block
 * rather than silently import a partial/wrong statement.
 */
export async function previewStatementAction(accountId: number, formData: FormData): Promise<PreviewStatementResult> {
  const files = formData.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return { ok: false, errors: [{ file: "", message: "No file uploaded." }] };
  }

  const statements = [];
  const errors: { file: string; message: string }[] = [];

  for (const file of files) {
    let text: string;
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      text = await extractStatementText(buffer);
    } catch {
      errors.push({ file: file.name, message: "Could not read this PDF." });
      continue;
    }
    const parsed = parseStatementText(text);
    if (!parsed.ok) {
      errors.push({ file: file.name, message: parsed.error });
      continue;
    }
    statements.push(parsed.statement);
  }

  if (errors.length > 0) return { ok: false, errors };

  const preview = buildSwissquotePreview(db, accountId, statements);
  return { ok: true, rows: preview.rows };
}

export type ConfirmStatementResult = { ok: true; count: number } | { ok: false; error: string };

/** Insert the rows the user kept checked in the preview. */
export async function confirmStatementAction(
  accountId: number,
  rows: SwissquoteRowInput[]
): Promise<ConfirmStatementResult> {
  if (rows.length === 0) return { ok: false, error: "No rows selected." };
  const count = withUndoStep(`Import ${rows.length} statement rows`, () =>
    commitSwissquoteImport(db, accountId, rows)
  );
  refresh(accountId);
  return { ok: true, count };
}
