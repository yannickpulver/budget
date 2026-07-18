import { revalidatePath } from "next/cache";
import { invalidateBudgetCache } from "@/lib/queries";

/**
 * Shared by every category/group mutation below. Not a "use server" file
 * itself (every export of one of those must be an async action) — the
 * server action module imports this plain helper instead. Mirrors
 * `src/app/accounts/refresh.ts`.
 */
export function refresh(): void {
  invalidateBudgetCache();
  revalidatePath("/", "layout"); // sidebar lives in the root layout
  revalidatePath("/budget/[month]", "page");
  revalidatePath("/settings/categories", "page");
}
