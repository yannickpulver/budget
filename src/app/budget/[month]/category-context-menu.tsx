"use client";

import { useTransition } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { hideCategoryFromMonth } from "../actions";

/**
 * Right-click wrapper for budget category rows: hide the category from the
 * viewed month on. A hidden category simply stops rendering for that month
 * (see `getBudgetView`'s `isHiddenForMonth` filter), so there's no "unhide"
 * entry here — unhiding lives in Settings > Categories.
 */
export function CategoryContextMenu({
  categoryId,
  month,
  className,
  children,
}: {
  categoryId: number;
  month: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [, startTransition] = useTransition();

  return (
    <ContextMenu>
      <ContextMenuTrigger className={className}>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onClick={() => startTransition(() => void hideCategoryFromMonth(month, categoryId))}
        >
          Hide from this month
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
