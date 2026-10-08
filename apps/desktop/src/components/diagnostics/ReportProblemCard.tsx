import React from 'react';
import { LifeBuoy, ChevronRight } from 'lucide-react';
import { ClToggle } from '../cl';
import { useAuth } from '../../contexts/AuthContext';
import { openReportProblem } from '../../utils/diagnostics/reportRequest';
import { setAutoSendEnabled, useAutoSendEnabled, AUTO_SEND_DAILY_CAP } from '../../utils/diagnostics/autoSend';
import './reportProblem.css';

/**
 * Settings → Advanced → "Help & feedback": the Report-a-problem entry point
 * and the "Automatically send crash reports" opt-in (default OFF, per account
 * on this device, never restored from a backup — see autoSend.ts).
 */
/** Signed-in user id, or null outside an AuthProvider (AdvancedSettings is
 *  mounted standalone in its tests). useAuth is called unconditionally — the
 *  try only catches its "no provider" throw — so hook order never changes. */
function useSignedInUserId(): string | null {
    try { return useAuth().userId; } catch { return null; }
}

export const ReportProblemCard: React.FC = () => {
    const userId = useSignedInUserId();
    const auto = useAutoSendEnabled(userId);
    return (
        <div className="sd-card">
            <div className="flex items-center gap-3">
                <span className="sd-tile"><LifeBuoy size={16} /></span>
                <div>
                    <h3 className="rp-card-title">Help &amp; feedback</h3>
                    <p className="rp-card-sub">
                        Something not working? Send us a report with the diagnostics that matter — you see every byte before it’s sent.
                    </p>
                </div>
            </div>

            <button type="button" className="rp-report-btn" onClick={() => openReportProblem({ trigger: 'manual' })}>
                <span className="rp-report-text">
                    <b>Report a problem</b>
                    <span>Crashes, screen share or call quality, freezes, notifications — anything.</span>
                </span>
                <ChevronRight size={18} className="rp-go" aria-hidden />
            </button>

            <div className="sd-row mt-3" style={{ borderTop: 'none' }}>
                <div className="sd-rl">
                    <b id="rp-auto-label">Automatically send crash reports</b>
                    <span>
                        When Cipherline closes unexpectedly, send the crash report without asking — the same
                        privacy-scrubbed report you’d otherwise review first. At most {AUTO_SEND_DAILY_CAP} a day,
                        and never the same crash twice in a week. Off: we ask you each time.
                    </span>
                </div>
                <div className="sd-rc">
                    <ClToggle
                        checked={auto}
                        onChange={v => setAutoSendEnabled(userId, v)}
                        disabled={!userId}
                        aria-label="Automatically send crash reports"
                    />
                </div>
            </div>
        </div>
    );
};

export default ReportProblemCard;
