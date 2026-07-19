"use client";

import { Scale } from "lucide-react";
import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { formatMoney, parseMoneyInput } from "@/lib/currency";
import { setAccountBalanceAction } from "../actions";

/**
 * For tracking accounts whose funds aren't exchange-listed (e.g. a
 * pillar-3a account) — the user reads the current value off the provider's
 * app and types it in here. Books an adjustment transaction for the
 * difference, same idea as the holdings "Sync balance" button but manual.
 */
export function SetBalancePopover({ accountId, balance }: { accountId: number; balance: number }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  function onOpenChange(next: boolean) {
    if (next) setValue(formatMoney(balance));
    setError(null);
    setOpen(next);
  }

  function save() {
    const parsed = parseMoneyInput(value);
    if (parsed == null) {
      setError("Not a valid amount.");
      return;
    }
    setOpen(false);
    startTransition(async () => {
      const result = await setAccountBalanceAction(accountId, parsed);
      // "Already at that balance" is an expected no-op, not a real error.
      if (!result.ok && result.error !== "Already at that balance.") setError(result.error);
    });
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={<Button size="sm" variant="outline" disabled={pending} />}>
        <Scale className="size-3.5" />
        Set balance
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56" initialFocus={inputRef}>
        <PopoverHeader>
          <PopoverTitle>Set balance</PopoverTitle>
        </PopoverHeader>
        <Input
          ref={inputRef}
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            }
          }}
          className="text-right tabular-nums"
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end">
          <Button size="sm" onClick={save}>
            Save
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
