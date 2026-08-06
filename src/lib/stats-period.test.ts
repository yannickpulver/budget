import { describe, expect, it } from "vitest";
import {
  currentPeriod,
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
