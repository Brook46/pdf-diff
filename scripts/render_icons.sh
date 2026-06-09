#!/usr/bin/env bash
# Regenerate PNG icons from icon.svg using macOS `sips`.
# Run from the pdf-diff/ directory: ./scripts/render_icons.sh
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p icons
for s in 152 167 180; do sips -s format png -z $s $s icon.svg --out icons/apple-touch-icon-$s.png > /dev/null; done
for s in 192 512 1024; do sips -s format png -z $s $s icon.svg --out icons/icon-$s.png > /dev/null; done
echo "Icons regenerated:"
ls -1 icons/
