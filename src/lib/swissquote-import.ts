/**
 * Swissquote monthly-statement (Kontoauszug) PDF importer — text extraction
 * + pure parsing. Mirrors `csv-import.ts`'s split: this module never
 * touches the DB, `queries.ts` owns the preview/commit steps (holding
 * lookup, deposit matching, duplicate detection).
 *
 * `extractStatementText` is the only async, IO-touching export (wraps
 * `pdf-parse`); everything else is a pure, synchronously-testable function
 * over the extracted text so the parser can be unit-tested against a small
 * synthetic fixture instead of a real (personal-data-bearing) PDF.
 *
 * Extraction format (from `pdf-parse`'s `getText()`, verified against real
 * statements): each entry starts at a line "DD.MM.YYYY\t<Information>".
 * Rows with no further detail (Anfangsbestand/Schlussbilanz, Depotgebühren)
 * carry the rest of the row as more tab-separated fields on the SAME line;
 * rows with a multi-line detail block (Kauf/Verkauf/Dividende/Zahlung
 * von/Währungsumtausch) spill their name/ISIN/Anzahl/etc. onto plain
 * (tab-free) lines, terminated by a tab-separated "tail" line carrying
 * whatever combination of REFERENZ / BELASTUNG-or-GUTSCHRIFT / VALUTA-DATUM
 * / SALDO is present for that row (1, 3 or 4 fields — see `parseTail`).
 *
 * BELASTUNG vs GUTSCHRIFT (the row's direction) is never read positionally
 * — the printed column layout is not reliable text-extraction output.
 * Instead each row's signed amount is *derived* from the running SALDO
 * column (this row's balance minus the previous row's balance), which is
 * definitionally correct and, as a side effect, makes the required
 * Anfangssaldo+credits−debits=Endsaldo check partly self-verifying; the
 * independent per-section "Total Belastung"/"Total Gutschrift" header
 * figures (not derived from our own math) are what actually catch a parser
 * that silently missed or misread a row.
 */
import { createHash } from "node:crypto";
import { parseMoneyInput } from "./currency";
import { parseDate } from "./ynab-import";

export type StatementRowKind = "buy" | "sell" | "dividend" | "interest" | "fee" | "deposit" | "other" | "boundary";

export interface StatementEntry {
  date: string; // ISO
  rawType: string;
  kind: StatementRowKind;
  referenz: string | null;
  /** Signed minor units; 0 for boundary rows (Anfangsbestand/Schlussbilanz). */
  amount: number;
  valutaDate: string | null;
  /** Running balance after this row, minor units. */
  saldo: number;
  currency: string;
  // Trade (buy/sell) and dividend fields — undefined when not applicable.
  ticker?: string;
  yahooSymbol?: string;
  name?: string;
  quantity?: number;
  isin?: string;
  venue?: string;
}

export interface StatementSection {
  currency: string;
  openingDate: string;
  openingBalance: number;
  closingDate: string;
  closingBalance: number;
  totalDebit: number;
  totalCredit: number;
  entries: StatementEntry[];
}

export interface ParsedStatement {
  periodStart: string;
  periodEnd: string;
  sections: StatementSection[];
}

export type ParseStatementResult = { ok: true; statement: ParsedStatement } | { ok: false; error: string };

/** SIX-listed tickers map to Yahoo's ".SW" suffix; everything else (US tickers etc.) stays plain. */
export function mapSwissquoteTicker(ticker: string, venue: string | undefined): string {
  if (venue && venue.toLowerCase().includes("six")) return `${ticker}.SW`;
  return ticker;
}

/**
 * Stable per-row dedup key: the bank's own reference number when the row
 * has one (buys/sells/dividends/deposits/FX rows all do), else a composite
 * of date+type+amount for the few row types that don't (Depotgebühren).
 * Used both to flag duplicate rows across overlapping statements in preview
 * and as the row's identity in the `imported_statement_rows` ledger at
 * commit time — see `queries.ts`.
 */
export function computeSwissquoteImportHash(
  accountId: number,
  entry: Pick<StatementEntry, "referenz" | "date" | "rawType" | "amount">
): string {
  const key = entry.referenz ?? `${entry.date}|${entry.rawType}|${entry.amount}`;
  return createHash("sha256").update(`sq|${accountId}|${key}`).digest("hex");
}

function classifyKind(rawType: string): StatementRowKind {
  const t = rawType.trim();
  if (t === "Anfangsbestand" || t === "Schlussbilanz") return "boundary";
  if (t === "Kauf") return "buy";
  if (t === "Verkauf") return "sell";
  if (t === "Dividende") return "dividend";
  if (t === "Zins" || /^zins/i.test(t)) return "interest";
  if (/gebühr/i.test(t)) return "fee";
  if (t.startsWith("Zahlung von")) return "deposit";
  return "other";
}

function money(raw: string): number | null {
  return parseMoneyInput(raw.trim());
}

const DATE_RE = /^\d{2}\.\d{2}\.\d{4}$/;

/** Parse a completed row's trailing tab-separated fields (see module docs). */
function parseTail(
  tail: string[]
): { referenz: string | null; statedAmount: number | null; valutaDate: string | null; saldo: number } | null {
  const fields = tail;
  if (fields.length === 1) {
    const saldo = money(fields[0]);
    if (saldo == null) return null;
    return { referenz: null, statedAmount: null, valutaDate: null, saldo };
  }
  if (fields.length === 3) {
    const [amountRaw, valutaRaw, saldoRaw] = fields;
    const statedAmount = money(amountRaw);
    const saldo = money(saldoRaw);
    if (statedAmount == null || saldo == null || !DATE_RE.test(valutaRaw)) return null;
    return { referenz: null, statedAmount, valutaDate: parseDate(valutaRaw), saldo };
  }
  if (fields.length === 4) {
    const [referenzRaw, amountRaw, valutaRaw, saldoRaw] = fields;
    const statedAmount = money(amountRaw);
    const saldo = money(saldoRaw);
    if (statedAmount == null || saldo == null || !DATE_RE.test(valutaRaw)) return null;
    return { referenz: referenzRaw || null, statedAmount, valutaDate: parseDate(valutaRaw), saldo };
  }
  return null;
}

const FIELD_LABEL_RE = /^(Anzahl|Preis|Betrag|Kommission|Taxen|Handelsplatz|ISIN|Total):\s*(.*)$/;

interface TradeFields {
  name: string | null;
  ticker: string | null;
  quantity: number | null;
  handelsplatz: string | null;
  isin: string | null;
}

/** Extract the structured Kauf/Verkauf/Dividende sub-fields from an entry's detail lines. */
function extractTradeFields(detailLines: string[]): TradeFields {
  const fieldStart = detailLines.findIndex((l) => FIELD_LABEL_RE.test(l));
  const nameLines = fieldStart === -1 ? detailLines : detailLines.slice(0, fieldStart);
  const fieldLines = fieldStart === -1 ? [] : detailLines.slice(fieldStart);

  const nameRaw = nameLines.join(" ").trim();
  const tickerMatch = nameRaw.match(/\(([A-Za-z0-9.\-]+)\)\s*$/);
  const ticker = tickerMatch ? tickerMatch[1] : null;
  const name = (ticker ? nameRaw.slice(0, tickerMatch!.index).trim() : nameRaw) || null;

  let quantity: number | null = null;
  let handelsplatz: string | null = null;
  let isin: string | null = null;
  for (const line of fieldLines) {
    const m = line.match(FIELD_LABEL_RE);
    if (!m) continue;
    const [, label, value] = m;
    if (label === "Anzahl") quantity = Number(value.trim()) || null;
    else if (label === "Handelsplatz") handelsplatz = value.trim();
    else if (label === "ISIN") isin = value.trim();
  }

  return { name, ticker, quantity, handelsplatz, isin };
}

interface RawRow {
  date: string;
  rawType: string;
  tail: string[];
  detailLines: string[];
}

/** Scan a section's text into raw (unclassified) rows. Null on structural failure. */
function scanRows(sectionText: string): RawRow[] | null {
  const lines = sectionText.split(/\r?\n/);
  const rows: RawRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const start = line.match(/^(\d{2}\.\d{2}\.\d{4})\s*\t(.+)$/);
    if (!start) {
      i++;
      continue;
    }
    const date = start[1];
    const restParts = start[2].split("\t").map((s) => s.trim());
    const rawType = restParts[0];

    if (restParts.length > 1) {
      rows.push({ date, rawType, tail: restParts.slice(1), detailLines: [] });
      i++;
      continue;
    }

    // No tail on the start line: scan forward through detail lines for the
    // tab-separated tail line that closes this entry.
    i++;
    const detailLines: string[] = [];
    let tail: string[] | null = null;
    while (i < lines.length) {
      const l = lines[i];
      if (l.includes("\t")) {
        tail = l.split("\t").map((s) => s.trim());
        i++;
        break;
      }
      if (/^\d{2}\.\d{2}\.\d{4}\s*\t/.test(l)) return null; // next entry started, this one never closed
      if (l.trim() !== "") detailLines.push(l.trim());
      i++;
    }
    if (tail == null) return null; // statement ended mid-entry
    rows.push({ date, rawType, tail, detailLines });
  }
  return rows;
}

function fail(message: string): ParseStatementResult {
  return { ok: false, error: message };
}

/** Parse one currency section's text (everything after its "Kontoauszug in XXX" header line). */
function parseSection(currency: string, text: string): { section: StatementSection } | { error: string } {
  const saldoMatches = [...text.matchAll(/Saldo per\s+(\d{2}\.\d{2}\.\d{4})\s+(-?[\d'.,]+)\s+([A-Z]{3})/g)];
  if (saldoMatches.length < 2) {
    return { error: `${currency} section: could not find opening and closing "Saldo per" lines.` };
  }
  const [open, close] = saldoMatches;
  const openingBalance = money(open[2]);
  const closingBalance = money(close[2]);
  if (openingBalance == null || closingBalance == null) {
    return { error: `${currency} section: could not parse opening/closing balance.` };
  }

  const debitMatch = text.match(/Total Belastung\s+(-?[\d'.,]+)\s+[A-Z]{3}/);
  const creditMatch = text.match(/Total Gutschrift\s+(-?[\d'.,]+)\s+[A-Z]{3}/);
  const totalDebit = debitMatch ? money(debitMatch[1]) : null;
  const totalCredit = creditMatch ? money(creditMatch[1]) : null;
  if (totalDebit == null || totalCredit == null) {
    return { error: `${currency} section: could not find Total Belastung/Total Gutschrift.` };
  }

  const rawRows = scanRows(text);
  if (rawRows == null) {
    return { error: `${currency} section: statement structure did not parse (an entry never closed).` };
  }
  if (rawRows.length === 0) return { error: `${currency} section: no entries found.` };
  if (rawRows[0].rawType !== "Anfangsbestand") {
    return { error: `${currency} section: first row is not "Anfangsbestand".` };
  }
  if (rawRows[rawRows.length - 1].rawType !== "Schlussbilanz") {
    return { error: `${currency} section: last row is not "Schlussbilanz".` };
  }

  const entries: StatementEntry[] = [];
  let running: number | null = null;
  let sumCredit = 0;
  let sumDebit = 0;

  for (const raw of rawRows) {
    const tail = parseTail(raw.tail);
    if (tail == null) {
      return { error: `${currency} section: could not parse row "${raw.date} ${raw.rawType}".` };
    }
    const kind = classifyKind(raw.rawType);
    const date = parseDate(raw.date);

    if (running == null) {
      // First row (Anfangsbestand) anchors the running balance.
      running = tail.saldo;
      entries.push({ date, rawType: raw.rawType, kind, referenz: null, amount: 0, valutaDate: null, saldo: tail.saldo, currency });
      continue;
    }

    const delta = tail.saldo - running;
    running = tail.saldo;

    if (kind !== "boundary" && tail.statedAmount != null) {
      if (Math.abs(Math.abs(delta) - tail.statedAmount) > 0) {
        return {
          error: `${currency} section: row "${raw.date} ${raw.rawType}" balance moved by ${delta} but the row states ${tail.statedAmount}.`,
        };
      }
    }
    if (delta > 0) sumCredit += delta;
    if (delta < 0) sumDebit += -delta;

    const entry: StatementEntry = {
      date,
      rawType: raw.rawType,
      kind,
      referenz: tail.referenz,
      amount: kind === "boundary" ? 0 : delta,
      valutaDate: tail.valutaDate,
      saldo: tail.saldo,
      currency,
    };

    if (kind === "buy" || kind === "sell" || kind === "dividend") {
      const trade = extractTradeFields(raw.detailLines);
      entry.name = trade.name ?? undefined;
      entry.ticker = trade.ticker ?? undefined;
      entry.quantity = trade.quantity ?? undefined;
      entry.isin = trade.isin ?? undefined;
      entry.venue = trade.handelsplatz ?? undefined;
      if (trade.ticker) entry.yahooSymbol = mapSwissquoteTicker(trade.ticker, trade.handelsplatz ?? undefined);

      // A buy/sell that moves holdings must carry a ticker and quantity —
      // silently dropping either would desync the resulting holding
      // quantity from what the statement actually says, so fail the whole
      // import instead (same "refuse rather than guess" policy as the
      // balance check above).
      if ((kind === "buy" || kind === "sell") && (!trade.ticker || trade.quantity == null)) {
        return { error: `${currency} section: could not parse ticker/quantity for "${raw.date} ${raw.rawType}".` };
      }
    }

    entries.push(entry);
  }

  if (openingBalance !== entries[0].saldo) {
    return { error: `${currency} section: Anfangsbestand (${entries[0].saldo}) does not match the stated opening Saldo (${openingBalance}).` };
  }
  if (closingBalance !== running) {
    return { error: `${currency} section: computed closing balance (${running}) does not match the stated Endsaldo (${closingBalance}).` };
  }
  if (sumCredit !== totalCredit) {
    return { error: `${currency} section: computed total credits (${sumCredit}) does not match the statement's Total Gutschrift (${totalCredit}).` };
  }
  if (sumDebit !== totalDebit) {
    return { error: `${currency} section: computed total debits (${sumDebit}) does not match the statement's Total Belastung (${totalDebit}).` };
  }

  return {
    section: {
      currency,
      openingDate: parseDate(open[1]),
      openingBalance,
      closingDate: parseDate(close[1]),
      closingBalance,
      totalDebit,
      totalCredit,
      entries,
    },
  };
}

/** Parse the plain-text extraction of one Swissquote Kontoauszug PDF. Pure, synchronous, no IO. */
export function parseStatementText(text: string): ParseStatementResult {
  const periodMatch = text.match(/Kontoauszug vom\s+(\d{2}\.\d{2}\.\d{4})\s+bis\s+(\d{2}\.\d{2}\.\d{4})/);
  if (!periodMatch) return fail('Could not find the statement period ("Kontoauszug vom ... bis ...").');

  const sectionHeaders = [...text.matchAll(/^Kontoauszug in ([A-Z]{3})$/gm)];
  if (sectionHeaders.length === 0) return fail('No currency sections found ("Kontoauszug in XXX").');

  const sections: StatementSection[] = [];
  for (let i = 0; i < sectionHeaders.length; i++) {
    const currency = sectionHeaders[i][1];
    const start = sectionHeaders[i].index! + sectionHeaders[i][0].length;
    const end = i + 1 < sectionHeaders.length ? sectionHeaders[i + 1].index! : text.length;
    const result = parseSection(currency, text.slice(start, end));
    if ("error" in result) return fail(result.error);
    sections.push(result.section);
  }

  return {
    ok: true,
    statement: { periodStart: parseDate(periodMatch[1]), periodEnd: parseDate(periodMatch[2]), sections },
  };
}

/**
 * Extract plain text from a Swissquote statement PDF. The only IO-touching
 * export in this module — `parseStatementText` above does all the actual
 * parsing and is exercised directly in tests against a synthetic fixture.
 */
export async function extractStatementText(buffer: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return result.text;
  } finally {
    await parser.destroy();
  }
}
