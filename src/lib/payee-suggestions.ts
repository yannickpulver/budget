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

/**
 * Same prefix-then-substring ranking as {@link filterPayeeSuggestions}, but
 * matched against the "Transfer: <Account>" label a transfer target is
 * displayed as (as well as the bare account name, so typing "checking"
 * still finds "Transfer: Checking"). An empty query returns every target —
 * unlike payee suggestions, this list is short and meant to be browsable.
 */
export function filterTransferTargets<T extends { name: string }>(
  targets: T[],
  query: string,
  limit = MAX_PAYEE_SUGGESTIONS
): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return targets.slice(0, limit);

  const prefix: T[] = [];
  const substring: T[] = [];
  for (const target of targets) {
    const label = `transfer: ${target.name}`.toLowerCase();
    const name = target.name.toLowerCase();
    if (label.startsWith(q) || name.startsWith(q)) prefix.push(target);
    else if (name.includes(q)) substring.push(target);
  }
  return [...prefix, ...substring].slice(0, limit);
}
