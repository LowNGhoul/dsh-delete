# dsh-session-admin

Permanently delete a conversation from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

dsh ships an archive action, which hides a session from the sidebar and leaves
every byte on disk. This plugin removes the session instead: the append-only log,
its projection checkpoint, its membership in the workspace registry, and its
entry in the archive list. There is no undo.

## Install

```sh
dsh plugin --profile web add /absolute/path/to/dsh-session-admin
```

Restart the profile afterwards. The command appends the package to the profile's
bundle list, which is what loads the plugin's composition patch.

From a checkout there is also `./install.sh`, which runs the test suite, prints
what the store currently holds, and then performs the same install.
`./install.sh web --uninstall` reverses it.

The CLI works without any installation:

```sh
node lib/cli.js list --dsh-home ~/.dsh
```

## Use it

**From the GUI.** Open the conversation and press the trash icon in the
conversation header, next to the other session actions. The dialog lists the
title, project, stored size, how many artifacts will go, and which workspace
rows the conversation belongs to. Nothing is removed until you press
**Delete permanently**.

**From the command line, inside a conversation.**

```
/delete                  # the session you are reading, if it is not the live one
/delete <session-id>     # any stored session
```

**From a shell, with no dsh process running.**

```sh
npx dsh-session-admin list
npx dsh-session-admin inspect <session-id>
npx dsh-session-admin delete <session-id> --yes
```

## What actually gets removed

A dsh session is more than one file. Deleting only the log leaves a ghost row in
the sidebar, so a real deletion covers all of these:

| Artifact | Default location |
| --- | --- |
| Session log (every format generation) | `$DSH_HOME/sessions/--<project>--/<id>/session.v<N>.jsonl[.zstd]` |
| Projection checkpoint (sidebar title, stats, todos) | `$DSH_HOME/storages/session_projcache/sessions/<id>.json` |
| Workspace membership | `$DSH_HOME/storages/workspace.json` → `tables.workspaces[*].sessionIds` |
| Archive flag | `$DSH_HOME/storages/workspace.json` → `global.archivedSessionIds` |

Two things are deliberately kept:

**Attachments.** `$DSH_HOME/attachments/v1` stores images and files by content
hash. The same bytes are shared by every session that ever attached them, so a
per-session deletion cannot own them. The confirmation dialog reports how many a
session referenced and leaves the bytes in place.

**The session you are currently in.** A live session's agent holds an open write
handle on its log; removing the file underneath it would lose whatever it writes
next. The dialog offers to queue the deletion instead, and it completes the
moment you switch to another conversation. The CLI has no such limitation
because it runs in its own process.

The session directory is removed as a unit, so `session.lock`, older format
generations, and migration staging files inside it go too. `SECURITY.md` lists
every durable per-session file the shipped dsh writes and what happens to each.

## Options

In `cordis.patch.yml`, under the plugin's row:

| Option | Default | Meaning |
| --- | --- | --- |
| `backup` | `false` | Move bytes into `<home>/session-admin/trash/<timestamp>-<id>/` instead of unlinking them. The conversation still disappears from dsh. |
| `enableCommand` | `true` | Register the `/delete` command. |
| `commandName` | `delete` | Rename that command. |
| `enableRpc` | `true` | Serve the browser channel the header action uses. |
| `journal` | `true` | Write the deletion ledger and the finish-on-close journals. |
| `finishOnClose` | `true` | Complete a queued deletion as soon as its session closes. |
| `dshHome`, `sessionsRoot`, `storagesRoot` | resolved | Point at a non-default harness home or store. |

## Safety

Every deletion path requires a deliberate act. The GUI needs a second press in a
dialog that first states what will go. The CLI refuses without `--yes` and prints
the same preview instead. Deletions are journalled before they start and recorded
after they finish, so an interrupted one leaves evidence and can be finished
idempotently:

```sh
dsh-session-admin recover
```

The engine refuses a symlinked store entry rather than following it, validates
every session id against a strict pattern before it becomes a path, and rewrites
`workspace.json` atomically while preserving its file mode. `SECURITY.md` walks
through each threat and names the control and the test that covers it.

## Tests

```sh
npm test
```

52 tests build their own store under a temporary directory. They cover the
deletion itself, the refusals (live sessions, unknown ids, hostile payloads,
symlinked directories, prototype-polluting documents), the host plugin's policy,
the wire contract, and the command surface. Nothing in the suite reads or writes
a real `$DSH_HOME`.

## License

MIT.
