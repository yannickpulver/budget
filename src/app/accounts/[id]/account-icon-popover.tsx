"use client";

import { useRef, useState, useTransition } from "react";
import { AccountIcon } from "@/components/account-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import type { AccountType } from "@/lib/budget-math";
import { updateAccountIconAction } from "../actions";

/**
 * Click-to-edit emoji override for the account's icon. Free text (no grid
 * picker, kept dense) — 1-2 chars is the expected shape but not enforced
 * beyond a maxLength, since some emoji are multi-codepoint.
 */
export function AccountIconPopover({
  accountId,
  type,
  icon,
}: {
  accountId: number;
  type: AccountType;
  icon: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(icon ?? "");
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  function onOpenChange(next: boolean) {
    if (next) setValue(icon ?? "");
    setOpen(next);
  }

  function save() {
    const trimmed = value.trim();
    setOpen(false);
    startTransition(async () => {
      await updateAccountIconAction(accountId, trimmed === "" ? null : trimmed);
    });
  }

  function reset() {
    setOpen(false);
    startTransition(async () => {
      await updateAccountIconAction(accountId, null);
    });
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        aria-label="Edit account icon"
        disabled={pending}
        className="flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-muted"
      >
        <AccountIcon type={type} icon={icon} className="size-4" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-44" initialFocus={inputRef}>
        <PopoverHeader>
          <PopoverTitle>Icon</PopoverTitle>
        </PopoverHeader>
        <Input
          ref={inputRef}
          value={value}
          maxLength={2}
          onChange={(e) => setValue(e.currentTarget.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            }
          }}
          placeholder="🏦"
          className="text-center"
        />
        <div className="flex justify-between gap-2">
          <Button size="sm" variant="ghost" onClick={reset} disabled={icon == null}>
            Reset
          </Button>
          <Button size="sm" onClick={save}>
            Save
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
