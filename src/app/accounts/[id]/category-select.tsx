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
}: {
  groups: CategoryGroupOption[];
  value: number | null;
  onChange: (categoryId: number | null) => void;
  /** Show a "Ready to Assign" item representing categoryId = null. */
  includeReadyToAssign?: boolean;
  placeholder?: string;
  className?: string;
}) {
  return (
    <Select
      value={value == null ? (includeReadyToAssign ? "rta" : "") : String(value)}
      onValueChange={(v) => onChange(!v || v === "rta" ? null : Number(v))}
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
