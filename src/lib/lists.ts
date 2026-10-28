import type { SlackClient } from './slack-client.ts';
import type { ListCellUpdate, SlackListColumn, SlackListRecord } from '../types/index.ts';
import { normalizeIdentifier } from './slack-url-parser.ts';
import { InvalidInputError } from './cli-errors.ts';

// The cell types `lists edit-cell --type` accepts. Each one maps to the typed
// key Slack's web client sends for that column type.
export const LIST_CELL_TYPES = ['text', 'checkbox', 'people', 'date', 'number'] as const;
export type ListCellType = (typeof LIST_CELL_TYPES)[number];

/**
 * One cell of a lists.cells.update call, built from the user's raw value. Each
 * type checks its value first, so a bad value fails before any request.
 * `people` takes comma-separated user IDs; `date` takes YYYY-MM-DD.
 */
export function listCellUpdateOf(rowId: string, columnId: string, type: string, value: string): ListCellUpdate {
  const cell = { row_id: rowId, column_id: columnId };
  switch (type) {
    case 'text':
      return {
        ...cell,
        rich_text: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: value }] }] }],
      };
    case 'checkbox':
      if (value !== 'true' && value !== 'false') {
        throw new InvalidInputError('A checkbox cell takes "true" or "false".');
      }
      return { ...cell, checkbox: value === 'true' };
    case 'people': {
      const users = value.split(',').map((id) => id.trim()).filter(Boolean);
      if (users.length === 0 || users.some((id) => !/^[UW][A-Z0-9]+$/.test(id))) {
        throw new InvalidInputError('A people cell takes one or more user IDs (U... or W...), separated by commas.');
      }
      return { ...cell, user: users };
    }
    case 'date': {
      const day = new Date(`${value}T00:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value) {
        throw new InvalidInputError('A date cell takes a real date as YYYY-MM-DD.');
      }
      return { ...cell, date: [value] };
    }
    case 'number': {
      const number = value.trim() === '' ? Number.NaN : Number(value);
      if (!Number.isFinite(number)) throw new InvalidInputError('A number cell takes a finite number.');
      return { ...cell, number: [number] };
    }
    default:
      throw new InvalidInputError(`Unknown cell type "${type}". Use one of: ${LIST_CELL_TYPES.join(', ')}.`);
  }
}

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
