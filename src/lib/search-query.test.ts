import { describe, expect, it } from 'bun:test';
import { buildSearchQuery } from './search-query.ts';

// The query sent to Slack by `search messages` and `search files`: the
// positional term plus the --in / --from filters, each as an operator.
describe('buildSearchQuery', () => {
  it('returns the trimmed term when no filter is given', () => {
    expect(buildSearchQuery('  deploy  ', {})).toBe('deploy');
  });

  it('appends in: and from: after the term, in that order', () => {
    expect(buildSearchQuery('release', { in: 'engineering', from: 'alice' })).toBe(
      'release in:engineering from:alice',
    );
  });

  it('builds the query from the filters alone when the term is missing', () => {
    expect(buildSearchQuery(undefined, { from: 'alice' })).toBe('from:alice');
  });

  it('treats a whitespace-only term as empty', () => {
    expect(buildSearchQuery('   ', {})).toBe('');
    expect(buildSearchQuery('  ', { in: 'eng' })).toBe('in:eng');
  });

  it('returns an empty string when neither a term nor a filter is given', () => {
    expect(buildSearchQuery(undefined, {})).toBe('');
    expect(buildSearchQuery(undefined, { in: '', from: undefined })).toBe('');
  });
});
