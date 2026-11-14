#!/usr/bin/env bash
# Builds the two distributions from this one source tree:
#   dist/printnimbus-laptop-<version>.zip   (Windows laptop; macOS/Linux via start-laptop.sh)
#   dist/printnimbus-pi-<version>.zip       (Raspberry Pi)
set -euo pipefail
cd "$(dirname "$0")/.."
VER=$(node -p "require('./package.json').version")
OUT="$PWD/dist"; rm -rf "$OUT"; mkdir -p "$OUT"
COMMON=(src public admin test branding README.md SECURITY-AUDIT.md .env.example .gitignore)

build() {  # build <laptop|pi>
  local kind=$1 name="printnimbus-$1-$VER" dir="$OUT/stage/printnimbus-$1"
  mkdir -p "$dir"
  for f in "${COMMON[@]}"; do cp -r "$f" "$dir/"; done
  if [ "$kind" = laptop ]; then
    cp laptop/* "$dir/"; cp docs/QUICKSTART-LAPTOP.md "$dir/"
    node -e "const p=require('./package.json'); p.name='printnimbus-laptop'; require('fs').writeFileSync('$dir/package.json', JSON.stringify(p,null,2)+'\n')"
  else
    mkdir -p "$dir/deploy"; cp deploy/* "$dir/deploy/"; cp docs/QUICKSTART-PI.md "$dir/"
    # the Pi does not need the Windows-only printing package
    node -e "const p=require('./package.json'); p.name='printnimbus-pi'; delete p.optionalDependencies; require('fs').writeFileSync('$dir/package.json', JSON.stringify(p,null,2)+'\n')"
  fi
  ( cd "$dir" && npm install --package-lock-only --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null )
  ( cd "$OUT/stage" && zip -qr "$OUT/$name.zip" "printnimbus-$kind" )
  echo "built $OUT/$name.zip"
}
build laptop; build pi
rm -rf "$OUT/stage"
