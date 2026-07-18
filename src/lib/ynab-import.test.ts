import { describe, expect, it } from "vitest";
import { buildImportResult, type RegisterRow } from "./ynab-import";

/**
 * Transfer-pairing regression coverage: the YNAB Register export has no
 * explicit link between a transfer's two legs, so `buildImportResult` must
 * deterministically pair opposite-direction rows by (account pair, date,
 * amount) — grouping and zipping in file order — and stamp a shared
 * `transferPairId`. This is what lets the migrated DB use the stable
 * `transfer_pair_id` column instead of the ambiguous runtime heuristic (see
 * `findMirrorLeg` in queries.ts) once imported.
 */

function row(overrides: Partial<RegisterRow>): RegisterRow {
  return {
    Account: "Checking",
    Flag: "",
    Date: "01.03.2025",
    Payee: "",
    "Category Group/Category": "",
    "Category Group": "",
    Category: "",
    Memo: "",
    Outflow: "CHF 0.00",
    Inflow: "CHF 0.00",
    Cleared: "Cleared",
    ...overrides,
  };
}

/** One transfer's two register rows (Checking <-> Savings), given a memo to tell transfers apart. */
function transferRows(date: string, amount: string, memo: string): RegisterRow[] {
  return [
    row({ Account: "Checking", Date: date, Payee: "Transfer : Savings", Memo: memo, Outflow: amount }),
    row({ Account: "Savings", Date: date, Payee: "Transfer : Checking", Memo: memo, Inflow: amount }),
  ];
}

describe("buildImportResult transfer pairing", () => {
  it("stamps a shared transferPairId per transfer, and distinct ids across two same-day same-amount transfers", () => {
    const registerRows = [
      ...transferRows("01.03.2025", "CHF 100.00", "First"),
      ...transferRows("01.03.2025", "CHF 100.00", "Second"),
    ];

    const result = buildImportResult(registerRows, []);
    const transactions = result.transactions;
    expect(transactions).toHaveLength(4);

    const first = transactions.filter((t) => t.memo === "First");
    const second = transactions.filter((t) => t.memo === "Second");
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);

    // Both legs of the same transfer share a pair id.
    expect(first[0].transferPairId).not.toBeNull();
    expect(first[0].transferPairId).toBe(first[1].transferPairId);
    expect(second[0].transferPairId).not.toBeNull();
    expect(second[0].transferPairId).toBe(second[1].transferPairId);

    // The two transfers (same day, same amount, same account pair) must NOT
    // share a pair id — this is exactly the ambiguous case the runtime
    // heuristic gets wrong.
    expect(first[0].transferPairId).not.toBe(second[0].transferPairId);
  });

  it("pairs distinct transfers between different account pairs independently", () => {
    const registerRows = [
      ...transferRows("01.03.2025", "CHF 100.00", "To savings"),
      row({ Account: "Checking", Date: "01.03.2025", Payee: "Transfer : Cash", Memo: "To cash", Outflow: "CHF 50.00" }),
      row({ Account: "Cash", Date: "01.03.2025", Payee: "Transfer : Checking", Memo: "To cash", Inflow: "CHF 50.00" }),
    ];

    const result = buildImportResult(registerRows, []);
    const toSavings = result.transactions.filter((t) => t.memo === "To savings");
    const toCash = result.transactions.filter((t) => t.memo === "To cash");

    expect(toSavings[0].transferPairId).toBe(toSavings[1].transferPairId);
    expect(toCash[0].transferPairId).toBe(toCash[1].transferPairId);
    expect(toSavings[0].transferPairId).not.toBe(toCash[0].transferPairId);
  });

  it("leaves non-transfer rows with a null transferPairId", () => {
    const registerRows = [
      row({ Account: "Checking", Payee: "Coffee Shop", Outflow: "CHF 4.50" }),
    ];

    const result = buildImportResult(registerRows, []);
    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].transferPairId).toBeNull();
  });

  it("leaves the unmatched leftover null when a group is unbalanced", () => {
    // Three Checking->X legs but only two X->Checking legs on the same
    // day/amount: two are pairable, one is left without a mirror in this
    // file (e.g. the counterpart landed in a different account's export).
    const registerRows = [
      row({ Account: "Checking", Date: "01.03.2025", Payee: "Transfer : Savings", Memo: "A", Outflow: "CHF 20.00" }),
      row({ Account: "Checking", Date: "01.03.2025", Payee: "Transfer : Savings", Memo: "B", Outflow: "CHF 20.00" }),
      row({ Account: "Checking", Date: "01.03.2025", Payee: "Transfer : Savings", Memo: "C", Outflow: "CHF 20.00" }),
      row({ Account: "Savings", Date: "01.03.2025", Payee: "Transfer : Checking", Memo: "A", Inflow: "CHF 20.00" }),
      row({ Account: "Savings", Date: "01.03.2025", Payee: "Transfer : Checking", Memo: "B", Inflow: "CHF 20.00" }),
    ];

    const result = buildImportResult(registerRows, []);
    const paired = result.transactions.filter((t) => t.transferPairId != null);
    const unpaired = result.transactions.filter((t) => t.transferPairId == null);

    expect(paired).toHaveLength(4);
    expect(unpaired).toHaveLength(1);
    expect(unpaired[0].memo).toBe("C");
  });
});
