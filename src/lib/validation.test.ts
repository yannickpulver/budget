import { describe, expect, it } from "vitest";
import { isValidIsoDate, isValidNumber, MAX_ABS_NUMBER } from "./validation";

describe("isValidNumber", () => {
  it("accepts ordinary finite amounts, positive and negative", () => {
    expect(isValidNumber(0)).toBe(true);
    expect(isValidNumber(4250)).toBe(true);
    expect(isValidNumber(-4250)).toBe(true);
  });

  it("rejects NaN and Infinity", () => {
    expect(isValidNumber(NaN)).toBe(false);
    expect(isValidNumber(Infinity)).toBe(false);
    expect(isValidNumber(-Infinity)).toBe(false);
  });

  it("accepts exactly the max magnitude and rejects anything beyond it", () => {
    expect(isValidNumber(MAX_ABS_NUMBER)).toBe(true);
    expect(isValidNumber(-MAX_ABS_NUMBER)).toBe(true);
    expect(isValidNumber(MAX_ABS_NUMBER + 1)).toBe(false);
    expect(isValidNumber(-(MAX_ABS_NUMBER + 1))).toBe(false);
  });

  it("rejects an absurdly large value", () => {
    expect(isValidNumber(1e20)).toBe(false);
  });

  it("respects a custom max", () => {
    expect(isValidNumber(50, 100)).toBe(true);
    expect(isValidNumber(150, 100)).toBe(false);
  });
});

describe("isValidIsoDate", () => {
  it("accepts a valid YYYY-MM-DD date", () => {
    expect(isValidIsoDate("2025-03-01")).toBe(true);
  });

  it("rejects the wrong format", () => {
    expect(isValidIsoDate("01.03.2025")).toBe(false);
  });

  it("rejects an impossible calendar date", () => {
    expect(isValidIsoDate("2025-13-45")).toBe(false);
  });

  it("rejects garbage", () => {
    expect(isValidIsoDate("garbage")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidIsoDate("")).toBe(false);
  });
});
