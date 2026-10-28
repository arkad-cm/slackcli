import { getLogger } from '@logtape/logtape';
import type { DraftSummary, ScheduledMessageSummary, SlackDraft, SlackDraftListResponse } from '../types/index.ts';
import type { SlackClient } from './slack-client.ts';
import { InvalidInputError, NotFoundError } from './cli-errors.ts';
import { parseMrkdwn } from './mrkdwn.ts';

const logger = getLogger(['slackcli', 'drafts']);

const POSITIVE_INTEGER = /^[1-9]\d*$/;

export function parseDraftLimit(value: string): number {
  if (!POSITIVE_INTEGER.test(value)) {
    throw new InvalidInputError('--limit must be a positive integer');
  }

  const limit = Number(value);
  if (!Number.isSafeInteger(limit)) {
    throw new RangeError('--limit must be a positive integer');
  }
  return limit;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringField(element: Record<string, unknown>, key: string): string | undefined {
  const value = element[key];
  return typeof value === 'string' ? value : undefined;
}

function wrapped(value: string | undefined, prefix: string, suffix = '>'): string | undefined {
  return value === undefined ? undefined : `${prefix}${value}${suffix}`;
}

// Leaf elements, rendered as Slack's own mrkdwn tokens. `undefined` means the
// element lacked the field it needs and falls through to the generic handling.
const LEAF_RENDERERS: Record<string, (element: Record<string, unknown>) => string | undefined> = {
  text: (element) => stringField(element, 'text') ?? '',
  emoji: (element) => wrapped(stringField(element, 'name'), ':', ':') ?? '',
  link: (element) => stringField(element, 'text') ?? stringField(element, 'url') ?? '',
  channel: (element) => wrapped(stringField(element, 'channel_id'), '<#'),
  user: (element) => wrapped(stringField(element, 'user_id'), '<@'),
  usergroup: (element) => wrapped(stringField(element, 'usergroup_id'), '<!subteam^'),
  broadcast: (element) => wrapped(stringField(element, 'range'), '<!'),
  date: (element) => stringField(element, 'fallback'),
};

function richTextValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(richTextValue).join('');

  const element = asRecord(value);
  if (!element) return '';

  const type = stringField(element, 'type') ?? '';
  const leaf = Object.hasOwn(LEAF_RENDERERS, type) ? LEAF_RENDERERS[type](element) : undefined;
  if (leaf !== undefined) return leaf;

  const children = Array.isArray(element.elements) ? element.elements : [];
  const separator = type === 'rich_text_list' ? '\n' : '';
  if (children.length > 0) return children.map(richTextValue).join(separator);

  // Preserve text from an unfamiliar element type rather than silently
  // dropping it if Slack extends the undocumented response shape.
  return stringField(element, 'text') ?? '';
}

export function extractDraftText(blocks: Array<Record<string, unknown>> = []): string {
  return blocks.map(richTextValue).filter(Boolean).join('\n');
}

export function projectDraft(draft: SlackDraft): DraftSummary {
  if (!draft.id) {
    throw new Error('Slack returned a draft without an id');
  }
  const destination = draft.destinations?.[0];
  if (!destination?.channel_id) {
    throw new Error(`Slack returned draft ${draft.id} without a channel destination`);
  }
  if (draft.date_created === undefined) {
    throw new Error(`Slack returned draft ${draft.id} without a creation date`);
  }

  return {
    draft_id: draft.id,
    channel_id: destination.channel_id,
    text: extractDraftText(draft.blocks),
    date_created: draft.date_created,
    file_ids: draft.file_ids ?? [],
    ...(destination.thread_ts ? { thread_ts: destination.thread_ts } : {}),
    ...(draft.date_scheduled && draft.date_scheduled > 0
      ? { date_scheduled: draft.date_scheduled }
      : {}),
  };
}

// A draft started in Slack's "New message" composer before a recipient was
// picked has no channel destination. There is nothing to show for it and
// send-draft refuses it, so it is skipped like deleted and sent drafts.
function hasChannelDestination(draft: SlackDraft): boolean {
  return Boolean(draft.destinations?.[0]?.channel_id);
}

export async function fetchDrafts(
  client: Pick<SlackClient, 'listDrafts'>,
  options: { limit: number; onProgress?: (message: string) => void },
): Promise<DraftSummary[]> {
  options.onProgress?.('Fetching active drafts...');
  const response = await client.listDrafts({ limit: options.limit });

  return (response.drafts ?? [])
    .filter((draft) => !draft.is_deleted && !draft.is_sent && hasChannelDestination(draft))
    .map(projectDraft)
    .slice(0, options.limit);
}

export interface SentDraftResult {
  channel_id: string;
  ts: string;
  permalink?: string;
  cleanup_error?: string;
}

export function findActiveDraft(response: SlackDraftListResponse, draftId: string): SlackDraft {
  const draft = response.drafts?.find((item) => item.id === draftId && !item.is_deleted && !item.is_sent);
  if (!draft) {
    throw new NotFoundError(`Active draft ${draftId} was not found`);
  }
  return draft;
}

export function validateSendableDraft(draft: SlackDraft): {
  channelId: string;
  threadTs?: string;
  text: string;
  blocks: Array<Record<string, unknown>>;
} {
  if (draft.date_scheduled && draft.date_scheduled > 0) {
    throw new InvalidInputError('Scheduled drafts cannot be sent with this command');
  }
  if (draft.file_ids?.length) {
    throw new InvalidInputError('Drafts with file attachments cannot be sent with this command');
  }
  if (draft.destinations?.length !== 1) {
    throw new InvalidInputError('Draft must have exactly one channel destination');
  }
  const destination = draft.destinations[0];
  const channelId = destination?.channel_id;
  if (!channelId) throw new InvalidInputError('Draft must have exactly one channel destination');
  if (destination.broadcast) {
    throw new InvalidInputError('Draft has unsupported destination options');
  }
  const blocks = draft.blocks ?? [];
  if (!blocks.length || blocks.some((block) => block.type !== 'rich_text')) {
    throw new InvalidInputError('Draft must contain supported rich-text blocks');
  }
  const text = extractDraftText(blocks);
  if (!text.trim()) {
    throw new InvalidInputError('Draft has no text to send');
  }
  return { channelId, threadTs: destination.thread_ts, text, blocks };
}

export async function loadActiveDraft(
  client: Pick<SlackClient, 'listDrafts'>,
  draftId: string,
): Promise<SlackDraft> {
  if (!draftId.trim()) throw new InvalidInputError('Draft ID cannot be empty');
  const response = await client.listDrafts({ limit: 1000 });
  try {
    return findActiveDraft(response, draftId);
  } catch (error) {
    if (response.has_more) {
      throw new NotFoundError(`Draft ${draftId} was not found in the first 1000 active drafts`);
    }
    throw error;
  }
}

export async function sendDraft(
  client: Pick<SlackClient, 'postMessage' | 'deleteDraft' | 'getPermalink'>,
  draftId: string,
  draft: SlackDraft,
): Promise<SentDraftResult> {
  const { channelId, threadTs, text, blocks } = validateSendableDraft(draft);
  const posted = await client.postMessage(channelId, text, { thread_ts: threadTs, blocks });
  if (typeof posted.ts !== 'string' || !posted.ts) {
    throw new Error('Slack posted the draft but returned no message timestamp; check the channel before retrying');
  }

  const result: SentDraftResult = { channel_id: channelId, ts: posted.ts };
  try {
    await client.deleteDraft(draftId);
  } catch (error) {
    result.cleanup_error = error instanceof Error ? error.message : String(error);
  }
  try {
    const link = await client.getPermalink(channelId, posted.ts);
    if (link?.permalink) result.permalink = link.permalink;
  } catch {
    // A failed link lookup cannot undo a delivered message.
  }
  return result;
}

// How many active drafts one drafts.list call asks for. Scheduled drafts are
// found among them, so a list that Slack cut short is logged.
const ACTIVE_DRAFT_LIMIT = 1000;

// Browser session tokens schedule a message as a draft with a send time (#474).
// drafts.create takes the time when Slack keeps it; otherwise drafts.update sets
// it. A draft whose time cannot be set is deleted before the error is thrown, so
// a failed schedule leaves no draft behind.
export async function scheduleDraft(
  client: Pick<SlackClient, 'createDraft' | 'updateDraft' | 'deleteDraft'>,
  input: { channel: string; text: string; postAt: number; thread_ts?: string; blocks?: unknown[] },
): Promise<{ scheduled_message_id: string; post_at: number }> {
  const blocks = input.blocks ?? parseMrkdwn(input.text);
  const created = await client.createDraft(input.channel, input.text, {
    thread_ts: input.thread_ts,
    blocks,
    date_scheduled: input.postAt,
  });
  const draftId: string | undefined = created.draft?.id;
  if (!draftId) throw new Error('Slack created a draft without an id, so nothing was scheduled');

  const kept: unknown = created.draft?.date_scheduled;
  if (typeof kept === 'number' && kept > 0) return { scheduled_message_id: draftId, post_at: kept };

  try {
    await client.updateDraft(draftId, input.channel, { thread_ts: input.thread_ts, blocks, date_scheduled: input.postAt });
  } catch (error) {
    try {
      await client.deleteDraft(draftId);
    } catch (cleanupError) {
      logger.warn('Could not delete draft {draft_id} after its schedule failed: {reason}', {
        draft_id: draftId,
        reason: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
    throw error;
  }
  return { scheduled_message_id: draftId, post_at: input.postAt };
}

// The scheduled drafts still ahead, soonest first, as list-scheduled prints them.
// Slack's drafts.list also returns drafts that are not scheduled, and drafts
// whose time has passed, so only the drafts with a future date_scheduled are kept.
export async function listScheduledDrafts(
  client: Pick<SlackClient, 'listDrafts'>,
  options: { channel?: string; limit?: number } = {},
): Promise<ScheduledMessageSummary[]> {
  const response = await client.listDrafts({ limit: ACTIVE_DRAFT_LIMIT });
  if (response.has_more) {
    logger.warn('drafts.list returned more than {limit} active drafts; scheduled drafts past them are not listed', {
      limit: ACTIVE_DRAFT_LIMIT,
    });
  }

  const now = Date.now() / 1000;
  const found = (response.drafts ?? [])
    .filter((draft) => !draft.is_deleted && !draft.is_sent && hasChannelDestination(draft))
    .filter((draft) => (draft.date_scheduled ?? 0) > now)
    .map((draft) => {
      const summary = projectDraft(draft);
      return {
        scheduled_message_id: summary.draft_id,
        channel_id: summary.channel_id,
        post_at: draft.date_scheduled ?? 0,
        date_created: summary.date_created,
        text: summary.text,
      };
    })
    .filter((message) => !options.channel || message.channel_id === options.channel)
    .sort((a, b) => a.post_at - b.post_at || a.scheduled_message_id.localeCompare(b.scheduled_message_id));
  return options.limit === undefined ? found : found.slice(0, options.limit);
}
