"use client";

import { useMemo } from "react";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from "@/components/ui/combobox";

export interface Option {
  /** Stable encoded id, e.g. "rta", "cat:12", "xfer:3". */
  value: string;
  label: string;
}

export interface OptionGroup {
  /** Group heading. Base UI uses `value` as the group key. */
  value: string;
  items: Option[];
}

/**
 * Searchable single-select over grouped options, shared by the category pickers.
 *
 * Base UI's Select can't filter (typeahead only), so this uses Combobox with the
 * search field inside the popup — the trigger keeps showing the current
 * selection rather than turning into a text input. Filtering is Base UI's, which
 * drops non-matching items and hides groups that end up empty.
 */
export function SearchableOptionSelect({
  groups,
  value,
  onChange,
  placeholder = "Category",
  searchPlaceholder = "Search…",
  emptyMessage = "No matches",
  className,
  defaultOpen,
  onOpenChange,
}: {
  groups: OptionGroup[];
  /** Encoded value, or null for "nothing selected". */
  value: string | null;
  onChange: (value: string | null) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  className?: string;
  /** Open as soon as this mounts — used for open-on-click-in-place editing. */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const selected = useMemo(() => {
    for (const group of groups) {
      const match = group.items.find((item) => item.value === value);
      if (match) return match;
    }
    return null;
  }, [groups, value]);

  return (
    <Combobox
      items={groups}
      value={selected}
      onValueChange={(next: Option | null) => onChange(next?.value ?? null)}
      // Items are objects, so identity comparison isn't enough: the selected
      // value and the item in `groups` are distinct objects after a re-render.
      isItemEqualToValue={(a: Option, b: Option) => a.value === b.value}
      // Drives both the filter query matching and the trigger's displayed text.
      itemToStringLabel={(item: Option) => item.label}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
    >
      <ComboboxTrigger className={className}>
        <ComboboxValue>{selected?.label ?? placeholder}</ComboboxValue>
      </ComboboxTrigger>
      <ComboboxContent>
        <ComboboxInput placeholder={searchPlaceholder} />
        <ComboboxEmpty>{emptyMessage}</ComboboxEmpty>
        <ComboboxList>
          {(group: OptionGroup) => (
            <ComboboxGroup key={group.value} items={group.items}>
              {group.value !== "" && <ComboboxGroupLabel>{group.value}</ComboboxGroupLabel>}
              <ComboboxCollection>
                {(item: Option) => (
                  <ComboboxItem key={item.value} value={item}>
                    {item.label}
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
