"use client";

import { Menu } from "lucide-react";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { SidebarContent } from "@/components/sidebar";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { UndoButtons } from "@/components/undo-buttons";
import type { SidebarData } from "@/lib/queries";
import type { UndoState } from "@/lib/undo";

/**
 * The below-`md` replacement for the sidebar: a sticky bar with a menu button
 * that slides the very same {@link SidebarContent} in from the left, plus the
 * undo/redo pair the sidebar header carries on desktop. Navigating closes the
 * sheet — every link in there is a route change.
 */
export function MobileTopBar({ data, undo }: { data: SidebarData; undo: UndoState }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // Close on navigation — the "adjust state during render" pattern (same as
  // sidebar.tsx), so this needs no effect.
  const [lastPathname, setLastPathname] = useState(pathname);
  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    setOpen(false);
  }

  return (
    <div className="pt-safe sticky top-0 z-30 flex items-center justify-between gap-2 border-b border-border bg-background/95 px-2 supports-backdrop-filter:backdrop-blur-sm md:hidden">
      <div className="flex min-w-0 items-center gap-1 py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setOpen(true)}
          aria-label="Open menu"
        >
          <Menu />
        </Button>
        <span className="truncate text-sm font-semibold tracking-tight">budget</span>
      </div>
      <UndoButtons state={undo} />

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="left"
          showCloseButton={false}
          className="gap-0 bg-sidebar p-0 data-[side=left]:w-72 data-[side=left]:max-w-[85vw]"
        >
          {/* Named like every other sheet — the panel's own header is the
              sidebar wordmark, so the accessible title is visually hidden. */}
          <SheetTitle className="sr-only">Menu</SheetTitle>
          <div className="pt-safe pb-safe flex h-full flex-col overflow-hidden">
            <SidebarContent data={data} undo={undo} />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
