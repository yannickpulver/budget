import { describe, expect, it } from "vitest";
import { computeSwissquoteImportHash, mapSwissquoteTicker, parseStatementText } from "./swissquote-import";

/**
 * Pure parser tests against a synthetic fixture that mimics `pdf-parse`'s
 * exact tab-delimited extraction shape (verified against the real Kontoauszug
 * PDFs during development — see PLAN.md/TODO.md) but with invented
 * name/address/IBAN/amounts. No real statement data or PDFs are committed;
 * this string is the entire fixture.
 *
 * Layout notes replicated on purpose because the parser depends on them:
 *  - every field is separated by a literal tab, sometimes preceded by a
 *    stray space ("DATE \tTYPE") — real extractions have this inconsistently.
 *  - a row with no detail block puts its whole tail on the start line
 *    (Anfangsbestand/Schlussbilanz: just SALDO; Depotgebühren: AMOUNT,
 *    VALUTA-DATUM, SALDO — no REFERENZ).
 *  - a row with a detail block (Kauf/Zahlung von/Dividende) puts only
 *    "DATE\tTYPE" on the start line, then plain (tab-free) detail lines,
 *    closed by a tab-separated tail line: REFERENZ, AMOUNT, VALUTA-DATUM, SALDO.
 */

function buildFixture(overrides: { totalGutschriftChf?: string } = {}): string {
  const totalGutschriftChf = overrides.totalGutschriftChf ?? "500.00";
  return `Ihr Kontoauszug
Kontoauszug vom \t01.01.2026 bis 31.01.2026
Dokument erstellt am 01.02.2026
Anfangssaldo \t100.00 \tCHF
Endsaldo \t140.85 \tCHF

-- 1 of 2 --

Kontoauszug in CHF
Saldo per 01.01.2026 \t100.00 CHF
Total Belastung \t460.00 CHF
Total Gutschrift \t${totalGutschriftChf} CHF
Saldo per 31.01.2026 \t140.00 CHF
DATUM \tINFORMATION \tREFERENZ \tBELASTUNG \tGUTSCHRIFT \tVALUTA-DATUM \tSALDO (CHF)
01.01.2026 \tAnfangsbestand \t100.00
15.01.2026 \tZahlung von
Muster Max
Musterstrasse 1
8000 Zürich
CH
100000001 \t500.00 \t15.01.2026 \t600.00
16.01.2026 \tKauf
Test Fund UCITS ETF
(TEST)
Anzahl: 3
Preis: CHF 150.00
Betrag: CHF 450.00
Kommission: CHF 5.00
Taxen: CHF 1.00
Handelsplatz: SIX Swiss Exchange
ISIN: CH0000000001
100000002 \t456.00 \t18.01.2026 \t144.00
31.01.2026 \tDepotgebühren \t4.00 \t31.01.2026 \t140.00
31.01.2026 \tSchlussbilanz \t140.00

-- 2 of 2 --

Kontoauszug in USD
Saldo per 01.01.2026 \t0.00 USD
Total Belastung \t103.20 USD
Total Gutschrift \t0.85 USD
Saldo per 31.01.2026 \t-102.35 USD
DATUM \tINFORMATION \tREFERENZ \tBELASTUNG \tGUTSCHRIFT \tVALUTA-DATUM \tSALDO (USD)
01.01.2026 \tAnfangsbestand \t0.00
20.01.2026 \tDividende
ACME ORD (ACME)
Anzahl: 5
Betrag: USD 1.00
Taxen: USD 0.15
Total: USD 0.85
200000001 \t0.85 \t20.01.2026 \t0.85
22.01.2026 \tKauf
Acme Corp Class A
(ACME2)
Anzahl: 1
Preis: USD 100.00
Betrag: USD 100.00
Kommission: USD 3.00
Taxen: USD 0.20
Handelsplatz: NASDAQ New York
ISIN: US0000000002
200000002 \t103.20 \t23.01.2026 \t-102.35
31.01.2026 \tSchlussbilanz \t-102.35
`;
}

describe("parseStatementText", () => {
  it("parses period, sections and classifies every row kind", () => {
    const result = parseStatementText(buildFixture());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.statement.periodStart).toBe("2026-01-01");
    expect(result.statement.periodEnd).toBe("2026-01-31");
    expect(result.statement.sections).toHaveLength(2);

    const chf = result.statement.sections[0];
    expect(chf.currency).toBe("CHF");
    expect(chf.openingBalance).toBe(10000);
    expect(chf.closingBalance).toBe(14000);
    expect(chf.totalDebit).toBe(46000);
    expect(chf.totalCredit).toBe(50000);

    const kinds = chf.entries.map((e) => e.kind);
    expect(kinds).toEqual(["boundary", "deposit", "buy", "fee", "boundary"]);

    const deposit = chf.entries[1];
    expect(deposit.amount).toBe(50000);
    expect(deposit.referenz).toBe("100000001");

    const buy = chf.entries[2];
    expect(buy.amount).toBe(-45600);
    expect(buy.ticker).toBe("TEST");
    expect(buy.yahooSymbol).toBe("TEST.SW");
    expect(buy.name).toBe("Test Fund UCITS ETF");
    expect(buy.quantity).toBe(3);
    expect(buy.isin).toBe("CH0000000001");

    const fee = chf.entries[3];
    expect(fee.amount).toBe(-400);
    expect(fee.referenz).toBeNull();

    const usd = result.statement.sections[1];
    expect(usd.entries.map((e) => e.kind)).toEqual(["boundary", "dividend", "buy", "boundary"]);
    const dividend = usd.entries[1];
    expect(dividend.amount).toBe(85);
    expect(dividend.ticker).toBe("ACME");
    expect(dividend.quantity).toBe(5);

    const usBuy = usd.entries[2];
    expect(usBuy.ticker).toBe("ACME2");
    expect(usBuy.venue).toBe("NASDAQ New York");
    // Not a SIX listing — Yahoo symbol stays plain, no .SW suffix.
    expect(usBuy.yahooSymbol).toBe("ACME2");
    expect(usBuy.amount).toBe(-10320);
  });

  it("refuses the whole statement when a section's totals don't reconcile", () => {
    // Total Gutschrift is wrong relative to the actual entries (500.00 -> 999.00).
    const result = parseStatementText(buildFixture({ totalGutschriftChf: "999.00" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/CHF section/);
    expect(result.error).toMatch(/Total Gutschrift/);
  });

  it("rejects text with no recognizable currency sections", () => {
    const result = parseStatementText("Kontoauszug vom \t01.01.2026 bis 31.01.2026\nnothing else here\n");
    expect(result.ok).toBe(false);
  });
});

describe("mapSwissquoteTicker", () => {
  it("appends .SW for SIX Swiss Exchange listings", () => {
    expect(mapSwissquoteTicker("VWRL", "SIX Swiss Exchange")).toBe("VWRL.SW");
  });

  it("keeps non-SIX tickers plain", () => {
    expect(mapSwissquoteTicker("GOOGL", "NASDAQ New York")).toBe("GOOGL");
    expect(mapSwissquoteTicker("AAPL", undefined)).toBe("AAPL");
  });
});

describe("computeSwissquoteImportHash", () => {
  it("is stable for the same account+referenz and differs across accounts", () => {
    const entry = { referenz: "100000001", date: "2026-01-15", rawType: "Zahlung von", amount: 50000 };
    const a = computeSwissquoteImportHash(1, entry);
    const b = computeSwissquoteImportHash(1, entry);
    const c = computeSwissquoteImportHash(2, entry);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("falls back to a date+type+amount composite when there is no referenz (e.g. Depotgebühren)", () => {
    const withoutReferenz = computeSwissquoteImportHash(1, {
      referenz: null,
      date: "2026-01-31",
      rawType: "Depotgebühren",
      amount: -400,
    });
    const differentDate = computeSwissquoteImportHash(1, {
      referenz: null,
      date: "2026-02-28",
      rawType: "Depotgebühren",
      amount: -400,
    });
    expect(withoutReferenz).not.toBe(differentDate);
  });
});
