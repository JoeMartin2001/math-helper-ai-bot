#!/usr/bin/env bash
# Renders the brand assets from src/*.html to PNG with headless Chrome.
# Usage: ./brand/render.sh            (all assets)
#        ./brand/render.sh avatar     (one asset)
set -euo pipefail
cd "$(dirname "$0")"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
mkdir -p out

# name:width:height:scale (scale 2 = retina export at double size)
ASSETS=(
  "avatar:640:640:2"
  "description:640:360:1"
  "guide:1080:1350:1"
  "announcement:1280:720:1"
  "logo:512:512:2"
)

for spec in "${ASSETS[@]}"; do
  IFS=: read -r name w h scale <<<"$spec"
  [[ $# -gt 0 && "$1" != "$name" ]] && continue
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run \
    --allow-file-access-from-files --virtual-time-budget=4000 --default-background-color=00000000 \
    --force-device-scale-factor="$scale" --window-size="$w,$h" \
    --screenshot="$PWD/out/$name.png" "file://$PWD/src/$name.html" 2>/dev/null
  echo "out/$name.png ($((w * scale))x$((h * scale)))"
done

# Telegram's BotFather wants the profile photo at 640x640.
if [[ -f out/avatar.png ]]; then
  python3 -c "from PIL import Image; Image.open('out/avatar.png').convert('RGB').resize((640, 640), Image.LANCZOS).save('out/avatar-640.jpg', quality=95)"
  echo "out/avatar-640.jpg (640x640)"
fi
