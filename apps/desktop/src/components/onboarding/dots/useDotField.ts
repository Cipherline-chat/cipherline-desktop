import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import { tryCreateDotField } from './engine';
import type { DotField, DotFieldOptions } from './engine';

/* React StrictMode (src/main.tsx) mounts, unmounts and remounts every effect
   in dev. destroy() deletes the field's GL objects and shrinks the canvas, so
   a naive destroy-in-cleanup would leave the second mount with a gutted
   field (and a context that was ever lost can never be re-acquired on the
   same canvas). Cleanup therefore defers the destroy
   by one macrotask; a remount on the same canvas inside that window takes the
   still-live field back instead of creating one. A real unmount has no
   remount, so the timer fires and the field is destroyed. */
const pendingDestroy = new WeakMap<HTMLCanvasElement, { field: DotField; timer: number }>();

/**
 * Create a DotField on the canvas after mount; destroy it on unmount.
 * Returns null until mounted, and permanently null when WebGL is
 * unavailable (never throws). `opts` is read once, at creation.
 */
export function useDotField(canvasRef: RefObject<HTMLCanvasElement | null>, opts: DotFieldOptions = {}): DotField | null {
  const [field, setField] = useState<DotField | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    let f: DotField | null;
    const pending = pendingDestroy.get(canvas);
    if (pending) {
      window.clearTimeout(pending.timer);
      pendingDestroy.delete(canvas);
      f = pending.field;
    } else {
      f = tryCreateDotField(canvas, opts);
    }
    setField(f);
    return () => {
      setField(null);
      if (!f) return;
      const mine = f;
      const timer = window.setTimeout(() => {
        pendingDestroy.delete(canvas);
        mine.destroy();
      }, 0);
      pendingDestroy.set(canvas, { field: mine, timer });
    };
    // creation options are deliberately not dependencies: one field per canvas
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasRef]);
  return field;
}
