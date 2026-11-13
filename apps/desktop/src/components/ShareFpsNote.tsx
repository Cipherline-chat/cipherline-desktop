import React from 'react';
import { ClNote } from './cl/ClNote';

/** One copy for every place a screen-share frame rate can be picked. */
export const SHARE_FPS_90_NOTE = '90 fps depends on your PC and upload speed — some setups will land nearer 60.';

/**
 * Informational (not a warning) note shown only while 90 fps is selected -
 * 90 is an "up to" target, the others are not. Shared by the screen-share
 * picker and the call bar's quality panel so the wording cannot drift.
 */
export const ShareFpsNote: React.FC<{ frameRate: number; className?: string }> = ({ frameRate, className }) =>
    frameRate === 90 ? (
        <ClNote className={className} data-testid="share-fps-note">{SHARE_FPS_90_NOTE}</ClNote>
    ) : null;

/** Which frame-rate disclaimer the picker shows for the current choice, if any. */
export type ShareFpsLimit = 'capture-cap' | 'refresh-cap' | null;

/**
 * Screen capture samples the compositor, so it can't produce more distinct
 * frames per second than the display actually generates: asking for 90 on a
 * 60 Hz panel gets 60. That is a hardware ceiling, not a tuning problem, so
 * say so plainly instead of letting people chase it. The OS capturer can have
 * a tighter ceiling of its own (Wayland/PipeWire: 60 whatever the monitor
 * runs at); when it is the tighter of the two, it is the one named.
 *
 * `maxRefreshHz` 0 = unknown (say nothing rather than guess);
 * `captureCeiling` 0 = no fixed capturer limit.
 */
export function shareFpsLimit(frameRate: number, maxRefreshHz: number, captureCeiling = 0): ShareFpsLimit {
    const refreshCapped = maxRefreshHz > 0 && frameRate > maxRefreshHz;
    const captureCapped = captureCeiling > 0 && frameRate > captureCeiling
        && !(refreshCapped && maxRefreshHz <= captureCeiling);
    if (captureCapped) return 'capture-cap';
    if (refreshCapped) return 'refresh-cap';
    return null;
}

/**
 * The picker's single frame-rate disclaimer: a hard cap (warning tone) when
 * one applies, otherwise the 90 fps "depends on your PC" info note, otherwise
 * nothing. Same note family either way (ClNote), so they read as one set.
 */
export const ShareFpsDisclaimer: React.FC<{
    frameRate: number;
    maxRefreshHz: number;
    captureCeiling?: number;
    className?: string;
}> = ({ frameRate, maxRefreshHz, captureCeiling = 0, className }) => {
    const limit = shareFpsLimit(frameRate, maxRefreshHz, captureCeiling);
    if (limit === 'capture-cap') {
        return (
            <ClNote tone="warn" className={className} data-testid="share-capture-cap-note">
                <strong className="font-semibold text-cl-text">Screen sharing is limited to {captureCeiling} fps here.</strong>{' '}
                On Wayland the system&apos;s screen capture (PipeWire) delivers at most {captureCeiling} frames
                per second, whatever your monitor runs at.
            </ClNote>
        );
    }
    if (limit === 'refresh-cap') {
        return (
            <ClNote tone="warn" className={className} data-testid="share-refresh-cap-note">
                <strong className="font-semibold text-cl-text">
                    Your display runs at {maxRefreshHz} Hz, so this shares at about {maxRefreshHz} fps.
                </strong>{' '}
                Capture can&apos;t go faster than the screen it&apos;s reading; only a faster monitor lifts this.
            </ClNote>
        );
    }
    return <ShareFpsNote frameRate={frameRate} className={className} />;
};
