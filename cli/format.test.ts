import { describe, expect, it } from "vitest";
import { formatMoney, isValidIsoDate, parseMoneyInput, table } from "./format.ts";

describe("formatMoney", () => {
  it("groups thousands with apostrophes and always shows two decimals", () => {
    expect(formatMoney(0)).toBe("0.00");
    expect(formatMoney(500)).toBe("5.00");
    expect(formatMoney(123456)).toBe("1'234.56");
    expect(formatMoney(-123456)).toBe("-1'234.56");
    expect(formatMoney(100000000)).toBe("1'000'000.00");
  });
});

describe("parseMoneyInput", () => {
  it("parses plain and Swiss-grouped amounts into minor units", () => {
    expect(parseMoneyInput("120")).toBe(12000);
    expect(parseMoneyInput("120.5")).toBe(12050);
    expect(parseMoneyInput(" 1'200.50 ")).toBe(120050);
    expect(parseMoneyInput("-5")).toBe(-500);
  });

  it("rejects empty and non-numeric input", () => {
    expect(parseMoneyInput("")).toBeNull();
    expect(parseMoneyInput("abc")).toBeNull();
    expect(parseMoneyInput("1.234")).toBeNull();
  });
});

describe("isValidIsoDate", () => {
  it("accepts real YYYY-MM-DD dates only", () => {
    expect(isValidIsoDate("2026-08-28")).toBe(true);
    expect(isValidIsoDate("2024-02-29")).toBe(true);
    expect(isValidIsoDate("2025-02-30")).toBe(false);
    expect(isValidIsoDate("2025-13-45")).toBe(false);
    expect(isValidIsoDate("01.03.2025")).toBe(false);
    expect(isValidIsoDate("garbage")).toBe(false);
    expect(isValidIsoDate("")).toBe(false);
  });
});

describe("table", () => {
  it("pads columns to the widest cell and right-aligns where asked", () => {
    expect(table([["Neon", "1.00"], ["PostFinance", "123.45"]], ["l", "r"])).toEqual([
      "Neon           1.00",
      "PostFinance  123.45",
    ]);
  });
});
