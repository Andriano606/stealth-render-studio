#!/usr/bin/env bash
# Thin Conductor wrapper -> archive.rb. Puts asdf shims on PATH (non-interactive
# shells don't have them), selects a modern Ruby for the orchestrator via env
# (the asdf global is 2.5.8; we never write .tool-versions) and execs it.
set -euo pipefail
cd "${CONDUCTOR_WORKSPACE_PATH:-$PWD}"
export PATH="$HOME/.asdf/shims:$HOME/.asdf/bin:$PATH"
export ASDF_RUBY_VERSION="${ASDF_RUBY_VERSION:-3.4.8}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec ruby "$HERE/archive.rb" "$@"
