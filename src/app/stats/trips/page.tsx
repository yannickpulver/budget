import type { Metadata } from "next";
import { Plane } from "lucide-react";
import { db } from "@/db";
import { BarList } from "@/components/charts/bar-list";
import { formatCurrency } from "@/lib/currency";
import { MONTH_SHORT_NAMES, parseStatsPeriod } from "@/lib/stats-period";
import { getTrips, type Trip } from "@/lib/stats-queries";
import { StatsTabs } from "../tabs";
import { EmptyNote, SectionHeading, StatsHeader, Tile } from "../ui";

export const metadata: Metadata = { title: "Trips · budget" };

/** "12 Jul – 26 Jul 2024", collapsing whatever the two dates share. */
function formatDateRange(from: string, to: string): string {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  const day = (d: number, m: number, y?: number) =>
    `${d} ${MONTH_SHORT_NAMES[m - 1]}${y != null ? ` ${y}` : ""}`;

  if (from === to) return day(fd, fm, fy);
  if (fy !== ty) return `${day(fd, fm, fy)} – ${day(td, tm, ty)}`;
  if (fm === tm) return `${fd} – ${day(td, tm, ty)}`;
  return `${day(fd, fm)} – ${day(td, tm, ty)}`;
}

export default async function TripsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const { period: periodParam } = await searchParams;
  const now = new Date();
  // Trips are all-time, but the period rides along so the tab row keeps the
  // window the other views are showing.
  const period = parseStatsPeriod(periodParam, now);

  const { trips, currency } = getTrips(db);
  const total = trips.reduce((sum, trip) => sum + trip.total, 0);
  const average = trips.length > 0 ? Math.round(total / trips.length) : 0;

  return (
    <div className="flex flex-1 flex-col">
      <StatsHeader icon={<Plane className="size-5 text-muted-foreground" />} title="Stats" />
      <StatsTabs active="trips" period={period} />

      <div className="border-b border-border px-4 py-3 text-sm text-muted-foreground">
        All time — trips aren&apos;t period-scoped.
      </div>

      <div className="px-4 py-4">
        {trips.length === 0 ? (
          <EmptyNote>
            No trips yet. Trips come from the categories in a category group named
            &ldquo;Trips&rdquo; — one category per trip.
          </EmptyNote>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Tile label="Trips" value={String(trips.length)} />
              <Tile label="Total spent" value={formatCurrency(total, currency)} />
              <Tile label="Avg per trip" value={formatCurrency(average, currency)} />
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {trips.map((trip) => (
                <TripCard key={trip.categoryId} trip={trip} currency={currency} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function TripCard({ trip, currency }: { trip: Trip; currency: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="min-w-0 truncate text-base font-semibold">{trip.name}</h3>
        <span className="shrink-0 text-base font-semibold tabular-nums">
          {formatCurrency(trip.total, currency)}
        </span>
      </div>

      <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
        {formatDateRange(trip.firstDate, trip.lastDate)} · {trip.days} {trip.days === 1 ? "day" : "days"}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Tile label="Per day" value={formatCurrency(trip.costPerDay, currency)} />
        <Tile
          label="Transactions"
          value={String(trip.count)}
          hint={trip.inflow > 0 ? `+${formatCurrency(trip.inflow, currency)} back` : undefined}
        />
      </div>

      {trip.topPayees.length > 0 && (
        <div className="mt-3">
          <SectionHeading>Top payees</SectionHeading>
          <BarList
            items={trip.topPayees.map((payee) => ({
              key: payee.payee,
              label: payee.payee,
              value: payee.outflow,
              hint: `${payee.count}×`,
            }))}
            formatValue={(value) => formatCurrency(value, currency)}
          />
        </div>
      )}
    </div>
  );
}
