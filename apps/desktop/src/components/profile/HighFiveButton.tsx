import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Hand } from 'lucide-react';
import { apiUrl } from '../../utils/apiPath';
import { highFiveAgainLabel, highFiveResultOf } from '../../utils/profileExtras';
import { invalidateProfile } from '../../utils/profileCache';
import '../../styles/profile-card.css';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Who this session already high-fived, and until when (`known` = the server told
 * us the reopening time). The server's 24 h key is the authority and reaches the
 * card as `profile.high_fived_today`, which survives a restart; this map only
 * covers the gap while a cached profile is older than the press - so a stale
 * profile can never re-enable the button. In memory, per session, entries lapse
 * after the window; no log of who was high-fived is ever written anywhere.
 */
const sentThisSession = new Map<string, { until: number; known: boolean }>();
/** Test seam: a fresh app start. */
export const __resetHighFiveSession = () => { sentThisSession.clear(); };

const sessionEntry = (userId: string, now: number) => {
    const e = sentThisSession.get(userId);
    if (!e) return null;
    if (e.until <= now) { sentThisSession.delete(userId); return null; }
    return e;
};

const SPARKS = [0, 60, 120, 180, 240, 300];

/**
 * "High five" for another user's card: one button that carries the running
 * count. One per person per 24 h (server rule); once sent - or when the server
 * says it was already sent today - it stays pressed as "High-fived today".
 *
 * Feedback (transform/opacity only, skipped under reduced motion): the hand
 * slaps, a "+1" floats up and a small burst goes off; the count ticks over.
 */
export const HighFiveButton: React.FC<{
    userId: string; token: string; count: number;
    /** `profile.high_fived_today` - the viewer already high-fived them inside the 24 h window (survives restarts). */
    alreadyToday?: boolean;
    /** `profile.high_five_again_at` - ISO time the window reopens; tooltip only. */
    againAt?: string | null;
}> = ({ userId, token, count, alreadyToday, againAt }) => {
    const [, bump] = useState(0);
    const now = Date.now();
    const mine = sessionEntry(userId, now);
    const done = !!mine || !!alreadyToday;
    const serverAgainMs = againAt ? Date.parse(againAt) : NaN;
    const againAtMs = mine?.known ? mine.until : Number.isFinite(serverAgainMs) ? serverAgainMs : null;
    const [bumped, setBumped] = useState<number | null>(null);
    const shown = Math.max(count, bumped ?? 0);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const [burst, setBurst] = useState(0);

    useEffect(() => {
        if (!burst) return;
        const t = window.setTimeout(() => setBurst(0), 1000);
        return () => window.clearTimeout(t);
    }, [burst]);
    useEffect(() => {
        if (!err) return;
        const t = window.setTimeout(() => setErr(null), 4000);
        return () => window.clearTimeout(t);
    }, [err]);

    const send = async () => {
        if (busy || done) return;
        setBusy(true);
        setErr(null);
        try {
            const res = await axios.post(apiUrl`/users/${userId}/high-five`, {}, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
            if (highFiveResultOf(res.status) === 'sent') {
                sentThisSession.set(userId, { until: Date.now() + DAY_MS, known: true });
                bump((n) => n + 1); setBumped(shown + 1); setBurst(Date.now()); invalidateProfile(userId);
            }
        } catch (e) {
            const resp = (e as { response?: { status?: number; data?: unknown } })?.response;
            const r = highFiveResultOf(resp?.status, resp?.data);
            if (r === 'already') {
                // The server's own answer: flip to the pressed state for good (no error), using its reopening time when it gave one.
                const wait = (resp?.data as { retry_after?: unknown } | null | undefined)?.retry_after;
                const known = typeof wait === 'number' && Number.isFinite(wait) && wait > 0;
                sentThisSession.set(userId, { until: Date.now() + (known ? wait * 1000 : DAY_MS), known });
                bump((n) => n + 1); invalidateProfile(userId);
            }
            else setErr(r === 'gone' ? 'Unavailable right now.' : 'Could not send. Try again.');
        } finally {
            setBusy(false);
        }
    };

    const doneTip = highFiveAgainLabel(againAtMs, now);
    const label = done ? `High-fived today. ${doneTip}. ${shown} high-five${shown === 1 ? '' : 's'}` : `Send a high five. ${shown} high-five${shown === 1 ? '' : 's'} so far`;
    return (
        <span className="pcd-hf" data-testid="high-five" data-burst={burst ? "true" : undefined}>
            <button
                type="button" className="pcd-hf-btn" data-done={done ? 'true' : undefined}
                onClick={(e) => { e.stopPropagation(); void send(); }}
                disabled={busy} aria-disabled={done} aria-pressed={done} aria-label={label}
                title={done ? doneTip : 'High five'}
            >
                <Hand size={16} aria-hidden="true" />
                {shown > 0 ? <span className="pcd-hf-n" data-testid="high-five-count" aria-hidden="true">{shown}</span> : <span aria-hidden="true">High five</span>}
            </button>
            {burst > 0 && (
                <>
                    <span className="pcd-hf-plus" aria-hidden="true">+1</span>
                    <span className="pcd-hf-burst" aria-hidden="true">
                        {SPARKS.map((a) => <i key={a} style={{ ['--a' as string]: `${a}deg` } as React.CSSProperties} />)}
                    </span>
                </>
            )}
            {err && <span role="alert" className="pcd-hf-err">{err}</span>}
        </span>
    );
};

export default HighFiveButton;
