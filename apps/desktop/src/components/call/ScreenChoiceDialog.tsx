import React from 'react';
import { MonitorUp } from 'lucide-react';
import { ClButton, ClModal } from '../cl';
import { DialogHeader, DialogBody, DialogFooter } from '../dialog/DialogFrame';
import type { OverlayScreenChoice } from '../../utils/annotationOverlayTypes';
import { layoutScreenChoice } from '../../utils/screenChoiceLayout';
import { CALL_PROMPT_OVERLAY_STYLE } from '../../utils/callNoticeLayer';
import { useHoldCallNotices } from '../../hooks/useCallNoticeLayer';

const BOX_W = 440;
const BOX_H = 200;

/**
 * "Which screen are you sharing?" Asked once per share, and only when two or more of the
 * sharer's monitors are indistinguishable to us (Wayland never says which one the portal
 * streamed). Draws the real monitor layout; only the monitors that fit the share can be picked.
 * "Not now" keeps the in-app preview and tells viewers drawings will not appear on this desktop.
 *
 * An actionable call prompt (utils/callNoticeLayer.ts): it sits above every call notice card
 * and the fullscreen call, and holds the notice cards back while it is open, so a "can't keep
 * up" card that fires at the same moment waits instead of covering these buttons.
 */
export const ScreenChoiceDialog: React.FC<{
    choice: OverlayScreenChoice | null;
    /** The display picked last time on this layout: highlighted and focused, never picked for the sharer. */
    preselectId?: number | null;
    onPick: (displayId: number) => void;
    onDecline: () => void;
}> = ({ choice, preselectId = null, onPick, onDecline }) => {
    const tiles = choice ? layoutScreenChoice(choice, BOX_W, BOX_H) : [];
    useHoldCallNotices(!!choice, 'screen-choice');
    return (
        <ClModal
            open={!!choice}
            onClose={onDecline}
            closeOnOverlay={false}
            overlayStyle={CALL_PROMPT_OVERLAY_STYLE}
            width={500}
            label="Which screen are you sharing?"
            cardClassName="dlg-card"
        >
            <DialogHeader
                icon={<MonitorUp size={19} strokeWidth={2.2} />}
                title="Which screen are you sharing?"
                subtitle="Your system doesn't tell us, and two of your screens look the same. Pick the one you're sharing so drawings from the call land on it."
            />
            <DialogBody>
                <div
                    role="group"
                    aria-label="Your screens"
                    data-testid="screen-choice-layout"
                    style={{ position: 'relative', width: BOX_W, height: BOX_H, maxWidth: '100%', margin: '0 auto' }}
                >
                    {tiles.map(t => (
                        <button
                            key={t.id}
                            type="button"
                            disabled={!t.selectable}
                            onClick={() => onPick(t.id)}
                            aria-label={`Screen ${t.number}, ${t.pxWidth} by ${t.pxHeight}${t.primary ? ', main screen' : ''}${t.selectable ? '' : ', not the shared size'}`}
                            data-testid={`screen-choice-${t.number}`}
                            data-preselected={t.selectable && t.id === preselectId ? 'true' : undefined}
                            autoFocus={t.selectable && t.id === preselectId}
                            className={t.selectable
                                ? 'absolute flex flex-col items-center justify-center rounded-lg bg-cl-lume/10 text-white hover:bg-cl-lume/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cl-lume transition-colors'
                                : 'absolute flex flex-col items-center justify-center rounded-lg border border-white/10 bg-white/5 text-white/30 cursor-not-allowed'}
                            style={{ left: t.left, top: t.top, width: t.width, height: t.height, ...(t.selectable ? { border: t.id === preselectId ? '3px solid rgba(37,224,200,1)' : '2px solid rgba(37,224,200,0.75)' } : null) }}
                        >
                            <span className="text-2xl font-semibold leading-none">{t.number}</span>
                            <span className="text-[11px] mt-1 opacity-80">{t.pxWidth}×{t.pxHeight}{t.primary ? ' · main' : ''}</span>
                        </button>
                    ))}
                </div>
            </DialogBody>
            <DialogFooter hint={preselectId !== null ? 'Last time you picked the highlighted screen. Asked once per share.' : 'Asked once per share.'}>
                <ClButton variant="ghost" size="sm" onClick={onDecline}>Not now</ClButton>
            </DialogFooter>
        </ClModal>
    );
};
