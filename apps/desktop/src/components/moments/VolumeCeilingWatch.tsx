import React, { useRef } from 'react';
import { CEILING_KEYS, ceilingPush, requestMoment } from '../../utils/moments';

/**
 * Wrap a volume slider to notice someone trying to take it past 200%
 * ("Keys would like his ears back."). A push is a drag that carries on past
 * the slider's right end, or an increase key (→ ↑ PgUp End), while the slider
 * already sits at its max; three inside a few seconds asks for the moment.
 *
 * Reads only the slider's own ARIA state (`aria-valuenow` / `aria-valuemax`
 * on the role="slider" element — ClSlider keeps it live during a drag) and
 * the pointer position. Changes nothing: the slider behaves exactly as before.
 * `display: contents`, so layout is untouched; ClSlider (a cl/ primitive the
 * website shares) is not modified.
 */
export const VolumeCeilingWatch: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const times = useRef<number[]>([]);
    const pushedThisDrag = useRef(false);

    const sliderAtMax = (target: EventTarget | null): Element | null => {
        const el = (target as Element | null)?.closest?.('[role="slider"]') ?? null;
        if (!el) return null;
        const now = Number(el.getAttribute('aria-valuenow'));
        const max = Number(el.getAttribute('aria-valuemax'));
        return Number.isFinite(now) && Number.isFinite(max) && now >= max ? el : null;
    };
    const push = () => {
        const r = ceilingPush(times.current, Date.now());
        times.current = r.times;
        if (r.fire) requestMoment('volume-ceiling');
    };

    return (
        <span
            style={{ display: 'contents' }}
            data-volume-ceiling-watch=""
            onPointerDown={() => { pushedThisDrag.current = false; }}
            onPointerMove={e => {
                if (!(e.buttons & 1) || pushedThisDrag.current) return;
                const el = sliderAtMax(e.target);
                if (!el) return;
                if (e.clientX > el.getBoundingClientRect().right + 24) { pushedThisDrag.current = true; push(); }
            }}
            onKeyDown={e => { if (CEILING_KEYS.has(e.key) && sliderAtMax(e.target)) push(); }}
        >
            {children}
        </span>
    );
};

export default VolumeCeilingWatch;
