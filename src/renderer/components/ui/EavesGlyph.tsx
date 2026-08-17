import {
  EAVES_GLYPH_PATH,
  EAVES_GLYPH_TRANSFORM,
  EAVES_GLYPH_VIEW_BOX,
} from './eavesGlyphPath';

interface EavesGlyphProps {
  className?: string;
  style?: React.CSSProperties;
}

export function EavesGlyph({ className, style }: EavesGlyphProps) {
  return (
    <svg
      viewBox={EAVES_GLYPH_VIEW_BOX}
      fill="currentColor"
      className={className}
      style={style}
      aria-label="Eaves"
    >
      <g transform={EAVES_GLYPH_TRANSFORM}>
        <path d={EAVES_GLYPH_PATH} />
      </g>
    </svg>
  );
}
