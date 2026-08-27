"use server";

import { db } from "@/db";
import {
  createCategory as createCategoryRow,
  createCategoryGroup as createCategoryGroupRow,
  currentMonth,
  deleteCategory as deleteCategoryRow,
  deleteCategoryGroup as deleteCategoryGroupRow,
  moveCategoryToGroup as moveCategoryToGroupRow,
  renameCategory as renameCategoryRow,
  renameCategoryGroup as renameCategoryGroupRow,
  reorderCategories as reorderCategoriesRow,
  reorderCategoryGroups as reorderCategoryGroupsRow,
  setCategoryGroupHidden as setCategoryGroupHiddenRow,
  setCategoryHiddenFrom as setCategoryHiddenFromRow,
  type SettingsResult,
} from "@/lib/queries";
import { withUndoStep } from "@/lib/undo";
import { refresh } from "./refresh";

export type ActionResult = SettingsResult;

export async function createCategoryGroupAction(
  name: string
): Promise<ActionResult & { id?: number }> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Name is required." };
  const id = withUndoStep("Add group", () => createCategoryGroupRow(db, trimmed));
  refresh();
  return { ok: true, id };
}

export async function renameCategoryGroupAction(id: number, name: string): Promise<ActionResult> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Name is required." };
  withUndoStep("Rename group", () => renameCategoryGroupRow(db, id, trimmed));
  refresh();
  return { ok: true };
}

export async function setCategoryGroupHiddenAction(id: number, hidden: boolean): Promise<ActionResult> {
  withUndoStep(hidden ? "Hide group" : "Show group", () =>
    setCategoryGroupHiddenRow(db, id, hidden)
  );
  refresh();
  return { ok: true };
}

export async function deleteCategoryGroupAction(id: number): Promise<ActionResult> {
  const result = withUndoStep("Delete group", () => deleteCategoryGroupRow(db, id));
  if (result.ok) refresh();
  return result;
}

export async function reorderCategoryGroupsAction(orderedGroupIds: number[]): Promise<ActionResult> {
  withUndoStep("Reorder groups", () => reorderCategoryGroupsRow(db, orderedGroupIds));
  refresh();
  return { ok: true };
}

export async function createCategoryAction(
  groupId: number,
  name: string
): Promise<ActionResult & { id?: number }> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Name is required." };
  const id = withUndoStep("Add category", () => createCategoryRow(db, groupId, trimmed));
  refresh();
  return { ok: true, id };
}

export async function renameCategoryAction(id: number, name: string): Promise<ActionResult> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Name is required." };
  withUndoStep("Rename category", () => renameCategoryRow(db, id, trimmed));
  refresh();
  return { ok: true };
}

export async function setCategoryHiddenAction(id: number, hidden: boolean): Promise<ActionResult> {
  withUndoStep(hidden ? "Hide category" : "Show category", () =>
    setCategoryHiddenFromRow(db, id, hidden ? currentMonth() : null)
  );
  refresh();
  return { ok: true };
}

export async function deleteCategoryAction(id: number): Promise<ActionResult> {
  const result = withUndoStep("Delete category", () => deleteCategoryRow(db, id));
  if (result.ok) refresh();
  return result;
}

export async function reorderCategoriesAction(
  groupId: number,
  orderedCategoryIds: number[]
): Promise<ActionResult> {
  withUndoStep("Reorder categories", () => reorderCategoriesRow(db, groupId, orderedCategoryIds));
  refresh();
  return { ok: true };
}

export async function moveCategoryToGroupAction(id: number, groupId: number): Promise<ActionResult> {
  withUndoStep("Move category", () => moveCategoryToGroupRow(db, id, groupId));
  refresh();
  return { ok: true };
}
