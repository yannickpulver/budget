import { describe, expect, it } from "vitest";
import {
  comparisonBounds,
  comparisonLabel,
  comparisonPeriod,
  currentBounds,
  currentPeriod,
  isCurrentPeriod,
  monthAxisLabel,
  monthKeyOf,
  monthKeyShift,
  monthKeysBetween,
  monthShortLabel,
  monthSpan,
  parseStatsPeriod,
  periodMode,
  shiftPeriod,
  statsPeriodBounds,
  statsPeriodLabel,
} from "./stats-period";

const NOW = new Date("2026-08-06T12:00:00Z");

describe("periodMode", () => {
  it("classifies month/year/all", () => {
    expect(periodMode("2026-08")).toBe("month");
    expect(periodMode("2026")).toBe("year");
    expect(periodMode("all")).toBe("all");
  });

  it("falls back to month for anything unrecognized", () => {
    expect(periodMode("garbage")).toBe("month");
  });
});

describe("parseStatsPeriod", () => {
  it("maps legacy 'month'/'year'/'all' to concrete periods", () => {
    expect(parseStatsPeriod("month", NOW)).toBe("2026-08");
    expect(parseStatsPeriod("year", NOW)).toBe("2026");
    expect(parseStatsPeriod("all", NOW)).toBe("all");
  });

  it("passes through a valid YYYY-MM or YYYY", () => {
    expect(parseStatsPeriod("2020-07", NOW)).toBe("2020-07");
    expect(parseStatsPeriod("2019", NOW)).toBe("2019");
  });

  it("defaults invalid or missing values to the current month", () => {
    expect(parseStatsPeriod(undefined, NOW)).toBe("2026-08");
    expect(parseStatsPeriod("nonsense", NOW)).toBe("2026-08");
    expect(parseStatsPeriod("2026-13", NOW)).toBe("2026-08");
  });

  // Fix 3: a hand-edited `?period=2030-05` URL must not reach the query layer
  // and render a page of zeros whose nav label disagrees with the data.
  it("clamps a future month period to the current month", () => {
    expect(parseStatsPeriod("2030-05", NOW)).toBe("2026-08");
  });

  it("clamps a future year period to the current year", () => {
    expect(parseStatsPeriod("2030", NOW)).toBe("2026");
  });

  it("leaves a past month/year period untouched", () => {
    expect(parseStatsPeriod("2020-07", NOW)).toBe("2020-07");
    expect(parseStatsPeriod("2019", NOW)).toBe("2019");
  });

  it("leaves 'all' untouched", () => {
    expect(parseStatsPeriod("all", NOW)).toBe("all");
  });
});

describe("statsPeriodBounds", () => {
  it("returns half-open month bounds", () => {
    expect(statsPeriodBounds("2026-08")).toEqual({ start: "2026-08-01", end: "2026-09-01" });
  });

  it("rolls over into the next year for December", () => {
    expect(statsPeriodBounds("2026-12")).toEqual({ start: "2026-12-01", end: "2027-01-01" });
  });

  it("returns year bounds", () => {
    expect(statsPeriodBounds("2025")).toEqual({ start: "2025-01-01", end: "2026-01-01" });
  });

  it("returns nulls for all-time", () => {
    expect(statsPeriodBounds("all")).toEqual({ start: null, end: null });
  });
});

describe("statsPeriodLabel", () => {
  it("labels month/year/all", () => {
    expect(statsPeriodLabel("2026-08")).toBe("August 2026");
    expect(statsPeriodLabel("2025")).toBe("2025");
    expect(statsPeriodLabel("all")).toBe("All time");
  });
});

describe("shiftPeriod", () => {
  it("shifts a month period forward/backward", () => {
    expect(shiftPeriod("2026-07", 1, NOW)).toBe("2026-08");
    expect(shiftPeriod("2026-08", -1, NOW)).toBe("2026-07");
  });

  it("rolls over year boundaries", () => {
    expect(shiftPeriod("2026-01", -1, NOW)).toBe("2025-12");
    expect(shiftPeriod("2025-12", 1, NOW)).toBe("2026-01");
  });

  it("shifts a year period", () => {
    expect(shiftPeriod("2025", 1, NOW)).toBe("2026");
    expect(shiftPeriod("2024", -1, NOW)).toBe("2023");
  });

  it("returns null for all-time", () => {
    expect(shiftPeriod("all", 1, NOW)).toBeNull();
  });

  it("refuses to navigate a month period past the current month", () => {
    expect(shiftPeriod("2026-08", 1, NOW)).toBeNull();
  });

  it("refuses to navigate a year period past the current year", () => {
    expect(shiftPeriod("2026", 1, NOW)).toBeNull();
  });

  it("allows navigating exactly to the current period", () => {
    expect(shiftPeriod("2026-07", 1, NOW)).toBe("2026-08");
    expect(shiftPeriod("2025", 1, NOW)).toBe("2026");
  });
});

describe("monthKeyShift", () => {
  it("shifts forward and backward, rolling over year boundaries", () => {
    expect(monthKeyShift("2026-08", 1)).toBe("2026-09");
    expect(monthKeyShift("2026-01", -1)).toBe("2025-12");
    expect(monthKeyShift("2025-12", 1)).toBe("2026-01");
  });
});

describe("currentPeriod", () => {
  it("returns the current period per mode", () => {
    expect(currentPeriod("month", NOW)).toBe("2026-08");
    expect(currentPeriod("year", NOW)).toBe("2026");
    expect(currentPeriod("all", NOW)).toBe("all");
  });
});

describe("monthShortLabel", () => {
  it("formats a month key", () => {
    expect(monthShortLabel("2026-07")).toBe("Jul 2026");
  });
});

describe("monthAxisLabel", () => {
  it("formats without year for non-January months", () => {
    expect(monthAxisLabel("2026-07")).toBe("Jul");
  });

  it("carries the year for January", () => {
    expect(monthAxisLabel("2026-01")).toBe("Jan '26");
  });
});

describe("monthKeysBetween", () => {
  it("returns an inclusive ascending list", () => {
    expect(monthKeysBetween("2025-11", "2026-02")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
  });

  it("returns a single key when a equals b", () => {
    expect(monthKeysBetween("2026-08", "2026-08")).toEqual(["2026-08"]);
  });
});

describe("monthSpan", () => {
  it("counts inclusive months", () => {
    expect(monthSpan("2026-01", "2026-08")).toBe(8);
    expect(monthSpan("2026-08", "2026-08")).toBe(1);
  });

  it("spans across years", () => {
    expect(monthSpan("2025-11", "2026-02")).toBe(4);
  });
});

describe("monthKeyOf", () => {
  it("formats a Date as YYYY-MM", () => {
    expect(monthKeyOf(NOW)).toBe("2026-08");
    expect(monthKeyOf(new Date("2026-01-15T12:00:00Z"))).toBe("2026-01");
  });
});

describe("comparisonPeriod", () => {
  it("maps a month to the previous month and a year to the previous year", () => {
    expect(comparisonPeriod("2026-08")).toBe("2026-07");
    expect(comparisonPeriod("2026-01")).toBe("2025-12");
    expect(comparisonPeriod("2026")).toBe("2025");
  });

  it("has nothing to compare all time against", () => {
    expect(comparisonPeriod("all")).toBeNull();
  });
});

describe("isCurrentPeriod", () => {
  it("is true for the running month and year only", () => {
    expect(isCurrentPeriod("2026-08", NOW)).toBe(true);
    expect(isCurrentPeriod("2026-07", NOW)).toBe(false);
    expect(isCurrentPeriod("2026", NOW)).toBe(true);
    expect(isCurrentPeriod("2025", NOW)).toBe(false);
    expect(isCurrentPeriod("all", NOW)).toBe(false);
  });
});

describe("comparisonBounds", () => {
  it("cuts the previous month at the same day for a running month (month-to-date fairness)", () => {
    // NOW is 2026-08-06, so August-so-far covers days 1..6; the previous
    // month is cut the same way (end is exclusive, hence the 7th).
    expect(comparisonBounds("2026-08", NOW)).toEqual({
      start: "2026-07-01",
      end: "2026-07-07",
      partial: true,
    });
  });

  it("uses the whole previous month for a period that is already over", () => {
    expect(comparisonBounds("2026-07", NOW)).toEqual({
      start: "2026-06-01",
      end: "2026-07-01",
      partial: false,
    });
  });

  it("clamps the cut day to the previous month's length (day 31 -> February)", () => {
    const march31 = new Date("2026-03-31T12:00:00Z");
    // February 2026 has 28 days, so "March so far" compares against all of it.
    expect(comparisonBounds("2026-03", march31)).toEqual({
      start: "2026-02-01",
      end: "2026-03-01",
      partial: true,
    });
  });

  it("clamps to a leap-year February when the previous year is shorter", () => {
    const feb29 = new Date("2028-02-29T12:00:00Z");
    expect(comparisonBounds("2028", feb29)).toEqual({
      start: "2027-01-01",
      end: "2027-03-01", // Feb 2027 has 28 days: clamped to the 28th, end exclusive.
      partial: true,
    });
  });

  it("cuts the previous year at the same month+day for a running year", () => {
    expect(comparisonBounds("2026", NOW)).toEqual({
      start: "2025-01-01",
      end: "2025-08-07",
      partial: true,
    });
  });

  it("uses the whole previous year for a past year", () => {
    expect(comparisonBounds("2025", NOW)).toEqual({
      start: "2024-01-01",
      end: "2025-01-01",
      partial: false,
    });
  });

  it("returns null for all time", () => {
    expect(comparisonBounds("all", NOW)).toBeNull();
  });
});

describe("currentBounds", () => {
  it("cuts a running month at today, so it matches the comparison window", () => {
    // NOW is 2026-08-06: August-so-far is days 1..6, end exclusive on the 7th
    // — the same shape `comparisonBounds` gives July.
    expect(currentBounds("2026-08", NOW)).toEqual({
      start: "2026-08-01",
      end: "2026-08-07",
      partial: true,
    });
    expect(currentBounds("2026", NOW)).toEqual({
      start: "2026-01-01",
      end: "2026-08-07",
      partial: true,
    });
  });

  it("gives a finished period its full calendar bounds", () => {
    expect(currentBounds("2026-07", NOW)).toEqual({
      start: "2026-07-01",
      end: "2026-08-01",
      partial: false,
    });
    expect(currentBounds("2025", NOW)).toEqual({
      start: "2025-01-01",
      end: "2026-01-01",
      partial: false,
    });
  });

  it("rolls over a month end when today is the last day", () => {
    expect(currentBounds("2026-08", new Date("2026-08-31T12:00:00Z"))).toEqual({
      start: "2026-08-01",
      end: "2026-09-01",
      partial: true,
    });
  });

  it("returns null for all time", () => {
    expect(currentBounds("all", NOW)).toBeNull();
  });
});

describe("comparisonLabel", () => {
  it("labels a finished period against the whole previous one", () => {
    expect(comparisonLabel("2026-07", NOW)).toBe("vs Jun");
    expect(comparisonLabel("2025", NOW)).toBe("vs 2024");
  });

  it("says 'so far' while the period is running", () => {
    expect(comparisonLabel("2026-08", NOW)).toBe("vs Jul so far");
    expect(comparisonLabel("2026", NOW)).toBe("vs 2025 so far");
  });

  it("returns null for all time", () => {
    expect(comparisonLabel("all", NOW)).toBeNull();
  });
});
