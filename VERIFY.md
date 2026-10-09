# Verification checklist

Everything the author could check without writing to your `$DSH_HOME`, and the
short list of things only you can confirm on your machine.

## Already verified

| Check | Command | Result |
| --- | --- | --- |
| Unit, host, client and CLI tests | `node --test 'test/*.test.js'` | 85 pass, 0 fail |
| Tests pass from a fresh clone | `git clone <this repo> /tmp/x && cd /tmp/x && node --test 'test/*.test.js'` | 85 pass, 0 fail |
| The plugin runs in the real Cordis runtime | `node --test test/cordis.test.js` | 4 pass against the `@deepseek-ai/cordis` a dsh install ships; skips where none is present |
| Containment: a symlinked store root, project directory, storages root or workspace unit | `node --test --test-name-pattern 'symlink' test/engine.test.js` | every case refused, nothing outside the store touched |
| A deletion that finds no log refuses instead of reporting success | `node --test --test-name-pattern 'generation-zero\|orphan\|different session' test/engine.test.js` | named errors, log untouched |
| The CLI refuses to delete without `--yes` | `node lib/cli.js delete <id> --dsh-home <copy>` | exit 1, file untouched |
| A hostile id never reaches the filesystem | `node lib/cli.js delete '../etc/passwd' --yes` | `SESSION_ADMIN_INVALID_ID` |
| A full deletion against a copy of a real store | see below | log, checkpoint, workspace row and archive flag all gone |
| The host entry imports cleanly | `node -e "import('./lib/index.js')"` | exports the plugin |
| The composition patch parses as YAML | `node -e "require('js-yaml').load(...)"` | one insert row, expected config |
| The browser bundle evaluates as a classic script | `node --test test/client.test.js` | factory registers, plugin applies, dialog renders |
| The RPC channel is reachable over real HTTP | `node --test test/host.test.js` | `node:http` server, 200 with the documented envelope, 401 unauthenticated, 404 for a nested path |
| A real profile boots with the row composed | `dsh --profile web --dump-config \| grep -A6 dsh-session-admin` | the row and its config appear |
| The endpoint answers on a real server | boot a second instance, then `curl` the channel | `POST /session-admin/store` returns the store summary; without the cookie it is `401` |
| The client bundle is served | fetch the application combo URL from the index | our `window.__ModuleLoader__.load({ id: 'dsh-session-admin' … })` is inside it |

The full-deletion check against a real store copy:

```sh
cp -R "$DSH_HOME" /tmp/store-copy
node lib/cli.js inspect <session-id> --dsh-home /tmp/store-copy
node lib/cli.js delete  <session-id> --yes --json --dsh-home /tmp/store-copy
node lib/cli.js store --dsh-home /tmp/store-copy   # one fewer session
ls  /tmp/store-copy/sessions/*/<session-id>        # no such directory
ls  /tmp/store-copy/storages/session_projcache/sessions/<session-id>.json   # not found
grep -c <session-id> /tmp/store-copy/storages/workspace.json                # 0
```

## Yours to confirm

1. **The plugin loads.** After `./install.sh` and a profile restart, open
   **Settings → Plugins**. The row `dsh-session-admin` should be listed and
   enabled. If it is absent, the profile did not compose the patch: check that
   `dsh-session-admin` appears in `dsh.profile.bundles` in
   `$DSH_HOME/profiles/<profile>/package.json`.
2. **The header action appears.** Open any conversation. A trash icon sits in
   the header beside the other session actions. A conversation with no session
   id (an empty new session) renders nothing, which is expected.
3. **The dialog reads correctly.** Press it on a conversation you do not need.
   The panel lists the title, project, size, artifact counts and workspace rows,
   and states that it cannot be undone. Press **Cancel** first and confirm
   nothing changed in the sidebar.
4. **A real deletion.** Delete a throwaway conversation and confirm it leaves
   the sidebar, the archive list, and the store:

   ```sh
   node lib/cli.js list --dsh-home ~/.dsh | grep <session-id>   # no output
   ```

5. **The live-session path.** Press the delete action on the conversation you
   are currently reading. The button should read **Delete as soon as it closes**
   and the panel should say the conversation will be removed when it closes.
   Switch to another conversation, then confirm the first one is gone.

Turn on `backup: true` in the profile's `cordis.patch.yml` before step 4 if you
want the bytes kept in `$DSH_HOME/session-admin/trash/` while you check.
