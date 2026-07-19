"use client";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { CategoryGroupOption } from "@/lib/queries";

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
  // Base UI's `Select.Value` only resolves a value to its label once the
  // popup has mounted at least once — otherwise it shows the raw value
  // (e.g. a numeric category id). Passing `items` lets it resolve the label
  // up front, so the trigger shows the category name immediately.
  const items = [
    ...(includeReadyToAssign ? [{ value: "rta", label: "Ready to Assign" }] : []),
    ...groups.flatMap((group) =>
      group.categories.map((category) => ({ value: String(category.id), label: category.name }))
    ),
  ];

  return (
    <Select
      items={items}
      value={value == null ? (includeReadyToAssign ? "rta" : "") : String(value)}
      onValueChange={(v) => onChange(!v || v === "rta" ? null : Number(v))}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
    >
      <SelectTrigger className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {includeReadyToAssign && (
          <SelectGroup>
            <SelectItem value="rta">Ready to Assign</SelectItem>
          </SelectGroup>
        )}
        {groups.map((group) => (
          <SelectGroup key={group.id}>
            <SelectLabel>{group.name}</SelectLabel>
            {group.categories.map((category) => (
              <SelectItem key={category.id} value={String(category.id)}>
                {category.name}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
