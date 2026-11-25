/**
 * THE rule for when an animated GIF plays, shared by every GIF surface:
 * GifPlayer (GIF images, KLIPY, linked .gif files) and the GIF-like video loops
 * from Tenor / Giphy / Imgur .gifv links (components/embeds/GifLoopEmbed).
 *
 *   - Settings → Accessibility → Animated images (Always / On hover / Never),
 *     with the legacy "Automatically play GIFs" toggle and reduced motion
 *     folded in (utils/a11y/motionPrefs.ts useImageMode('gif'));
 *   - the window must be focused: an unfocused window freezes every GIF;
 *   - "On hover" plays while hovered or while the play badge has focus;
 *     "Never" plays only after the badge is pressed (per GIF).
 *
 * Extracted unchanged from GifPlayer so the video loops cannot drift from it.
 */
import { useState } from 'react';
import { useWindowFocus } from './useWindowFocus';
import { useImageMode, imagePlays, type ImageMotionMode } from '../utils/a11y/motionPrefs';

export interface GifPlayback {
    mode: ImageMotionMode;
    /** Animate now? */
    shouldPlay: boolean;
    /** Show the small play / pause badge (only once the media has loaded). */
    showPlayIcon: boolean;
    /**
     * Show the small "GIF" tag (round 3, owner 2026-11-23): the GIF is frozen
     * ONLY because the window is unfocused, in the "Always" mode, so a still
     * frame is not mistaken for a photo. Decoration: it resumes by itself.
     */
    showFrozenTag: boolean;
    manualPlay: boolean;
    toggleManualPlay: () => void;
    hoverProps: { onMouseEnter: () => void; onMouseLeave: () => void };
    badgeFocusProps: { onFocus: () => void; onBlur: () => void };
}

export function useGifPlayback(loaded: boolean): GifPlayback {
    const mode = useImageMode('gif');
    const windowFocused = useWindowFocus();
    const [isHovered, setIsHovered] = useState(false);
    const [badgeFocused, setBadgeFocused] = useState(false);
    /** Click / Enter on the play badge: plays (or pauses) this one GIF. */
    const [manualPlay, setManualPlay] = useState(false);
    const shouldPlay = windowFocused && imagePlays(mode, isHovered || badgeFocused, manualPlay);
    // Play icon: only when the user has opted out of autoplay and the cursor is
    // not over the GIF. Window-unfocus pauses silently (it resumes on refocus).
    const showPlayIcon = loaded && mode !== 'always' && !(mode === 'hover' && isHovered && !badgeFocused);
    const showFrozenTag = loaded && !windowFocused && mode === 'always';
    return {
        mode,
        shouldPlay,
        showPlayIcon,
        showFrozenTag,
        manualPlay,
        toggleManualPlay: () => setManualPlay((m) => !m),
        hoverProps: { onMouseEnter: () => setIsHovered(true), onMouseLeave: () => setIsHovered(false) },
        badgeFocusProps: { onFocus: () => setBadgeFocused(true), onBlur: () => setBadgeFocused(false) },
    };
}
