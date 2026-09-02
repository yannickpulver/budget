import { describe, expect, it } from "vitest";
import { barWidth, DELTA_NOISE_FLOOR, formatDelta, isNoChange } from "./stats-format";

describe("formatDelta", () => {
  it("renders a signed whole-franc amount with the percentage in parentheses", () => {
    expect(formatDelta(18000, 0.17, "CHF")).toBe("+CHF 180 (+17%)");
    expect(formatDelta(-4000, -0.03, "CHF")).toBe("−CHF 40 (−3%)");
  });

  it("uses a middot when a label follows the delta", () => {
    expect(formatDelta(18000, 0.17, "CHF", { separator: "middot" })).toBe("+CHF 180 · +17%");
  });

  it("omits the percentage when there is none", () => {
    expect(formatDelta(18000, null, "CHF")).toBe("+CHF 180");
    expect(formatDelta(-18000, null, "CHF", { separator: "middot" })).toBe("−CHF 180");
  });

  it("takes the sign from the amount, so a negative percent is not double-signed", () => {
    expect(formatDelta(-5000, -0.5, "CHF")).toBe("−CHF 50 (−50%)");
  });
});

describe("isNoChange", () => {
  it("treats sub-franc movement as no change, because the display rounds to francs", () => {
    expect(isNoChange(0)).toBe(true);
    expect(isNoChange(DELTA_NOISE_FLOOR - 1)).toBe(true);
    expect(isNoChange(-(DELTA_NOISE_FLOOR - 1))).toBe(true);
    expect(isNoChange(DELTA_NOISE_FLOOR)).toBe(false);
    expect(isNoChange(-10000)).toBe(false);
  });
});

describe("barWidth", () => {
  it("scales against the ceiling, with a visible floor for a small value", () => {
    expect(barWidth(50, 100)).toBe(50);
    expect(barWidth(1, 1000)).toBe(2);
    expect(barWidth(200, 100)).toBe(100);
  });

  it("draws nothing at all for zero or an inflow-only value", () => {
    expect(barWidth(0, 100)).toBe(0);
    expect(barWidth(-500, 100)).toBe(0);
  });

  it("falls back to the floor when the ceiling is degenerate", () => {
    expect(barWidth(500, 0)).toBe(2);
  });
});
