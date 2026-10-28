// The Slack query for `search messages` and `search files`: the positional
// term plus the --in / --from filters, each appended as a search operator.

export interface SearchFilters {
  in?: string;
  from?: string;
}

/**
 * Build the query sent to Slack. The term is optional when a filter is given,
 * so a search specified entirely by filters is a complete query. A
 * whitespace-only term counts as empty. Returns '' when neither is given.
 */
export function buildSearchQuery(term: string | undefined, filters: SearchFilters): string {
  const parts: string[] = [];
  const trimmed = term?.trim();
  if (trimmed) parts.push(trimmed);
  if (filters.in) parts.push(`in:${filters.in}`);
  if (filters.from) parts.push(`from:${filters.from}`);
  return parts.join(' ');
}
