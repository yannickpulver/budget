"use server";

import { db } from "@/db";
import {
  createCategory as createCategoryRow,
  createCategoryGroup as createCategoryGroupRow,
  deleteCategory as deleteCategoryRow,
  deleteCategoryGroup as deleteCategoryGroupRow,
  moveCategoryToGroup as moveCategoryToGroupRow,
  renameCategory as renameCategoryRow,
  renameCategoryGroup as renameCategoryGroupRow,
  reorderCategories as reorderCategoriesRow,
  reorderCategoryGroups as reorderCategoryGroupsRow,
  setCategoryGroupHidden as setCategoryGroupHiddenRow,
  setCategoryHidden as setCategoryHiddenRow,
  type SettingsResult,
} from "@/lib/queries";
import { refresh } from "./refresh";

export type ActionResult = SettingsResult;

export async function createCategoryGroupAction(
  name: string
): Promise<ActionResult & { id?: number }> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Name is required." };
  const id = createCategoryGroupRow(db, trimmed);
  refresh();
  return { ok: true, id };
}

export async function renameCategoryGroupAction(id: number, name: string): Promise<ActionResult> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Name is required." };
  renameCategoryGroupRow(db, id, trimmed);
  refresh();
  return { ok: true };
}

export async function setCategoryGroupHiddenAction(id: number, hidden: boolean): Promise<ActionResult> {
  setCategoryGroupHiddenRow(db, id, hidden);
  refresh();
  return { ok: true };
}

export async function deleteCategoryGroupAction(id: number): Promise<ActionResult> {
  const result = deleteCategoryGroupRow(db, id);
  if (result.ok) refresh();
  return result;
}

export async function reorderCategoryGroupsAction(orderedGroupIds: number[]): Promise<ActionResult> {
  reorderCategoryGroupsRow(db, orderedGroupIds);
  refresh();
  return { ok: true };
}

export async function createCategoryAction(
  groupId: number,
  name: string
): Promise<ActionResult & { id?: number }> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Name is required." };
  const id = createCategoryRow(db, groupId, trimmed);
  refresh();
  return { ok: true, id };
}

export async function renameCategoryAction(id: number, name: string): Promise<ActionResult> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "Name is required." };
  renameCategoryRow(db, id, trimmed);
  refresh();
  return { ok: true };
}

export async function setCategoryHiddenAction(id: number, hidden: boolean): Promise<ActionResult> {
  setCategoryHiddenRow(db, id, hidden);
  refresh();
  return { ok: true };
}

export async function deleteCategoryAction(id: number): Promise<ActionResult> {
  const result = deleteCategoryRow(db, id);
  if (result.ok) refresh();
  return result;
}

export async function reorderCategoriesAction(
  groupId: number,
  orderedCategoryIds: number[]
): Promise<ActionResult> {
  reorderCategoriesRow(db, groupId, orderedCategoryIds);
  refresh();
  return { ok: true };
}

export async function moveCategoryToGroupAction(id: number, groupId: number): Promise<ActionResult> {
  moveCategoryToGroupRow(db, id, groupId);
  refresh();
  return { ok: true };
}
