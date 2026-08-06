import Link from "next/link";
import { cn } from "@/lib/utils";
import type { StatsPeriod } from "@/lib/stats-period";

export type StatsTab = "overview" | "trips" | "categories";

/**
 * Underlined tab row under the /stats header. Takes the active tab as a prop
 * (rather than reading the pathname) so it stays a server component. `period`
 * rides along to every tab so switching views keeps the window you were
 * looking at; `cat` is Categories-only and is never leaked to the other tabs.
 */
export function StatsTabs({
  active,
  period,
  cat,
}: {
  active: StatsTab;
  period: StatsPeriod;
  /** Selected category ("all" or an id) — only appended to the Categories tab. */
  cat?: string;
}) {
  const query = (extra?: Record<string, string>) =>
    `?${new URLSearchParams({ period, ...extra }).toString()}`;

  const tabs: { key: StatsTab; label: string; href: string }[] = [
    { key: "overview", label: "Overview", href: `/stats${query()}` },
    { key: "trips", label: "Trips", href: `/stats/trips${query()}` },
    {
      key: "categories",
      label: "Categories",
      href: `/stats/categories${query(cat != null ? { cat } : undefined)}`,
    },
  ];

  return (
    <nav className="flex items-center gap-4 border-b border-border px-4">
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={tab.href}
          aria-current={tab.key === active ? "page" : undefined}
          className={cn(
            "-mb-px border-b-2 py-2 text-sm font-medium transition-colors",
            tab.key === active
              ? "border-foreground text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
