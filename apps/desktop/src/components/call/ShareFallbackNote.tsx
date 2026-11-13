import React from 'react';
import { Check, Gauge, X } from 'lucide-react';
import { useClTooltip } from '../cl/useClTooltip';
import { KEEP_FULL_QUALITY_HINT, lighterNoticeCopy, shareFallbackNotice, type ShareFallbackNotice } from '../../utils/shareFallbackNotice';
import { useShareFallbackNotice } from '../../hooks/useShareFallbackNotice';
import type { ChromeInsets } from './videoRectChrome';

/**
 * The note on a watched screen share while the loss fallback (utils/shareLossFallback.ts)
 * holds it at its lighter copy: what happened, "Keep full quality", and ×. Then,
 * if the full layer comes back by itself, "Back to full quality" for a few seconds.
 *
 * Same look as the share-hold note (ShareHoldPlaceholder.tsx): a small dark glass
 * pill on the picture. Top-centre of the picture, one corner row below its top edge,
 * so it never sits on the corner chrome (resolution, annotation tools, name pill)
 * in either the docked or the fullscreen arrangement (videoRectChrome.tileChromeSlots).
 *
 * The wrapper is always mounted on an eligible tile, so the live region exists
 * before its text changes (aria-live is only reliable that way). It is
 * pointer-transparent; only the two buttons take input, and they keep every
 * pointer event from reaching the tile (a click must not also toggle focus or
 * fullscreen). No key handling of its own: Esc still leaves fullscreen.
 */

/** Height of the corner row (a name pill / tool cluster) plus a gap: the note starts below it. */
export const FALLBACK_NOTE_TOP_OFFSET_PX = 40;

const stop = (e: React.SyntheticEvent) => e.stopPropagation();
const KeepFullQualityButton = ({ onKeep }: { onKeep: () => void }) => {
    const { anchorProps, tooltip } = useClTooltip(KEEP_FULL_QUALITY_HINT, { preferred: 'bottom', wide: true });
    const { ref, onPointerDown, ...handlers } = anchorProps;
    // Described always, not only while the tooltip is open: a screen reader hears the cost on focus.
    const hintId = React.useId();
    return (
        <>
            <button
                ref={ref as React.Ref<HTMLButtonElement>}
                {...handlers}
                type="button"
                data-testid="share-fallback-keep"
                aria-describedby={hintId}
                onClick={e => { e.stopPropagation(); onKeep(); }}
                onPointerDown={e => { e.stopPropagation(); onPointerDown(); }}
                onMouseDown={stop}
                onDoubleClick={stop}
                onContextMenu={stop}
                className="shrink-0 pointer-events-auto rounded-md px-2 py-0.5 bg-white/10 text-white text-[11px] font-semibold whitespace-nowrap hover:bg-white/20 active:bg-white/25 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cl-lume"
            >
                Keep full quality
            </button>
            <span id={hintId} className="sr-only">{KEEP_FULL_QUALITY_HINT}</span>
            {tooltip}
        </>
    );
};

export interface ShareFallbackNoteProps {
    notice: ShareFallbackNotice | null;
    /** The picture's insets inside the tile (videoRectInsets), as the corner chrome uses. */
    insets: ChromeInsets;
    onKeep: () => void;
    onDismiss: () => void;
}

export const ShareFallbackNote = ({ notice, insets, onKeep, onDismiss }: ShareFallbackNoteProps) => {
    const copy = notice?.kind === 'lighter' ? lighterNoticeCopy(notice.shortSide) : null;
    return (
        <div
            aria-live="polite"
            data-share-fallback-note=""
            className="@container absolute z-20 flex justify-center pointer-events-none"
            style={{ top: insets.top + FALLBACK_NOTE_TOP_OFFSET_PX, left: insets.left, right: insets.right }}
        >
            {copy && (
                <div
                    role="group"
                    aria-label="Stream quality"
                    data-share-fallback="lighter"
                    className="cl-share-fallback-note flex items-center gap-2 max-w-full bg-black/55 backdrop-blur-sm rounded-lg pl-3 pr-1.5 py-1.5"
                >
                    <Gauge className="w-3.5 h-3.5 text-cl-lume shrink-0" aria-hidden="true" />
                    <span className="hidden @[560px]:inline text-white/90 text-xs font-medium leading-snug">{copy.full}</span>
                    <span className="@[560px]:hidden text-white/90 text-xs font-medium truncate min-w-0">{copy.short}</span>
                    <KeepFullQualityButton onKeep={onKeep} />
                    <button
                        type="button"
                        aria-label="Dismiss"
                        title="Dismiss"
                        data-testid="share-fallback-dismiss"
                        onClick={e => { e.stopPropagation(); onDismiss(); }}
                        onPointerDown={stop}
                        onMouseDown={stop}
                        onDoubleClick={stop}
                        onContextMenu={stop}
                        className="shrink-0 pointer-events-auto grid place-items-center w-5 h-5 rounded-md text-white/70 hover:text-white hover:bg-white/15 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cl-lume"
                    >
                        <X className="w-3 h-3" strokeWidth={2.5} aria-hidden="true" />
                    </button>
                </div>
            )}
            {notice?.kind === 'restored' && (
                <div
                    data-share-fallback="restored"
                    className="cl-share-fallback-restored flex items-center gap-2 bg-black/55 backdrop-blur-sm rounded-lg px-3 py-1.5"
                >
                    <Check className="w-3.5 h-3.5 text-cl-lume shrink-0" aria-hidden="true" />
                    <span className="text-white/90 text-xs font-medium whitespace-nowrap">Back to full quality</span>
                </div>
            )}
        </div>
    );
};

/** The note for one watched share, wired to the store. `sid` = the share's track SID. */
export const ShareFallbackNoteFor = ({ sid, insets }: { sid: string; insets: ChromeInsets }) => {
    const notice = useShareFallbackNotice(sid);
    return (
        <ShareFallbackNote
            notice={notice}
            insets={insets}
            onKeep={() => shareFallbackNotice.keepFullQuality(sid)}
            onDismiss={() => shareFallbackNotice.dismiss(sid)}
        />
    );
};
