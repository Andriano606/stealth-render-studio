#!/usr/bin/env bash
# Thin Conductor wrapper -> setup.rb. Puts asdf shims on PATH (non-interactive
# shells don't have them), selects a modern Ruby for the orchestrator via env
# (the asdf global is 2.5.8; we never write .tool-versions) and execs it.
#
# Conductor calls the MAIN checkout's copy by absolute path, which only changes
# on a manual pull. So it hands over to the WORKSPACE's own copy (fresh main for
# a new workspace) when that copy knows the shared-state layout — marker:
# conductor-delegate: v1
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # before cd: BASH_SOURCE may be relative
cd "${CONDUCTOR_WORKSPACE_PATH:-$PWD}"
OWN="$PWD/conductor/setup.sh"
if [ -z "${CONDUCTOR_NO_DELEGATE:-}" ] && [ -f "$OWN" ] && [ "$(cd "$PWD/conductor" && pwd)" != "$HERE" ] \
   && grep -q '^# conductor-delegate: v1$' "$OWN"; then
  exec bash "$OWN" "$@"
fi
export PATH="$HOME/.asdf/shims:$HOME/.asdf/bin:$PATH"
export ASDF_RUBY_VERSION="${ASDF_RUBY_VERSION:-3.4.8}"
exec ruby "$HERE/setup.rb" "$@"
