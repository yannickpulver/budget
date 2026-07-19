"use client";

import { FileText } from "lucide-react";
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
import { formatCurrency, formatQuantity } from "@/lib/currency";
import { cn } from "@/lib/utils";
import {
  confirmStatementAction,
  previewStatementAction,
  type StatementPreviewRowDto,
} from "./import-statement-actions";

interface RowState extends StatementPreviewRowDto {
  checked: boolean;
}

const KIND_LABEL: Record<StatementPreviewRowDto["kind"], string> = {
  buy: "Buy",
  sell: "Sell",
  dividend: "Dividend",
  interest: "Interest",
  fee: "Fee",
  deposit: "Deposit",
};

function statusBadge(row: RowState) {
  if (!row.bookable) return { text: "Info only", className: "bg-muted text-muted-foreground" };
  if (row.exists) return { text: "Exists", className: "bg-amber-100 text-amber-800" };
  if (row.isDuplicate) return { text: "Duplicate", className: "bg-amber-100 text-amber-800" };
  return { text: "New", className: "bg-emerald-100 text-emerald-800" };
}

/** Default-checked: bookable, not a duplicate, and no matching existing transaction. */
function defaultChecked(row: StatementPreviewRowDto): boolean {
  return row.bookable && !row.isDuplicate && !row.exists;
}

/**
 * "Import statement" flow for a tracking account: upload one or more
 * Swissquote Kontoauszug PDFs -> server-parsed + balance-verified preview
 * (grouped buy/sell/dividend/interest/fee/deposit rows, toggleable) ->
 * confirm applies the checked rows. Mirrors `ImportCsvDialog`'s
 * upload/preview/confirm shape.
 */
export function ImportStatementDialog({ accountId, currency }: { accountId: number; currency: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<{ file: string; message: string }[] | null>(null);
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

  function onFilesChosen(files: FileList) {
    setFormError(null);
    setErrors(null);
    setRows(null);
    setImportedCount(null);
    const formData = new FormData();
    for (const file of Array.from(files)) formData.append("files", file);
    startTransition(async () => {
      const outcome = await previewStatementAction(accountId, formData);
      if (!outcome.ok) {
        setErrors(outcome.errors);
        return;
      }
      setRows(outcome.rows.map((r) => ({ ...r, checked: defaultChecked(r) })));
    });
  }

  function toggleRow(key: string) {
    setRows((prev) => prev && prev.map((r) => (r.key === key ? { ...r, checked: !r.checked } : r)));
  }

  function confirm() {
    if (!rows) return;
    const checkedRows = rows.filter((r) => r.checked && r.bookable);
    startTransition(async () => {
      const outcome = await confirmStatementAction(
        accountId,
        checkedRows.map((r) => ({
          statementKey: r.statementKey,
          kind: r.kind,
          date: r.date,
          amount: r.amount,
          quantity: r.quantity,
          yahooSymbol: r.yahooSymbol,
          name: r.name,
          payee: r.payee,
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
        <FileText className="size-3.5" />
        Import statement
      </DialogTrigger>
      <DialogContent className="max-w-full sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Import Swissquote statement</DialogTitle>
        </DialogHeader>

        {!errors && !rows && importedCount === null && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Upload one or more Kontoauszug PDFs (Swissquote monthly statements). Buys/sells update your holdings,
              dividends/fees/deposits become transactions; foreign-currency cash entries are shown for reference
              only.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,application/pdf"
              multiple
              disabled={pending}
              onChange={(e) => {
                const files = e.currentTarget.files;
                if (files && files.length > 0) onFilesChosen(files);
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
                  {e.file && <span className="font-medium">{e.file}: </span>}
                  {e.message}
                </li>
              ))}
            </ul>
            <Button size="sm" variant="outline" onClick={reset} className="self-start">
              Try again
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
                    <th className="px-2.5 py-1.5 text-left font-medium">Kind</th>
                    <th className="px-2.5 py-1.5 text-left font-medium">Detail</th>
                    <th className="px-2.5 py-1.5 text-right font-medium">Amount</th>
                    <th className="px-2.5 py-1.5 text-right font-medium">New qty</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {rows.map((r) => {
                    const badge = statusBadge(r);
                    const isTrade = r.kind === "buy" || r.kind === "sell";
                    return (
                      <tr key={r.key} className={cn(!r.checked && "opacity-50")}>
                        <td className="px-2.5 py-1.5">
                          <input
                            type="checkbox"
                            checked={r.checked}
                            disabled={!r.bookable}
                            onChange={() => toggleRow(r.key)}
                            aria-label={`Include row ${r.key}`}
                          />
                        </td>
                        <td className="px-2.5 py-1.5">
                          <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium uppercase", badge.className)}>
                            {badge.text}
                          </span>
                        </td>
                        <td className="px-2.5 py-1.5 tabular-nums whitespace-nowrap">{r.date}</td>
                        <td className="px-2.5 py-1.5 whitespace-nowrap">
                          {KIND_LABEL[r.kind]}
                          {r.currency !== currency && <span className="ml-1 text-muted-foreground">({r.currency})</span>}
                        </td>
                        <td className="max-w-56 truncate px-2.5 py-1.5" title={isTrade ? `${r.name ?? ""} (${r.ticker ?? ""})` : r.payee}>
                          {isTrade ? `${r.name ?? r.ticker ?? ""} (${r.yahooSymbol ?? r.ticker ?? ""})` : r.payee}
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap">
                          {isTrade
                            ? `${r.kind === "buy" ? "+" : "-"}${formatQuantity(r.quantity ?? 0)}`
                            : formatCurrency(r.amount, r.currency)}
                        </td>
                        <td className="px-2.5 py-1.5 text-right tabular-nums whitespace-nowrap text-muted-foreground">
                          {isTrade && r.resultingQuantity != null ? formatQuantity(r.resultingQuantity) : "—"}
                        </td>
                      </tr>
                    );
                  })}
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
            Imported {importedCount} row{importedCount === 1 ? "" : "s"}.
          </p>
        )}

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
          {rows && (
            <Button onClick={confirm} disabled={pending || checkedCount === 0}>
              {pending ? "Importing…" : `Import ${checkedCount} row${checkedCount === 1 ? "" : "s"}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
