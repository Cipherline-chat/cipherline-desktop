import React, { useMemo } from 'react';
import { Crown } from 'lucide-react';
import { ClRole } from './cl/ClMisc';
import { useClTooltip } from './cl/useClTooltip';
import { formatProSinceTooltip } from '../utils/proSince';

/**
 * The gold "Pro" pill, with a "Pro member since March 2026 · 7 months" hover
 * and keyboard-focus tooltip when the server says when the Pro period began.
 *
 * `proSince` is the API's month-precision "YYYY-MM" (`pro_since` on the public
 * profile). When it is absent (an older server), null (a comped account), or
 * malformed, the pill renders exactly as it always did: no tab stop, no
 * tooltip, same markup. The pill is display only - it grants nothing.
 */
export interface ProPillProps {
    proSince?: string | null;
    style?: React.CSSProperties;
}

export const ProPill: React.FC<ProPillProps> = ({ proSince, style }) => {
    // Memoised: `useClTooltip` re-measures when its text identity changes.
    const tip = useMemo(() => formatProSinceTooltip(proSince), [proSince]);
    const { anchorProps, tooltip, describedBy } = useClTooltip(tip);
    const { ref, ...handlers } = anchorProps;

    const pill = (
        <ClRole variant="gold" style={{ fontSize: 11, ...style }}>
            <Crown size={11} aria-hidden /> Pro
        </ClRole>
    );
    if (!tip) return pill;

    return (
        <span
            ref={ref as React.Ref<HTMLSpanElement>}
            {...handlers}
            tabIndex={0}
            role="img"
            aria-label={tip}
            aria-describedby={describedBy}
            data-testid="pro-pill"
            className="inline-flex items-center cursor-default rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        >
            {pill}
            {tooltip}
        </span>
    );
};

export default ProPill;
