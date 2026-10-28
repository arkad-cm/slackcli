# Lists

Read Slack lists and their records from the terminal. Both commands are read only, and both need a browser login.

| Command | What it does |
|---|---|
| `slackcli lists read <list>` | Every record of a list, across all pages |
| `slackcli lists record <list> <record-id>` | One record, with its column names when Slack sends the list schema |

## Naming a list

`<list>` takes either form:

- The list file ID, which starts with `F`, for example `F0123456789`.
- The list's Slack URL, copied from Slack. It looks like `https://acme.slack.com/lists/T0123456789/F0123456789`. The CLI reads the file ID from it.

## Read every record

```bash
slackcli lists read F0123456789
slackcli lists read F0123456789 --json --fields id,fields
```

Text output prints one line per record. The line starts with the record ID, then each cell as `column: value`.

Columns show their column IDs in `lists read`, because that command does not fetch the list schema. Run `lists record` on one record to see column names.

## Read one record

```bash
slackcli lists record F0123456789 Rec0123456789
slackcli lists record F0123456789 Rec0123456789 --json
```

Get record IDs from `lists read`. Text output names each column from the list schema.

Select and person cells print the IDs that Slack sends. They do not print option labels or names yet.

## JSON output

`lists read --json` returns `list_id`, `record_count`, and `records`. Each record carries its `id`, `list_id`, `fields`, and timestamps. Each cell carries `column_id`, `key`, `value`, and a typed value such as `text` or `select`.

`lists record --json` returns the record's own keys, with `list_id` added.

Both commands take `--fields` to keep only some keys. See [scripting and JSON output](scripting.md).

## Notes

- Browser login only. A standard app token is refused before any request is sent.
- `lists read` follows every page of records. It stops after 100 pages as a safety bound.
- A list that Slack cannot find returns the `not_found` error code. A record that Slack cannot find (`record_not_found`) is not mapped yet, so it reports the `unknown` code.
