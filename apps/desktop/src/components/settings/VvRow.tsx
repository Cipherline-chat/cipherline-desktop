import React from 'react';
import { InfoTip } from './InfoTip';

/**
 * The one row shape of Settings → Voice & Video (and its per-device editor).
 *
 * `field`: name in a fixed label column, control fills the rest (selects,
 * sliders, meters). `switch`: name takes the width, control hugs the right
 * edge. `block`: name on top, control full width under it (option cards).
 * `note`: a short line that must be read without opening the "i" — under the
 * name. `labels` are settings-search labels that are not literally on screen
 * (revealSetting matches data-labels).
 */
export const VvRow: React.FC<{
    label: string;
    info?: React.ReactNode;
    note?: React.ReactNode;
    kind?: 'field' | 'switch' | 'block';
    labels?: string[];
    children: React.ReactNode;
}> = ({ label, info, note, kind = 'field', labels, children }) => (
    <div className={`vv-row vv-row--${kind}`} data-labels={labels?.join('|') || undefined}>
        <div className="vv-labcol">
            <div className="vv-lab">
                <b>{label}</b>
                {info && <InfoTip label={label}>{info}</InfoTip>}
            </div>
            {note && <p className="vv-rnote">{note}</p>}
        </div>
        <div className="vv-ctl" role="group" aria-label={label}>{children}</div>
    </div>
);
