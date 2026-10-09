#!/usr/bin/env bash
# Install dsh-session-admin into a local dsh profile.
#
# The agent that wrote this plugin could not run these steps itself: they write
# to $DSH_HOME, which is outside its file sandbox. Everything below is the same
# thing `dsh plugin --profile <name> add <path>` does, spelled out so you can see
# exactly what changes on your machine.
#
# Usage:
#   ./install.sh                 # install into the "web" profile from this checkout
#   ./install.sh tui             # install into another profile
#   ./install.sh web --uninstall # remove it again
#
# After it finishes, restart the profile: a new host row is only composed at boot.

set -euo pipefail

PROFILE="${1:-web}"
ACTION="${2:-}"
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"

if ! command -v dsh >/dev/null 2>&1; then
  echo "install.sh: 'dsh' is not on PATH" >&2
  exit 1
fi

if [ ! -d "$PROFILE_DIR" ]; then
  echo "install.sh: no profile at $PROFILE_DIR" >&2
  echo "           start it once (for example 'dsh web') so the profile is created" >&2
  exit 1
fi

if [ "$ACTION" = "--uninstall" ]; then
  echo "==> removing dsh-session-admin from the '$PROFILE' profile"
  dsh plugin --profile "$PROFILE" remove dsh-session-admin
  echo "==> done; restart the '$PROFILE' profile"
  exit 0
fi

echo "==> plugin source: $SOURCE"
echo "==> profile:       $PROFILE_DIR"

echo "==> 1/3 running the plugin's own tests"
( cd "$SOURCE" && node --test 'test/*.test.js' >/dev/null )
echo "    ok"

echo "==> 2/3 showing what a deletion would do (read-only preview)"
node "$SOURCE/lib/cli.js" store

echo "==> 3/3 installing into the profile"
dsh plugin --profile "$PROFILE" add "$SOURCE"

cat <<EOF

Installed. Next steps:

  1. Restart the '$PROFILE' profile. A host row is composed at boot, so the
     running process does not have it yet.
  2. Open a conversation. A trash icon appears in the conversation header,
     beside the other session actions.
  3. Optional: turn on 'backup: true' in the profile's cordis.patch.yml before
     you delete anything you might want to review afterwards.

To remove it again:  $0 $PROFILE --uninstall

The standalone CLI also works without dsh running:

  node $SOURCE/lib/cli.js list
  node $SOURCE/lib/cli.js inspect <session-id>
  node $SOURCE/lib/cli.js delete <session-id> --yes
EOF
