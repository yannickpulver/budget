/**
 * Currency helpers. Amounts are integer minor units (Rappen/cents).
 * Display uses Swiss grouping: 1'234.50.
 */

/** Format minor units as Swiss-style "1'234.50" (no currency code). */
export function formatMoney(minorUnits: number): string {
  const negative = minorUnits < 0;
  const abs = Math.abs(minorUnits);
  const whole = Math.floor(abs / 100);
  const cents = abs % 100;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  const body = `${grouped}.${String(cents).padStart(2, "0")}`;
  return negative ? `-${body}` : body;
}

/** Format with the currency code, e.g. "CHF 1'234.50". */
export function formatCurrency(minorUnits: number, currency: string): string {
  return `${currency} ${formatMoney(minorUnits)}`;
}

/** Format minor units rounded to whole currency units, Swiss grouping, no decimals — e.g. "1'235". */
export function formatMoneyWhole(minorUnits: number): string {
  const whole = Math.round(Math.abs(minorUnits) / 100);
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, "'");
}

/**
 * Parse user input into minor units. Accepts "120", "120.50", "1'200",
 * "1'200.50", optional leading minus and surrounding whitespace. Apostrophes
 * (and spaces) are treated as thousands separators. Returns null if unparseable.
 */
export function parseMoneyInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const cleaned = trimmed.replace(/['\s]/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

type Token = { kind: "num"; value: number } | { kind: "op"; value: "+" | "-" | "*" | "/" } | { kind: "paren"; value: "(" | ")" };

/** Tokenize a Swiss-formatted arithmetic expression. Returns null on any unrecognized character. */
function tokenize(cleaned: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < cleaned.length) {
    const ch = cleaned[i];
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/") {
      tokens.push({ kind: "op", value: ch });
      i++;
    } else if (ch === "(" || ch === ")") {
      tokens.push({ kind: "paren", value: ch });
      i++;
    } else if (/\d/.test(ch)) {
      let j = i + 1;
      while (j < cleaned.length && /[\d.]/.test(cleaned[j])) j++;
      const text = cleaned.slice(i, j);
      if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
      tokens.push({ kind: "num", value: Number(text) });
      i = j;
    } else {
      return null;
    }
  }
  return tokens;
}

/**
 * Recursive-descent parser/evaluator over the token stream. Grammar:
 *   expr   := term (('+' | '-') term)*
 *   term   := unary (('*' | '/') unary)*
 *   unary  := '-' unary | atom
 *   atom   := number | '(' expr ')'
 * Returns null on malformed input, non-finite results, or division by zero.
 */
function evaluateTokens(tokens: Token[]): number | null {
  let pos = 0;

  function peek(): Token | undefined {
    return tokens[pos];
  }

  function parseAtom(): number | null {
    const tok = peek();
    if (!tok) return null;
    if (tok.kind === "num") {
      pos++;
      return tok.value;
    }
    if (tok.kind === "paren" && tok.value === "(") {
      pos++;
      const value = parseExpr();
      if (value == null) return null;
      const close = peek();
      if (!close || close.kind !== "paren" || close.value !== ")") return null;
      pos++;
      return value;
    }
    return null;
  }

  function parseUnary(): number | null {
    const tok = peek();
    if (tok && tok.kind === "op" && tok.value === "-") {
      pos++;
      const value = parseUnary();
      return value == null ? null : -value;
    }
    if (tok && tok.kind === "op" && tok.value === "+") {
      pos++;
      return parseUnary();
    }
    return parseAtom();
  }

  function parseTerm(): number | null {
    let value = parseUnary();
    if (value == null) return null;
    for (;;) {
      const tok = peek();
      if (!tok || tok.kind !== "op" || (tok.value !== "*" && tok.value !== "/")) break;
      pos++;
      const rhs = parseUnary();
      if (rhs == null) return null;
      if (tok.value === "*") {
        value = value * rhs;
      } else {
        if (rhs === 0) return null;
        value = value / rhs;
      }
    }
    return value;
  }

  function parseExpr(): number | null {
    let value = parseTerm();
    if (value == null) return null;
    for (;;) {
      const tok = peek();
      if (!tok || tok.kind !== "op" || (tok.value !== "+" && tok.value !== "-")) break;
      pos++;
      const rhs = parseTerm();
      if (rhs == null) return null;
      value = tok.value === "+" ? value + rhs : value - rhs;
    }
    return value;
  }

  const result = parseExpr();
  if (result == null || pos !== tokens.length || !Number.isFinite(result)) return null;
  return result;
}

/**
 * Evaluate a money expression: a plain number or a small arithmetic
 * expression over Swiss-formatted numbers, e.g. "200+20", "1'200+50",
 * "3*33.30". Supports + - * / with standard precedence, optional
 * parentheses, unary minus, and apostrophe/space thousands separators.
 * Result is rounded to minor units the same way as `parseMoneyInput`.
 * Returns null for anything malformed, division by zero, or non-finite. A
 * plain number behaves exactly like `parseMoneyInput`.
 */
export function evaluateMoneyExpression(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const cleaned = trimmed.replace(/['\s]/g, "");
  if (!/^[-+*/().\d]+$/.test(cleaned)) return null;
  const tokens = tokenize(cleaned);
  if (!tokens || tokens.length === 0) return null;
  const result = evaluateTokens(tokens);
  if (result == null) return null;
  return Math.round(result * 100);
}

/**
 * Parse a holding quantity: a positive decimal, arbitrary precision (for
 * fractional shares). Accepts a comma as the decimal separator. Returns null
 * if unparseable or not strictly positive.
 */
export function parseQuantityInput(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (trimmed === "") return null;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value > 0 ? value : null;
}

/** Format a quantity for display, trimming trailing zeros beyond 2 decimals. */
export function formatQuantity(quantity: number): string {
  return quantity.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 6 });
}
