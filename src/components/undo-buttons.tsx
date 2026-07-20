"use client";

import { Redo2, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useTransition } from "react";
import { redoAction, undoAction } from "@/app/undo-actions";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { UndoState } from "@/lib/undo";

/** True when a keydown originated in an editable field — leave native undo alone there. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

/**
 * Undo/redo toolbar. State comes from the server (refreshed on every mutation
 * via revalidatePath("/", "layout")); the global shortcuts mirror the buttons.
 */
export function UndoButtons({ state }: { state: UndoState }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const runUndo = useCallback(() => {
    if (!state.canUndo) return;
    startTransition(async () => {
      await undoAction();
      router.refresh();
    });
  }, [state.canUndo, router]);

  const runRedo = useCallback(() => {
    if (!state.canRedo) return;
    startTransition(async () => {
      await redoAction();
      router.refresh();
    });
  }, [state.canRedo, router]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (isEditableTarget(e.target)) return; // keep native field undo working

      const key = e.key.toLowerCase();
      const isRedo = (key === "z" && e.shiftKey) || key === "y";
      const isUndo = key === "z" && !e.shiftKey;
      if (!isRedo && !isUndo) return;

      e.preventDefault();
      if (isRedo) runRedo();
      else runUndo();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [runUndo, runRedo]);

  return (
    <div className="flex items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={pending || !state.canUndo}
              onClick={runUndo}
              aria-label="Undo"
            />
          }
        >
          <Undo2 />
        </TooltipTrigger>
        <TooltipContent>{state.undoLabel ? `Undo: ${state.undoLabel}` : "Nothing to undo"}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={pending || !state.canRedo}
              onClick={runRedo}
              aria-label="Redo"
            />
          }
        >
          <Redo2 />
        </TooltipTrigger>
        <TooltipContent>{state.redoLabel ? `Redo: ${state.redoLabel}` : "Nothing to redo"}</TooltipContent>
      </Tooltip>
    </div>
  );
}
