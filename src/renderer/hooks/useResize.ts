import { useState, useCallback, useEffect } from 'react';

interface UseResizeOptions {
  initialSize: number;
  minSize: number;
  maxSize: number;
  storageKey?: string;
  direction?: 'horizontal' | 'vertical';
  /** Set to true for bottom panels where dragging up should increase size */
  invertDelta?: boolean;
}

export function useResize({ initialSize, minSize, maxSize, storageKey, direction = 'horizontal', invertDelta = false }: UseResizeOptions) {
  // Load from localStorage if storageKey provided
  const savedSize = storageKey ? localStorage.getItem(storageKey) : null;
  const [size, setSize] = useState(savedSize ? parseInt(savedSize, 10) : initialSize);
  const [isResizing, setIsResizing] = useState(false);

  const startResize = useCallback(() => {
    setIsResizing(true);
  }, []);

  const stopResize = useCallback(() => {
    setIsResizing(false);
  }, []);

  // No `resizeDirection` parameter. Every call site used the default, and
  // inversion is already expressed by `invertDelta` — two knobs for one
  // behaviour, one of them dead.
  const resize = useCallback(
    (delta: number) => {
      setSize((prevSize) => {
        const newSize = Math.min(Math.max(prevSize + delta, minSize), maxSize);

        // Save to localStorage if storageKey provided
        if (storageKey) {
          localStorage.setItem(storageKey, newSize.toString());
        }

        return newSize;
      });
    },
    [minSize, maxSize, storageKey]
  );

  useEffect(() => {
    if (!isResizing) return;

    // `null`, not `0`. The old sentinel was `lastPos !== 0`, so a move event
    // at exactly clientX/clientY 0 — the very edge of the window, which is
    // where a resize handle often is — was treated as "no previous position"
    // and its delta was dropped.
    let lastPos: number | null = null;

    const handleMouseMove = (e: MouseEvent) => {
      const currentPos = direction === 'horizontal' ? e.clientX : e.clientY;
      if (lastPos !== null) {
        let delta = currentPos - lastPos;
        // For bottom panels, dragging up (negative delta) should increase size
        if (invertDelta) {
          delta = -delta;
        }
        resize(delta);
      }
      lastPos = currentPos;
    };

    const endResize = () => {
      stopResize();
      lastPos = null;
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', endResize);
    // Release the drag when the pointer leaves the window or the window loses
    // focus. With `document` listeners alone, a mouseup outside the window is
    // never seen, so the panel stayed glued to the cursor after the button was
    // released — every subsequent mouse move kept resizing it.
    document.addEventListener('mouseleave', endResize);
    window.addEventListener('blur', endResize);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', endResize);
      document.removeEventListener('mouseleave', endResize);
      window.removeEventListener('blur', endResize);
    };
  }, [isResizing, resize, stopResize, direction, invertDelta]);

  return {
    size,
    isResizing,
    startResize,
    setSize,
  };
}
