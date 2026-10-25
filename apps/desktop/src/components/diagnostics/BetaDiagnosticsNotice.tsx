import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { ShieldCheck, Activity, Cpu, PhoneCall } from 'lucide-react';
import { ClButton } from '../cl';
import { useEscape } from '../../hooks/useEscape';
import './reportProblem.css';
import './betaDiagnostics.css';

/** The contract's notice text, verbatim. */
export const BETA_NOTICE_TEXT =
    'During the closed beta Cipherline sends automatic diagnostics about failures, your hardware and call quality — never message content or who you talk to. Turn it off any time in Settings.';

/**
 * The one-time "beta diagnostics are on" notice. Shown the first time beta
 * diagnostics is active for this account on this device (the server switched
 * it on AND the local toggle is on — it defaults on). "Got it" remembers it;
 * "Turn off" flips the Settings toggle right here. Same floating card as the
 * other prompts: not a modal, focus goes to "Got it" once it has entered.
 */
export const BetaDiagnosticsNotice: React.FC<{ onAcknowledge: () => void; onTurnOff: () => void }> = ({ onAcknowledge, onTurnOff }) => {
    const primaryRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const t = setTimeout(() => primaryRef.current?.querySelector<HTMLButtonElement>('button')?.focus(), 350);
        return () => clearTimeout(t);
    }, []);
    useEscape(onAcknowledge, true);

    return createPortal(
        <div className="cl-kit" style={{ display: 'contents' }}>
            <div className="rp-prompt bd-card" role="dialog" aria-modal="false" aria-labelledby="bd-notice-title" aria-describedby="bd-notice-desc">
                <div className="rp-prompt-head">
                    <div className="rp-tile" style={{ width: 38, height: 38, borderRadius: 12 }} aria-hidden><ShieldCheck size={18} /></div>
                    <div style={{ minWidth: 0 }}>
                        <h3 id="bd-notice-title">Beta diagnostics are on<span className="bd-beta">Beta</span></h3>
                        <p id="bd-notice-desc">{BETA_NOTICE_TEXT}</p>
                    </div>
                </div>
                <ul className="bd-notice-list" aria-label="What is sent">
                    <li><Activity size={14} aria-hidden /> Failures: key, delivery, call and app errors — scrubbed, as counts and codes.</li>
                    <li><Cpu size={14} aria-hidden /> Your hardware: OS, CPU class, GPU, RAM bucket, device counts.</li>
                    <li><PhoneCall size={14} aria-hidden /> Call quality: latency, loss, freezes — never who was in the call.</li>
                </ul>
                <div className="rp-prompt-actions">
                    <ClButton variant="ghost" onClick={onTurnOff}>Turn off</ClButton>
                    <div ref={primaryRef} style={{ display: 'contents' }}>
                        <ClButton onClick={onAcknowledge}>Got it</ClButton>
                    </div>
                </div>
            </div>
        </div>,
        document.body,
    );
};

export default BetaDiagnosticsNotice;
