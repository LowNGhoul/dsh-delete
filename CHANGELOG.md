# Changelog

## 0.1.0

First release.

### Fixed during the security review that preceded it

An independent adversarial review of the first draft found issues that are fixed
here; each one has a regression test, and `SECURITY.md` section 3 names the
control:

- **Deletion could escape the store through a symlinked ancestor.** Containment
  was decided lexically and only the final path component was checked, so a
  symlinked `sessions` root or project directory let a recursive removal act
  outside the store. Containment is now decided on canonical (`realpath`) paths,
  a symlinked store root is refused, and every target is re-verified at removal
  time.
- **A deletion could report success while the only log survived.** The log-name
  pattern could not match generation zero (`session.jsonl`), a project directory
  had to be named `--<project>--`, and `removedPaths` was built from the plan
  rather than from confirmed removals. The pattern is corrected, project
  directories are recognized by containment rather than by name, a found log is
  required, and the engine re-checks every path and raises
  `SESSION_ADMIN_DELETION_INCOMPLETE` if anything survived.
- **The browser delete action could never have worked.** Two independent defects:
  the RPC endpoints were absolute while the carrier hands the handler a name
  relative to the channel, and the channel was registered with
  `connection.rpc.handle()`, which cannot be called from outside the connection
  package — it resolves `webServer` from the connection service's own context,
  which does not declare that injection, so it throws and the channel never
  reaches the route table. Requests then fell through to the SPA's static handler
  as a 405. Endpoints are relative names and the route is registered directly on
  `webServer` behind `connection.requestRejection`, which is the shape the shipped
  `open-in-app` routes use. Both defects were caught by booting a real profile and
  calling the endpoint over HTTP, so the RPC tests now run against a real
  `node:http` server instead of a stubbed handler.
- **A cancelled deletion destroyed its own recovery record.** The journal was
  removed on any exit; it now survives unless the deletion completed.
- **A configuration that declared roots was honored by listings and ignored by
  deletions**, which could edit one store while reporting on another.
- **The ledger and journal directories were world-readable**, and the ledger
  recorded the conversation title. Both are private now, and the ledger holds no
  conversation content.
- **`Config` was a plain descriptor** where Cordis requires a Standard Schema,
  which would have thrown during plugin resolution and taken the whole profile
  down at boot. Defaults now live in `lib/config.js` and are applied in `apply`.

- **Deleting the conversation you are reading no longer needs a restart.** It
  used to be refused, then deferred, then completed on the next start — three
  steps for what a person experiences as one. On a POSIX filesystem the log's
  directory entry can be unlinked while the agent still holds the file open, so a
  confirmed deletion now removes it immediately; later writes from that handle go
  to an unreachable inode. The dialog keeps its single confirmation, and the page
  clears its selection and re-pulls the list so the row disappears from the
  sidebar too. `allowLiveDeletion: false` restores the deferral model.
- **A deferred deletion was forgotten by the restart it was waiting for.** A
  session that is open cannot be removed, so the dialog offers to delete it when
  it closes; that request lived only in the host's memory. Restarting, which is
  exactly what the operator does next, discarded it and the conversation was
  still there. The queue is now written to disk before the request is
  acknowledged, loaded again at startup, and completed there — a restart now
  finishes the deletion instead of cancelling it. `dsh-session-admin settle`
  does the same from outside a server. The delete control is also held disabled
  until the inspection answers, so an early press cannot reach the host and come
  back as an unexplained refusal.

Two known limits are documented rather than papered over: the running harness can
restore a deleted id into `workspace.json` from its in-memory copy (mitigated by
`repair`, which runs at startup and before every deletion), and the CLI cannot ask
a running server whether a session is live.

- Permanent deletion of one stored session: the session log directory (every
  format generation, the lock file, and migration staging files inside it), the
  `session_projcache` checkpoint including its `.bak` variants, the workspace
  membership, and the archive flag.
- Host plugin: `ctx.sessionAdmin`, a `/delete` command, and an authenticated
  `/session-admin` RPC channel.
- Browser half: a delete action in the conversation header with a confirmation
  dialog that states what will be removed.
- Standalone CLI (`dsh-session-admin`) that works with no dsh process running.
- Safety: live sessions are refused and can be queued instead, `--backup` moves
  bytes to a trash directory, every deletion is journalled first and ledgered
  after, symlinked store entries are refused rather than followed, and storage
  documents carrying prototype-polluting keys are rejected.
