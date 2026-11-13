import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Cpu, MonitorUp, Play, ShieldCheck, X } from 'lucide-react';
import { ClButton } from '../cl';
import { useEscape } from '../../hooks/useEscape';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import {
    dismissLinuxShareIntro, revealLinuxShareIntro, useLinuxShareIntro, type ShareBackendKind,
} from '../../utils/linuxShareIntro';
import howToVideo from '../../assets/linux-share-report.webm';
import howToPoster from '../../assets/linux-share-report-poster.webp';
import './reportProblem.css';
import './linuxShareIntro.css';

/**
 * "Screen sharing on Linux is new" — shown ONCE per device, the first time it shares its screen on Linux, whatever the
 * GPU (utils/linuxShareIntro.ts has the rules). A floating card like the crash / GPU / call-rating prompts: never a
 * modal, never takes focus, never in front of the share starting (it appears after the share is already live, and only
 * once the window is visible and focused). Esc or "Got it" closes it.
 *
 * The video is the owner's own recording of the Windows app's share menu -> "Report a Quality Problem" -> Review ->
 * Send, cropped and with the channel list, messages, member names and the account handle blurred. Silent, ~20 s.
 * It is loaded as a blob: URL (CSP media-src 'self' blob:): the packaged app's static server answers Range requests with
 * the whole file and an octet-stream type, which a <video> tolerates badly; a blob plays and loops the same in dev and
 * prod. Reduced motion: no autoplay, the poster with a play button instead.
 */

const BACKEND_LINE: Record<ShareBackendKind, { text: string; tone: 'ok' | 'new' }> = {
    nvenc: { text: 'This share is using your NVIDIA card’s hardware encoder.', tone: 'ok' },
    vaapi: { text: 'This share is using your AMD or Intel card’s hardware encoder, the least-tested path. Your reports help most here.', tone: 'new' },
    normal: { text: 'This share is using the standard screen share, not Cipherline’s hardware one.', tone: 'ok' },
};

const VIDEO_LABEL = 'How to send a report: open the screen share menu, choose Report a Quality Problem, say what happened, review the report and send it.';

/** Loads the bundled clip into a blob: URL; null until ready (or with no asset), 'failed' when it could not be loaded (the poster stays). */
function useVideoBlobUrl(asset: string | null): string | null | 'failed' {
    const [url, setUrl] = useState<string | null | 'failed'>(null);
    useEffect(() => {
        if (!asset) return;
        let dead = false;
        let made: string | null = null;
        (async () => {
            try {
                const res = await fetch(asset);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const buf = await res.arrayBuffer();
                if (dead) return;
                made = URL.createObjectURL(new Blob([buf], { type: 'video/webm' }));
                setUrl(made);
            } catch {
                if (!dead) setUrl('failed');
            }
        })();
        return () => { dead = true; if (made) URL.revokeObjectURL(made); };
    }, [asset]);
    return url;
}

export interface LinuxShareIntroCardViewProps {
    backend: ShareBackendKind;
    onDismiss: () => void;
    /** Test seam: the clip's URL (skips the fetch). */
    videoSrc?: string | null;
}

export const LinuxShareIntroCardView: React.FC<LinuxShareIntroCardViewProps> = ({ backend, onDismiss, videoSrc }) => {
    const reduced = usePrefersReducedMotion();
    const loaded = useVideoBlobUrl(videoSrc === undefined ? howToVideo : null);
    const src = videoSrc !== undefined ? videoSrc : (loaded === 'failed' ? null : loaded);
    const videoRef = useRef<HTMLVideoElement>(null);
    // Under reduced motion nothing moves until asked; otherwise it plays (muted, looping) as soon as it is loaded.
    const [started, setStarted] = useState(!reduced);
    const showPlay = !started && !!src;

    useEscape(onDismiss, true);

    const play = () => {
        setStarted(true);
        const v = videoRef.current;
        if (v) { void v.play()?.catch(() => { /* the controls remain */ }); }
    };

    const line = BACKEND_LINE[backend];

    return (
        <div className="cl-kit" style={{ display: 'contents' }}>
            <div className="rp-prompt lsi-card" role="dialog" aria-modal="false" aria-labelledby="lsi-title" aria-describedby="lsi-desc">
                <div className="rp-prompt-head">
                    <div className="rp-tile" style={{ width: 38, height: 38, borderRadius: 12 }} aria-hidden><MonitorUp size={18} /></div>
                    <div style={{ minWidth: 0 }}>
                        <h3 id="lsi-title">Screen sharing on Linux is new<span className="lsi-new">New</span></h3>
                    </div>
                </div>
                <button type="button" className="rp-close" onClick={onDismiss} aria-label="Close"><X size={17} aria-hidden /></button>

                <div className="lsi-video">
                    {src ? (
                        <video
                            ref={videoRef}
                            src={src}
                            poster={howToPoster}
                            muted
                            loop
                            playsInline
                            autoPlay={started}
                            controls={started}
                            preload="auto"
                            aria-label={VIDEO_LABEL}
                        />
                    ) : (
                        <img src={howToPoster} alt={VIDEO_LABEL} />
                    )}
                    {showPlay && (
                        <button type="button" className="lsi-play" onClick={play} aria-label="Play the how-to video">
                            <span><Play size={22} fill="currentColor" aria-hidden /></span>
                        </button>
                    )}
                </div>

                <div id="lsi-desc">
                    <p className="lsi-body">
                        It’s tested on <b>NVIDIA</b> graphics cards, less so on <b>AMD</b> and <b>Intel</b>. We need test data to make it smoother and sharper.
                    </p>
                    <div className={`lsi-backend lsi-backend--${backend}`} data-tone={line.tone}>
                        <Cpu size={14} aria-hidden />
                        <span>{line.text}</span>
                    </div>
                    <p className="lsi-body">
                        If something looks wrong, send a report from the share menu, as the video shows.
                    </p>
                </div>

                <div className="lsi-foot">
                    <span className="lsi-never"><ShieldCheck size={14} aria-hidden /> Reports contain diagnostics, never your messages.</span>
                    <ClButton onClick={onDismiss}>Got it</ClButton>
                </div>
            </div>
        </div>
    );
};

/** True while this window is on screen and focused (the card waits for that before it counts as shown). */
function useWindowAttended(active: boolean): boolean {
    const read = () => {
        try { return document.visibilityState === 'visible' && document.hasFocus(); } catch { return false; }
    };
    const [attended, setAttended] = useState(read);
    useEffect(() => {
        if (!active) return;
        const update = () => setAttended(read());
        update();
        window.addEventListener('focus', update);
        window.addEventListener('blur', update);
        document.addEventListener('visibilitychange', update);
        return () => {
            window.removeEventListener('focus', update);
            window.removeEventListener('blur', update);
            document.removeEventListener('visibilitychange', update);
        };
    }, [active]);
    return attended;
}

/** The live card. Mounted once (Dashboard); renders nothing until a first Linux share made it pending. */
export const LinuxShareIntroCard: React.FC = () => {
    const intro = useLinuxShareIntro();
    const waiting = !!intro && !intro.shown;
    const attended = useWindowAttended(waiting);
    useEffect(() => {
        if (waiting && attended) revealLinuxShareIntro();
    }, [waiting, attended]);
    if (!intro?.shown) return null;
    return createPortal(
        <LinuxShareIntroCardView backend={intro.backend} onDismiss={dismissLinuxShareIntro} />,
        document.body,
    );
};

export default LinuxShareIntroCard;
