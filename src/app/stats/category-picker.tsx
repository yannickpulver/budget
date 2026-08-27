"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import type { CategoryGroupAdmin } from "@/lib/queries";

/**
 * Category selector for the category-stats page. Native <select> with an "All
 * categories" entry first, then categories grouped by category group (hidden
 * categories included, marked). Changing it navigates to /stats/categories
 * with the new `cat` search param ("all" or an id) while preserving `period`.
 */
export function CategoryPicker({
  groups,
  selected,
  period,
}: {
  groups: CategoryGroupAdmin[];
  selected: string;
  period: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <select
      value={selected}
      disabled={pending}
      onChange={(e) => {
        const params = new URLSearchParams({ cat: e.target.value, period });
        startTransition(() => router.push(`/stats/categories?${params.toString()}`));
      }}
      className="h-8 rounded-md border border-border bg-background px-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
      aria-label="Category"
    >
      <option value="all">All categories</option>
      {groups.map((group) => (
        <optgroup key={group.id} label={group.name}>
          {group.categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.hiddenFrom != null ? `${category.name} (hidden)` : category.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
