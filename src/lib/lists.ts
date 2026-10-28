import type { SlackClient } from './slack-client.ts';
import type { SlackListColumn, SlackListRecord } from '../types/index.ts';
import { normalizeIdentifier } from './slack-url-parser.ts';

// A bound on the pages followed, so a cursor that never ends cannot loop forever.
// Same guard as the scheduled-messages walk.
export const LISTS_MAX_PAGES = 100;

/** A list is named by its file ID (F...) or by a Slack list URL that carries it. */
export function listIdOf(input: string): string {
  return normalizeIdentifier(input, 'file', '<list>');
}

/** Every record of a list, across pages. An empty or repeated next_cursor ends the walk. */
export async function fetchListRecords(
  client: Pick<SlackClient, 'listRecords'>,
  listId: string,
  options: { onProgress?: (message: string) => void } = {},
): Promise<SlackListRecord[]> {
  const records: SlackListRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < LISTS_MAX_PAGES; page++) {
    options.onProgress?.(`Fetching list records (${records.length} so far)...`);
    const response = await client.listRecords(listId, { cursor });
    records.push(...(response.records ?? []));
    const next = response.response_metadata?.next_cursor;
    if (!next || next === cursor) break;
    cursor = next;
  }
  return records;
}

/** Column ID -> column name, from the list schema when the response carries one. */
export function columnNamesOf(schema: SlackListColumn[] | undefined): Map<string, string> {
  const names = new Map<string, string>();
  for (const column of schema ?? []) {
    if (column.name) names.set(column.id, column.name);
  }
  return names;
}
