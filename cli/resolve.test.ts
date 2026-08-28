import { describe, expect, it } from "vitest";
import { resolveName } from "./resolve.ts";

const accounts = [
  { name: "Neon" },
  { name: "Neon Savings" },
  { name: "Revolut" },
];

const categories = [
  { name: "Groceries", qualifiedName: "Spending/Groceries" },
  { name: "Restaurants", qualifiedName: "Spending/Restaurants" },
  { name: "Rent", qualifiedName: "Bills/Rent" },
];

describe("resolveName", () => {
  it("prefers an exact match over a substring match", () => {
    expect(resolveName(accounts, "Neon", "account").name).toBe("Neon");
  });

  it("resolves a unique substring match", () => {
    expect(resolveName(accounts, "sav", "account").name).toBe("Neon Savings");
  });

  it("ignores case on both sides", () => {
    expect(resolveName(accounts, "rEvOlUt", "account").name).toBe("Revolut");
  });

  it("lists the candidates when several match", () => {
    expect(() => resolveName(accounts, "neo", "account")).toThrow(
      'Several account matches for "neo": Neon, Neon Savings',
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
