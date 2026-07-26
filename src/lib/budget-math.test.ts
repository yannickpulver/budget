import { describe, expect, it } from "vitest";
import {
  computeAvailable,
  computeBalanceGoalStatus,
  computeCategoryActivity,
  computeGoalStatus,
  computeMonthSnapshot,
  isAccountHiddenForMonth,
  monthFromPathname,
  nextMonthKey,
  type AccountInfo,
  type MonthSnapshot,
  type TxnInput,
} from "./budget-math";

const CHECKING = 1;
const CREDIT = 2;
const TRACKING = 3;
const SAVINGS = 4;
const GIFTCARD = 5;

const GROCERIES = 100;
const RENT = 101;
const PAYMENT_CAT = 102;

function accountsMap(overrides: Record<number, AccountInfo> = {}): Map<number, AccountInfo> {
  const base: Record<number, AccountInfo> = {
    [CHECKING]: { id: CHECKING, type: "checking", paymentCategoryId: null },
    [CREDIT]: { id: CREDIT, type: "credit", paymentCategoryId: PAYMENT_CAT },
    [TRACKING]: { id: TRACKING, type: "tracking", paymentCategoryId: null },
    [SAVINGS]: { id: SAVINGS, type: "savings", paymentCategoryId: null },
    [GIFTCARD]: { id: GIFTCARD, type: "giftcard", paymentCategoryId: null },
    ...overrides,
  };
  return new Map(Object.entries(base).map(([id, info]) => [Number(id), info]));
}

interface MonthInput {
  assignedByCategory: Map<number, number>;
  transactions: TxnInput[];
}

function walkMonths(
  months: MonthInput[],
  categoryIds: number[],
  accounts: Map<number, AccountInfo>
): MonthSnapshot[] {
  const snapshots: MonthSnapshot[] = [];
  let prevAvailable = new Map<number, number>();
  let cumulativeFunds = 0;

  for (const month of months) {
    const snapshot = computeMonthSnapshot({
      categoryIds,
      prevAvailable,
      assignedByCategory: month.assignedByCategory,
      monthTransactions: month.transactions,
      cumulativeOnBudgetFundsThroughPrevMonth: cumulativeFunds,
      accounts,
    });
    snapshots.push(snapshot);
    prevAvailable = new Map(
      Array.from(snapshot.categories.entries()).map(([id, s]) => [id, s.available])
    );
    cumulativeFunds = snapshot.cumulativeOnBudgetFunds;
  }

  return snapshots;
}

describe("computeAvailable", () => {
  it("rolls a positive available balance forward", () => {
    // available(M) = max(0, prev) + assigned + activity
    expect(computeAvailable(50, 0, 0)).toBe(50);
  });

  it("does not let a negative available balance carry forward", () => {
    expect(computeAvailable(-30, 0, 0)).toBe(0);
  });
});

describe("rollover across months", () => {
  it("carries unspent available into the next month", () => {
    const accounts = accountsMap();
    const months: MonthInput[] = [
      {
        assignedByCategory: new Map([[GROCERIES, 10000]]),
        transactions: [{ accountId: CHECKING, categoryId: GROCERIES, amount: -4000 }],
      },
      {
        assignedByCategory: new Map(),
        transactions: [],
      },
    ];
    const [month1, month2] = walkMonths(months, [GROCERIES], accounts);
    expect(month1.categories.get(GROCERIES)?.available).toBe(6000);
    // Nothing assigned or spent in month 2 — the 6000 rolls forward unchanged.
    expect(month2.categories.get(GROCERIES)?.available).toBe(6000);
  });
});

describe("overspend reset", () => {
  it("does not carry a negative available forward; it comes out of next month's RTA instead", () => {
    const accounts = accountsMap();
    const months: MonthInput[] = [
      {
        // Nothing assigned to Groceries, but 30 spent -> available = -30.
        assignedByCategory: new Map(),
        transactions: [{ accountId: CHECKING, categoryId: GROCERIES, amount: -3000 }],
      },
      {
        assignedByCategory: new Map(),
        transactions: [],
      },
    ];
    const [month1, month2] = walkMonths(months, [GROCERIES], accounts);
    expect(month1.categories.get(GROCERIES)?.available).toBe(-3000);
    expect(month1.readyToAssign).toBe(0);
    // Overspend does not roll forward as a debt on the category...
    expect(month2.categories.get(GROCERIES)?.available).toBe(0);
    // ...instead it comes out of month2's readyToAssign, since the clamp to 0
    // only happens when the negative available is carried into the next month.
    expect(month2.readyToAssign).toBe(-3000);
  });
});

describe("readyToAssign identity", () => {
  it("always equals on-budget funds through M minus the sum of all category availables", () => {
    const accounts = accountsMap();
    const months: MonthInput[] = [
      {
        assignedByCategory: new Map([
          [GROCERIES, 20000],
          [RENT, 150000],
        ]),
        transactions: [
          { accountId: CHECKING, categoryId: null, amount: 500000 }, // income via RTA
          { accountId: CHECKING, categoryId: GROCERIES, amount: -8000 },
          { accountId: CHECKING, categoryId: RENT, amount: -150000 },
        ],
      },
      {
        assignedByCategory: new Map([[GROCERIES, 20000]]),
        transactions: [{ accountId: CHECKING, categoryId: GROCERIES, amount: -25000 }],
      },
    ];
    const snapshots = walkMonths(months, [GROCERIES, RENT], accounts);
    for (const snapshot of snapshots) {
      const totalAvailable = Array.from(snapshot.categories.values()).reduce(
        (sum, c) => sum + c.available,
        0
      );
      expect(snapshot.readyToAssign).toBe(snapshot.cumulativeOnBudgetFunds - totalAvailable);
    }
  });
});

describe("income via Ready to Assign category", () => {
  it("increases readyToAssign without touching any category's activity", () => {
    const accounts = accountsMap();
    const activity = computeCategoryActivity(
      [{ accountId: CHECKING, categoryId: null, amount: 100000 }],
      accounts
    );
    expect(activity.size).toBe(0);

    const [month] = walkMonths(
      [
        {
          assignedByCategory: new Map(),
          transactions: [{ accountId: CHECKING, categoryId: null, amount: 100000 }],
        },
      ],
      [GROCERIES],
      accounts
    );
    expect(month.readyToAssign).toBe(100000);
  });
});

describe("transfers excluded from activity", () => {
  it("a transfer leg (no category) never contributes to category activity", () => {
    const accounts = accountsMap();
    const activity = computeCategoryActivity(
      [
        { accountId: CHECKING, categoryId: null, amount: -20000 },
        { accountId: SAVINGS, categoryId: null, amount: 20000 },
      ],
      accounts
    );
    expect(activity.size).toBe(0);
  });

  it("a transfer between two on-budget accounts nets to zero on readyToAssign", () => {
    const accounts = accountsMap();
    const [month] = walkMonths(
      [
        {
          assignedByCategory: new Map(),
          transactions: [
            { accountId: CHECKING, categoryId: null, amount: -20000 },
            { accountId: SAVINGS, categoryId: null, amount: 20000 },
          ],
        },
      ],
      [GROCERIES],
      accounts
    );
    expect(month.readyToAssign).toBe(0);
  });

  it("a transfer to a tracking account removes funds from readyToAssign", () => {
    const accounts = accountsMap();
    const [month] = walkMonths(
      [
        {
          assignedByCategory: new Map(),
          transactions: [
            { accountId: CHECKING, categoryId: null, amount: -20000 },
            { accountId: TRACKING, categoryId: null, amount: 20000 },
          ],
        },
      ],
      [GROCERIES],
      accounts
    );
    expect(month.readyToAssign).toBe(-20000);
  });
});

describe("giftcard accounts are on-budget", () => {
  it("categorized spend on a giftcard counts as normal category activity", () => {
    const accounts = accountsMap();
    const activity = computeCategoryActivity(
      [{ accountId: GIFTCARD, categoryId: GROCERIES, amount: -3000 }],
      accounts
    );
    expect(activity.get(GROCERIES)).toBe(-3000);
  });

  it("counts toward on-budget funds like a checking account", () => {
    const accounts = accountsMap();
    const [month] = walkMonths(
      [
        {
          assignedByCategory: new Map(),
          // Receiving a giftcard as a present: uncategorized inflow -> RTA.
          transactions: [{ accountId: GIFTCARD, categoryId: null, amount: 5000 }],
        },
      ],
      [GROCERIES],
      accounts
    );
    expect(month.readyToAssign).toBe(5000);
    expect(month.cumulativeOnBudgetFunds).toBe(5000);
  });

  it("a transfer between checking and a giftcard (topping it up) nets to zero on readyToAssign", () => {
    const accounts = accountsMap();
    const [month] = walkMonths(
      [
        {
          assignedByCategory: new Map(),
          transactions: [
            { accountId: CHECKING, categoryId: null, amount: -10000 },
            { accountId: GIFTCARD, categoryId: null, amount: 10000 },
          ],
        },
      ],
      [GROCERIES],
      accounts
    );
    expect(month.readyToAssign).toBe(0);
  });
});

describe("credit-card payment-category feed", () => {
  it("categorized spend on a credit account also credits its linked payment category", () => {
    const accounts = accountsMap();
    const activity = computeCategoryActivity(
      [{ accountId: CREDIT, categoryId: GROCERIES, amount: -5000 }],
      accounts
    );
    expect(activity.get(GROCERIES)).toBe(-5000);
    expect(activity.get(PAYMENT_CAT)).toBe(5000);
  });

  it("keeps the RTA identity intact across a credit-card purchase", () => {
    const accounts = accountsMap();
    const [month] = walkMonths(
      [
        {
          assignedByCategory: new Map([[GROCERIES, 10000]]),
          transactions: [{ accountId: CREDIT, categoryId: GROCERIES, amount: -5000 }],
        },
      ],
      [GROCERIES, PAYMENT_CAT],
      accounts
    );
    expect(month.categories.get(GROCERIES)?.available).toBe(5000);
    expect(month.categories.get(PAYMENT_CAT)?.available).toBe(5000);
  });

  it("a payment transfer into the credit account reduces the payment category", () => {
    const accounts = accountsMap();
    // Paying CHF 50 from checking to the card: the credit leg is +5000.
    const activity = computeCategoryActivity(
      [
        {
          accountId: CREDIT,
          categoryId: null,
          amount: 5000,
          transferAccountId: CHECKING,
        },
        {
          accountId: CHECKING,
          categoryId: null,
          amount: -5000,
          transferAccountId: CREDIT,
        },
      ],
      accounts
    );
    // Only the payment category moves — negative, mirroring a card purchase.
    expect(activity.get(PAYMENT_CAT)).toBe(-5000);
    expect(activity.size).toBe(1);
  });

  it("a transfer between two on-budget non-credit accounts never touches a payment category", () => {
    const accounts = accountsMap();
    const activity = computeCategoryActivity(
      [
        { accountId: CHECKING, categoryId: null, amount: -5000, transferAccountId: SAVINGS },
        { accountId: SAVINGS, categoryId: null, amount: 5000, transferAccountId: CHECKING },
      ],
      accounts
    );
    expect(activity.size).toBe(0);
  });

  it("spend then payment nets the payment category to zero", () => {
    const accounts = accountsMap();
    const [month] = walkMonths(
      [
        {
          // Assign 50 to Groceries, spend 50 on the card, then pay the card 50.
          assignedByCategory: new Map([[GROCERIES, 5000]]),
          transactions: [
            { accountId: CREDIT, categoryId: GROCERIES, amount: -5000 },
            { accountId: CREDIT, categoryId: null, amount: 5000, transferAccountId: CHECKING },
            { accountId: CHECKING, categoryId: null, amount: -5000, transferAccountId: CREDIT },
          ],
        },
      ],
      [GROCERIES, PAYMENT_CAT],
      accounts
    );
    // Spend fed the payment category +5000; the payment drew it back to 0.
    expect(month.categories.get(PAYMENT_CAT)?.activity).toBe(0);
    expect(month.categories.get(PAYMENT_CAT)?.available).toBe(0);
    // Groceries is fully spent down.
    expect(month.categories.get(GROCERIES)?.available).toBe(0);
  });
});

describe("monthly goal underfunded calc", () => {
  it("is null when the category has no target", () => {
    expect(computeGoalStatus(null, 5000)).toBeNull();
  });

  it("reports the remaining amount when underfunded", () => {
    expect(computeGoalStatus(12000, 5000)).toEqual({ met: false, remaining: 7000 });
  });

  it("is met once assigned reaches the target, regardless of spending", () => {
    expect(computeGoalStatus(12000, 12000)).toEqual({ met: true, remaining: 0 });
    expect(computeGoalStatus(12000, 15000)).toEqual({ met: true, remaining: 0 });
  });

  it("caps 'to go' at the target when money was pulled out (negative assigned)", () => {
    // Target 500, but 955 was reallocated out (assigned -955): the goal asks
    // for at most one month's target, not target + what was withdrawn.
    expect(computeGoalStatus(50000, -95500)).toEqual({ met: false, remaining: 50000 });
    // Just below zero is still capped at the full target.
    expect(computeGoalStatus(50000, -1)).toEqual({ met: false, remaining: 50000 });
  });

  it("is met when explicitly funded this month, even if net assigned is still negative", () => {
    // Pulled 955 out then funded one month's 500 → net -455, but the monthly
    // contribution is done, so the goal is met and quiet.
    expect(computeGoalStatus(50000, -45500, true)).toEqual({ met: true, remaining: 0 });
    expect(computeGoalStatus(50000, 0, true)).toEqual({ met: true, remaining: 0 });
  });
});

describe("balance goal", () => {
  const base = { month: "2025-01", funded: false };

  it("is met once available reaches the target, regardless of the deadline", () => {
    const status = computeBalanceGoalStatus({ ...base, target: 200000, targetDate: "2025-06", assigned: 0, available: 200000 });
    expect(status).toEqual({ met: true, remaining: 0, underfunded: false });
  });

  it("with no deadline, asks for the full remainder this month", () => {
    // Saved 50'000 before, target 200'000, nothing assigned yet → 150'000 to go.
    const status = computeBalanceGoalStatus({ ...base, target: 200000, targetDate: null, assigned: 0, available: 50000 });
    expect(status).toEqual({ met: false, remaining: 150000, underfunded: true });
  });

  it("with a future deadline, paces the remainder evenly (rounding up)", () => {
    // 150'000 to go across Jan–Jun (6 months) → 25'000/month.
    const status = computeBalanceGoalStatus({ ...base, target: 200000, targetDate: "2025-06", assigned: 0, available: 50000 });
    expect(status).toEqual({ met: false, remaining: 25000, underfunded: true });
  });

  it("is on track (not underfunded) once this month's assignment covers the pace", () => {
    const status = computeBalanceGoalStatus({ ...base, target: 200000, targetDate: "2025-06", assigned: 25000, available: 75000 });
    expect(status).toEqual({ met: false, remaining: 0, underfunded: false });
  });

  it("treats a past deadline like no deadline (full remainder)", () => {
    const status = computeBalanceGoalStatus({ ...base, target: 200000, targetDate: "2024-06", assigned: 0, available: 50000 });
    expect(status).toEqual({ met: false, remaining: 150000, underfunded: true });
  });

  it("is met when explicitly funded, even below target", () => {
    const status = computeBalanceGoalStatus({ ...base, target: 200000, targetDate: "2025-06", assigned: 0, available: 50000, funded: true });
    expect(status).toEqual({ met: true, remaining: 0, underfunded: false });
  });
});

describe("nextMonthKey", () => {
  it("rolls over the year", () => {
    expect(nextMonthKey("2025-12")).toBe("2026-01");
  });

  it("increments within a year", () => {
    expect(nextMonthKey("2025-06")).toBe("2025-07");
  });
});

describe("isAccountHiddenForMonth", () => {
  it("is never hidden when hiddenFrom is null", () => {
    expect(isAccountHiddenForMonth(null, "2026-07")).toBe(false);
  });

  it("is not hidden for months before hiddenFrom", () => {
    expect(isAccountHiddenForMonth("2026-07", "2026-06")).toBe(false);
    expect(isAccountHiddenForMonth("2026-01", "2025-12")).toBe(false);
  });

  it("is hidden from the hiddenFrom month itself", () => {
    expect(isAccountHiddenForMonth("2026-07", "2026-07")).toBe(true);
  });

  it("is hidden for months after hiddenFrom", () => {
    expect(isAccountHiddenForMonth("2026-07", "2026-08")).toBe(true);
    expect(isAccountHiddenForMonth("2025-12", "2026-01")).toBe(true);
  });
});

describe("monthFromPathname", () => {
  it("extracts the month from a budget pathname", () => {
    expect(monthFromPathname("/budget/2026-07")).toBe("2026-07");
  });

  it("extracts the month when a suffix follows", () => {
    expect(monthFromPathname("/budget/2026-07?filter=negative")).toBe("2026-07");
  });

  it("returns null for non-budget paths", () => {
    expect(monthFromPathname("/accounts/3")).toBeNull();
    expect(monthFromPathname("/settings/categories")).toBeNull();
  });

  it("returns null when no month is present", () => {
    expect(monthFromPathname("/budget/")).toBeNull();
  });
});
