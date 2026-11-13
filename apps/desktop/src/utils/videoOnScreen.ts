/**
 * "Is someone watching a video in this window right now?" - what keeps the
 * screen lock's inactivity timer from firing during a screen share or a call
 * (owner 2026-10-31).
 *
 * Counts a <video> only if it is really showing moving pictures:
 *   - the window is not minimized / hidden;
 *   - it is playing with frames arriving, and its frame count moved since the
 *     last check. A remote camera that was turned off leaves the element
 *     "playing" on a frozen frame, and that must not hold the lock off forever;
 *   - it has a visible area inside the viewport.
 * Never counts your own picture (`data-local-preview`: self view, camera test),
 * or a screen lock could be held off by an empty room looking back at itself,
 * or a looping clip (a GIF sent as video keeps playing with nobody watching).
 */

/** The frame count each element had at the last check. */
const lastFrames = new WeakMap<HTMLVideoElement, number>();

const HAVE_CURRENT_DATA = 2;

function isShowingMovingPicture(v: HTMLVideoElement, viewW: number, viewH: number): boolean {
    if (v.dataset.localPreview === 'true' || v.loop) return false;
    if (v.paused || v.ended || v.readyState < HAVE_CURRENT_DATA) return false;

    const frames = v.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
    const previous = lastFrames.get(v);
    lastFrames.set(v, frames);
    if (frames <= 0 || (previous !== undefined && frames <= previous)) return false;

    const r = v.getBoundingClientRect();
    const w = Math.min(r.right, viewW) - Math.max(r.left, 0);
    const h = Math.min(r.bottom, viewH) - Math.max(r.top, 0);
    if (w <= 0 || h <= 0) return false;
    return v.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) ?? true;
}

export function isWatchingVideo(doc: Document): boolean {
    if (doc.hidden) return false;
    const view = doc.defaultView;
    const viewW = view?.innerWidth ?? 0;
    const viewH = view?.innerHeight ?? 0;
    // Every element is checked, no early exit: each one's frame count must stay current.
    let watching = false;
    for (const v of Array.from(doc.querySelectorAll('video'))) {
        if (isShowingMovingPicture(v, viewW, viewH)) watching = true;
    }
    return watching;
}
