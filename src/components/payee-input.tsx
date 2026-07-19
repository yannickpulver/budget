"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { filterPayeeSuggestions } from "@/lib/payee-suggestions";
import { cn } from "@/lib/utils";

/**
 * Payee text field with a keyboard-navigable suggestions dropdown. Looks like a
 * plain {@link Input}; the list overlays (never pushes) the dense register row.
 * Enter only picks a suggestion when one is actively highlighted — otherwise it
 * falls through to `onEnter` so the existing save-on-Enter flow is preserved.
 * Escape closes an open list (and only that); once closed it defers to `onEscape`.
 */
export function PayeeInput({
  suggestions,
  value,
  onValueChange,
  onEnter,
  onEscape,
  onFocus,
  onBlur,
  className,
  ...inputProps
}: {
  suggestions: string[];
  value: string;
  onValueChange: (value: string) => void;
  onEnter?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onEscape?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
} & Omit<React.ComponentProps<typeof Input>, "value" | "onChange" | "onKeyDown">) {
  const [open, setOpen] = React.useState(false);
  const [highlight, setHighlight] = React.useState(-1);
  const listId = React.useId();

  const items = React.useMemo(() => filterPayeeSuggestions(suggestions, value), [suggestions, value]);
  const showList = open && items.length > 0;

  function close() {
    setOpen(false);
    setHighlight(-1);
  }

  function pick(payee: string) {
    onValueChange(payee);
    close();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!showList) return setOpen(true);
      setHighlight((h) => (h + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      if (!showList) return;
      e.preventDefault();
      setHighlight((h) => (h <= 0 ? items.length - 1 : h - 1));
    } else if (e.key === "Enter") {
      if (showList && highlight >= 0) {
        e.preventDefault();
        pick(items[highlight]);
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
                pick(item);
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
        </ul>
      )}
    </div>
  );
}
