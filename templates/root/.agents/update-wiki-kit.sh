#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
AGENTS_DIR=$(basename "$SCRIPT_DIR")
if [ -z "${WIKI_KIT_PACKAGE:-}" ]; then
  WIKI_KIT_PACKAGE="$(node -e "const fs=require('fs');const path=require('path');const marker=path.resolve(process.argv[1],'.wiki-kit-install.json');try{const data=JSON.parse(fs.readFileSync(marker,'utf8'));const value=typeof data.package==='string'?data.package.trim():'';if(value)process.stdout.write(value);}catch{}" "$SCRIPT_DIR" 2>/dev/null || true)"
fi
WIKI_KIT_PACKAGE="${WIKI_KIT_PACKAGE:-github:ihorleleka/Local-Rag-Wiki}"

# update refreshes the managed files, pulls the pinned image, replaces an
# outdated container, and starts the repository container.
exec npx --yes --legacy-peer-deps "$WIKI_KIT_PACKAGE" update "$SCRIPT_DIR/.." --agents-dir "$AGENTS_DIR" --force "$@"
