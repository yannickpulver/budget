import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { listCategoryGroupsAdmin } from "@/lib/queries";
import { CategoriesEditor } from "./categories-editor";

export const metadata: Metadata = {
  title: "Categories · budget",
};

export default function CategoriesSettingsPage() {
  const groups = listCategoryGroupsAdmin();

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Link
          href="/"
          aria-label="Back to budget"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <div>
          <h1 className="text-sm font-semibold">Categories</h1>
          <p className="text-xs text-muted-foreground">
            Create, rename, hide, and drag to reorder category groups and categories — use the
            &ldquo;Move to…&rdquo; select to move a category into another group. Hidden categories
            stay in your budget history but drop off the budget view and new transactions. Only
            unused groups/categories can be deleted outright.
          </p>
        </div>
      </header>

      <div className="px-4 py-4">
        <CategoriesEditor groups={groups} />
      </div>
    </div>
  );
}
