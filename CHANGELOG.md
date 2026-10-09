# Changelog

## 0.1.0

First release.

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
