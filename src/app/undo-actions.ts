"use server";

import { undo, redo, undoState, type UndoResult, type UndoState } from "@/lib/undo";
import { refresh } from "./accounts/refresh";

/** Undo the most recent tracked change and revalidate every affected view. */
export async function undoAction(): Promise<UndoResult> {
  const result = undo();
  if (result.ok) refresh();
  return result;
}

/** Redo the most recently undone change. */
export async function redoAction(): Promise<UndoResult> {
  const result = redo();
  if (result.ok) refresh();
  return result;
}

/** Current undo/redo availability and labels, for the toolbar. */
export async function getUndoState(): Promise<UndoState> {
  return undoState();
}
