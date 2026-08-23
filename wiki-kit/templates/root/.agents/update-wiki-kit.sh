#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
AGENTS_DIR=$(basename "$SCRIPT_DIR")
WIKI_KIT_PACKAGE="${WIKI_KIT_PACKAGE:-github:ihorleleka/wiki-kit}"

exec npx "$WIKI_KIT_PACKAGE" update "$SCRIPT_DIR/.." --agents-dir "$AGENTS_DIR" "$@"

