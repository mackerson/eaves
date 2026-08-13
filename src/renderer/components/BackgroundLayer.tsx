import { useEffect, useState } from 'react';
import { useSettingsStore } from '@/stores/useSettingsStore';

/**
 * BackgroundLayer renders a fixed background behind all app content.
 * Supports local images, URLs (cached), and CSS gradients.
 * Includes opacity overlay and optional blur effect.
 */
export function BackgroundLayer() {
  const background = useSettingsStore((state) => state.settings.background);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Resolve the background image source
  useEffect(() => {
    if (!background || background.type === 'none' || background.type === 'gradient') {
      setImageSrc(null);
      return;
    }

    // Cancellation token. Changing the background twice quickly let the
    // slower first resolution win — the losing async chain still called
    // setImageSrc with a stale URL, and its setIsLoading(false) could land
    // before the newer one even started, leaving isLoading stuck true.
    let cancelled = false;

    const resolveImage = async () => {
      setIsLoading(true);

      if (background.type === 'local') {
        // Local file - value is a background:// protocol URL from the picker
        if (!cancelled) setImageSrc(background.value);
      } else if (background.type === 'url') {
        // Remote URL - check cache first, then load
        try {
          const cached = await window.electron.getCachedBackground(background.value);
          if (cancelled) return;
          if (cached.cached && cached.path) {
            // Path is now a background:// protocol URL
            setImageSrc(cached.path);
          } else {
            // Cache the image for future use
            const result = await window.electron.cacheBackgroundUrl(background.value);
            if (cancelled) return;
            if (result.success && result.path) {
              // Path is now a background:// protocol URL
              setImageSrc(result.path);
            } else {
              // Fallback to direct URL (for https:// URLs, CSP allows this)
              setImageSrc(background.value);
            }
          }
        } catch {
          // Fallback to direct URL on error
          if (!cancelled) setImageSrc(background.value);
        }
      }

      if (!cancelled) setIsLoading(false);
    };

    resolveImage();
    return () => { cancelled = true; };
  }, [background?.type, background?.value]);

  // Don't render if no background configured
  if (!background || background.type === 'none') {
    return null;
  }

  const { type, value, opacity, blur } = background;

  // Calculate styles
  // Use z-index 0 so it's in the normal stacking context but behind other content
  // The app-layout and other containers have higher z-index via their stacking context
  const containerStyle: React.CSSProperties = {
    position: 'fixed',
    inset: 0,
    zIndex: 0,
    pointerEvents: 'none',
    overflow: 'hidden',
  };

  const imageStyle: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    filter: blur > 0 ? `blur(${blur}px)` : undefined,
    // Scale slightly when blurring to prevent edge artifacts
    transform: blur > 0 ? 'scale(1.05)' : undefined,
  };

  const gradientStyle: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    background: value,
    filter: blur > 0 ? `blur(${blur}px)` : undefined,
  };

  const overlayStyle: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    backgroundColor: 'var(--bg-primary)',
    opacity: 1 - opacity, // Invert: opacity=1 means fully visible background, opacity=0 means fully hidden
  };

  return (
    <div style={containerStyle} className="background-layer">
      {/* Background content */}
      {type === 'gradient' ? (
        <div style={gradientStyle} />
      ) : imageSrc ? (
        <img
          src={imageSrc}
          alt=""
          style={imageStyle}
          onError={() => setImageSrc(null)}
        />
      ) : isLoading ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-8 h-8 border-2 border-accent-primary border-t-transparent rounded-full animate-spin" />
        </div>
      ) : null}

      {/* Opacity overlay */}
      <div style={overlayStyle} />
    </div>
  );
}
