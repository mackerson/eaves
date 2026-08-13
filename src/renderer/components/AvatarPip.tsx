import { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as DialogPrimitive from '@radix-ui/react-dialog';

interface AvatarPipProps {
  /** Bare filename under userData/avatars, served by the avatar:// protocol. */
  avatar?: string;
  name: string;
  color: string;
}

/** Approximate hover-card footprint used to clamp it inside the viewport. */
const CARD_W = 272;
const CARD_H = 360;
const EDGE_GAP = 8;
const HOVER_DELAY_MS = 250;

/**
 * Pip with artwork: hovering shows a full-art preview card next to the pip,
 * clicking opens a lightbox with the art at full size.
 */
function AvatarArtPip({ avatar, name }: { avatar: string; name: string }) {
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const hoverTimer = useRef<number | null>(null);

  const clearHover = () => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    setHoverPos(null);
  };

  useEffect(() => clearHover, []);

  const handleMouseEnter = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    hoverTimer.current = window.setTimeout(() => {
      // Prefer the right of the pip; flip left when it would clip.
      let x = rect.right + EDGE_GAP;
      if (x + CARD_W > window.innerWidth - EDGE_GAP) {
        x = Math.max(EDGE_GAP, rect.left - EDGE_GAP - CARD_W);
      }
      const y = Math.max(EDGE_GAP, Math.min(rect.top, window.innerHeight - CARD_H - EDGE_GAP));
      setHoverPos({ x, y });
    }, HOVER_DELAY_MS);
  };

  return (
    <>
      <button
        type="button"
        className="p-0 border-0 bg-transparent flex-shrink-0 rounded-full cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
        aria-label={`View ${name}'s avatar art`}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={clearHover}
        onClick={() => {
          clearHover();
          setLightboxOpen(true);
        }}
      >
        <img
          src={`avatar://${avatar}`}
          alt=""
          className="w-5 h-5 rounded-full object-cover block"
        />
      </button>

      {hoverPos &&
        createPortal(
          <div
            className="fixed z-[1000] pointer-events-none"
            style={{ left: hoverPos.x, top: hoverPos.y }}
          >
            <div className="rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] shadow-xl overflow-hidden">
              <img
                src={`avatar://${avatar}`}
                alt={name}
                className="block max-w-[16rem] max-h-[20rem] object-contain"
              />
              <div className="px-2 py-1 text-xs font-medium text-center truncate text-[var(--text-primary)]">
                {name}
              </div>
            </div>
          </div>,
          document.body,
        )}

      <DialogPrimitive.Root open={lightboxOpen} onOpenChange={setLightboxOpen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-[1001] bg-black/80 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
          <DialogPrimitive.Content
            className="fixed left-1/2 top-1/2 z-[1001] -translate-x-1/2 -translate-y-1/2 cursor-zoom-out"
            // inline: the app's global :focus outline outranks Tailwind's outline-none
            style={{ outline: 'none' }}
            onClick={() => setLightboxOpen(false)}
            aria-describedby={undefined}
          >
            <img
              src={`avatar://${avatar}`}
              alt={name}
              className="max-h-[85vh] max-w-[85vw] rounded-lg shadow-2xl"
            />
            <DialogPrimitive.Title className="mt-2 text-center text-sm text-white/90">
              {name}
            </DialogPrimitive.Title>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}

/**
 * Small round sender marker for message rows and participant lists: the
 * avatar image when one is set (hover previews the full art, click opens
 * it in a lightbox), a colored-initial circle otherwise.
 */
export const AvatarPip = memo(function AvatarPip({ avatar, name, color }: AvatarPipProps) {
  if (avatar) {
    return <AvatarArtPip avatar={avatar} name={name} />;
  }
  return (
    <span
      className="w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-semibold text-white flex-shrink-0"
      style={{ backgroundColor: color }}
    >
      {(name.trim()[0] || '?').toUpperCase()}
    </span>
  );
});
