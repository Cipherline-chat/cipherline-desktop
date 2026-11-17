import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Radio } from 'lucide-react';
import { ClButton } from './cl';
import { useEscape } from '../hooks/useEscape';
import {
    acknowledgeHeldTip, neverShowHeldTip, offerRichPresenceHeldTip, useRichPresenceHeldTip, withdrawHeldTip,
} from '../utils/richPresenceTip';
import './diagnostics/reportProblem.css';

/**
 * One-time tip: the game you are playing sends its live details (round, score,
 * party) over Rich Presence, but another app — the Discord client — holds the
 * local endpoint, so they reach it instead of Cipherline. Rules and wording
 * rationale: utils/richPresenceTip.ts. A floating card like the other one-time
 * prompts (never modal, never takes focus); naming Discord is factual, no logo
 * or branding.
 */
export const RichPresenceHeldTipView: React.FC<{ game: string; onGotIt: () => void; onNever: () => void }> = ({ game, onGotIt, onNever }) => {
    useEscape(onGotIt, true);
    return (
        <div className="cl-kit" style={{ display: 'contents' }}>
            <div className="rp-prompt" role="dialog" aria-modal="false" aria-labelledby="rph-title" aria-describedby="rph-desc" data-testid="rich-presence-held-tip">
                <div className="rp-prompt-head">
                    <div className="rp-tile" style={{ width: 38, height: 38, borderRadius: 12 }} aria-hidden><Radio size={18} /></div>
                    <div style={{ minWidth: 0 }}>
                        <h3 id="rph-title">{game}’s live details are going to Discord</h3>
                        <p id="rph-desc">
                            Discord is running, so it gets {game}’s live details (round, score, party) instead of Cipherline.
                            Quit Discord, including from the system tray, to see them here.
                        </p>
                    </div>
                </div>
                <div className="rp-prompt-actions">
                    <ClButton variant="ghost" fullWidth onClick={onNever}>Don’t show again</ClButton>
                    <ClButton fullWidth onClick={onGotIt}>Got it</ClButton>
                </div>
            </div>
        </div>
    );
};

/** Mounted once (Dashboard). Listens for main's hint; renders nothing until there is one. */
export const RichPresenceHeldTip: React.FC<{ gameActivityOn: boolean }> = ({ gameActivityOn }) => {
    const tip = useRichPresenceHeldTip();
    useEffect(() => {
        const api = window.electronAPI;
        if (!api?.onRichPresenceHeld) return;
        return api.onRichPresenceHeld(({ name }) => { offerRichPresenceHeldTip(name, gameActivityOn); });
    }, [gameActivityOn]);
    useEffect(() => { if (!gameActivityOn) withdrawHeldTip(); }, [gameActivityOn]);
    if (!tip || !gameActivityOn) return null;
    return createPortal(<RichPresenceHeldTipView game={tip.name} onGotIt={acknowledgeHeldTip} onNever={neverShowHeldTip} />, document.body);
};

export default RichPresenceHeldTip;
