"use client";

import { Upload } from "lucide-react";
import { useRef, useState, useTransition } from "react";
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
import { formatCurrency } from "@/lib/currency";
import { cn } from "@/lib/utils";
import {
  confirmImportAction,
  previewImportAction,
  type ImportPreviewRowDto,
  type ImportRowErrorDto,
} from "./import-actions";

interface RowState extends ImportPreviewRowDto {
  checked: boolean;
}

/**
 * "Import CSV" flow for an account's register: upload -> server-parsed
 * preview (NEW/DUPLICATE per row, toggleable) -> confirm inserts the
 * checked rows. Parse errors block the whole file — nothing is inserted.
 */
export function ImportCsvDialog({ accountId, currency }: { accountId: number; currency: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<ImportRowErrorDto[] | null>(null);
  const [rows, setRows] = useState<RowState[] | null>(null);
  const [importedCount, setImportedCount] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function reset() {
    setErrors(null);
    setRows(null);
    setImportedCount(null);
    setFormError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function onOpenChange(next: boolean) {
    if (next) reset();
    setOpen(next);
  }

  function onFileChosen(file: File) {
    setFormError(null);
    setErrors(null);
    setRows(null);
    setImportedCount(null);
    const formData = new FormData();
    formData.append("file", file);
    startTransition(async () => {
      const outcome = await previewImportAction(accountId, formData);
      if (!outcome.ok) {
        setErrors(outcome.errors);
        return;
      }
      setRows(outcome.rows.map((r) => ({ ...r, checked: !r.isDuplicate })));
    });
  }

  function toggleRow(line: number) {
    setRows((prev) => prev && prev.map((r) => (r.line === line ? { ...r, checked: !r.checked } : r)));
  }

  function confirm() {
    if (!rows) return;
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
        }))
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button size="sm" variant="outline" />}>
        <Upload className="size-3.5" />
        Import CSV
      </DialogTrigger>
      <DialogContent className="max-w-full sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import CSV</DialogTitle>
        </DialogHeader>

        {!errors && !rows && importedCount === null && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Upload a CSV in YNAB Register column format (Date, Payee, Memo, Outflow, Inflow). Account, Flag and
              category columns are optional.
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
            <div className="max-h-[28rem] overflow-y-auto rounded-md border border-border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted text-muted-foreground uppercase">
                  <tr>
                    <th className="w-8 px-2.5 py-1.5" />
                    <th className="px-2.5 py-1.5 text-left font-medium">Status</th>
                    <th className="px-2.5 py-1.5 text-left font-medium">Date</th>
                    <th className="px-2.5 py-1.5 text-left font-medium">Payee</th>
                    <th className="px-2.5 py-1.5 text-left font-medium">Category</th>
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
                          onChange={() => toggleRow(r.line)}
                          aria-label={`Include row ${r.line}`}
                        />
                      </td>
                      <td className="px-2.5 py-1.5">
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase",
                            r.isDuplicate ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"
                          )}
                        >
                          {r.isDuplicate ? "Duplicate" : "New"}
                        </span>
                      </td>
                      <td className="px-2.5 py-1.5 tabular-nums whitespace-nowrap">{r.date}</td>
                      <td className="max-w-40 truncate px-2.5 py-1.5" title={r.payee}>
                        {r.payee || "—"}
                      </td>
                      <td className="max-w-32 truncate px-2.5 py-1.5 text-muted-foreground" title={r.categoryName ?? undefined}>
                        {r.categoryName ?? "—"}
                      </td>
                      <td className="max-w-40 truncate px-2.5 py-1.5 text-muted-foreground" title={r.memo}>
                        {r.memo || "—"}
                      </td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {formatCurrency(r.amount, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              {rows.length} row{rows.length === 1 ? "" : "s"} parsed, {checkedCount} selected to import.
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
              {pending ? "Importing…" : `Import ${checkedCount} transaction${checkedCount === 1 ? "" : "s"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
