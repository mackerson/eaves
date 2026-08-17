#!/usr/bin/env node
/**
 * Derive every logo asset from assets/eaves.svg.
 *
 * eaves.svg is a *line drawing*: the mark is a stroked polyline, not filled
 * regions. Rendering it anywhere that needs a fill (currentColor theming, a
 * macOS template icon, a flat PNG) means baking the stroke into real geometry
 * with Inkscape's stroke-to-path. Simply dropping the stroke is wrong twice
 * over -- it fattens every ribbon by stroke-width and silently deletes any
 * 2-point subpath, which has zero area and so disappears the moment it is
 * filled rather than stroked.
 *
 * Outputs (all generated -- edit eaves.svg, not these):
 *   assets/glyph.svg                              currentColor, tight square
 *   assets/tray-icon.svg                          white, tight square, no halo
 *   assets/icon.svg                               padded + dark halo, for rasterizing
 *   src/renderer/.../eavesGlyphPath.ts            inline path for EavesGlyph.tsx
 *
 * Requires: inkscape. ImageMagick optional (enables the fidelity check).
 * Run via `yarn generate:logo`, or `yarn generate:icons` for this plus rasters.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'assets', 'eaves.svg');
const GLYPH_TS = path.join(ROOT, 'src/renderer/components/ui/eavesGlyphPath.ts');

/** Margin added around the mark for platform app icons, as a fraction of its size. */
const ICON_PADDING = 0.1;
/** Fidelity check fails above this. Antialiasing alone lands well under 0.1%. */
const MAX_DIFF_PERCENT = 0.5;

const log = (msg = '') => console.log(msg);
const fail = (msg) => {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
};

function which(bin) {
  try {
    execFileSync('command', ['-v', bin], { shell: true, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function inkscape(args) {
  return execFileSync('inkscape', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/** ImageMagick 7 ships `magick`; older installs only have `convert`. */
const IM = which('magick') ? 'magick' : which('convert') ? 'convert' : null;

// ---------------------------------------------------------------------------
// Source inspection
// ---------------------------------------------------------------------------

/** Absolute length in CSS px. Inkscape documents are usually authored in mm. */
function toPx(value) {
  const m = /^\s*(-?[\d.]+)\s*([a-z%]*)\s*$/i.exec(value);
  if (!m) return null;
  const n = parseFloat(m[1]);
  switch (m[2].toLowerCase()) {
    case '':
    case 'px': return n;
    case 'mm': return (n * 96) / 25.4;
    case 'cm': return (n * 96) / 2.54;
    case 'in': return n * 96;
    case 'pt': return (n * 96) / 72;
    case 'pc': return n * 16;
    default: return null;
  }
}

function readSource() {
  if (!fs.existsSync(SOURCE)) fail(`Source not found: ${SOURCE}`);
  const svg = fs.readFileSync(SOURCE, 'utf8');

  const viewBox = /\sviewBox="([^"]+)"/.exec(svg)?.[1];
  if (!viewBox) fail('Source has no viewBox.');
  const [, , vbW] = viewBox.trim().split(/[\s,]+/).map(Number);

  const widthAttr = /<svg\b[^>]*?\swidth="([^"]+)"/s.exec(svg)?.[1];
  const widthPx = widthAttr ? toPx(widthAttr) : null;
  if (!widthPx) fail(`Could not read a usable width from the source (<svg width="${widthAttr}">).`);

  // The <path> carrying the artwork -- the first one with real path data.
  const style = /<path\b[^>]*?\sstyle="([^"]*)"/s.exec(svg)?.[1] ?? '';
  const fillMatch = /(?:^|;)\s*fill\s*:\s*([^;]+)/i.exec(style)?.[1]?.trim();
  const strokeWidth = /(?:^|;)\s*stroke-width\s*:\s*([\d.]+)/i.exec(style)?.[1];

  return {
    svg,
    viewBox,
    // User units per rendered px -- lets us convert Inkscape's px bbox back to
    // viewBox coordinates without assuming the document is authored in mm.
    userPerPx: vbW / widthPx,
    filled: Boolean(fillMatch) && fillMatch !== 'none',
    fill: fillMatch ?? '(unset)',
    strokeWidth: strokeWidth ? Number(strokeWidth) : null,
  };
}

// ---------------------------------------------------------------------------
// Stroke -> filled geometry
// ---------------------------------------------------------------------------

/**
 * Bake the stroke into fillable geometry.
 *
 * With `fill:none` the stroke outline *is* the mark, so stroke-to-path alone
 * is the whole conversion. With an actual fill, stroke-to-path yields two
 * paths -- the fill region and the stroke ring painted over it -- and the
 * visible mark is the former minus the latter, so a boolean difference is
 * needed to reproduce what the eye sees.
 */
function strokeToPath(source, tmpDir) {
  const out = path.join(tmpDir, 'converted.svg');
  const actions = source.filled
    ? 'select-all;object-stroke-to-path;select-all;selection-ungroup;selection-ungroup;select-all;path-difference'
    : 'select-all;object-stroke-to-path';

  inkscape([
    SOURCE,
    `--actions=${actions};export-filename:${out};export-plain-svg;export-do`,
  ]);

  if (!fs.existsSync(out)) fail('Inkscape produced no output. Is the source a valid SVG?');

  const svg = fs.readFileSync(out, 'utf8');
  const paths = [...svg.matchAll(/<path\b[^>]*?\sd="([^"]+)"/gs)];
  if (paths.length === 0) fail('Conversion produced no path. Does the source contain artwork?');
  if (paths.length > 1) {
    fail(
      `Conversion produced ${paths.length} paths; expected 1. The source is probably ` +
        `more than one object -- combine them in Inkscape (Path > Union) and retry.`
    );
  }

  return { file: out, d: paths[0][1].replace(/\s+/g, ' ').trim() };
}

/** Visual bbox in viewBox user units. */
function queryBBox(file, userPerPx) {
  const line = inkscape([file, '--query-all']).trim().split('\n')[0];
  const [, x, y, w, h] = line.split(',');
  const n = (v) => Number(v) * userPerPx;
  return { x: n(x), y: n(y), w: n(w), h: n(h) };
}

// ---------------------------------------------------------------------------
// Fidelity check
// ---------------------------------------------------------------------------

/**
 * The converted file keeps the source's viewBox, so it should be pixel-identical
 * to the source. Anything above noise means the conversion lost or moved
 * geometry -- exactly the class of bug that motivated this script.
 */
function verify(convertedFile, tmpDir) {
  if (!IM) {
    log('⚠️  ImageMagick not found -- skipping the fidelity check');
    return null;
  }
  const render = (input, output) => {
    inkscape([
      input,
      '--export-type=png',
      `--export-filename=${output}`,
      '--export-width=700',
      '--export-background=#ffffff',
      '--export-background-opacity=1',
    ]);
    execFileSync(IM, [output, '-resize', '700x700!', output]);
  };

  const a = path.join(tmpDir, 'a.png');
  const b = path.join(tmpDir, 'b.png');
  render(SOURCE, a);
  render(convertedFile, b);

  const pct = Number(
    execFileSync(IM, [
      a, b,
      '-compose', 'difference', '-composite',
      '-colorspace', 'Gray', '-threshold', '25%',
      '-format', '%[fx:100*mean]', 'info:',
    ]).toString()
  );
  return pct;
}

/**
 * Fraction of the canvas covered by non-transparent pixels, or null when
 * ImageMagick is unavailable. Zero means the file drew nothing.
 */
function inkRatio(file, tmpDir) {
  if (!IM) return null;
  const png = path.join(tmpDir, 'ink.png');
  try {
    inkscape([
      file,
      '--export-type=png',
      `--export-filename=${png}`,
      '--export-width=256',
      '--export-height=256',
      '--export-background-opacity=0',
    ]);
    return Number(
      execFileSync(IM, [png, '-alpha', 'extract', '-format', '%[fx:mean]', 'info:']).toString()
    );
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

const BANNER = (strokeWidth) => `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!--
  GENERATED from assets/eaves.svg -- do not edit by hand.

  eaves.svg is a line drawing (${strokeWidth ? `stroke-width ${strokeWidth}` : 'stroked'}); the stroke IS the artwork, so it is
  baked into filled geometry here via Inkscape stroke-to-path rather than
  dropped. Verified pixel-identical to the source at generation time.

  Regenerate with: yarn generate:icons
-->
`;

function svgDocument({ banner, viewBox, body }) {
  return `${banner}<svg
   xmlns="http://www.w3.org/2000/svg"
   viewBox="${viewBox}"
   width="149mm"
   height="149mm"
   version="1.1">
${body}
</svg>
`;
}

function main() {
  if (!which('inkscape')) {
    fail('Inkscape is required.\n   Arch: sudo pacman -S inkscape   Debian: sudo apt install inkscape');
  }

  log('🎨 Eaves Logo Generator');
  log('========================\n');

  const source = readSource();
  log(`   source     assets/eaves.svg`);
  log(`   fill       ${source.fill}${source.filled ? '' : '  (line drawing)'}`);
  log(`   stroke     ${source.strokeWidth ?? '(unset)'}`);
  log(`   mode       ${source.filled ? 'stroke-to-path + difference' : 'stroke-to-path'}\n`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eaves-logo-'));
  try {
    const converted = strokeToPath(source, tmpDir);

    const diff = verify(converted.file, tmpDir);
    if (diff !== null) {
      if (diff > MAX_DIFF_PERCENT) {
        fail(
          `Converted geometry differs from the source by ${diff.toFixed(3)}% ` +
            `(limit ${MAX_DIFF_PERCENT}%).\n   Nothing was written. This usually means the ` +
            `source has an open subpath or an effect stroke-to-path cannot reproduce.`
        );
      }
      log(`✅ Fidelity: ${diff.toFixed(3)}% differing vs source (limit ${MAX_DIFF_PERCENT}%)\n`);
    }

    // The mark is wider than it is tall (or vice versa); square the frame around
    // it so every downstream square export centres the art instead of stretching.
    const bb = queryBBox(converted.file, source.userPerPx);
    const side = Math.max(bb.w, bb.h);
    const x = bb.x - (side - bb.w) / 2;
    const y = bb.y - (side - bb.h) / 2;
    const r = (v) => v.toFixed(4);

    const tight = `${r(x)} ${r(y)} ${r(side)} ${r(side)}`;
    const pad = side * ICON_PADDING;
    const padded = `${r(x - pad)} ${r(y - pad)} ${r(side + 2 * pad)} ${r(side + 2 * pad)}`;

    log(`   bbox       ${r(bb.w)} x ${r(bb.h)} user units`);
    log(`   tight      ${tight}`);
    log(`   padded     ${padded}  (${ICON_PADDING * 100}% margin)\n`);

    // Inkscape keeps the artwork under the layer's transform; carry it through
    // verbatim rather than folding it into the coordinates.
    const transform = /<g\b[^>]*?\stransform="([^"]+)"/s.exec(
      fs.readFileSync(converted.file, 'utf8')
    )?.[1];
    const banner = BANNER(source.strokeWidth);
    const indent = (block, pad) =>
      block
        .split('\n')
        .map((line) => pad + line)
        .join('\n');

    const pathEl = (fill) => {
      const el = `<path\n   fill="${fill}"\n   d="${converted.d}" />`;
      const inner = transform
        ? `<g transform="${transform}">\n${indent(el, '  ')}\n</g>`
        : el;
      return indent(inner, '  ');
    };

    const write = (rel, contents) => {
      const abs = path.join(ROOT, rel);
      fs.writeFileSync(abs, contents);
      // A malformed SVG renders as a fully transparent PNG rather than an
      // error, so every packaged icon can silently go blank. Check the ink.
      const ink = inkRatio(abs, tmpDir);
      if (ink !== null && ink <= 0) {
        fail(`${rel} renders completely empty. The generated markup is malformed.`);
      }
      log(`   ✓ ${rel}${ink === null ? '' : `  (${(ink * 100).toFixed(1)}% ink)`}`);
    };

    log('📦 Writing vector assets...');
    write('assets/glyph.svg', svgDocument({ banner, viewBox: tight, body: pathEl('currentColor') }));
    write(
      'assets/tray-icon.svg',
      svgDocument({ banner, viewBox: tight, body: pathEl('#ffffff') })
    );
    write(
      'assets/icon.svg',
      `${banner}<svg
   xmlns="http://www.w3.org/2000/svg"
   viewBox="${padded}"
   width="149mm"
   height="149mm"
   version="1.1">
  <defs>
    <!-- Keeps a light mark legible on a light desktop background. Deliberately
         tight: a wide blur turns thin strokes to mush. -->
    <filter id="dark-halo" x="-20%" y="-20%" width="140%" height="140%"
            color-interpolation-filters="sRGB">
      <feFlood flood-color="#000000" flood-opacity="0.45" result="color" />
      <feComposite in="color" in2="SourceGraphic" operator="in" result="shadow-shape" />
      <feGaussianBlur in="shadow-shape" stdDeviation="1.2" result="halo" />
      <feMerge>
        <feMergeNode in="halo" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  </defs>
  <g filter="url(#dark-halo)">
${pathEl('#fafafa')}
  </g>
</svg>
`
    );

    const tsRel = path.relative(ROOT, GLYPH_TS);
    fs.writeFileSync(
      GLYPH_TS,
      `// GENERATED from assets/eaves.svg -- do not edit by hand.
// Regenerate with: yarn generate:icons
//
// Inlined rather than imported as a file so the mark can inherit \`currentColor\`
// and follow the active theme; an <img> src cannot.

export const EAVES_GLYPH_VIEW_BOX = '${tight}';

${transform ? `export const EAVES_GLYPH_TRANSFORM = '${transform}';\n\n` : ''}export const EAVES_GLYPH_PATH =
  '${converted.d}';
`
    );
    log(`   ✓ ${tsRel}`);

    log('\n========================');
    log('✅ Logo assets generated\n');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
