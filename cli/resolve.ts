/** Name lookup for accounts and categories given a user-typed query. */

export type Named = { name: string; qualifiedName?: string };

/** The names an item can be matched by: its own name plus, for categories, "Group/Category". */
function candidateNames(item: Named): string[] {
  return item.qualifiedName ? [item.name, item.qualifiedName] : [item.name];
}

/**
 * Resolve `query` against `items`, case-insensitively: an exact name match wins,
 * otherwise a single substring match does. Throws when nothing or several things match.
 */
export function resolveName<T extends Named>(items: T[], query: string, kind: string): T {
  const needle = query.trim().toLowerCase();
  const matching = (predicate: (name: string) => boolean) =>
    items.filter((item) => candidateNames(item).some((name) => predicate(name.toLowerCase())));

  const exact = matching((name) => name === needle);
  const matches = exact.length > 0 ? exact : matching((name) => name.includes(needle));

  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`No ${kind} matches "${query}"`);
  const candidates = matches.map((item) => item.qualifiedName ?? item.name).join(", ");
  throw new Error(`Several ${kind} matches for "${query}": ${candidates}`);
}
