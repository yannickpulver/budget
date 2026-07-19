import type { Metadata } from "next";
import Link from "next/link";
import { Compass } from "lucide-react";

export const metadata: Metadata = {
  title: "Not found · budget",
};

export default function NotFound() {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <div className="max-w-sm rounded-lg border border-dashed border-border p-8 text-center">
        <Compass className="mx-auto size-6 text-muted-foreground" />
        <h1 className="mt-3 text-sm font-semibold">Page not found</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          There&apos;s nothing here — the account, month, or page you&apos;re looking for
          doesn&apos;t exist.
        </p>
        <Link
          href="/"
          className="mt-4 inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
        >
          Back to budget
        </Link>
      </div>
    </div>
  );
}
