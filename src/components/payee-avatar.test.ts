import { describe, expect, it } from "vitest";
import { payeeColorClass } from "./payee-avatar";

describe("payeeColorClass", () => {
  it("is deterministic — the same payee always maps to the same class", () => {
    for (const payee of ["Migros", "Coop", "Amazon", "SBB", ""]) {
      expect(payeeColorClass(payee)).toBe(payeeColorClass(payee));
    }
  });

  it("returns a defined palette class (bg + text pair)", () => {
    expect(payeeColorClass("Migros")).toMatch(/^bg-\w+-100 text-\w+-700$/);
  });

  it("spreads a variety of payees across the palette", () => {
    const names = Array.from({ length: 200 }, (_, i) => `Payee ${i}`);
    const distinct = new Set(names.map(payeeColorClass));
    // 10-color palette: a healthy hash should reach most buckets.
    expect(distinct.size).toBeGreaterThanOrEqual(6);
  });
});
