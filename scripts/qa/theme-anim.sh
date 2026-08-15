#!/usr/bin/env bash
# Assemble the theme-shots stills into the rotating-theme animation for the README.
#
# Usage:
#   node scripts/qa/harness.mjs launch --fresh
#   node scripts/qa/theme-shots.mjs                       # -> docs/qa/theme-shots/*.png
#   node scripts/qa/harness.mjs stop
#   scripts/qa/theme-anim.sh                              # -> docs/screenshots/themes-rotating.webp
#
# Env overrides: SHOT_DIR, OUT, WIDTH, QUALITY, HOLD, STEP, TWEENS, BLUR, ORDER.
#
# Frames are ordered by mean luminance, not themes.ts order. A crossfade between a
# near-black theme and a near-white one passes through flat grey with the text gone;
# sorting leaves exactly two of those crossings per loop (the minimum for a cycle
# spanning both) instead of ~20, so every other transition stays readable. Set
# ORDER=file to keep the on-disk order instead.
#
# Per-frame durations come from ffmpeg's concat demuxer, so the long holds cost one
# frame each rather than a constant-fps run of duplicates.
#
# Size is dominated by the 32 held stills (~825K at q75/1280, i.e. whatever a
# no-transition build would cost); each crisp tween frame adds ~19K on top. BLUR
# defocuses the tweens on a sine ramp peaking mid-transition, which roughly halves
# the total — but it visibly defocuses, so it is off by default.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SHOT_DIR=${SHOT_DIR:-$repo_root/docs/qa/theme-shots}
OUT=${OUT:-$repo_root/docs/screenshots/themes-rotating.webp}
WIDTH=${WIDTH:-1280}
QUALITY=${QUALITY:-75}
HOLD=${HOLD:-0.6}      # seconds a theme is held still
STEP=${STEP:-0.06}     # seconds per tween frame
TWEENS=${TWEENS:-3}    # tween frames per transition
BLUR=${BLUR:-0}        # peak blur sigma mid-transition; 0 keeps tweens crisp
ORDER=${ORDER:-luminance}  # luminance | file

for bin in magick ffmpeg; do
  command -v "$bin" >/dev/null || { echo "$bin not found" >&2; exit 1; }
done

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# --- 1. Order the stills ---
shots=("$SHOT_DIR"/*.png)
[ -e "${shots[0]}" ] || { echo "no PNGs in $SHOT_DIR" >&2; exit 1; }

if [ "$ORDER" = luminance ]; then
  mapfile -t ordered < <(
    for f in "${shots[@]}"; do
      printf '%s\t%s\n' "$(magick "$f" -colorspace Gray -format '%[fx:mean]' info:)" "$f"
    done | sort -n | cut -f2
  )
else
  mapfile -t ordered < <(printf '%s\n' "${shots[@]}" | sort)
fi
n=${#ordered[@]}
echo "$n themes, order=$ORDER"

mkdir -p "$work/src"
for i in "${!ordered[@]}"; do
  magick "${ordered[i]}" -resize "${WIDTH}x" "$work/src/$(printf %03d "$i").png"
done
# The loop wraps, so the last transition targets frame 0 again.
cp "$work/src/000.png" "$work/src/$(printf %03d "$n").png"

# --- 2. Morph each consecutive pair, blurring on a sine ramp ---
mkdir -p "$work/tween"
for ((i = 0; i < n; i++)); do
  magick "$work/src/$(printf %03d "$i").png" "$work/src/$(printf %03d $((i + 1))).png" \
    -morph "$TWEENS" -delete 0 -delete -1 "$work/tween/$(printf %03d "$i")-%d.png"
done
if awk -v p="$BLUR" 'BEGIN { exit !(p > 0) }'; then
  for ((k = 0; k < TWEENS; k++)); do
    sigma=$(awk -v k="$k" -v n="$TWEENS" -v p="$BLUR" \
      'BEGIN { printf "%.2f", sin(atan2(0,-1) * (k+1) / (n+1)) * p }')
    for f in "$work"/tween/*-"$k".png; do magick "$f" -blur "0x$sigma" "$f"; done
  done
fi

# --- 3. Concat list with per-frame durations, then encode ---
list=$work/concat.txt
: >"$list"
for ((i = 0; i < n; i++)); do
  printf "file '%s'\nduration %s\n" "$work/src/$(printf %03d "$i").png" "$HOLD" >>"$list"
  for ((k = 0; k < TWEENS; k++)); do
    printf "file '%s'\nduration %s\n" "$work/tween/$(printf %03d "$i")-$k.png" "$STEP" >>"$list"
  done
done
# The concat demuxer ignores the duration of a trailing entry, so repeat frame 0.
printf "file '%s'\n" "$work/src/000.png" >>"$list"

mkdir -p "$(dirname "$OUT")"
ffmpeg -y -v error -f concat -safe 0 -i "$list" -fps_mode vfr \
  -c:v libwebp_anim -lossless 0 -q:v "$QUALITY" -compression_level 6 -loop 0 -an "$OUT"

echo "$OUT ($(du -h "$OUT" | cut -f1), $(magick identify -format '%wx%h' "$OUT[0]"), $(awk -v n="$n" -v h="$HOLD" -v t="$TWEENS" -v s="$STEP" 'BEGIN{printf "%.1fs", n*(h+t*s)}') loop)"
