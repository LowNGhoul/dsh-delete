# Security review — `dsh-session-admin`

This document is the honest account of what this plugin can do, what it refuses
to do, and which risks are covered by which mechanism. It is written for the
person who has to decide whether to install a tool whose whole job is to destroy
data irreversibly.

The tool is designed so that **the worst outcome of a bug is losing the session
the operator asked to lose, and never anything else.** Every control below
exists to keep that sentence true.

---

## 1. What the capability is

`dsh-session-admin` permanently removes one stored DeepSeek Harness session: its
append-only log, its projection checkpoint, its workspace membership, and its
archive flag. It reaches those through three Cordis services the host
composition already provides (`sessions`, `sessionPersistence`,
`storageDomain`) plus the storage files themselves.

It performs no network I/O, spawns no process, executes no shell, and opens no
listening socket. Its complete capability is: *read and write files under
`$DSH_HOME`, and remove a single session's entries from the workspace registry.*

## 2. Assets and the blast radius

| Asset | Read | Written | Deleted |
| --- | --- | --- | --- |
| `<home>/sessions/**/session.v*.jsonl[.zstd]` | header only | — | one session's own directory |
| `<home>/storages/session_projcache/sessions/<id>.json` | title only | — | the same session's checkpoint |
| `<home>/storages/workspace.json` | full unit | full unit, atomically, mode-preserving | one id, from two lists |
| `<home>/attachments/**` | **never** | **never** | **never** |
| Everything else | **never** | **never** | **never** |

`attachments/` is content-addressed and shared by every session that ever
attached the same bytes. A per-session deletion therefore cannot own an
attachment, so this tool reports how many a session referenced and leaves the
bytes alone. Removing them is not implemented on purpose.

## 3. Threats considered, and the control for each

### 3.1 Path traversal through a session id

**Threat.** A caller supplies `../../etc/passwd` (or a NUL, a separator, a
120-character nonsense string) and the tool resolves it into a filesystem path.

**Control.**
1. `assertSessionId` accepts only `[A-Za-z0-9][A-Za-z0-9._-]{0,127}` — no
   separators, no leading dot, no NUL, bounded length.
2. The id is then encoded with the persistence backend's own
   `encodeSegment`, which maps every unsafe code unit to `~XXXX`, so the id can
   only ever become one path segment. `.` and `..` are special-cased there too.
3. Finally `assertInside(root, candidate)` resolves the candidate and refuses
   it if `path.relative(root, candidate)` escapes. This is a third, independent
   check, so a mistake in either of the first two still cannot escape.

**Covered by.** `test/engine.test.js` (validation table),
`test/host.test.js` (hostile RPC payloads leave the log byte-identical).

### 3.2 Symlink escape, including a symlinked ancestor

**Threat.** Someone (or something) places a symlink in the store: a session
directory, a project directory, the `sessions` root itself, or `workspace.json`.
`readdir` follows symlinks and `rm -r` recurses through them, so a link named
like a session could make a "delete this session" request read — and then
recursively remove — whatever it points at. This was a real bug during
development: the first implementation followed a symlinked session directory and
deleted files outside the store. A second, subtler version followed a symlinked
*ancestor*, which `lstat` on the leaf cannot see.

**Control.** Four layers, each verified against the incident:

1. Every directory and file is `lstat`-checked as a real directory or file
   (`isRealDirectory`, `isRealFile`), both when the plan is built and again at
   the moment of removal, so a link is refused rather than followed.
2. Containment is decided on **canonical** paths: `assertContained` resolves the
   target with `realpath` and requires its resolved parent to be the canonical
   directory it was planned under, with that directory directly under the
   canonical root.
3. A store root that is itself a symlink is refused outright
   (`SESSION_ADMIN_STORAGE_SHAPE`): without that check every later canonical
   comparison would simply agree with the link target and look well contained.
4. `workspace.json` must be a regular file. Rewriting through a link would
   replace the link with a file while the real unit kept the deleted id.

**Covered by.** `test/engine.test.js` → *does not follow a symlinked sessions
root*, *does not follow a symlinked project directory*, *does not unlink a
projection record through a symlinked storages root*, *refuses to rewrite a
workspace unit that is a symlink*, *ignores a symlinked session directory
instead of following it*.

### 3.3 Deleting a session a live agent still owns

**Threat.** The session currently being read is deleted, so its agent keeps
appending to a removed log — silent data loss and an inconsistent store.

**Control.** Every deletion path consults `ctx.agents.get(id)` and
`ctx.sessions.get(id)` first. A live session raises `LiveSessionError`; the
engine only proceeds when the caller passes `live: false`, which the host does
**only** from the `session/disposed` listener — the moment the store has already
released the session. The GUI offers the honest alternative (queue until the
session closes) instead of pretending the deletion happened.

**Covered by.** `test/engine.test.js` → *refuses a live session*;
`test/host.test.js` → *refuses to delete a live session and queues it instead*.

### 3.4 A browser page deleting conversations it should not reach

**Threat.** Any web page in the user's browser, or any device on the LAN,
triggers deletions through the plugin's HTTP endpoint.

**Control.** The plugin registers its own channel (`/session-admin`) on
`dsh-client-connection`'s shared, already-authenticated API carrier rather than
inventing an endpoint. That carrier applies, before the handler runs:

- a Host/Origin fence (`403`) that refuses a request whose `Host` is not
  loopback or a configured trusted authority, refuses a mismatched `Origin`,
  and refuses `sec-fetch-site: cross-site`;
- browser-session authentication (`401`) requiring the signed, `HttpOnly`,
  `SameSite=Strict` cookie that only a token-bearing visit to `/` can obtain.

The plugin adds no bypass, no query-token path, and no unauthenticated route. It
also refuses to register on `/api`, which is reserved for the host's single
interceptor — a second owner there throws, so this is structurally impossible
rather than merely avoided.

### 3.5 Information disclosure to the page

**Threat.** The browser half receives absolute filesystem paths, log contents, or
other sessions' data.

**Control.** The host projects each report through
`summarizeInspectionForBrowser` / `summarizeDeletionForBrowser`, which keep only
scalars a user is shown (id, title, cwd, byte count, artifact counts) and drop
every path. The browser never receives a log body, another session's data, or a
host object. A test asserts the JSON contains neither the harness home nor the
`logFiles` key.

**Covered by.** `test/host.test.js` → *answers store, inspect and delete with the
documented envelopes*.

### 3.6 Prototype pollution through a storage document

**Threat.** A hostile or corrupted `workspace.json` carries `__proto__` /
`constructor` / `prototype` as an own key; spreading that object while planning
the rewrite pollutes `Object.prototype` in the host process.

**Control.** `assertNoDangerousKeys` walks every parsed storage document and
refuses one that carries a reserved key (bounded walk, so a hostile file cannot
become a denial of service). All copies are made with
`copyPlain` (`Object.keys` + literal assignment), which never invokes a
`__proto__` setter.

**Covered by.** `test/engine.test.js` → *refuses a workspace document carrying a
prototype-polluting key*.

### 3.7 Losing more than the requested session

**Threat.** A bug removes a sibling session, an entire project, or a whole
storage unit.

**Control.**
- Sibling sessions are never *enumerated*: only the encoded id of the requested
  session is looked up inside each project directory.
- A project directory is removed only after a fresh read shows it empty, and
  with `rmdir` rather than a recursive remove, so a non-empty directory cannot
  be removed even under a race.
- `workspace.json` is rewritten by replacing exactly one id in exactly two
  lists; every other table, key and field is copied through untouched.
- The workspace rewrite is atomic (`write` → `fsync` → `rename`) and preserves
  the file's mode, so a crash leaves the previous complete document and a
  private file does not become world-readable.

**Covered by.** `test/engine.test.js` → *leaves a sibling session in the same
project untouched*, *removes the project directory once its last session is
gone*, *preserves the mode of the storage file it rewrites*.

### 3.7a Reporting a deletion that did not happen

**Threat.** The tool says "permanently deleted" while some copy of the
conversation survives. This is the failure mode a privacy tool must not have,
and it had two real forms: a log-name pattern that could not match a
generation-zero `session.jsonl`, and a success report built from the plan rather
than from what was actually removed.

**Control.** A deletion now has to prove itself:

- A log must be found (`SESSION_ADMIN_ORPHAN_METADATA` otherwise), and the log
  must declare the requested id (`SESSION_ADMIN_IDENTITY_MISMATCH` otherwise).
- `removedPaths` gets a path only after `lstat` confirms nothing occupies that
  name, so a path that vanished or turned out to be a link is not reported.
- After the removal loop the engine re-checks every planned path and raises
  `SESSION_ADMIN_DELETION_INCOMPLETE` if anything survived, instead of returning
  a success report.
- A cancellation or mid-run failure leaves the journal in place, so
  `listPendingDeletions` can still name the session and a later run can finish
  it. A test covers record → abort → finish.

**Covered by.** `test/engine.test.js` → *deletes a generation-zero log named
session.jsonl*, *finds a session in a project directory that is not named
--<project>--*, *refuses a log that declares a different session*, *names orphan
metadata instead of reporting a deletion*, *leaves the journal in place when a
deletion is cancelled after it starts*.

### 3.8 Irreversible operator error

**Threat.** A typo, a wrong id, or a misread listing deletes the wrong
conversation with no way back.

**Control.**
- Nothing is deleted without an explicit act: the GUI requires a second
  confirmation in a dialog that first *states what will be removed*; the CLI
  refuses without `--yes` and prints the same preview instead.
- `--backup` / `backup: true` **moves** the bytes into
  `<home>/session-admin/trash/<timestamp>-<id>/` instead of unlinking them. The
  session still disappears from dsh; the bytes stay reviewable.
- Every completed deletion appends one identity-only row to
  `<home>/session-admin/deletions.jsonl` — what went, when, how many bytes.
- A deletion that is interrupted is journalled in
  `<home>/session-admin/pending/` and can be listed (`recover`, `/session-admin/pending`)
  and finished idempotently.

### 3.9 Denial of service and resource exhaustion

**Threat.** A request makes the host read a huge log, walk an unbounded tree, or
loop forever.

**Control.** Log reading is bounded three ways — how much of the file is read at
all (`maxFileBytes`, 64 MiB), how much is decoded (`maxBytes`), and how many
frames are decoded (`maxFrames`) — so a multi-gigabyte log cannot OOM the
process that is deleting it. The hostile-document walk is bounded, the session
listing caps its page (default 200, hard ceiling 500), the RPC body is capped by
`dsh-client-connection`'s request limit, and an id is capped at 128 bytes.
Cancellation is honoured through the `AbortSignal` the carrier passes in, and is
reported as `SESSION_ADMIN_ABORTED` rather than as an internal failure.

## 4. What a deletion does not cover

A privacy tool is only as good as its inventory, so this is the full accounting
of durable per-session state the shipped dsh writes, and what happens to each.
Two rows are honest gaps rather than features.

| Durable state | Removed? | Notes |
| --- | --- | --- |
| `<id>/session.jsonl[.zstd]` — the canonical generation zero — and `session.vN.jsonl[.zstd]` for every later generation | yes | the whole session directory goes. An earlier revision matched only `.vN` and would have missed a v0 store while reporting success; the pattern is now `^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$` and a deletion that finds no log refuses instead of reporting one |
| `<id>/session.lock` | yes | inside the same directory |
| `<id>/session.migration.<hex>.jsonl[.zstd].tmp`, `<id>/session.vN.jsonl.<hex>.tmp` | yes | inside the same directory |
| A session directory under a project directory with any name | yes | the persistence backend accepts an arbitrary project directory name and a person may rename one, so project directories are recognized by being real directories directly under the canonical root rather than by a `--*--` name |
| `storages/session_projcache/sessions/<id>.json` and `<id>.json.bak.<stamp>` | yes | exact name plus the domain layer's own bad-record sidecar |
| `storages/workspace.json` membership and archive flag | yes, and re-applied | the running harness holds this unit in memory and can restore an id from it on its next unrelated write. Every deletion is recorded in the ledger, and `repair` (run at startup, before each deletion, and callable directly) puts the file back in agreement. A test covers the restore-then-repair cycle |
| `attachments/v1/**` | **no, by design** | content-addressed and shared across sessions; there is no manifest mapping an attachment to a session, so the bytes cannot be attributed to the one being deleted. The report says how many the session referenced |
| Child and forked sessions whose `parentSession` names the deleted id | **no** | a fork seeds its child with a *copy* of the parent's events (`dsh-session` `options.seed`), so a child holds its own copy of that content and deleting the parent does not remove it. The report counts children it finds and says so rather than implying they went too |
| Browser `localStorage`: `dsh.conversation.<sessionId>` (unsent draft), `dsh.sessions.current`, and the workspace view's id arrays | **no** | the host cannot reach a browser's storage. A draft in a deleted conversation's composer survives in that browser until the page's own storage is cleared |
| `tmp/dsh-spill-*/session-<sha256(id)[0:12]>/…` (spilled tool output) | **no** | a private per-process directory under the OS temp directory with its own 30-day startup sweep; the engine has the id and could derive the directory name, which is a reasonable future addition |
| The SQLite search index | **only when in-memory** | the shipped profile opens it at `:memory:`. A deployment that points `path` at a file keeps a second copy of every session's text; the deletion report names that file, and a restart or reindex is what clears it. This engine never writes that database, because corrupting a shared index is worse than a stale row |
| `session-admin/deletions.jsonl` | **no, by design** | session ids, byte counts and path counts, `0600`, containing no conversation content. Delete the file if the ids themselves are sensitive |
| `session-admin/pending/*.json` | **no** | the record that makes an interrupted deletion recoverable; it holds ids and planned paths, `0600`, and is removed when the deletion completes |
| `session-admin/trash/**` (only with `backup: true`) | **no, by design** | the point of the option; remove it when satisfied |

The session directory is removed as a unit, which is what keeps most of this
table short: anything the persistence backend keeps beside the log inside that
directory is covered without this engine having to know about it.

A deletion also refuses rather than guesses at two states it cannot resolve:

- **Metadata without a log** (`SESSION_ADMIN_ORPHAN_METADATA`). A projection
  record with no session directory is an orphan; reporting it as deleted would
  be a lie.
- **A log declaring another session** (`SESSION_ADMIN_IDENTITY_MISMATCH`). The
  directory is matched by encoded id, so this only happens when a store entry
  was moved or copied by hand — and deleting on the name alone would destroy a
  conversation nobody asked about.

## 5. Deliberate non-goals

- **No undo.** Permanence is the feature. Deletion is not "move to trash and
  forget"; that behaviour is `archive`, which dsh already has. `backup: true`
  is the opt-in escape hatch, not the default.
- **No attachment reclamation.** Shared, content-addressed bytes are out of
  scope, as explained above.
- **No remote or shared-store deletion.** This operates on a local harness home.
  A shared or object-store backend would need its own deletion story.
- **No protection against a hostile local user.** Anyone who can write to
  `$DSH_HOME` can already delete these files with `rm`. This tool is not a
  privilege boundary and does not pretend to be one.

## 6. Residual risk

| Risk | Assessment |
| --- | --- |
| A compromised dsh host process | Out of scope: such a process already has the same filesystem access without this plugin. |
| A compromised browser session cookie | The cookie is the harness's own authentication; a stolen cookie can already drive every other host RPC, including session creation and prompts. Deletion adds no new class of authority. |
| A store the user deliberately symlinked | Refused, including the case where the whole `sessions` root is a link to another volume. The refusal is loud (`SESSION_ADMIN_STORAGE_SHAPE`) rather than silent, so a legitimate setup that needs it can be discussed rather than discovered. |
| `backup: false` (the default) | Bytes are gone at the filesystem level. Recovery depends on the platform's own snapshots. Turn `backup: true` on if that is not acceptable. |
| Store format drift | The engine recognizes unit version 2 of `workspace` and the `session_projcache` layout; a different version, a non-object `tables`, or a non-regular file is refused with `SESSION_ADMIN_STORAGE_SHAPE` rather than guessed at. A future dsh version that changes these shapes must be checked before upgrading — the plugin fails closed rather than half-deleting. |
| The workspace unit's in-memory copy | A running dsh can restore a deleted id from the workspace domain's memory on its next unrelated write. `repair` re-applies the ledger to fix it, and it runs at startup and before every deletion; a page that never triggers a repair and never restarts could still show a ghost until it does. |
| Deleting a session a *different* process has open | The CLI runs outside any dsh process and cannot ask a server whether a session is live. Its `--yes` output says so. The on-disk `session.lock` is not consulted; doing it properly means taking the same lease the persistence backend takes, which is a change worth making deliberately rather than in passing. |
| Encoding drift | `encodeSegment` / `projectKey` are re-implementations, pinned by tests against the real directory names. A drift would make a deletion find nothing (fail closed), never delete the wrong thing. |

## 7. Reporting

If you find a flaw in the reasoning above — especially a path by which this tool
can remove something other than the one session it was asked to remove — please
open an issue with the reproduction. Deletion is not a place for optimism.
