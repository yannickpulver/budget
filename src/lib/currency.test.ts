import { describe, expect, it } from "vitest";
import { evaluateMoneyExpression, parseMoneyInput } from "./currency";

describe("evaluateMoneyExpression", () => {
  it("matches parseMoneyInput for plain numbers", () => {
    const cases = ["200", "-31.90", "1'200.50", "0", "0.5", "  42  ", "1'200", "-0.01"];
    for (const raw of cases) {
      expect(evaluateMoneyExpression(raw)).toBe(parseMoneyInput(raw));
    }
  });

  it("matches parseMoneyInput's rejections for malformed plain numbers", () => {
    const cases = ["", "abc", "1.234", "1.2.3", "12a"];
    for (const raw of cases) {
      expect(evaluateMoneyExpression(raw)).toBe(parseMoneyInput(raw));
    }
  });

  it("adds", () => {
    expect(evaluateMoneyExpression("200+20")).toBe(22000);
  });

  it("subtracts", () => {
    expect(evaluateMoneyExpression("200-20")).toBe(18000);
  });

  it("chains addition and subtraction", () => {
    expect(evaluateMoneyExpression("200+20-5.50")).toBe(21450);
  });

  it("multiplies", () => {
    expect(evaluateMoneyExpression("3*33.30")).toBe(9990);
  });

  it("divides", () => {
    expect(evaluateMoneyExpression("100/4")).toBe(2500);
  });

  it("respects standard operator precedence", () => {
    // 2 + 3*4 = 14, not (2+3)*4 = 20
    expect(evaluateMoneyExpression("2+3*4")).toBe(1400);
    expect(evaluateMoneyExpression("10-2/2")).toBe(900);
  });

  it("supports parentheses to override precedence", () => {
    expect(evaluateMoneyExpression("(2+3)*4")).toBe(2000);
    expect(evaluateMoneyExpression("(200+20-5.50)")).toBe(21450);
  });

  it("treats a leading minus as a negative number, not an error", () => {
    expect(evaluateMoneyExpression("-31.90")).toBe(-3190);
    expect(evaluateMoneyExpression("-5+10")).toBe(500);
  });

  it("treats a minus after an operator as unary (double-negative subtraction)", () => {
    expect(evaluateMoneyExpression("200--20")).toBe(22000);
    expect(evaluateMoneyExpression("--5")).toBe(500);
  });

  it("tolerates apostrophes and spaces as thousands separators / whitespace", () => {
    expect(evaluateMoneyExpression("1'200+50")).toBe(125000);
    expect(evaluateMoneyExpression("1 200 + 50")).toBe(125000);
    expect(evaluateMoneyExpression(" 200 + 20 ")).toBe(22000);
  });

  it("rounds to Rappen like parseMoneyInput", () => {
    expect(evaluateMoneyExpression("10/3")).toBe(333); // 3.333... -> 333
    expect(evaluateMoneyExpression("0.1+0.2")).toBe(30);
  });

  it("returns null for division by zero", () => {
    expect(evaluateMoneyExpression("5/0")).toBeNull();
    expect(evaluateMoneyExpression("10/(2-2)")).toBeNull();
  });

  it("returns null for malformed expressions", () => {
    expect(evaluateMoneyExpression("200+")).toBeNull();
    expect(evaluateMoneyExpression("+*200")).toBeNull();
    expect(evaluateMoneyExpression("200+*20")).toBeNull();
    expect(evaluateMoneyExpression("()")).toBeNull();
    expect(evaluateMoneyExpression("(200+20")).toBeNull();
    expect(evaluateMoneyExpression("200+20)")).toBeNull();
    expect(evaluateMoneyExpression("200*/20")).toBeNull();
    expect(evaluateMoneyExpression("abc")).toBeNull();
    expect(evaluateMoneyExpression("200+abc")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(evaluateMoneyExpression("")).toBeNull();
    expect(evaluateMoneyExpression("   ")).toBeNull();
  });

  it("returns null for non-finite results", () => {
    // Effectively unreachable through the grammar (division by zero is
    // caught explicitly), but guard the finiteness check regardless.
    expect(evaluateMoneyExpression("1e999")).toBeNull();
  });

  it("rejects numbers with more than two decimal digits, like parseMoneyInput", () => {
    expect(evaluateMoneyExpression("1.234")).toBeNull();
    expect(evaluateMoneyExpression("1.234+1")).toBeNull();
  });
});
