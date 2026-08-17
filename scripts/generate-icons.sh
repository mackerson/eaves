#!/bin/bash
#
# Generate Icons from SVG
#
# Two stages:
#   1. scripts/generate-logo.mjs derives the vector assets from the single
#      source of truth, assets/eaves.svg (see that file for why the stroke has
#      to be baked rather than dropped).
#   2. This script rasterizes them into every platform format and size.
#
# Edit assets/eaves.svg and re-run this; everything else is generated.
#
# Requirements:
#   - Inkscape (for SVG → PNG conversion)
#   - ImageMagick (for .ico generation)
#   - iconutil (macOS only, for .icns generation)
#
# Usage:
#   ./scripts/generate-icons.sh

set -e  # Exit on error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_SVG="$PROJECT_ROOT/assets/eaves.svg"
# All derived by generate-logo.mjs below -- do not hand-edit.
LOGO_SVG="$PROJECT_ROOT/assets/icon.svg"
TRAY_SVG="$PROJECT_ROOT/assets/tray-icon.svg"
GLYPH_SVG="$PROJECT_ROOT/assets/glyph.svg"
ICONS_DIR="$PROJECT_ROOT/assets/icons"

echo "🎨 Eaves Icon Generator"
echo "========================"
echo ""

# Only the hand-authored source needs to pre-exist; the rest is generated.
if [ ! -f "$SOURCE_SVG" ]; then
  echo "❌ Error: eaves.svg not found at $SOURCE_SVG"
  exit 1
fi

# Check for required tools
check_command() {
  if ! command -v "$1" &> /dev/null; then
    echo "⚠️  Warning: $1 not found. Install with:"
    echo "   $2"
    return 1
  fi
  return 0
}

has_inkscape=true
has_imagemagick=true

if ! check_command inkscape "sudo apt install inkscape (Linux) or brew install inkscape (macOS)"; then
  has_inkscape=false
fi

# ImageMagick 7 renamed the entrypoint to `magick` and warns on every `convert`.
if command -v magick &> /dev/null; then
  IM=magick
elif command -v convert &> /dev/null; then
  IM=convert
else
  check_command convert "sudo apt install imagemagick (Linux) or brew install imagemagick (macOS)" || true
  has_imagemagick=false
fi

if [ "$has_inkscape" = false ]; then
  echo ""
  echo "❌ Inkscape is required for SVG → PNG conversion"
  exit 1
fi

echo ""
echo "✅ All required tools found"
echo ""

# Stage 1: derive the vector assets from assets/eaves.svg. Regenerates
# icon.svg / tray-icon.svg / glyph.svg, so it has to run before rasterizing.
node "$PROJECT_ROOT/scripts/generate-logo.mjs"

# Create icons directory if it doesn't exist
mkdir -p "$ICONS_DIR"

# PNG sizes needed for various platforms
PNG_SIZES=(16 32 48 64 128 256 512 1024)

echo "📦 Generating PNG icons..."
for size in "${PNG_SIZES[@]}"; do
  output="$ICONS_DIR/icon-${size}.png"
  echo "   Creating ${size}x${size} → $(basename $output)"

  inkscape "$LOGO_SVG" \
    --export-type=png \
    --export-filename="$output" \
    --export-width=$size \
    --export-height=$size \
    --export-background-opacity=0 \
    > /dev/null 2>&1
done

# Main icon (512x512)
echo "   Creating 512x512 → icon.png"
cp "$ICONS_DIR/icon-512.png" "$ICONS_DIR/icon.png"

echo "✅ PNG icons generated"
echo ""

# Generate .ico for Windows
if [ "$has_imagemagick" = true ]; then
  echo "🪟 Generating Windows .ico..."

  # .ico needs multiple sizes embedded
  "$IM" \
    "$ICONS_DIR/icon-16.png" \
    "$ICONS_DIR/icon-32.png" \
    "$ICONS_DIR/icon-48.png" \
    "$ICONS_DIR/icon-256.png" \
    "$ICONS_DIR/icon.ico"

  echo "✅ icon.ico generated"
  echo ""
else
  echo "⚠️  Skipping .ico generation (ImageMagick not found)"
  echo ""
fi

# Generate .icns for macOS
if command -v iconutil &> /dev/null; then
  echo "🍎 Generating macOS .icns..."

  # Create iconset directory
  ICONSET="$ICONS_DIR/icon.iconset"
  rm -rf "$ICONSET"
  mkdir -p "$ICONSET"

  # Copy and rename PNGs to iconset format
  # macOS needs specific naming: icon_SIZExSIZE.png and icon_SIZExSIZE@2x.png
  cp "$ICONS_DIR/icon-16.png"   "$ICONSET/icon_16x16.png"
  cp "$ICONS_DIR/icon-32.png"   "$ICONSET/icon_16x16@2x.png"
  cp "$ICONS_DIR/icon-32.png"   "$ICONSET/icon_32x32.png"
  cp "$ICONS_DIR/icon-64.png"   "$ICONSET/icon_32x32@2x.png"
  cp "$ICONS_DIR/icon-128.png"  "$ICONSET/icon_128x128.png"
  cp "$ICONS_DIR/icon-256.png"  "$ICONSET/icon_128x128@2x.png"
  cp "$ICONS_DIR/icon-256.png"  "$ICONSET/icon_256x256.png"
  cp "$ICONS_DIR/icon-512.png"  "$ICONSET/icon_256x256@2x.png"
  cp "$ICONS_DIR/icon-512.png"  "$ICONSET/icon_512x512.png"
  cp "$ICONS_DIR/icon-1024.png" "$ICONSET/icon_512x512@2x.png"

  # Convert iconset to icns
  iconutil -c icns "$ICONSET" -o "$ICONS_DIR/icon.icns"

  # Clean up iconset
  rm -rf "$ICONSET"

  echo "✅ icon.icns generated"
  echo ""
else
  echo "⚠️  Skipping .icns generation (iconutil not found - macOS only)"
  echo ""
fi

# Generate tray icons
echo "🔔 Generating tray icons..."

# The tray renders at 16px, where icon.svg's halo and margin turn to mush.
# tray-icon.svg is the same mark cropped tight with no halo.
echo "   Creating tray icons (16x16 and 32x32)"
inkscape "$TRAY_SVG" \
  --export-type=png \
  --export-filename="$ICONS_DIR/tray-icon.png" \
  --export-width=16 \
  --export-height=16 \
  --export-background-opacity=0 \
  > /dev/null 2>&1

inkscape "$TRAY_SVG" \
  --export-type=png \
  --export-filename="$ICONS_DIR/tray-icon@2x.png" \
  --export-width=32 \
  --export-height=32 \
  --export-background-opacity=0 \
  > /dev/null 2>&1

# macOS template images are recolored from alpha alone, so the RGB must be
# black -- a copy of the white tray icon renders as a blob in the menu bar.
if [ "$has_imagemagick" = true ]; then
  "$IM" "$ICONS_DIR/tray-icon@2x.png" \
    -channel RGB -evaluate set 0 +channel \
    "$ICONS_DIR/tray-iconTemplate.png"
else
  echo "⚠️  ImageMagick not found; tray-iconTemplate.png left as a white copy"
  cp "$ICONS_DIR/tray-icon.png" "$ICONS_DIR/tray-iconTemplate.png"
fi

echo "✅ Tray icons generated"
echo ""

# Generate README logos
echo "📖 Generating README logos..."

# The README renders on whatever theme the reader picked, so it needs both inks
# and a <picture> element to choose between them. glyph.svg is currentColor,
# which rasterizes to black -- the right ink for a light page; tray-icon.svg is
# already white for a dark one.
inkscape "$GLYPH_SVG" \
  --export-type=png \
  --export-filename="$ICONS_DIR/logo-light-bg.png" \
  --export-width=256 \
  --export-height=256 \
  --export-background-opacity=0 \
  > /dev/null 2>&1

inkscape "$TRAY_SVG" \
  --export-type=png \
  --export-filename="$ICONS_DIR/logo-dark-bg.png" \
  --export-width=256 \
  --export-height=256 \
  --export-background-opacity=0 \
  > /dev/null 2>&1

echo "✅ README logos generated"
echo ""

# Summary
echo "========================"
echo "✅ Icon generation complete!"
echo ""
echo "Generated files in assets/icons/:"
echo "  • PNG icons: 16, 32, 48, 64, 128, 256, 512, 1024"
echo "  • icon.png (512x512 main icon)"

if [ "$has_imagemagick" = true ]; then
  echo "  • icon.ico (Windows)"
fi

if command -v iconutil &> /dev/null; then
  echo "  • icon.icns (macOS)"
fi

echo "  • tray-icon.png, tray-icon@2x.png, tray-iconTemplate.png"
echo "  • logo-light-bg.png, logo-dark-bg.png (README)"
echo ""
