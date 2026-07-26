"use client";

import type { CategoryGroupOption } from "@/lib/queries";
import { SearchableOptionSelect, type OptionGroup } from "./searchable-option-select";

/** Plain category picker — used to edit an existing transaction's category (no transfer options). */
export function CategorySelect({
  groups,
  value,
  onChange,
  includeReadyToAssign = false,
  placeholder = "Category",
  className,
  defaultOpen,
  onOpenChange,
}: {
  groups: CategoryGroupOption[];
  value: number | null;
  onChange: (categoryId: number | null) => void;
  /** Show a "Ready to Assign" item representing categoryId = null. */
  includeReadyToAssign?: boolean;
  placeholder?: string;
  className?: string;
  /** Open the popup as soon as this mounts — used to open-on-click-in-place. */
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const optionGroups: OptionGroup[] = [
    // Ungrouped leading item: an empty heading renders no label.
    ...(includeReadyToAssign ? [{ value: "", items: [{ value: "rta", label: "Ready to Assign" }] }] : []),
    ...groups.map((group) => ({
      value: group.name,
      items: group.categories.map((category) => ({ value: String(category.id), label: category.name })),
    })),
  ];

  return (
    <SearchableOptionSelect
      groups={optionGroups}
      value={value == null ? (includeReadyToAssign ? "rta" : null) : String(value)}
      onChange={(next) => onChange(next == null || next === "rta" ? null : Number(next))}
      placeholder={placeholder}
      searchPlaceholder="Search categories…"
      emptyMessage="No categories match"
      className={className}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
    />
  );
}
