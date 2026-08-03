import { describe, expect, it } from "vitest";
import { filterPayeeSuggestions, filterTransferTargets } from "./payee-suggestions";

const PAYEES = ["Migros", "Migrol", "Coop", "Denner", "Amazon", "SBB Migros Shop"];

describe("filterPayeeSuggestions", () => {
  it("returns nothing for an empty or whitespace query", () => {
    expect(filterPayeeSuggestions(PAYEES, "")).toEqual([]);
    expect(filterPayeeSuggestions(PAYEES, "   ")).toEqual([]);
  });

  it("matches case-insensitively as a substring", () => {
    expect(filterPayeeSuggestions(PAYEES, "oop")).toEqual(["Coop"]);
    expect(filterPayeeSuggestions(PAYEES, "AMA")).toEqual(["Amazon"]);
  });

  it("ranks prefix matches ahead of mid-string matches", () => {
    // "Migros"/"Migrol" start with the query; "SBB Migros Shop" contains it.
    expect(filterPayeeSuggestions(PAYEES, "migro")).toEqual(["Migros", "Migrol", "SBB Migros Shop"]);
  });

  it("preserves incoming order within a bucket", () => {
    expect(filterPayeeSuggestions(["Zebra", "Apple", "Avocado"], "a")).toEqual([
      "Apple",
      "Avocado",
      "Zebra",
    ]);
  });

  it("drops the exact current value so a fully-typed payee shows no list", () => {
    expect(filterPayeeSuggestions(PAYEES, "oop")).toEqual(["Coop"]);
    expect(filterPayeeSuggestions(PAYEES, "Coop")).toEqual([]);
  });

  it("caps the result at the given limit", () => {
    const many = Array.from({ length: 20 }, (_, i) => `Shop ${i}`);
    expect(filterPayeeSuggestions(many, "shop", 8)).toHaveLength(8);
  });
});

const ACCOUNTS = [
  { id: 1, name: "Checking" },
  { id: 2, name: "Savings" },
  { id: 3, name: "Brokerage" },
];

describe("filterTransferTargets", () => {
  it("returns every target for an empty query", () => {
    expect(filterTransferTargets(ACCOUNTS, "")).toEqual(ACCOUNTS);
  });

  it("matches against the plain account name", () => {
    expect(filterTransferTargets(ACCOUNTS, "check")).toEqual([ACCOUNTS[0]]);
  });

  it("matches against the 'Transfer: <Account>' label", () => {
    expect(filterTransferTargets(ACCOUNTS, "transfer: sav")).toEqual([ACCOUNTS[1]]);
  });

  it("ranks name-prefix matches ahead of mid-string matches", () => {
    // "Brokerage" starts with "bro"; "Old Brokerage" only contains it.
    const accounts = [{ id: 1, name: "Old Brokerage" }, { id: 2, name: "Brokerage" }];
    expect(filterTransferTargets(accounts, "bro")).toEqual([accounts[1], accounts[0]]);
  });

  it("caps the result at the given limit", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: i, name: `Account ${i}` }));
    expect(filterTransferTargets(many, "", 8)).toHaveLength(8);
  });
});
