export const MAX_PAYEE_SUGGESTIONS = 8;

/**
 * Case-insensitive substring filter over pre-ranked payees. Prefix matches rank
 * ahead of mid-string matches; each bucket keeps the incoming (frequency/recency)
 * order. The exact current value is dropped so a fully-typed payee shows no list.
 * Pure so it can be unit-tested on its own.
 */
export function filterPayeeSuggestions(
  suggestions: string[],
  query: string,
  limit = MAX_PAYEE_SUGGESTIONS
): string[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];

  const prefix: string[] = [];
  const substring: string[] = [];
  for (const payee of suggestions) {
    const lower = payee.toLowerCase();
    if (lower === q) continue;
    const idx = lower.indexOf(q);
    if (idx === 0) prefix.push(payee);
    else if (idx > 0) substring.push(payee);
  }
  return [...prefix, ...substring].slice(0, limit);
}
