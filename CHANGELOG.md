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
- **The browser delete action could never have worked.** The RPC endpoints were
  absolute while the carrier hands the handler a name relative to the channel, so
  every request would have been refused before dispatch. Endpoints are relative
  now, and the test harness strips the prefix exactly as the real carrier does.
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
