/**
 * Pause remote video nobody is looking at.
 *
 * The call runs with `adaptiveStream: false` (CallPane — explicit per-tile
 * setVideoQuality replaces LiveKit's dimension-based adaptation), and that
 * also switched off adaptiveStream's OTHER job: pausing a subscribed video
 * track while no visible <video> shows it. So a camera or screen share kept
 * streaming and being DECRYPTED + DECODED at full rate while its tile was
 * scrolled out of the side panel, while the user was on a different server or
 * view, or while the user had hidden that person's video — CPU (and download)
 * spent on pixels nobody sees. In an 8-camera call that is most of the tiles
 * most of the time; for a 1440p/90 fps screen share it is the single most
 * expensive thing the renderer does.
 *
 * Demand is ref-counted per publication: each on-screen tile showing it holds
 * one reference (VideoTile). When the last reference goes, the track is paused
 * at the SFU (`setEnabled(false)` — the server stops forwarding it, so nothing
 * arrives to decrypt or decode) after PAUSE_AFTER_MS, so scrolling past a tile
 * or a quick view switch never touches the stream. The first new reference
 * resumes it immediately; the SFU asks the sender for a keyframe on resume.
 *
 * Only the forwarding is paused: the subscription (and therefore a screen
 * share's "watching" state, its audio, and the viewer count) is untouched,
 * and quality is unchanged once visible.
 */

export const PAUSE_AFTER_MS = 4000;

export interface PausableVideoPublication {
    isSubscribed: boolean;
    isEnabled: boolean;
    setEnabled(enabled: boolean): void;
}

interface Demand { refs: number; timer: ReturnType<typeof setTimeout> | null }
const demand = new WeakMap<PausableVideoPublication, Demand>();

/** A remote video track was just subscribed. If no tile claims it within
 *  PAUSE_AFTER_MS (the user is on another view, has hidden this person's
 *  video, or the tile is scrolled away), pause it — the same as a tile that
 *  went away. A tile mounting later resumes it via retainRemoteVideo. */
export function noteRemoteVideoSubscribed(pub: PausableVideoPublication): void {
    let d = demand.get(pub);
    if (!d) { d = { refs: 0, timer: null }; demand.set(pub, d); }
    if (d.refs > 0 || d.timer) return;
    const entry = d;
    entry.timer = setTimeout(() => {
        entry.timer = null;
        if (entry.refs === 0 && pub.isSubscribed && pub.isEnabled) pub.setEnabled(false);
    }, PAUSE_AFTER_MS);
}

/** Hold the publication's video on while the caller is showing it on screen.
 *  Returns the release function. */
export function retainRemoteVideo(pub: PausableVideoPublication): () => void {
    let d = demand.get(pub);
    if (!d) { d = { refs: 0, timer: null }; demand.set(pub, d); }
    d.refs++;
    if (d.timer) { clearTimeout(d.timer); d.timer = null; }
    if (!pub.isEnabled) pub.setEnabled(true);
    let released = false;
    const entry = d;
    return () => {
        if (released) return;
        released = true;
        entry.refs--;
        if (entry.refs > 0 || entry.timer) return;
        entry.timer = setTimeout(() => {
            entry.timer = null;
            if (entry.refs === 0 && pub.isSubscribed && pub.isEnabled) pub.setEnabled(false);
        }, PAUSE_AFTER_MS);
    };
}
