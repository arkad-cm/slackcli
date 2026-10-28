import { describe, expect, it } from 'bun:test';
import {
  extractDraftText,
  fetchDrafts,
  findActiveDraft,
  listScheduledDrafts,
  loadActiveDraft,
  parseDraftLimit,
  projectDraft,
  scheduleDraft,
  sendDraft,
  validateSendableDraft,
} from './drafts.ts';
import type { SlackDraft, SlackDraftListResponse } from '../types/index.ts';

describe('parseDraftLimit', () => {
  it('accepts positive integers', () => {
    expect(parseDraftLimit('1')).toBe(1);
    expect(parseDraftLimit('100')).toBe(100);
  });

  it('rejects zero, negatives, decimals, trailing junk, and unsafe integers', () => {
    for (const value of ['0', '-1', '1.5', '10drafts', 'abc', '9007199254740992']) {
      expect(() => parseDraftLimit(value)).toThrow('--limit must be a positive integer');
    }
  });
});

describe('extractDraftText', () => {
  it('projects formatted text, emoji, links, and mentions without exposing raw blocks', () => {
    const text = extractDraftText([{
      type: 'rich_text',
      elements: [{
        type: 'rich_text_section',
        elements: [
          { type: 'text', text: 'Hello ' },
          { type: 'emoji', name: 'wave' },
          { type: 'text', text: ' — ' },
          { type: 'link', text: 'runbook', url: 'https://example.com/runbook' },
          { type: 'text', text: ' ' },
          { type: 'user', user_id: 'U123' },
          { type: 'text', text: ' in ' },
          { type: 'channel', channel_id: 'C123' },
          { type: 'text', text: ' ' },
          { type: 'usergroup', usergroup_id: 'S123' },
          { type: 'text', text: ' ' },
          { type: 'broadcast', range: 'here' },
        ],
      }],
    }]);

    expect(text).toBe(
      'Hello :wave: — runbook <@U123> in <#C123> <!subteam^S123> <!here>',
    );
  });

  it('uses a link URL without a label and separates list items and blocks with newlines', () => {
    const text = extractDraftText([
      {
        type: 'rich_text',
        elements: [{
          type: 'rich_text_list',
          elements: [
            { type: 'rich_text_section', elements: [{ type: 'text', text: 'First' }] },
            { type: 'rich_text_section', elements: [{ type: 'text', text: 'Second' }] },
          ],
        }],
      },
      {
        type: 'rich_text',
        elements: [{
          type: 'rich_text_section',
          elements: [{ type: 'link', url: 'https://example.com' }],
        }],
      },
    ]);

    expect(text).toBe('First\nSecond\nhttps://example.com');
  });

  it('keeps fallback text from date and unfamiliar future elements', () => {
    const text = extractDraftText([{
      type: 'rich_text',
      elements: [{
        type: 'rich_text_section',
        elements: [
          { type: 'date', fallback: 'Sep 21' },
          { type: 'future_element', text: ' preserved' },
        ],
      }],
    }]);

    expect(text).toBe('Sep 21 preserved');
  });

  it('degrades malformed leaf elements the same way as before, without throwing', () => {
    const text = extractDraftText([{
      type: 'rich_text',
      elements: [{
        type: 'rich_text_section',
        elements: [
          { type: 'text', text: 42 },
          { type: 'emoji', name: null },
          { type: 'link' },
          // Missing ids fall through to the element's own text.
          { type: 'channel', text: '#general' },
          { type: 'user', text: ' @someone' },
          { type: 'date', text: ' tomorrow' },
          // Type names that are Object.prototype keys are not renderers.
          { type: 'toString', text: ' kept' },
          { type: 'constructor' },
          'not an element',
          null,
        ],
      }],
    }]);

    expect(text).toBe('#general @someone tomorrow kept');
  });
});

describe('projectDraft', () => {
  it('produces the approved stable projection and omits unset optional fields', () => {
    expect(projectDraft({
      id: 'Dr123',
      date_created: 1700000000,
      date_scheduled: 0,
      destinations: [{ channel_id: 'C123' }],
      blocks: [{
        type: 'rich_text',
        elements: [{
          type: 'rich_text_section',
          elements: [{ type: 'text', text: 'Deploy later' }],
        }],
      }],
    })).toEqual({
      draft_id: 'Dr123',
      channel_id: 'C123',
      text: 'Deploy later',
      date_created: 1700000000,
      file_ids: [],
    });
  });

  it('includes thread, schedule, and file fields when present', () => {
    expect(projectDraft({
      id: 'Dr456',
      date_created: 1700000000,
      date_scheduled: 1700003600,
      destinations: [{ channel_id: 'C456', thread_ts: '1699999999.000100' }],
      file_ids: ['F1', 'F2'],
    })).toEqual({
      draft_id: 'Dr456',
      channel_id: 'C456',
      text: '',
      date_created: 1700000000,
      file_ids: ['F1', 'F2'],
      thread_ts: '1699999999.000100',
      date_scheduled: 1700003600,
    });
  });

  it('fails clearly when Slack omits a required projected field', () => {
    expect(() => projectDraft({
      date_created: 1700000000,
      destinations: [{ channel_id: 'C123' }],
    })).toThrow('without an id');
    expect(() => projectDraft({ id: 'Dr123', date_created: 1700000000 }))
      .toThrow('without a channel destination');
    expect(() => projectDraft({ id: 'Dr123', destinations: [{ channel_id: 'C123' }] }))
      .toThrow('without a creation date');
  });
});

describe('fetchDrafts', () => {
  it('passes the limit, filters inactive entries, projects fields, and reports progress', async () => {
    const calls: unknown[] = [];
    const progress: string[] = [];
    const response: SlackDraftListResponse = {
      ok: true,
      drafts: [
        {
          id: 'DrActive',
          date_created: 1700000000,
          destinations: [{ channel_id: 'C1' }],
          blocks: [],
        },
        {
          id: 'DrDeleted',
          date_created: 1700000001,
          destinations: [{ channel_id: 'C2' }],
          is_deleted: true,
        },
        {
          id: 'DrSent',
          date_created: 1700000002,
          destinations: [{ channel_id: 'C3' }],
          is_sent: true,
        },
      ],
    };
    const client = {
      listDrafts: async (options: { limit?: number }) => {
        calls.push(options);
        return response;
      },
    };

    const drafts = await fetchDrafts(client, {
      limit: 10,
      onProgress: (message) => progress.push(message),
    });

    expect(calls).toEqual([{ limit: 10 }]);
    expect(progress).toEqual(['Fetching active drafts...']);
    expect(drafts).toEqual([{
      draft_id: 'DrActive',
      channel_id: 'C1',
      text: '',
      date_created: 1700000000,
      file_ids: [],
    }]);
  });

  const listOf = (drafts: SlackDraftListResponse['drafts']) => ({
    listDrafts: async () => ({ ok: true, drafts }),
  });
  const active = (id: string, channel: string) => ({
    id,
    date_created: 1700000000,
    destinations: [{ channel_id: channel }],
  });

  it.each([
    ['no destinations', {}],
    ['an empty destinations array', { destinations: [] }],
    ['a destination with only user_ids', { destinations: [{ user_ids: ['U1'] }] }],
    ['an empty channel_id', { destinations: [{ channel_id: '' }] }],
  ])('skips a draft with %s and lists the others', async (_label, shape) => {
    const drafts = await fetchDrafts(listOf([
      active('DrBefore', 'C1'),
      { id: 'DrNoRecipient', date_created: 1700000001, ...shape } as SlackDraft,
      active('DrAfter', 'C2'),
    ]), { limit: 10 });

    expect(drafts.map((draft) => draft.draft_id)).toEqual(['DrBefore', 'DrAfter']);
  });

  it('applies the limit after skipping drafts with no recipient', async () => {
    const drafts = await fetchDrafts(listOf([
      { id: 'DrNoRecipient1', date_created: 1700000000 },
      active('Dr1', 'C1'),
      { id: 'DrNoRecipient2', date_created: 1700000000, destinations: [] },
      active('Dr2', 'C2'),
      active('Dr3', 'C3'),
    ]), { limit: 2 });

    expect(drafts.map((draft) => draft.draft_id)).toEqual(['Dr1', 'Dr2']);
  });

  it('still fails on a draft with a recipient but no id or creation date', async () => {
    await expect(fetchDrafts(listOf([
      active('Dr1', 'C1'),
      { destinations: [{ channel_id: 'C2' }], date_created: 1700000000 },
    ]), { limit: 10 })).rejects.toThrow('without an id');
    await expect(fetchDrafts(listOf([
      { id: 'DrUndated', destinations: [{ channel_id: 'C2' }] },
    ]), { limit: 10 })).rejects.toThrow('without a creation date');
  });

  it('returns an empty list when every active draft has no recipient', async () => {
    expect(await fetchDrafts(listOf([{ id: 'DrNoRecipient', date_created: 1700000000 }]), { limit: 10 }))
      .toEqual([]);
  });
});

const sendableDraft = {
  id: 'Dr123',
  destinations: [{ channel_id: 'C123', thread_ts: '1700000000.000001' }],
  blocks: [{
    type: 'rich_text',
    elements: [{
      type: 'rich_text_section',
      elements: [{ type: 'text', text: 'Reviewed *reply*', style: { bold: true } }],
    }],
  }],
};

describe('draft lifecycle', () => {
  it('finds only a matching active draft', () => {
    const response: SlackDraftListResponse = {
      ok: true,
      drafts: [{ ...sendableDraft, is_deleted: true }, { id: 'DrOther' }],
    };
    expect(() => findActiveDraft(response, 'Dr123')).toThrow('was not found');
    expect(findActiveDraft({ ok: true, drafts: [sendableDraft] }, 'Dr123')).toEqual(sendableDraft);
  });

  it('loads a requested draft and reports a truncated listing', async () => {
    const client = { listDrafts: async () => ({ ok: true, drafts: [], has_more: true }) };
    await expect(loadActiveDraft(client, 'DrMissing')).rejects.toThrow('first 1000 active drafts');
    await expect(loadActiveDraft(client, ' ')).rejects.toThrow('cannot be empty');
  });

  it('refuses scheduled, attached, multiple-destination, and empty drafts', () => {
    expect(() => validateSendableDraft({ ...sendableDraft, date_scheduled: 1700000100 }))
      .toThrow('Scheduled drafts');
    expect(() => validateSendableDraft({ ...sendableDraft, file_ids: ['F1'] }))
      .toThrow('file attachments');
    expect(() => validateSendableDraft({ ...sendableDraft, destinations: [{ channel_id: 'C1' }, { channel_id: 'C2' }] }))
      .toThrow('exactly one');
    expect(() => validateSendableDraft({ ...sendableDraft, blocks: [] }))
      .toThrow('supported rich-text');
    expect(() => validateSendableDraft({ ...sendableDraft, blocks: [{ type: 'rich_text', elements: [] }] }))
      .toThrow('no text');
  });

  it('accepts a DM destination carrying its recipient user id', () => {
    expect(validateSendableDraft({
      ...sendableDraft,
      destinations: [{ channel_id: 'D123', user_ids: ['U123'] }],
    }).channelId).toBe('D123');
  });

  it('posts the original blocks in the saved thread, then deletes and gets a link', async () => {
    const calls: unknown[] = [];
    const client = {
      postMessage: async (channel: string, text: string, options: unknown) => {
        calls.push(['post', channel, text, options]);
        return { ts: '1700000001.000002' };
      },
      deleteDraft: async (id: string) => { calls.push(['delete', id]); },
      getPermalink: async (channel: string, ts: string) => {
        calls.push(['link', channel, ts]);
        return { permalink: 'https://example.slack.com/archives/C123/p1700000001000002' };
      },
    };
    expect(await sendDraft(client, 'Dr123', sendableDraft)).toEqual({
      channel_id: 'C123', ts: '1700000001.000002',
      permalink: 'https://example.slack.com/archives/C123/p1700000001000002',
    });
    expect(calls).toEqual([
      ['post', 'C123', 'Reviewed *reply*', { thread_ts: '1700000000.000001', blocks: sendableDraft.blocks }],
      ['delete', 'Dr123'],
      ['link', 'C123', '1700000001.000002'],
    ]);
  });

  it('leaves the draft untouched when posting fails', async () => {
    let deleted = false;
    const client = {
      postMessage: async () => { throw new Error('post failed'); },
      deleteDraft: async () => { deleted = true; },
      getPermalink: async () => ({}),
    };
    await expect(sendDraft(client, 'Dr123', sendableDraft)).rejects.toThrow('post failed');
    expect(deleted).toBe(false);
  });

  it('returns the posted identity when cleanup fails, without inviting a duplicate retry', async () => {
    const client = {
      postMessage: async () => ({ ts: '1700000001.000002' }),
      deleteDraft: async () => { throw new Error('draft_has_conflict'); },
      getPermalink: async () => { throw new Error('link unavailable'); },
    };
    expect(await sendDraft(client, 'Dr123', sendableDraft)).toEqual({
      channel_id: 'C123', ts: '1700000001.000002', cleanup_error: 'draft_has_conflict',
    });
  });
});

describe('scheduleDraft (#474)', () => {
  const POST_AT = 1791791400;
  const input = { channel: 'C123', text: 'Standup', postAt: POST_AT, thread_ts: '1712345678.000100' };

  // A client whose draft calls answer as given and record what they were called with.
  function draftClient(created: unknown, failures: { update?: Error; remove?: Error } = {}) {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const client = {
      createDraft: async (...args: unknown[]) => { calls.push({ method: 'createDraft', args }); return created; },
      updateDraft: async (...args: unknown[]) => {
        calls.push({ method: 'updateDraft', args });
        if (failures.update) throw failures.update;
        return { ok: true };
      },
      deleteDraft: async (...args: unknown[]) => {
        calls.push({ method: 'deleteDraft', args });
        if (failures.remove) throw failures.remove;
      },
    };
    return { client: client as unknown as Parameters<typeof scheduleDraft>[0], calls };
  }

  it('keeps the draft when drafts.create takes the schedule', async () => {
    const { client, calls } = draftClient({ ok: true, draft: { id: 'Dr1', date_scheduled: POST_AT } });

    expect(await scheduleDraft(client, input)).toEqual({ scheduled_message_id: 'Dr1', post_at: POST_AT });
    expect(calls.map((call) => call.method)).toEqual(['createDraft']);
    expect(calls[0].args[2]).toMatchObject({ thread_ts: '1712345678.000100', date_scheduled: POST_AT });
  });

  it('sets the schedule with drafts.update when drafts.create leaves it off', async () => {
    const { client, calls } = draftClient({ ok: true, draft: { id: 'Dr2' } });

    expect(await scheduleDraft(client, input)).toEqual({ scheduled_message_id: 'Dr2', post_at: POST_AT });
    expect(calls.map((call) => call.method)).toEqual(['createDraft', 'updateDraft']);
    expect(calls[1].args).toEqual(['Dr2', 'C123', expect.objectContaining({ thread_ts: '1712345678.000100', date_scheduled: POST_AT })]);
  });

  it('deletes the draft and throws the update error when the schedule cannot be set', async () => {
    const { client, calls } = draftClient(
      { ok: true, draft: { id: 'Dr3' } },
      { update: new Error('Slack API error: invalid_arguments') },
    );

    await expect(scheduleDraft(client, input)).rejects.toThrow('Slack API error: invalid_arguments');
    expect(calls.map((call) => call.method)).toEqual(['createDraft', 'updateDraft', 'deleteDraft']);
    expect(calls[2].args).toEqual(['Dr3']);
  });

  it('still throws the update error when the cleanup delete fails too', async () => {
    const { client } = draftClient(
      { ok: true, draft: { id: 'Dr4' } },
      { update: new Error('update failed'), remove: new Error('delete failed') },
    );

    await expect(scheduleDraft(client, input)).rejects.toThrow('update failed');
  });

  it('throws when drafts.create returns no draft ID, and deletes nothing', async () => {
    const { client, calls } = draftClient({ ok: true });

    await expect(scheduleDraft(client, input)).rejects.toThrow('without an id');
    expect(calls.map((call) => call.method)).toEqual(['createDraft']);
  });
});

describe('listScheduledDrafts (#474)', () => {
  // Times are relative to now: a fixed one would fall into the past.
  const NOW = Math.floor(Date.now() / 1000);
  const draft = (id: string, dateScheduled: number, extra: Partial<SlackDraft> = {}): SlackDraft => ({
    id,
    date_created: NOW - 100,
    date_scheduled: dateScheduled,
    file_ids: [],
    destinations: [{ channel_id: 'C123' }],
    blocks: [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: `text of ${id}` }] }] }],
    ...extra,
  });
  const clientWith = (drafts: SlackDraft[], asked: unknown[] = []) => ({
    listDrafts: async (options: unknown) => {
      asked.push(options);
      return { ok: true, drafts } as SlackDraftListResponse;
    },
  }) as unknown as Parameters<typeof listScheduledDrafts>[0];

  it('keeps the drafts with a future send time, soonest first, as scheduled messages', async () => {
    const found = await listScheduledDrafts(clientWith([
      draft('Dr2', NOW + 7200),
      draft('Dr1', NOW + 3600),
      draft('DrPast', NOW - 60),
      draft('DrNone', 0),
      draft('DrDeleted', NOW + 60, { is_deleted: true }),
      draft('DrSent', NOW + 60, { is_sent: true }),
      draft('DrNoChannel', NOW + 60, { destinations: [] }),
    ]));

    expect(found).toEqual([
      { scheduled_message_id: 'Dr1', channel_id: 'C123', post_at: NOW + 3600, date_created: NOW - 100, text: 'text of Dr1' },
      { scheduled_message_id: 'Dr2', channel_id: 'C123', post_at: NOW + 7200, date_created: NOW - 100, text: 'text of Dr2' },
    ]);
  });

  it('filters by channel, then applies the limit, and asks Slack for up to 1000 drafts', async () => {
    const asked: unknown[] = [];
    const found = await listScheduledDrafts(clientWith([
      draft('Dr2', NOW + 20),
      draft('DrOther', NOW + 5, { destinations: [{ channel_id: 'C999' }] }),
      draft('Dr1', NOW + 10),
    ], asked), { channel: 'C123', limit: 1 });

    expect(asked).toEqual([{ limit: 1000 }]);
    expect(found.map((message) => message.scheduled_message_id)).toEqual(['Dr1']);
  });
});
