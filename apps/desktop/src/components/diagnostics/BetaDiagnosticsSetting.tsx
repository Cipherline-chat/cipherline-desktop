import React, { useSyncExternalStore } from 'react';
import { ClToggle } from '../cl';
import { betaReporter } from '../../utils/betaDiagnostics/reporter';
import { setBetaDiagEnabled, useBetaDiagEnabled } from '../../utils/betaDiagnostics/settings';
import './betaDiagnostics.css';

const subscribeState = (cb: () => void) => betaReporter.subscribe(cb);
const readServerEnabled = () => betaReporter.getState().serverEnabled;

/**
 * Settings → Advanced → Help & feedback → "Share beta diagnostics".
 *
 * Rendered ONLY while the server has beta diagnostics switched on (GET
 * /v1/client-status `beta_diagnostics`) — outside the beta there is nothing to
 * share and no toggle to show. Default ON; per account on this device; never
 * restored from a backup (backupRegistry.ts).
 */
export const BetaDiagnosticsSetting: React.FC<{ userId: string | null; serverEnabled?: boolean }> = ({ userId, serverEnabled }) => {
    const live = useSyncExternalStore(subscribeState, readServerEnabled, () => false);
    const on = useBetaDiagEnabled(userId);
    if (!(serverEnabled ?? live)) return null;
    return (
        <div className="sd-row mt-3" style={{ borderTop: 'none' }}>
            <div className="sd-rl">
                <b id="bd-setting-label">Share beta diagnostics</b>
                <span className="bd-setting-sub">
                    During the closed beta, automatically send failure reports (scrubbed codes and counts), your hardware
                    profile and call-quality numbers. Never message content, names or who you talk to. Deleted after 30 days.
                </span>
            </div>
            <div className="sd-rc">
                <ClToggle
                    checked={on}
                    onChange={v => setBetaDiagEnabled(userId, v)}
                    disabled={!userId}
                    aria-label="Share beta diagnostics"
                />
            </div>
        </div>
    );
};

export default BetaDiagnosticsSetting;
