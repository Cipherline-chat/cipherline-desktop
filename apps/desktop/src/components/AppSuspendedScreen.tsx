import { useEffect, useState } from 'react';
import { CirclePause, ShieldCheck, Sparkles } from 'lucide-react';
import { ClButton } from './cl';
import { ClientBlockScreen } from './ClientBlockScreen';
import { formatEta, type SuspendedNotice } from '../utils/clientControl';

/**
 * "App shut down" — the admin kill switch's blocking screen. Presentational:
 * ClientControlGate owns when it shows, the polling and the dismissal.
 *
 * Title and message are written by an admin and arrive from the server; they
 * are rendered as React TEXT (never HTML), so a hostile or mistyped value can
 * only ever be words on the screen.
 */
export interface AppSuspendedScreenProps {
    notice: SuspendedNotice;
    /** Epoch ms of the next automatic check, or null while one is running. */
    nextCheckAt: number | null;
    checking: boolean;
    /** The switch lifted: a short "we're back" beat before the gate unmounts this. */
    back?: boolean;
    onCheckAgain: () => void;
}

function fmtTime(iso: string | null): string | null {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const sameDay = d.toDateString() === new Date().toDateString();
    return d.toLocaleString(undefined, sameDay
        ? { hour: 'numeric', minute: '2-digit' }
        : { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function AppSuspendedScreen({ notice, nextCheckAt, checking, back, onCheckAgain }: AppSuspendedScreenProps) {
    // One-second tick for the countdown; nothing else re-renders.
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, []);

    const eta = formatEta(notice.until, now);
    const untilLabel = fmtTime(notice.until);
    const sinceLabel = fmtTime(notice.since);
    const secs = nextCheckAt ? Math.max(0, Math.ceil((nextCheckAt - now) / 1000)) : null;

    return (
        <ClientBlockScreen
            tone={back ? 'ok' : 'glow'}
            titleId="cb-suspended-title"
            bodyId="cb-suspended-body"
            testId="app-suspended-screen"
            leaving={back}
        >
            <div className="cb-emblem" data-kind="sonar" aria-hidden>
                {!back && <><span className="cb-ring" /><span className="cb-ring" /><span className="cb-ring" /></>}
                <div className="cb-emblem-core">
                    {back ? <Sparkles size={30} strokeWidth={2.2} /> : <CirclePause size={30} strokeWidth={2.2} />}
                </div>
            </div>

            <div className="cb-eyebrow">{back ? 'Back online' : 'Temporarily paused'}</div>
            <h1 id="cb-suspended-title" className="cb-title">{back ? 'We’re back!' : notice.title}</h1>
            <p id="cb-suspended-body" className="cb-body">
                {back ? 'Picking up right where you left off…' : notice.message}
            </p>

            {!back && (untilLabel || sinceLabel) && (
                <div className="cb-meta">
                    {untilLabel && (
                        <div>
                            <small>Expected back</small>
                            <b>{untilLabel}</b>
                            {eta && <span>{eta}</span>}
                        </div>
                    )}
                    {sinceLabel && (
                        <div>
                            <small>Paused since</small>
                            <b>{sinceLabel}</b>
                        </div>
                    )}
                </div>
            )}

            {!back && (
                <>
                    <div className="cb-status" aria-live="polite">
                        <div className="cb-status-line">
                            <span className="cb-dot" aria-hidden />
                            {checking
                                ? 'Checking whether we’re back…'
                                : secs !== null
                                    ? `This screen clears by itself — next check in ${secs}s`
                                    : 'This screen clears by itself when we’re back'}
                        </div>
                    </div>
                    <div className="cb-actions">
                        <ClButton
                            variant="primary"
                            size="lg"
                            className="cb-primary"
                            onClick={onCheckAgain}
                            disabled={checking}
                            autoFocus
                        >
                            {checking ? 'Checking…' : 'Check again'}
                        </ClButton>
                    </div>
                    <div className="cb-foot">
                        <ShieldCheck size={13} aria-hidden />
                        Your messages and encryption keys stay safe on this device.
                    </div>
                </>
            )}
        </ClientBlockScreen>
    );
}

export default AppSuspendedScreen;
