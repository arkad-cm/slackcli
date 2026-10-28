import { Command } from 'commander';
import ora from 'ora';
import { getAuthenticatedClient } from '../lib/auth.ts';
import { columnNamesOf, fetchListRecords, listIdOf } from '../lib/lists.ts';
import { formatListRecords, warning, writeJson, writeText } from '../lib/formatter.ts';
import { applyFields, fieldsOption, FIELDS_DESCRIPTION, FIELDS_FLAG } from '../lib/json-fields.ts';
import { workspaceMismatchWarning, workspaceOf } from '../lib/slack-url-parser.ts';
import type { SlackClient } from '../lib/slack-client.ts';
import { describeCommand, type CommandHelp } from '../lib/help.ts';
import { failCommand } from '../lib/command-errors.ts';
import { NotFoundError } from '../lib/cli-errors.ts';

// Both commands take the list the same way, so the note and the cell shape are written once.
const LIST_ARG_NOTE = '<list> accepts a list file ID (F...) or a Slack list URL (.../lists/<team>/<file>).';
const CELL_SHAPE = '{ column_id, key, value, text?, select?, user?, number?, date?, timestamp?, rich_text? }';

const HELP = {
  group: {
    summary: 'Read Slack lists and their records',
    description:
      'Read every record of a Slack list, or one record by its ID. ' +
      'A list is named by its file ID or by its list URL. Needs browser authentication.',
  },
  read: {
    summary: 'Read every record in a list',
    fields: 'each item of records',
    description:
      'Read every record of a Slack list, following each page. Text output prints one line per record. ' +
      'Columns show their column IDs, because lists read does not fetch the list schema. ' +
      'Use "lists record" for one record with its column names.',
    examples: [
      'slackcli lists read F0123456789',
      'slackcli lists read https://acme.slack.com/lists/T0123456789/F0123456789 --json --fields id,fields',
    ],
    json:
      '{ list_id, record_count, records: [{ id, list_id, fields: [' + CELL_SHAPE + '], ' +
      'date_created, updated_timestamp, ... }] }.',
    browserOnly: true,
    notes: [LIST_ARG_NOTE],
  },
  record: {
    summary: 'Read one record from a list',
    fields: 'the record',
    description:
      'Read one record of a Slack list by its record ID. Text output names the columns when Slack sends the schema. ' +
      'Get record IDs from "lists read".',
    examples: [
      'slackcli lists record F0123456789 Rec0123456789',
      'slackcli lists record https://acme.slack.com/lists/T0123456789/F0123456789 Rec0123456789 --json',
    ],
    json:
      '{ list_id, id, fields: [' + CELL_SHAPE + '], date_created, updated_timestamp, ... }, the record itself.',
    browserOnly: true,
    notes: [LIST_ARG_NOTE],
  },
} satisfies Record<string, CommandHelp>;

function warnOnWorkspaceMismatch(client: SlackClient, linkWorkspace: string | undefined): void {
  const message = workspaceMismatchWarning(linkWorkspace, client.workspaceHost);
  if (message) warning(message);
}

export function createListsCommand(): Command {
  const lists = describeCommand(new Command('lists'), HELP.group);

  describeCommand(lists.command('read'), HELP.read)
    .argument('<list>', 'List file ID or Slack list URL')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .option(FIELDS_FLAG, FIELDS_DESCRIPTION)
    .action(async (listArg, options) => {
      const spinner = ora('Fetching list records...').start();
      try {
        const fields = fieldsOption(options);
        const listId = listIdOf(listArg);
        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, workspaceOf(listArg));

        const records = await fetchListRecords(client, listId, {
          onProgress: (message) => { spinner.text = message; },
        });

        spinner.succeed(`Found ${records.length} records`);

        if (options.json) {
          writeJson(applyFields('lists read', { list_id: listId, record_count: records.length, records }, fields));
          return;                          // never process.exit() after writeJson
        }
        if (records.length > 0) writeText('\n' + formatListRecords(records));
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to read list' });
      }
    });

  describeCommand(lists.command('record'), HELP.record)
    .argument('<list>', 'List file ID or Slack list URL')
    .argument('<record-id>', 'Record ID from lists read')
    .option('--workspace <id|name>', 'Workspace to use')
    .option('--json', 'Output in JSON format', false)
    .option(FIELDS_FLAG, FIELDS_DESCRIPTION)
    .action(async (listArg, recordId, options) => {
      const spinner = ora('Fetching list record...').start();
      try {
        const fields = fieldsOption(options);
        const listId = listIdOf(listArg);
        const client = await getAuthenticatedClient(options.workspace);
        warnOnWorkspaceMismatch(client, workspaceOf(listArg));

        const response = await client.getListRecord(listId, recordId);
        const record = response.record;
        if (!record) throw new NotFoundError(`No record ${recordId} in that list`);

        spinner.succeed('Found record');

        if (options.json) {
          writeJson(applyFields('lists record', { list_id: listId, ...record }, fields));
          return;                          // never process.exit() after writeJson
        }
        writeText('\n' + formatListRecords([record], columnNamesOf(response.list?.list_metadata?.schema)));
      } catch (err: any) {
        failCommand(err, { json: options.json, spinner, context: 'Failed to read list record' });
      }
    });

  return lists;
}
