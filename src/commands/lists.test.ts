import { describe, expect, it } from 'bun:test';
import { helpOf } from '../lib/help.ts';
import { createListsCommand } from './lists.ts';

function subcommand(name: string) {
  return createListsCommand().commands.find((command) => command.name() === name);
}

function longOptions(name: string): string[] {
  return (subcommand(name)?.options ?? []).map((option) => option.long ?? '');
}

describe('lists command', () => {
  it('exposes read and record, each browser-only, with workspace, JSON and fields options', () => {
    for (const name of ['read', 'record']) {
      const command = subcommand(name);

      expect(command).toBeDefined();
      expect(longOptions(name)).toEqual(expect.arrayContaining(['--workspace', '--json', '--fields']));
      expect(helpOf(command!)?.browserOnly).toBe(true);
    }
  });

  it('takes the list, and on record also the record ID', () => {
    expect(subcommand('read')?.registeredArguments.map((arg) => arg.name())).toEqual(['list']);
    expect(subcommand('record')?.registeredArguments.map((arg) => arg.name())).toEqual(['list', 'record-id']);
  });
});
