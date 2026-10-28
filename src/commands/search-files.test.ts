// search files (#468), in process. The client is a real SlackClient whose
// transport is replaced, so the query sent, the paging params and the output
// are all checked at the one seam every Slack call goes through.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as authLib from '../lib/auth.ts';
import { formatTimestamp } from '../lib/formatter.ts';
import { SlackClient } from '../lib/slack-client.ts';
import type { WorkspaceConfig } from '../types/index.ts';
import { createSearchCommand } from './search.ts';

const BROWSER: WorkspaceConfig = {
  workspace_id: 'T0123456789',
  workspace_name: 'Acme Corp',
  workspace_url: 'https://acme.slack.com',
  profile: 'acme',
  auth_type: 'browser',
  xoxd_token: 'xoxd-fake',
  xoxc_token: 'xoxc-fake',
};

const FILES = [
  {
    id: 'F0123456789',
    name: 'report.pdf',
    title: 'Q3 report',
    filetype: 'pdf',
    user: 'U0123456789',
    username: 'alice',
    created: 1712345678,
    permalink: 'https://acme.slack.com/files/U0123456789/F0123456789/report.pdf',
  },
  {
    id: 'F0123456790',
    name: 'data.csv',
    title: 'data',
    filetype: 'csv',
    user: 'U0123456789',
    username: 'alice',
    created: 1712345700,
    permalink: 'https://acme.slack.com/files/U0123456789/F0123456790/data.csv',
  },
];

type Call = { method: string; params: Record<string, any> };

let calls: Call[];
let answer: Record<string, unknown>;
let stdout: string;
let stderr: string;
let savedExitCode: typeof process.exitCode;

function clientFor(): SlackClient {
  const client = new SlackClient(BROWSER);
  spyOn(client, 'request').mockImplementation(async (method: string, params: Record<string, any> = {}) => {
    calls.push({ method, params });
    return structuredClone(answer);
  });
  return client;
}

async function run(argv: string[]): Promise<void> {
  spyOn(authLib, 'getAuthenticatedClient').mockResolvedValue(clientFor());
  await createSearchCommand().parseAsync(['files', ...argv], { from: 'user' });
}

function pagedAnswer(page: number, pageCount: number, total: number, matches: unknown[]) {
  return { ok: true, files: { total, pagination: { page, page_count: pageCount }, matches } };
}

beforeEach(() => {
  calls = [];
  answer = pagedAnswer(1, 1, FILES.length, FILES);
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
});

afterEach(() => {
  mock.restore();
  process.exitCode = savedExitCode ?? 0;
});

describe('search files — query', () => {
  it('builds the query from --in and --from with no positional term', async () => {
    await run(['--in', 'finance', '--from', 'alice', '--json']);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('search.files');
    expect(calls[0].params.query).toBe('in:finance from:alice');
  });

  it('joins the positional term to the filters', async () => {
    await run(['report', '--in', 'finance', '--json']);
    expect(calls[0].params.query).toBe('report in:finance');
  });

  it('rejects a call with neither a query nor a filter before any Slack call', async () => {
    await run(['--json']);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stderr)).toMatchObject({ error: { code: 'invalid_input' } });
    expect(calls).toHaveLength(0);
  });

  it('treats a whitespace-only positional as empty', async () => {
    await run(['   ', '--json']);
    expect(process.exitCode).toBe(1);
    expect(JSON.parse(stderr)).toMatchObject({ error: { code: 'invalid_input' } });
    expect(calls).toHaveLength(0);
  });
});

describe('search files — --json shape', () => {
  it('prints { query, total, page, pages, files } with Slack\'s raw matches', async () => {
    await run(['report', '--json']);
    const out = JSON.parse(stdout);
    expect(Object.keys(out)).toEqual(['query', 'total', 'page', 'pages', 'files']);
    expect(out.query).toBe('report');
    expect(out.total).toBe(FILES.length);
    expect(out.page).toBe(1);
    expect(out.pages).toBe(1);
    expect(out.files).toEqual(FILES);
  });
});

describe('search files — --fields', () => {
  it('projects each file to the fields named and keeps the envelope', async () => {
    await run(['report', '--json', '--fields', 'id,name,permalink']);
    const out = JSON.parse(stdout);
    expect(Object.keys(out)).toEqual(['query', 'total', 'page', 'pages', 'files']);
    expect(out.files).toEqual(
      FILES.map(({ id, name, permalink }) => ({ id, name, permalink })),
    );
  });
});

describe('search files — paging', () => {
  it('sends count, page, sort and sort_dir to search.files', async () => {
    await run(['report', '--limit', '5', '--page', '3', '--sort', 'score', '--sort-dir', 'asc', '--json']);
    expect(calls[0].params).toEqual({
      query: 'report',
      count: 5,
      page: 3,
      sort: 'score',
      sort_dir: 'asc',
    });
  });

  it('reports Slack\'s page and page count under --json', async () => {
    answer = pagedAnswer(2, 4, 40, FILES);
    await run(['report', '--page', '2', '--json']);
    const out = JSON.parse(stdout);
    expect(out.total).toBe(40);
    expect(out.page).toBe(2);
    expect(out.pages).toBe(4);
  });

  it('prints the next-page hint in text output while more pages exist', async () => {
    answer = pagedAnswer(2, 4, 40, FILES);
    await run(['report', '--page', '2']);
    expect(stdout).toContain('Use --page 3 to see more.');
  });
});

describe('search files — text output', () => {
  it('prints one line per file with name, type, owner, date and permalink', async () => {
    await run(['report']);
    const lines = stdout.split('\n').filter((line) => line.includes('https://acme.slack.com/files/'));
    expect(lines).toHaveLength(FILES.length);
    FILES.forEach((file, i) => {
      expect(lines[i]).toContain(file.name);
      expect(lines[i]).toContain(file.filetype);
      expect(lines[i]).toContain(`@${file.username}`);
      expect(lines[i]).toContain(formatTimestamp(String(file.created)));
      expect(lines[i]).toContain(file.permalink);
    });
  });

  it('prints nothing on stdout when no file matches, even with --json', async () => {
    answer = pagedAnswer(1, 1, 0, []);
    await run(['nothing', '--json']);
    expect(stdout).toBe('');
    expect(process.exitCode).toBe(0);
  });
});
