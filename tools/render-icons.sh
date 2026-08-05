#!/usr/bin/env bash
# Render the PNG icon set and the social card from the SVG masters.
#
# The PNGs are committed rather than generated at deploy time: the Docker image
# is alpine + node, and pulling a headless browser into it to redraw four icons
# would cost more than the icons weigh. Re-run this by hand whenever
# assets/logo.svg changes.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
assets="$root/assets"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$chrome" ] || { echo "Chrome not found at $chrome" >&2; exit 1; }

shot() { # shot <url> <width> <height> <out>
  "$chrome" --headless --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=1 --default-background-color=00000000 \
    --window-size="$2,$3" --screenshot="$4" "$1" 2>/dev/null
}

icon() { # icon <svg> <size> <out>
  cat > "$work/i.html" <<HTML
<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}
img{display:block;width:${2}px;height:${2}px}</style>
<img src="file://$1">
HTML
  shot "file://$work/i.html" "$2" "$2" "$3"
  echo "  $(basename "$3")  ${2}x${2}"
}

echo "icons →"
icon "$assets/logo.svg"         16  "$assets/favicon-16.png"
icon "$assets/logo.svg"         32  "$assets/favicon-32.png"
icon "$assets/logo.svg"        192  "$assets/icon-192.png"
icon "$assets/logo.svg"        512  "$assets/icon-512.png"
# iOS masks its own corners, so this one is fed the square-cornered master.
icon "$assets/logo-square.svg" 180  "$assets/apple-touch-icon.png"

echo "social card →"
shot "file://$here/og.html" 1200 630 "$assets/og.png"
echo "  og.png  1200x630"
