import { describe, expect, it } from 'bun:test';
import { columnNamesOf, fetchListRecords, LISTS_MAX_PAGES, listIdOf } from './lists.ts';
import { formatListRecords } from './formatter.ts';
import { applyFields, fieldsOption } from './json-fields.ts';
import type { SlackClient } from './slack-client.ts';
import type { SlackListRecord, SlackListRecordsResponse } from '../types/index.ts';

describe('listIdOf', () => {
  it('accepts a list file ID as-is', () => {
    expect(listIdOf('F0123456789')).toBe('F0123456789');
  });

  it('extracts the list file ID from a list URL, the same as the ID form', () => {
    expect(listIdOf('https://acme.slack.com/lists/T0123456789/F0123456789')).toBe('F0123456789');
  });

  it('rejects a channel ID and a list URL that names no file', () => {
    expect(() => listIdOf('C0123456789')).toThrow();
    expect(() => listIdOf('https://acme.slack.com/lists/T0123456789')).toThrow('could not read an ID');
  });
});

describe('fetchListRecords', () => {
  it('follows next_cursor until it is empty, passing each cursor and reporting progress', async () => {
    const calls: Array<string | undefined> = [];
    const progress: string[] = [];
    const pages: SlackListRecordsResponse[] = [
      { ok: true, records: [{ id: 'Rec1' }], response_metadata: { next_cursor: 'page-2' } },
      { ok: true, records: [{ id: 'Rec2' }], response_metadata: { next_cursor: '' } },
    ];
    const client: Pick<SlackClient, 'listRecords'> = {
      listRecords: async (listId, options = {}) => {
        expect(listId).toBe('F0123456789');
        calls.push(options.cursor);
        return pages[calls.length - 1];
      },
    };

    const records = await fetchListRecords(client, 'F0123456789', { onProgress: (message) => progress.push(message) });

    expect(calls).toEqual([undefined, 'page-2']);
    expect(records.map((record) => record.id)).toEqual(['Rec1', 'Rec2']);
    expect(progress).toHaveLength(2);
  });

  it('stops when a page returns the cursor it was asked for', async () => {
    const client: Pick<SlackClient, 'listRecords'> = {
      listRecords: async () => ({
        ok: true,
        records: [{ id: 'RecLoop' }],
        response_metadata: { next_cursor: 'same' },
      }),
    };

    const records = await fetchListRecords(client, 'F0123456789');

    expect(records).toHaveLength(2);
  });

  it('stops at the page bound when every page brings a new cursor', async () => {
    let page = 0;
    const client: Pick<SlackClient, 'listRecords'> = {
      listRecords: async () => {
        page += 1;
        return { ok: true, records: [{ id: `Rec${page}` }], response_metadata: { next_cursor: `c${page}` } };
      },
    };

    const records = await fetchListRecords(client, 'F0123456789');

    expect(records).toHaveLength(LISTS_MAX_PAGES);
  });
});

describe('columnNamesOf', () => {
  it('maps column IDs to names from the list schema', () => {
    const names = columnNamesOf([
      { id: 'Col1', name: 'Task', type: 'text' },
      { id: 'Col2', name: 'Owner', type: 'user' },
    ]);

    expect(names.get('Col1')).toBe('Task');
    expect(names.get('Col2')).toBe('Owner');
  });

  it('is empty when the response carries no schema', () => {
    expect(columnNamesOf(undefined).size).toBe(0);
  });
});

describe('formatListRecords', () => {
  const records: SlackListRecord[] = [
    {
      id: 'Rec1',
      fields: [
        { column_id: 'Col1', text: 'Ship it' },
        { column_id: 'Col2', user: ['U0123456789'] },
        { column_id: 'Col3', select: ['Opt1', 'Opt2'] },
        { column_id: 'Col4', number: [3] },
      ],
    },
    { id: 'Rec2' },
  ];

  it('prints one line per record, naming columns where known and showing the ID otherwise', () => {
    const lines = formatListRecords(records, new Map([['Col1', 'Task']])).split('\n');

    expect(lines).toEqual([
      'Rec1  Task: Ship it | Col2: U0123456789 | Col3: Opt1, Opt2 | Col4: 3',
      'Rec2',
    ]);
  });
});

describe('list JSON and --fields', () => {
  it('projects --fields over each record of the read envelope', () => {
    const payload = {
      list_id: 'F0123456789',
      record_count: 1,
      records: [{ id: 'Rec1', list_id: 'F0123456789', fields: [{ column_id: 'Col1', text: 'x' }] }],
    };

    expect(applyFields('lists read', payload, fieldsOption({ fields: 'id', json: true }))).toEqual({
      list_id: 'F0123456789',
      record_count: 1,
      records: [{ id: 'Rec1' }],
    });
  });

  it('projects --fields over the single record of the record envelope', () => {
    const payload = { list_id: 'F0123456789', id: 'Rec1', date_created: 1700000000, fields: [] };

    expect(applyFields('lists record', payload, fieldsOption({ fields: 'id,date_created', json: true })))
      .toEqual({ id: 'Rec1', date_created: 1700000000 });
  });
});
