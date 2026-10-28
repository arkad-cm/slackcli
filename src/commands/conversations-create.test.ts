// `conversations create` (#467), in process. The Slack client is a stub that
// records every call, in the same shape as the join cases in
// name-resolution.test.ts, so a test can prove which write was made and that a
// dry run made none.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Command } from 'commander';
import * as authLib from '../lib/auth.ts';
import { createConversationsCommand } from './conversations.ts';

type Call = { method: string; args: unknown[] };

// Slack's name errors: `name_taken` and the `invalid_name_*` family.
const NAME_ERRORS = [
  'name_taken',
  'invalid_name_required',
  'invalid_name_punctuation',
  'invalid_name_maxlength',
  'invalid_name_specials',
];

function recordingClient(createError?: string) {
  const calls: Call[] = [];
  const client = new Proxy({}, {
    get: (_target, prop) => {
      if (prop === 'then') return undefined;
      if (prop === 'workspaceHost') return 'acme.slack.com';
      if (prop === 'workspaceIdentity') return { id: 'T0123456789', name: 'Acme Corp' };
      return async (...args: unknown[]) => {
        calls.push({ method: String(prop), args });
        if (prop === 'createConversation') {
          if (createError) {
            throw Object.assign(new Error(`Slack API error: ${createError}`), {
              slackData: { ok: false, error: createError },
            });
          }
          const [name, isPrivate] = args as [string, boolean];
          return { ok: true, channel: { id: 'C0123456789', name, is_private: isPrivate } };
        }
        return { ok: true };
      };
    },
  });
  return { client, calls, methods: () => calls.map((c) => c.method) };
}

describe('conversations create, in process', () => {
  const realIsTTY = process.stdin.isTTY;
  let stdout: string;
  let stderr: string;
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    stdout = '';
    stderr = '';
    savedExitCode = process.exitCode;
    process.exitCode = 0;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
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
    Object.defineProperty(process.stdin, 'isTTY', { value: realIsTTY, configurable: true });
    process.exitCode = savedExitCode ?? 0;
  });

  async function run(argv: string[], stub = recordingClient()) {
    spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(stub.client as any);
    const parser: Command = createConversationsCommand();
    // Throw on a usage error instead of calling process.exit under the test runner.
    parser.exitOverride();
    await parser.parseAsync(['create', ...argv], { from: 'user' });
    return stub;
  }

  // The `--json` error line on stderr is the last line the command wrote.
  function lastError(): { code: string } {
    const line = stderr.trim().split('\n').pop() ?? '';
    return JSON.parse(line).error;
  }

  it('creates a public channel by default', async () => {
    const stub = await run(['test-channel']);
    expect(stub.calls.find((c) => c.method === 'createConversation')?.args).toEqual(['test-channel', false]);
  });

  it('creates a private channel with --private', async () => {
    const stub = await run(['test-private', '--private']);
    expect(stub.calls.find((c) => c.method === 'createConversation')?.args).toEqual(['test-private', true]);
  });

  it('prints a flat { channel_id, name, is_private } under --json', async () => {
    await run(['test-channel', '--json']);
    expect(JSON.parse(stdout)).toEqual({ channel_id: 'C0123456789', name: 'test-channel', is_private: false });
  });

  it('makes no write call under --dry-run and prints a preview', async () => {
    const stub = await run(['test-channel', '--dry-run', '--json']);
    expect(stub.calls).toEqual([]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ dry_run: true, action: 'create channel', payload: { name: 'test-channel', is_private: false } });
  });

  it.each(NAME_ERRORS)('maps Slack %s to invalid_input', async (code) => {
    await run(['test-channel', '--json'], recordingClient(code));
    expect(lastError().code).toBe('invalid_input');
    expect(process.exitCode).toBe(1);
  });
});
