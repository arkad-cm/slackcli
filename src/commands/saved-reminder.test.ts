// `saved` writes on reminder rows of the Later list, named by --item-id: the
// exact change sent, the --json shape, and the flag combinations refused.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as authLib from '../lib/auth.ts';
import { addSavedReminder, REOPEN_REMINDER_UPDATE, updateSavedReminder } from '../lib/saved.ts';
import { createSavedCommand } from './saved.ts';

const ID = 'Sa0ABC123';
const DUE = 1791791400;
const description = (text: string) => [{
  type: 'rich_text',
  elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text }] }],
}];

// listedByLook: what each saved.list call answers in turn; the last one repeats.
function client(listedByLook: unknown[][] = [[]]) {
  const calls: Array<[string, unknown[]]> = [];
  let looks = 0;
  return {
    calls,
    stub: {
      authType: 'browser',
      workspaceHost: 'acme.slack.com',
      workspaceIdentity: { id: 'T1', name: 'acme' },
      requireBrowserAuth: () => {},
      updateSavedReminder: async (id: string, update: any) => {
        calls.push(['updateSavedReminder', [id, update]]);
        return { ok: true, item: { item_id: id, item_type: 'reminder', todo_state: update.todo_state ?? 'to_do', date_due: update.date_due ?? DUE } };
      },
      deleteSavedReminder: async (id: string) => {
        calls.push(['deleteSavedReminder', [id]]);
        return { ok: true };
      },
      addReminder: async (text: string, time: number) => {
        calls.push(['addReminder', [text, time]]);
        return { ok: true, reminder: { id: 'Rm1', text, time } };
      },
      listSavedItems: async () => {
        calls.push(['listSavedItems', []]);
        return { saved_items: listedByLook[Math.min(looks++, listedByLook.length - 1)] };
      },
    },
  };
}

describe('saved writes on reminders (command)', () => {
  let stdout: string;
  let stderr: string;
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    stdout = '';
    stderr = '';
    savedExitCode = process.exitCode;
    process.exitCode = 0;
    spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    }) as typeof process.stdout.write);
    spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write);
    spyOn(console, 'log').mockImplementation((...args: unknown[]) => { stdout += `${args.join(' ')}\n`; });
    spyOn(console, 'error').mockImplementation((...args: unknown[]) => { stderr += `${args.join(' ')}\n`; });
  });

  afterEach(() => {
    mock.restore();
    process.exitCode = savedExitCode ?? 0;
  });

  async function run(stub: unknown, argv: string[]) {
    spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(stub as any);
    await createSavedCommand().parseAsync(argv, { from: 'user' });
  }

  it.each([
    [['--due', String(DUE)], { date_due: DUE }],
    [['--no-due'], { date_due: 0 }],
    [['--state', 'saved'], { todo_state: 'saved', date_due: 0 }],
  ])('update --item-id %j sends %j', async (flags, update) => {
    const { stub, calls } = client();

    await run(stub, ['update', '--item-id', ID, ...flags, '--json']);

    expect(process.exitCode).toBe(0);
    expect(calls).toEqual([['updateSavedReminder', [ID, update]]]);
    expect(JSON.parse(stdout)).toMatchObject({ item_id: ID, date_due: update.date_due });
  });

  it('update --text sends the text as rich_text description', async () => {
    const { stub, calls } = client();

    await run(stub, ['update', '--item-id', ID, '--text', 'New words', '--json']);

    expect(process.exitCode).toBe(0);
    const [method, [id, update]] = calls[0] as [string, [string, { description: string }]];
    expect([method, id]).toEqual(['updateSavedReminder', ID]);
    expect(JSON.parse(update.description)).toEqual(description('New words'));
  });

  it.each([
    ['--text without --item-id', ['update', '--channel-id', 'C1', '--timestamp', '1.1', '--text', 'x']],
    ['--text with --due', ['update', '--item-id', ID, '--text', 'x', '--due', String(DUE)]],
    ['--text with --no-due', ['update', '--item-id', ID, '--text', 'x', '--no-due']],
    ['--text with --state', ['update', '--item-id', ID, '--text', 'x', '--state', 'saved']],
    ['empty --text', ['update', '--item-id', ID, '--text', '  ']],
    ['--item-id with --timestamp', ['complete', '--item-id', ID, '--timestamp', '1.1']],
    ['--item-id that is not a Later id', ['complete', '--item-id', 'C0123']],
  ])('refuses %s', async (_name, argv) => {
    const { stub, calls } = client();

    await run(stub, [...argv, '--json']);

    expect(process.exitCode).toBe(1);
    expect(calls).toEqual([]);
  });

  it('complete --item-id sends the completed change', async () => {
    const { stub, calls } = client();

    await run(stub, ['complete', '--item-id', ID, '--json']);

    // No date_due: a 0 here is what made the old date unrecoverable on reopen.
    expect(calls).toEqual([['updateSavedReminder', [ID, { mark: 'completed', todo_state: 'completed' }]]]);
    expect(JSON.parse(stdout)).toEqual({ item_id: ID, todo_state: 'completed', date_due: DUE });
  });

  it('reports no date, not "no due date", when Slack omits it on a change that sent none', async () => {
    const stub = {
      updateSavedReminder: async () => ({ ok: true, item: { todo_state: 'to_do' } }),
    };

    const result = await updateSavedReminder(stub as any, ID, REOPEN_REMINDER_UPDATE);

    expect('date_due' in result && result.date_due !== undefined).toBe(false);

    await run({ ...client().stub, ...stub }, ['reopen', '--item-id', ID]);

    expect(stdout).toContain('due date not reported');
    expect(stdout).not.toContain('no due date');
  });

  it('reopen --item-id sends no date, so the row keeps the one it has', async () => {
    const { stub, calls } = client();

    await run(stub, ['reopen', '--item-id', ID, '--json']);

    expect(calls).toEqual([['updateSavedReminder', [ID, { mark: 'uncompleted', todo_state: 'to_do' }]]]);
  });

  it('remove --item-id needs --yes, then deletes that row only', async () => {
    const refused = client();
    const savedTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      await run(refused.stub, ['remove', '--item-id', ID, '--json']);
    } finally {
      if (savedTty) Object.defineProperty(process.stdin, 'isTTY', savedTty);
      else delete (process.stdin as any).isTTY;
    }
    expect(process.exitCode).toBe(1);
    expect(refused.calls).toEqual([]);

    process.exitCode = 0;
    stdout = '';
    const allowed = client();
    await run(allowed.stub, ['remove', '--item-id', ID, '--yes', '--json']);
    expect(allowed.calls).toEqual([['deleteSavedReminder', [ID]]]);
    expect(JSON.parse(stdout)).toEqual({ item_id: ID, removed: true });
  });

  it('--dry-run makes no write', async () => {
    const { stub, calls } = client();

    await run(stub, ['complete', '--item-id', ID, '--dry-run', '--json']);

    expect(calls).toEqual([]);
    expect(JSON.parse(stdout)).toMatchObject({ dry_run: true, target: { kind: 'reminder', id: ID } });
  });

  it('add --text --due creates a reminder and reports its Later id', async () => {
    const old = { item_type: 'reminder', item_id: 'SaOLD', date_created: 1, description: description('Call back') };
    const { stub, calls } = client([
      [old],
      [old, { item_type: 'reminder', item_id: ID, date_created: 2, date_due: DUE + 5, todo_state: 'to_do', description: description('Call back') }],
    ]);

    await run(stub, ['add', '--text', 'Call back', '--due', String(DUE), '--json']);

    expect(process.exitCode).toBe(0);
    expect(calls).toEqual([['listSavedItems', []], ['addReminder', ['Call back', DUE]], ['listSavedItems', []]]);
    expect(JSON.parse(stdout)).toEqual({ item_id: ID, text: 'Call back', todo_state: 'to_do', date_due: DUE + 5 });
  });

  it('add --text refuses a message target', async () => {
    const { stub, calls } = client();

    await run(stub, ['add', '--text', 'x', '--channel-id', 'C1', '--timestamp', '1.1', '--json']);

    expect(process.exitCode).toBe(1);
    expect(calls).toEqual([]);
  });
});

describe('addSavedReminder: finding the row it made', () => {
  const row = (item_id: string, date_created: number) => ({
    item_type: 'reminder', item_id, date_created, date_due: DUE, todo_state: 'to_do', description: description('Call back'),
  });
  const noWait = async () => {};

  it('skips an older row with the same words while the new row lags', async () => {
    const { stub } = client([[row('SaOLD', 1)], [row('SaOLD', 1)], [row('SaOLD', 1), row('SaNEW', 2)]]);

    const result = await addSavedReminder(stub as any, 'Call back', DUE, noWait);

    expect(result.item_id).toBe('SaNEW');
  });

  it('skips an older row even when its date_created is the larger one', async () => {
    const { stub } = client([[row('SaOLD', 9)], [row('SaOLD', 9), row('SaNEW', 2)]]);

    const result = await addSavedReminder(stub as any, 'Call back', DUE, noWait);

    expect(result.item_id).toBe('SaNEW');
  });

  it('throws when only the older row ever shows', async () => {
    const { stub } = client([[row('SaOLD', 1)]]);

    await expect(addSavedReminder(stub as any, 'Call back', DUE, noWait)).rejects.toThrow('did not show');
  });

  it('creates nothing when the list cannot be read first', async () => {
    const { stub, calls } = client();
    stub.listSavedItems = async () => { throw new Error('list down'); };

    await expect(addSavedReminder(stub as any, 'Call back', DUE, noWait)).rejects.toThrow('list down');
    expect(calls).toEqual([]);
  });
});
