"use client";

import * as React from "react";
import { ArrowLeftRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { filterPayeeSuggestions, filterTransferTargets } from "@/lib/payee-suggestions";
import { cn } from "@/lib/utils";

interface TransferTargetOption {
  id: number;
  name: string;
}

/**
 * Payee text field with a keyboard-navigable suggestions dropdown. Looks like a
 * plain {@link Input}; the list overlays (never pushes) the dense register row.
 * Enter only picks a suggestion when one is actively highlighted — otherwise it
 * falls through to `onEnter` so the existing save-on-Enter flow is preserved.
 * Escape closes an open list (and only that); once closed it defers to `onEscape`.
 *
 * When `transferTargets` is given, a second group of "Transfer: <Account>"
 * entries is appended below the payee suggestions — YNAB-style transfer
 * creation/conversion via the payee field. Keyboard navigation spans both
 * groups; picking a transfer entry calls `onTransferSelect` instead of
 * `onValueChange`.
 */
export function PayeeInput({
  suggestions,
  value,
  onValueChange,
  onEnter,
  onEscape,
  onFocus,
  onBlur,
  transferTargets,
  onTransferSelect,
  className,
  ...inputProps
}: {
  suggestions: string[];
  value: string;
  onValueChange: (value: string) => void;
  onEnter?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onEscape?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  transferTargets?: TransferTargetOption[];
  onTransferSelect?: (accountId: number) => void;
} & Omit<React.ComponentProps<typeof Input>, "value" | "onChange" | "onKeyDown">) {
  const [open, setOpen] = React.useState(false);
  const [highlight, setHighlight] = React.useState(-1);
  const listId = React.useId();

  const items = React.useMemo(() => filterPayeeSuggestions(suggestions, value), [suggestions, value]);
  const transferItems = React.useMemo(
    () => (transferTargets ? filterTransferTargets(transferTargets, value) : []),
    [transferTargets, value]
  );
  const total = items.length + transferItems.length;
  const showList = open && total > 0;

  function close() {
    setOpen(false);
    setHighlight(-1);
  }

  function pick(payee: string) {
    onValueChange(payee);
    close();
  }

  function pickAt(index: number) {
    if (index < items.length) {
      pick(items[index]);
      return;
    }
    const target = transferItems[index - items.length];
    onTransferSelect?.(target.id);
    close();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!showList) return setOpen(true);
      setHighlight((h) => (h + 1) % total);
    } else if (e.key === "ArrowUp") {
      if (!showList) return;
      e.preventDefault();
      setHighlight((h) => (h <= 0 ? total - 1 : h - 1));
    } else if (e.key === "Enter") {
      if (showList && highlight >= 0) {
        e.preventDefault();
        pickAt(highlight);
        return;
      }
      close();
      onEnter?.(e);
    } else if (e.key === "Escape") {
      if (showList) {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      onEscape?.(e);
    }
  }

  return (
    <div className="relative min-w-0">
      <Input
        {...inputProps}
        value={value}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={highlight >= 0 ? `${listId}-${highlight}` : undefined}
        className={className}
        onChange={(e) => {
          onValueChange(e.currentTarget.value);
          setOpen(true);
          // Fresh typing must never carry a stale highlight (keeps plain Enter = save).
          setHighlight(-1);
        }}
        onFocus={(e) => {
          setOpen(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          close();
          onBlur?.(e);
        }}
        onKeyDown={handleKeyDown}
      />
      {showList && (
        <ul
          id={listId}
          role="listbox"
          className="absolute top-full right-0 left-0 z-50 mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-md"
        >
          {items.map((item, i) => (
            <li
              key={item}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === highlight}
              // Pick on mousedown (not click) and prevent default so the input
              // never blurs — avoids the edit-cell blur→save race.
              onMouseDown={(e) => {
                e.preventDefault();
                pickAt(i);
              }}
              onMouseEnter={() => setHighlight(i)}
              className={cn(
                "cursor-default truncate rounded-sm px-1.5 py-1",
                i === highlight && "bg-accent text-accent-foreground"
              )}
            >
              {item}
            </li>
          ))}
          {transferItems.length > 0 && (
            <>
              {items.length > 0 && <li role="separator" className="my-1 border-t border-border" />}
              {transferItems.map((target, i) => {
                const index = items.length + i;
                return (
                  <li
                    key={target.id}
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === highlight}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pickAt(index);
                    }}
                    onMouseEnter={() => setHighlight(index)}
                    className={cn(
                      "flex cursor-default items-center gap-1.5 truncate rounded-sm px-1.5 py-1 text-muted-foreground",
                      index === highlight && "bg-accent text-accent-foreground"
                    )}
                  >
                    <ArrowLeftRight className="size-3 shrink-0" />
                    <span className="truncate">Transfer: {target.name}</span>
                  </li>
                );
              })}
            </>
          )}
        </ul>
      )}
    </div>
  );
}
