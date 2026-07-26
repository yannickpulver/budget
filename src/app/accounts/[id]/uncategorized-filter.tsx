"use client";

import { CircleSlash } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Toggle for "show only rows with no category". Free-text search can't express
 * this — an uncategorized row has no category text to match — so it needs its
 * own search param. Transfers are excluded from the result (they're
 * uncategorized by design).
 */
export function UncategorizedFilter({ active, count }: { active: boolean; count: number }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function toggle() {
    const params = new URLSearchParams(searchParams);
    if (active) params.delete("uncategorized");
    else params.set("uncategorized", "1");
    params.delete("page"); // a changed filter always starts back at page 1
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname);
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={active}
      className={cn(
        "flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors",
        active
          ? "border-amber-300 bg-amber-100 text-amber-900"
          : "border-border text-muted-foreground hover:bg-muted"
      )}
    >
      <CircleSlash className="size-3.5" />
      Uncategorized
      {count > 0 && <span className="tabular-nums opacity-70">{count}</span>}
    </button>
  );
}
