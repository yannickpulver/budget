"use client";

import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { useState, useTransition } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { AccountType } from "@/lib/budget-math";
import { evaluateMoneyExpression } from "@/lib/currency";
import { createAccountAction } from "./actions";

const TYPE_OPTIONS: Array<{ value: AccountType; label: string }> = [
  { value: "checking", label: "Checking" },
  { value: "savings", label: "Savings" },
  { value: "cash", label: "Cash" },
  { value: "credit", label: "Credit card" },
  { value: "giftcard", label: "Giftcard" },
  { value: "tracking", label: "Tracking (investments, loans…)" },
];

export function AddAccountDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("checking");
  const [startingBalance, setStartingBalance] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onOpenChange(next: boolean) {
    if (next) {
      setName("");
      setType("checking");
      setStartingBalance("");
      setError(null);
    }
    setOpen(next);
  }

  function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required.");
      return;
    }
    const parsedBalance = startingBalance.trim() === "" ? 0 : evaluateMoneyExpression(startingBalance);
    if (parsedBalance == null) {
      setError("Starting balance is not a valid amount.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await createAccountAction({ name: trimmed, type, startingBalance: parsedBalance });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      if (result.id != null) router.push(`/accounts/${result.id}`);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
        <Plus className="size-4" />
        Add account
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add account</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="account-name">Name</Label>
            <Input
              id="account-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder="e.g. Checking"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as AccountType)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="starting-balance">Starting balance</Label>
            <Input
              id="starting-balance"
              inputMode="decimal"
              placeholder="0.00"
              value={startingBalance}
              onChange={(e) => setStartingBalance(e.currentTarget.value)}
              className="text-right tabular-nums"
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button onClick={submit} disabled={pending}>
            {pending ? "Creating…" : "Create account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
