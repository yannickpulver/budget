import { revalidatePath } from "next/cache";
import { invalidateBudgetCache } from "@/lib/queries";

/**
 * Shared by every account/transaction/import mutation. Not a "use server"
 * file itself (every export of one of those must be an async action) — the
 * server action modules import this plain helper instead.
 */
export function refresh(...accountIds: Array<number | null | undefined>): void {
  invalidateBudgetCache();
  revalidatePath("/", "layout"); // sidebar lives in the root layout
  revalidatePath("/budget/[month]", "page");
  for (const id of accountIds) {
    if (id != null) revalidatePath(`/accounts/${id}`, "page");
  }
}
