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

### 3.2 Symlink escape

**Threat.** Someone (or something) places
`<home>/sessions/--x--/session-<id>` as a **symlink** to `~/Documents`.
`readdir` follows symlinks; a recursive delete would then remove the target's
contents. This is the most serious bug found during development and it was real:
the first implementation followed the link and deleted files outside the store.

**Control.** Every path is `lstat`-verified as a *real* directory or file before
it is read or removed (`isRealDirectory`, `isRealFile`), at both plan time and
removal time, for the project directory, the session directory, each log
generation, each projection document, and the workspace file. A symlinked entry
is treated as "not a session" rather than as a session with somewhere else's
contents.

**Covered by.** `test/engine.test.js` → *ignores a symlinked session directory
instead of following it*, plus *does not delete a directory that merely shares
the session id but holds no log*.

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

**Control.** Log decoding is bounded by a byte budget and a frame budget
(`maxBytes`, `maxFrames`); the hostile-document walk is bounded; the session
listing caps its page (default 200, hard ceiling 500); the RPC body is capped by
`dsh-client-connection`'s request limit and the id length is capped at 128
bytes. Cancellation is honoured through the `AbortSignal` the carrier passes in.

## 4. What a deletion does not cover

A privacy tool is only as good as its inventory, so this is the full accounting
of durable per-session state the shipped dsh writes, and what happens to each:

| Durable state | Removed? | Notes |
| --- | --- | --- |
| `sessions/--<project>--/<id>/session.v<N>.jsonl[.zstd]`, every generation | yes | the whole session directory goes, so v0/v1/v2 alongside v3 go with it |
| `sessions/--<project>--/<id>/session.lock` | yes | inside the same directory |
| `sessions/--<project>--/<id>/` staging files from a format migration | yes | inside the same directory |
| `storages/session_projcache/sessions/<id>.json` and `<id>.json.bak.<stamp>` | yes | the domain layer's own backup-of-a-bad-record variant is matched too |
| `storages/workspace.json` membership and archive flag | yes | rewritten atomically, one id removed from two lists |
| `attachments/v1/**` | **no, by design** | content-addressed and shared across sessions; the report says how many the session referenced |
| `llm-deepseek/files-v3.json` | **not needed** | keyed by a route/variant scope hash, not by session id, so nothing points at the deleted session |
| `spill-local` spit files | **no** | a private per-process directory under the OS temp dir, with its own 30-day startup cleanup; scratch output, not session state |
| `storages/session_query` (SQLite index) | **not needed when in-memory** | the shipped Web profile opens it at `:memory:`. A deployment that sets a real `path` or `openAt` would gain a per-session index this engine does not yet clear — check `session-query-sqlite` config before enabling in-memory search |
| `session-admin/deletions.jsonl` (this tool's ledger) | **no, by design** | it records the session id you deleted and nothing about its content; delete the file if the id itself is sensitive |
| `session-admin/trash/**` (only with `backup: true`) | **no, by design** | the point of the option; remove it when satisfied |

The session *directory* is removed as a unit, which is what makes the inventory
above short: anything the persistence backend keeps beside the log inside that
directory is covered without this engine having to know about it.

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
| `backup: false` (the default) | Bytes are gone at the filesystem level. Recovery depends on the platform's own snapshots. Turn `backup: true` on if that is not acceptable. |
| Store format drift | The engine recognizes the shipped `workspace` unit and `session_projcache` layout; an unrecognized `workspace.json` is refused with `SESSION_ADMIN_STORAGE_SHAPE` rather than guessed at. A future dsh version that changes these shapes must be checked before upgrading — the plugin fails closed rather than half-deleting. |
| Encoding drift | `encodeSegment` / `projectKey` are re-implementations, pinned by tests against the real directory names. A drift would make a deletion find nothing (fail closed), never delete the wrong thing. |

## 7. Reporting

If you find a flaw in the reasoning above — especially a path by which this tool
can remove something other than the one session it was asked to remove — please
open an issue with the reproduction. Deletion is not a place for optimism.
