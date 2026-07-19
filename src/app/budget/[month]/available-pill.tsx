"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { cn } from "@/lib/utils";
import { evaluateMoneyExpression, formatMoney } from "@/lib/currency";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { GroupView } from "@/lib/queries";
import { moveMoney } from "../actions";

const RTA = "rta";

function availableClass(value: number): string {
  if (value > 0) return "bg-emerald-100 text-emerald-700";
  if (value < 0) return "bg-red-100 text-red-700";
  return "bg-muted text-muted-foreground";
}

/**
 * The Available pill on a budget row. Zero stays inert (nothing to move).
 * A positive amount opens "Move money" — pick where the surplus goes. A
 * negative amount opens "Cover overspending" — pick where the deficit comes
 * from. Either side of the move can be Ready to Assign.
 */
export function AvailablePill({
  month,
  categoryId,
  available,
  groups,
}: {
  month: string;
  categoryId: number;
  available: number;
  groups: GroupView[];
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [target, setTarget] = useState<string>(RTA);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const isPositive = available > 0;

  const optionGroups = useMemo(
    () =>
      groups
        .map((group) => ({
          id: group.id,
          name: group.name,
          categories: group.categories.filter(
            (c) => c.id !== categoryId && (isPositive || c.available > 0)
          ),
        }))
        .filter((group) => group.categories.length > 0),
    [groups, categoryId, isPositive]
  );

  const items = useMemo(
    () => [
      { value: RTA, label: "Ready to Assign" },
      ...optionGroups.flatMap((group) =>
        group.categories.map((c) => ({
          value: String(c.id),
          label: isPositive ? c.name : `${c.name} · ${formatMoney(c.available)}`,
        }))
      ),
    ],
    [optionGroups, isPositive]
  );

  const pillClass = cn(
    "rounded-full px-2 py-0.5 text-right text-sm tabular-nums",
    availableClass(available)
  );

  function onOpenChange(next: boolean) {
    if (next) {
      setAmount(formatMoney(Math.abs(available)));
      setTarget(RTA);
    }
    setOpen(next);
  }

  function confirm() {
    const parsed = evaluateMoneyExpression(amount);
    if (parsed == null || parsed <= 0) return;
    const otherId = target === RTA ? null : Number(target);
    setOpen(false);
    const [fromId, toId] = isPositive ? [categoryId, otherId] : [otherId, categoryId];
    startTransition(() => {
      void moveMoney(month, fromId, toId, parsed);
    });
  }

  if (available === 0) {
    return <span className={pillClass}>{formatMoney(available)}</span>;
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        className={cn(
          pillClass,
          "cursor-pointer transition-shadow hover:underline hover:ring-2 hover:ring-foreground/15",
          pending && "opacity-50"
        )}
      >
        {formatMoney(available)}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64" initialFocus={inputRef}>
        <PopoverHeader>
          <PopoverTitle>{isPositive ? "Move money" : "Cover overspending"}</PopoverTitle>
        </PopoverHeader>
        <Input
          ref={inputRef}
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              confirm();
            }
          }}
          className="text-right tabular-nums"
        />
        <Select items={items} value={target} onValueChange={(v) => setTarget(v ?? RTA)}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={RTA}>Ready to Assign</SelectItem>
            </SelectGroup>
            {optionGroups.map((group) => (
              <SelectGroup key={group.id}>
                <SelectLabel>{group.name}</SelectLabel>
                {group.categories.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {isPositive ? c.name : `${c.name} · ${formatMoney(c.available)}`}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" onClick={confirm} disabled={pending} className="self-end">
          {isPositive ? "Move" : "Cover"}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
