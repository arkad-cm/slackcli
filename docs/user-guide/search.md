# Search Slack messages, files, channels and people

`slackcli search` covers messages, files, channels, and people. Every subcommand
accepts `--workspace <id|name>` and `--json`; with `--json`, [`--fields`](scripting.md#keeping-output-small---fields-and---limit)
trims each result to the fields you name (`--fields ts,user,text,channel.name,permalink`).

## `search messages`

```bash
slackcli search messages "deployment failed"
slackcli search messages "release" --in=engineering --from=rafael
slackcli search messages "incident" --limit=50 --sort=score
slackcli search messages "after:2026-07-01 has:link" --json
slackcli search messages --from=rafael --sort=timestamp --limit=1
```

| Option | Default | Purpose |
|---|---|---|
| `--in <channel>` | — | Shorthand for the `in:` operator |
| `--from <user>` | — | Shorthand for the `from:` operator |
| `--limit <number>` | `20` | Results per page |
| `--page <number>` | `1` | Which page |
| `--sort <field>` | `timestamp` | `score` or `timestamp` |
| `--sort-dir <dir>` | `desc` | `asc` or `desc` |

The query is passed to Slack, so all of its
[search operators](https://slack.com/help/articles/202528808-Search-in-Slack)
work: `in:`, `from:`, `before:`, `after:`, `on:`, `during:`, `has:`, `is:`,
`with:`. `--in` and `--from` are just conveniences appended to the query.

The positional query is optional when at least one of `--in`/`--from` is given,
so you can search by filter alone (`search messages --from=rafael`). A call with
neither a query nor a filter fails with `invalid_input`.

When more pages exist, the next-page command is printed. In `--json` mode the
`page` and `pages` fields carry the same information. The JSON `query` field is
the full query sent to Slack, including any `in:`/`from:` operators appended from
`--in`/`--from`.

In all three subcommands, a search with no results prints nothing on stdout,
even with `--json`, and exits 0.

Standard bot tokens (`xoxb-*`) cannot call `search.messages` at all — Slack
restricts it to user tokens. Use a `xoxp-*` token or browser auth.

## `search files`

```bash
slackcli search files "quarterly report"
slackcli search files "budget" --in=finance --from=rafael --sort=score
slackcli search files report --json --fields id,name,permalink
```

Takes the same options as `search messages` (`--in`, `--from`, `--limit`, `--page`,
`--sort`, `--sort-dir`), and the same query rules: the positional query is optional
when `--in` or `--from` is given, and a call with neither fails with `invalid_input`.
The query goes to Slack's `search.files`, so the operators work as they do for messages.

Each file prints on one line with its name, type, owner, date and permalink. With
`--json`, the output is `{ query, total, page, pages, files: [...] }`, where `files`
holds Slack's raw search matches. Use the `id` of a match with `files info`,
`files read` or `files download`.

A bot token (`xoxb-*`) is refused, as with `search messages`. Use a `xoxp-*` token or
browser auth.

## `search channels`

```bash
slackcli search channels platform
slackcli search channels incident --limit=50 --json
```

With **browser auth** this calls Slack's own search backend (`search.modules`),
which ranks the results; `total` is Slack's match count and can exceed the
channels returned. With a **standard token** there is no equivalent API, so
SlackCLI lists up to 1000 non-archived channels the token can see (one
`conversations.list` call) and keeps those whose name, topic, or purpose
contains the query (case-insensitive) — correct, but slower on large
workspaces, capped at that 1000, and `total` is just the number returned.

## `search people`

```bash
slackcli search people rafael
slackcli search people "@example.com" --limit=50
slackcli search people rafael --resolve-fields --json
```

The same auth-type split applies: browser auth uses Slack's search backend
(`search.modules`); standard auth lists the first 1000 users (one `users.list`
call) and keeps those whose username, real name, display name, or email
contains the query (case-insensitive), skipping deactivated accounts and bots.

`--resolve-fields` labels each result's custom profile fields (`Xf…` ID →
human label) via one cached `team.profile.get` call — the same shared resolver
used by [`users info` and `users list`](users.md#--resolve-fields). Labels only:
field values that are user IDs (Manager, Direct Reports) stay as `U…` IDs.
