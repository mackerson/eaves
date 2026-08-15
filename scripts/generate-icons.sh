#!/bin/bash
#
# Generate Icons from SVG
# Converts assets/icon.svg into all required icon formats and sizes
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
LOGO_SVG="$PROJECT_ROOT/assets/icon.svg"
ICONS_DIR="$PROJECT_ROOT/assets/icons"

echo "🎨 Eaves Icon Generator"
echo "========================"
echo ""

# Check if logo.svg exists
if [ ! -f "$LOGO_SVG" ]; then
  echo "❌ Error: icon.svg not found at $LOGO_SVG"
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

if ! check_command convert "sudo apt install imagemagick (Linux) or brew install imagemagick (macOS)"; then
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
  convert \
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

# Tray icons should be simple, monochrome icons
# For now, we'll use scaled versions of the main icon
# You may want to create a separate tray-icon.svg with a simpler design

echo "   Creating tray icons (16x16 and 32x32)"
inkscape "$LOGO_SVG" \
  --export-type=png \
  --export-filename="$ICONS_DIR/tray-icon.png" \
  --export-width=16 \
  --export-height=16 \
  --export-background-opacity=0 \
  > /dev/null 2>&1

inkscape "$LOGO_SVG" \
  --export-type=png \
  --export-filename="$ICONS_DIR/tray-icon@2x.png" \
  --export-width=32 \
  --export-height=32 \
  --export-background-opacity=0 \
  > /dev/null 2>&1

# Template icon for macOS (should be monochrome)
cp "$ICONS_DIR/tray-icon.png" "$ICONS_DIR/tray-iconTemplate.png"

echo "✅ Tray icons generated"
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
echo ""
echo "📝 Note: For best tray icon results on macOS, create a separate"
echo "   monochrome SVG at assets/tray-icon.svg and update this script."
echo ""
