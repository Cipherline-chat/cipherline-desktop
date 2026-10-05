import { useCallback, useState } from 'react';

/**
 * Wraps a modal's `onClose` so closes visibly animate out before unmount.
 *
 * Pattern for a modal's JSX:
 *   const { closing, handleClose } = useModalExit(onClose);
 *   <div className={closing ? 'animate-out fade-out duration-150' : 'animate-in fade-in duration-150'} onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}>
 *     <div className={closing ? 'animate-out fade-out zoom-out-95 duration-150' : 'animate-in fade-in zoom-in-95 duration-200'}>
 *       … every internal close button / cancel action must call handleClose (not the raw onClose) …
 *     </div>
 *   </div>
 *
 * The CSS `animate-out` shim in index.css animates toward opacity:0 / scale:0.95
 * for the duration configured here; the timeout fires the real onClose so the
 * component actually unmounts after the animation plays.
 */
export function useModalExit(onClose: () => void, durationMs = 150) {
    const [closing, setClosing] = useState(false);

    const handleClose = useCallback(() => {
        if (closing) return;
        setClosing(true);
        window.setTimeout(onClose, durationMs);
    }, [closing, onClose, durationMs]);

    return { closing, handleClose };
}
