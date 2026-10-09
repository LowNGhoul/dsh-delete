# dsh-session-admin

Permanently delete a conversation from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

dsh ships an archive action, which hides a session from the sidebar and leaves
every byte on disk. This plugin removes the session instead: the append-only log,
its projection checkpoint, its membership in the workspace registry, and its
entry in the archive list. There is no undo.

## Requirements

Node 22.19 or newer (the engine uses the built-in Zstandard API and
`node --test`), and a dsh installation whose `sessions`/`storages` layout matches
the shipped `@deepseek-ai/dsh-session-persistence-jsonl` and `dsh-workspace`
packages. There are no runtime dependencies to install: the host half imports
only Node built-ins, and the browser half requires only the React the page
already loads.

## Install

```sh
git clone https://github.com/LowNGhoul/dsh-delete.git
dsh plugin --profile web add "$PWD/dsh-delete"
```

The repository is `dsh-delete`; the package inside it is `dsh-session-admin`, and
that is the name a profile lists. Installing from a checkout you already have
works the same way:

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
rows the conversation belongs to, then one press removes it. That works for the
conversation you are reading too: on a POSIX filesystem the log's directory
entry is unlinked while the agent still holds the file open, so nothing waits for
a restart.

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

**A session another process is using.** The host can only remove a session no
other process holds. A second `dsh` instance running against the same store is
the case that remains, and the CLI covers it. The deferral machinery is still
there for the deployment that turns `allowLiveDeletion` off: a session marked
while open is then recorded on disk and removed when it closes, or on the next
start, and `dsh-session-admin settle` finishes anything still waiting.

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
| `allowLiveDeletion` | `true` | Let a confirmed deletion remove the session being read, instead of deferring it until it closes. |
| `journal` | `true` | Write the deletion ledger, the finish-on-close journals, and the workspace repair record. |
| `finishOnClose` | `true` | Complete a queued deletion as soon as its session closes. |
| `dshHome`, `sessionsRoot`, `storagesRoot` | resolved | Point at a non-default harness home or store. |

## Safety

Every deletion path requires a deliberate act. The GUI needs a second press in a
dialog that first states what will go. The CLI refuses without `--yes` and prints
the same preview instead.

A deletion has to prove itself before it reports success. It refuses when the
stored log declares a different session than the one you asked for, and when only
orphan metadata exists with no conversation log left. After removing, it
re-checks every path and fails loudly (`SESSION_ADMIN_DELETION_INCOMPLETE`) if
anything survived. Cancelling mid-run leaves a journal, so the session can be
named and finished later:

```sh
dsh-session-admin settle             # finish anything queued or interrupted
dsh-session-admin recover            # list unfinished deletions
dsh-session-admin repair             # re-apply every past deletion to workspace.json
```

`repair` exists because the running harness keeps the workspace registry in
memory and can restore a deleted id on its next unrelated write. The plugin runs
the repair at startup and before each deletion, so the file converges.

The engine refuses a symlinked store entry rather than following it, including a
symlinked project directory or a symlinked `sessions` root, decides containment
on canonical paths rather than lexical ones, validates every session id against a
strict pattern before it becomes a path, and rewrites `workspace.json` atomically
while preserving its file mode. `SECURITY.md` walks through each threat and names
the control and the test that covers it, along with the two things a deletion
knowingly does not reach: shared attachment bytes and content copied into a forked
child session.

## Tests

```sh
npm test
```

85 tests build their own store under a temporary directory. They cover the
deletion itself, the false-positive guards (generation-zero logs, hand-renamed
project directories, orphan metadata, mismatched identities), the refusals (live
sessions, unknown ids, hostile payloads, symlinked directories and roots,
prototype-polluting documents), the workspace repair cycle, the host plugin's
policy, the RPC channel over a real HTTP server, the browser bundle's
registration into a slot registry that parks and resumes declarations, its
rendered confirmation states, and the command surface. The
`real Cordis runtime` suite loads the actual `@deepseek-ai/cordis` that a dsh
installation ships and puts the plugin through a real fiber tree; it skips itself
where no dsh installation is present. Nothing in the suite reads or writes a real
`$DSH_HOME`.

## Development notes

`RETROSPECTIVE.md` is an account of how this was built: what held up, the four
defects an external review reproduced, and why the tests that existed did not
catch them. It is written against the commit history, so every claim in it can be
checked with `git log`.

## License

MIT.
