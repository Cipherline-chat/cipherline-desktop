import React, { useRef } from 'react';
import { playIco } from '../../utils/clPhysics';
import { bumpStreak, firesAt, type Streak } from '../../utils/eggStreak';

interface ClToggleProps {
    checked: boolean;
    onChange: (v: boolean) => void;
    disabled?: boolean;
    className?: string;
    'aria-label'?: string;
}

/** Flips within this window keep the streak alive (catalog: 6 in 3s). */
const JIG_WINDOW_MS = 3000;
const JIG_AT = 6;

/** Toggle — guide markup verbatim: `.clt` button + `.tsh`/`.trk`/`.knob`. */
export const ClToggle: React.FC<ClToggleProps> = ({
    checked, onChange, disabled, className, ...rest
}) => {
    const knobRef = useRef<HTMLSpanElement>(null);
    const streakRef = useRef<Streak | undefined>(undefined);
    const jiggedRef = useRef(false);

    const handleClick = () => {
        if (disabled) return;
        const next = !checked;
        onChange(next);

        // Knob jig (catalog): mash the toggle and the knob shakes in place.
        // ONLY when the flip lands ON — @keyframes jig runs from
        // translateX(17px) to 26px, anchored at the .clt.on position (22px),
        // so playing it while the knob sits at 0 teleports it across the
        // track and back. Fires once per mount (rule 6); playIco owns the
        // reduced-motion check (rule 9) and the 180ms grace (rule 10).
        const s = bumpStreak(streakRef.current, Date.now(), JIG_WINDOW_MS);
        streakRef.current = s;
        if (next && firesAt(s, JIG_AT) && !jiggedRef.current) {
            jiggedRef.current = true;
            playIco(knobRef.current, 'jig');
        }
    };

    return (
        <span className="cl-kit" style={{ display: 'contents' }}>
            <button
                type="button"
                role="switch"
                aria-checked={checked}
                disabled={disabled}
                onClick={handleClick}
                className={['clt', checked ? 'on' : '', className ?? ''].filter(Boolean).join(' ')}
                style={disabled ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
                {...rest}
            >
                <span className="tsh" />
                <span className="trk" />
                <span className="knob" ref={knobRef} />
            </button>
        </span>
    );
};

export default ClToggle;
