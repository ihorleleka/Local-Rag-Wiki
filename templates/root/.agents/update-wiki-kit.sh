#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
AGENTS_DIR=$(basename "$SCRIPT_DIR")
if [ -z "${WIKI_KIT_PACKAGE:-}" ]; then
  WIKI_KIT_PACKAGE="$(node -e "const fs=require('fs');const path=require('path');const marker=path.resolve(process.argv[1],'.wiki-kit-install.json');try{const data=JSON.parse(fs.readFileSync(marker,'utf8'));const value=typeof data.package==='string'?data.package.trim():'';if(value)process.stdout.write(value);}catch{}" "$SCRIPT_DIR" 2>/dev/null || true)"
fi
WIKI_KIT_PACKAGE="${WIKI_KIT_PACKAGE:-github:ihorleleka/Local-Rag-Wiki}"

npx "$WIKI_KIT_PACKAGE" update "$SCRIPT_DIR/.." --agents-dir "$AGENTS_DIR" "$@"

WIKI_KIT_IMAGE="$(node -e "const fs=require('fs');const path=require('path');const marker=path.resolve(process.argv[1],'.wiki-kit-install.json');const data=JSON.parse(fs.readFileSync(marker,'utf8'));if(typeof data.defaultImage!=='string'||!data.defaultImage.trim())throw new Error('installed wiki-kit marker has no default image');process.stdout.write(data.defaultImage.trim());" "$SCRIPT_DIR")"
docker pull "$WIKI_KIT_IMAGE"

printf '\nPulled wiki service image: %s\n' "$WIKI_KIT_IMAGE"
printf 'Restart the wiki service to use the new image:\n'
printf '  npx "%s" restart "%s" --agents-dir "%s"\n' "$WIKI_KIT_PACKAGE" "$SCRIPT_DIR/.." "$AGENTS_DIR"
