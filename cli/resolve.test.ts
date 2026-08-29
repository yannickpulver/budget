import { describe, expect, it } from "vitest";
import { resolveName } from "./resolve.ts";

const accounts = [
  { name: "Alpine Bank" },
  { name: "Alpine Savings" },
  { name: "Nomad Card" },
];

const categories = [
  { name: "Groceries", qualifiedName: "Spending/Groceries" },
  { name: "Restaurants", qualifiedName: "Spending/Restaurants" },
  { name: "Rent", qualifiedName: "Bills/Rent" },
];

describe("resolveName", () => {
  it("prefers an exact match over a substring match", () => {
    expect(resolveName(accounts, "Alpine Bank", "account").name).toBe("Alpine Bank");
  });

  it("resolves a unique substring match", () => {
    expect(resolveName(accounts, "sav", "account").name).toBe("Alpine Savings");
  });

  it("ignores case on both sides", () => {
    expect(resolveName(accounts, "nOmAd", "account").name).toBe("Nomad Card");
  });

  it("lists the candidates when several match", () => {
    expect(() => resolveName(accounts, "alp", "account")).toThrow(
      'Several account matches for "alp": Alpine Bank, Alpine Savings',
    );
  });

  it("reports when nothing matches", () => {
    expect(() => resolveName(accounts, "Wise", "account")).toThrow('No account matches "Wise"');
  });

  it("matches a category by its bare name", () => {
    expect(resolveName(categories, "groceries", "category").name).toBe("Groceries");
  });

  it("matches a category by its qualified Group/Category name", () => {
    expect(resolveName(categories, "Bills/Rent", "category").name).toBe("Rent");
  });

  it("matches a category by a substring of the group", () => {
    expect(resolveName(categories, "Spending/Rest", "category").name).toBe("Restaurants");
  });
});
