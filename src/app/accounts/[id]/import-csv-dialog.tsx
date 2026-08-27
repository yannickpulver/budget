"use client";

import { Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { PayeeInput } from "@/components/payee-input";
import { formatCurrency } from "@/lib/currency";
import type { CategoryGroupOption, TransferTarget } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { CategoryTransferSelect, type CategorySelection } from "./category-transfer-select";
import {
  confirmImportAction,
  previewImportAction,
  type ImportPreviewRowDto,
  type ImportRowErrorDto,
} from "./import-actions";

interface RowState extends ImportPreviewRowDto {
  checked: boolean;
}

const STATUS_LABELS: Record<ImportPreviewRowDto["status"], string> = {
  new: "New",
  duplicate: "Duplicate",
  revised: "Revised",
};

const STATUS_STYLES: Record<ImportPreviewRowDto["status"], string> = {
  new: "bg-emerald-100 text-emerald-800",
  duplicate: "bg-amber-100 text-amber-800",
  revised: "bg-sky-100 text-sky-800",
};

/** Row state -> the shape the shared category/transfer picker speaks. */
function selectionOf(row: RowState): CategorySelection {
  if (row.transferAccountId != null) {
    return { kind: "transfer", accountId: row.transferAccountId, categoryId: row.categoryId };
  }
  if (row.categoryId != null) return { kind: "category", categoryId: row.categoryId };
  return { kind: "rta" };
}

/** Picker selection -> row state. Category and transfer are mutually exclusive. */
function patchFor(selection: CategorySelection): Pick<RowState, "categoryId" | "transferAccountId"> {
  if (selection.kind === "transfer") {
    return { categoryId: selection.categoryId, transferAccountId: selection.accountId };
  }
  return { categoryId: selection.kind === "category" ? selection.categoryId : null, transferAccountId: null };
}

/**
 * "Import CSV" flow for an account's register: upload — via the file picker or
 * by dropping a CSV anywhere on the account page — -> server-parsed preview
 * (NEW/DUPLICATE/REVISED per row, toggleable) -> confirm inserts the checked
 * rows and updates the revised ones.
 * Payee and category/transfer are editable per row before confirming.
 * Parse errors block the whole file — nothing is inserted.
 */
export function ImportCsvDialog({
  accountId,
  currency,
  groups,
  transferTargets,
  payeeSuggestions,
}: {
  accountId: number;
  currency: string;
  groups: CategoryGroupOption[];
  /** Already excludes the account being imported into. */
  transferTargets: TransferTarget[];
  payeeSuggestions: string[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<ImportRowErrorDto[] | null>(null);
  const [rows, setRows] = useState<RowState[] | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [importedCount, setImportedCount] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Children fire their own dragenter/dragleave as the cursor crosses them, so a
  // plain boolean flickers. Count enters minus leaves instead.
  const [dragDepth, setDragDepth] = useState(0);

  function reset() {
    setErrors(null);
    setRows(null);
    setBatchId(null);
    setImportedCount(null);
    setFormError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function onOpenChange(next: boolean) {
    if (next) reset();
    setOpen(next);
  }

  const onFileChosen = useCallback(
    (file: File) => {
      setFormError(null);
      setErrors(null);
      setRows(null);
      setBatchId(null);
      setImportedCount(null);
      // The file input filters on `accept`, but a dropped file can be anything.
      if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") {
        setErrors([{ line: 0, message: `"${file.name}" is not a CSV file.` }]);
        return;
      }
      const formData = new FormData();
      formData.append("file", file);
      startTransition(async () => {
        const outcome = await previewImportAction(accountId, formData);
        if (!outcome.ok) {
          setErrors(outcome.errors);
          return;
        }
        setRows(outcome.rows.map((r) => ({ ...r, checked: r.status !== "duplicate" })));
        setBatchId(outcome.batchId);
      });
    },
    [accountId]
  );

  /**
   * Dropping a CSV anywhere on the account page starts the same flow as the file
   * picker. Listeners sit on `window` so the whole page is the target rather than
   * just the dialog; this component is mounted on exactly one account's page, so
   * a drop always imports into the account being viewed.
   */
  useEffect(() => {
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;

    function onDragEnter(e: DragEvent) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragDepth((d) => d + 1);
    }
    // Without preventDefault the browser navigates to the dropped file.
    function onDragOver(e: DragEvent) {
      if (!hasFiles(e)) return;
      e.preventDefault();
    }
    function onDragLeave(e: DragEvent) {
      if (!hasFiles(e)) return;
      setDragDepth((d) => Math.max(0, d - 1));
    }
    function onDrop(e: DragEvent) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragDepth(0);
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      // Bypasses onOpenChange (and so its reset) — onFileChosen already cleared state.
      setOpen(true);
      onFileChosen(file);
    }

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [onFileChosen]);

  function updateRow(line: number, patch: Partial<RowState>) {
    setRows((prev) => prev && prev.map((r) => (r.line === line ? { ...r, ...patch } : r)));
  }

  function confirm() {
    if (!rows || !batchId) return;
    const checkedRows = rows.filter((r) => r.checked);
    startTransition(async () => {
      const outcome = await confirmImportAction(
        accountId,
        checkedRows.map((r) => ({
          date: r.date,
          payee: r.payee,
          memo: r.memo,
          amount: r.amount,
          categoryId: r.categoryId,
          importHash: r.importHash,
          transferAccountId: r.transferAccountId,
          existingId: r.existingId,
        })),
        batchId
      );
      if (!outcome.ok) {
        setFormError(outcome.error);
        return;
      }
      setImportedCount(outcome.count);
      setRows(null);
    });
  }

  const checkedCount = rows?.filter((r) => r.checked).length ?? 0;
  const checkedRevisionCount = rows?.filter((r) => r.checked && r.status === "revised").length ?? 0;
  const checkedInsertCount = checkedCount - checkedRevisionCount;
  const confirmLabel =
    checkedRevisionCount === 0
      ? `Import ${checkedCount} transaction${checkedCount === 1 ? "" : "s"}`
      : checkedInsertCount === 0
        ? `Update ${checkedRevisionCount} transaction${checkedRevisionCount === 1 ? "" : "s"}`
        : `Import ${checkedInsertCount}, update ${checkedRevisionCount}`;

  return (
    <>
      {dragDepth > 0 && (
        // pointer-events-none: the overlay must not become the drop target itself.
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm">
          <div className="flex items-center gap-2 rounded-lg border-2 border-dashed border-border bg-background px-6 py-4 text-sm font-medium">
            <Upload className="size-4" />
            Drop a CSV to import into this account
          </div>
        </div>
      )}
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogTrigger render={<Button size="sm" variant="outline" aria-label="Import CSV" />}>
          <Upload className="size-3.5" />
          <span className="hidden md:inline">Import CSV</span>
        </DialogTrigger>
        <DialogContent className="max-h-[90dvh] max-w-full overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>Import CSV</DialogTitle>
          </DialogHeader>

          {!errors && !rows && importedCount === null && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">
                Upload a CSV in YNAB Register column format (Date, Payee, Memo, Outflow, Inflow), or drop one anywhere
                on this page. Account, Flag and category columns are optional. A{" "}
                <span className="font-medium">Transfer</span> column naming another account turns that row into a
                transfer — both sides are booked.
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                disabled={pending}
                onChange={(e) => {
                  const file = e.currentTarget.files?.[0];
                  if (file) onFileChosen(file);
                }}
                className="text-sm text-foreground file:mr-3 file:h-7 file:rounded-md file:border file:border-border file:bg-background file:px-2.5 file:text-sm file:font-medium hover:file:bg-muted"
              />
              {pending && <p className="text-xs text-muted-foreground">Parsing…</p>}
            </div>
          )}

          {errors && (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-destructive">Could not import — nothing was added. Fix these and try again:</p>
              <ul className="max-h-64 overflow-y-auto rounded-md border border-border text-xs">
                {errors.map((e, i) => (
                  <li key={i} className="border-b border-border/60 px-2.5 py-1.5 last:border-b-0">
                    {e.line > 0 ? `Line ${e.line}: ` : ""}
                    {e.message}
                  </li>
                ))}
              </ul>
              <Button size="sm" variant="outline" onClick={reset} className="self-start">
                Try another file
              </Button>
            </div>
          )}

          {rows && (
            <div className="flex flex-col gap-2">
              <div className="max-h-[60dvh] overflow-x-auto overflow-y-auto rounded-md border border-border md:max-h-[28rem]">
                <table className="w-full min-w-[36rem] text-xs">
                  <thead className="sticky top-0 bg-muted text-muted-foreground uppercase">
                    <tr>
                      <th className="w-8 px-2.5 py-1.5" />
                      <th className="px-2.5 py-1.5 text-left font-medium">Status</th>
                      <th className="px-2.5 py-1.5 text-left font-medium">Date</th>
                      <th className="px-2.5 py-1.5 text-left font-medium">Payee</th>
                      <th className="px-2.5 py-1.5 text-left font-medium">Category / Transfer</th>
                      <th className="px-2.5 py-1.5 text-left font-medium">Memo</th>
                      <th className="px-2.5 py-1.5 text-right font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {rows.map((r) => (
                      <tr key={r.line} className={cn(!r.checked && "opacity-50")}>
                        <td className="px-2.5 py-1.5">
                          <input
                            type="checkbox"
                            checked={r.checked}
                            onChange={() => updateRow(r.line, { checked: !r.checked })}
                            aria-label={`Include row ${r.line}`}
                          />
                        </td>
                        <td className="px-2.5 py-1.5">
                          <span
                            className={cn(
                              "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase",
                              STATUS_STYLES[r.status]
                            )}
                          >
                            {STATUS_LABELS[r.status]}
                          </span>
                        </td>
                        <td className="px-2.5 py-1.5 tabular-nums whitespace-nowrap">{r.date}</td>
                        <td className="w-48 px-2.5 py-1.5">
                          <PayeeInput
                            suggestions={payeeSuggestions}
                            value={r.payee}
                            onValueChange={(payee) => updateRow(r.line, { payee })}
                            placeholder="Payee"
                            aria-label={`Payee for row ${r.line}`}
                            className="h-7 text-xs"
                          />
                        </td>
                        <td className="w-56 px-2.5 py-1.5">
                          <CategoryTransferSelect
                            groups={groups}
                            transferTargets={transferTargets}
                            value={selectionOf(r)}
                            onChange={(selection) => updateRow(r.line, patchFor(selection))}
                          />
                        </td>
                        <td className="max-w-40 truncate px-2.5 py-1.5 text-muted-foreground" title={r.memo}>
                          {r.memo || "—"}
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap">
                          {r.status === "revised" && r.existingAmount != null && (
                            <span className="mr-1 text-muted-foreground line-through">
                              {formatCurrency(r.existingAmount, currency)}
                            </span>
                          )}
                          {formatCurrency(r.amount, currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground">
                {rows.length} row{rows.length === 1 ? "" : "s"} parsed, {checkedInsertCount} to import
                {checkedRevisionCount > 0 && `, ${checkedRevisionCount} to update`}.
              </p>
              {formError && <p className="text-sm text-destructive">{formError}</p>}
            </div>
          )}

          {importedCount !== null && (
            <p className="text-sm">
              Imported {importedCount} transaction{importedCount === 1 ? "" : "s"}.
            </p>
          )}

          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
            {rows && (
              <Button onClick={confirm} disabled={pending || checkedCount === 0}>
                {pending ? "Importing…" : confirmLabel}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
