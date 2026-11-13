import React from 'react';
import ReactDOM from 'react-dom';
import { Gauge, X } from 'lucide-react';
import { ClButton } from '../ClButton';
import { useCallOfferAnchor } from '../../hooks/useCallOfferAnchor';
import { useCallPromptCue } from '../../hooks/useCallPromptCue';
import { CALL_OFFER_ENTER_CLASS } from '../../utils/performanceOffer';

/**
 * "Your computer can't keep up with this stream": the encoder-overload suggestion
 * (utils/shareEncoderOverload.ts), as the same offer card the webcam's "lower your
 * camera" uses, in the same place. The call's offer slot keeps it from stacking on them.
 * Also the sharer's other share cards: the game-starvation offer / tip, and the
 * "drawings won't show on your screen" note (utils/sharerOverlayNotice.ts), each
 * with its own words and icon.
 */
export interface ShareOverloadCopy {
    /** The setting that is struggling, like "Source at 90 fps". Unused when `body` is given. */
    current?: string;
    /** The most this encoder looks able to sustain, like "1440p at 90 fps". Unused when `body` is given. */
    suggested?: string;
    /** The real pixels, like "3024×1964 → 2216×1438". Absent when only the frame rate changes. */
    sizeChange?: string | null;
    /** Headline. Default: the encoder-overload one. */
    title?: string;
    /** Replaces the "<current> is too much for it. <suggested> should run smoothly." sentence. */
    body?: string;
    /** Label of the primary button. Default "Switch". */
    acceptLabel?: string;
    /** Label of the quiet button. Default "Keep current". */
    dismissLabel?: string;
    /** The badge icon. Default the gauge (a performance suggestion). */
    icon?: React.ReactNode;
}

export interface ShareOverloadOfferProps extends ShareOverloadCopy {
    /** Absent for a tip: there is nothing to accept, only to dismiss. */
    onSwitch?: () => void;
    onDismiss: () => void;
    /** Play the call-prompt sound when it appears. Default true; false for a note that asks nothing. */
    cue?: boolean;
}

const DEFAULT_TITLE = 'Your computer can’t keep up';

export const ShareOverloadCard: React.FC<ShareOverloadOfferProps> = ({
    current, suggested, sizeChange, title, body, acceptLabel, dismissLabel, icon, onSwitch, onDismiss,
}) => (
    <div
        role="status"
        aria-live="polite"
        aria-label={title ?? 'Your computer can’t keep up with this stream'}
        data-testid="share-overload-offer"
        className={`pointer-events-auto relative flex items-start gap-3 pl-4 pr-2 py-3 bg-cl-deep border border-white/[0.08] ring-1 ring-cl-lume/30 rounded-xl shadow-2xl overflow-hidden ${CALL_OFFER_ENTER_CLASS}`}
    >
        <span className="absolute left-0 top-0 bottom-0 w-[3px] bg-cl-lume" aria-hidden="true" />
        <span className="shrink-0 mt-0.5 w-8 h-8 rounded-lg grid place-items-center text-cl-lume bg-cl-lume/10" aria-hidden="true">
            {icon ?? <Gauge size={17} />}
        </span>
        <div className="flex-1 min-w-0">
            <p className="text-[13px] font-semibold text-white leading-tight m-0">{title ?? DEFAULT_TITLE}</p>
            <p className="text-[12px] text-cl-muted leading-snug m-0 mt-0.5 break-words">
                {body ?? `${current} is too much for it. ${suggested} should run smoothly.`}
            </p>
            {sizeChange && (
                <p data-testid="share-overload-size" className="text-[11px] text-cl-muted leading-snug m-0 mt-1 tabular-nums">
                    Stream size: {sizeChange}
                </p>
            )}
            <div className="flex items-center gap-2 mt-2.5">
                {onSwitch && <ClButton size="sm" variant="primary" onClick={onSwitch}>{acceptLabel ?? 'Switch'}</ClButton>}
                <ClButton size="sm" variant={onSwitch ? 'ghost' : 'primary'} onClick={onDismiss}>{dismissLabel ?? 'Keep current'}</ClButton>
            </div>
        </div>
        <ClButton icon size="sm" variant="ghost" onClick={onDismiss} tooltip="Dismiss">
            <X size={14} />
        </ClButton>
    </div>
);

export const ShareOverloadOffer: React.FC<ShareOverloadOfferProps> = ({ cue = true, ...props }) => {
    const anchor = useCallOfferAnchor(true);
    // Not while an open call prompt holds it off screen: it cues when it is actually seen.
    useCallPromptCue(cue && !anchor.held);
    if (typeof document === 'undefined') return null;
    return ReactDOM.createPortal(
        <div className={anchor.className} style={anchor.style} data-testid="call-notice-wrapper"><ShareOverloadCard {...props} /></div>,
        document.body,
    );
};
