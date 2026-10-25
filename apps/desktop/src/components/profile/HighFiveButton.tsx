import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Hand } from 'lucide-react';
import { apiUrl } from '../../utils/apiPath';
import { highFiveResultOf } from '../../utils/profileExtras';
import { invalidateProfile } from '../../utils/profileCache';
import '../../styles/profile-card.css';

/** Who this session already high-fived (the server's 24 h key is the authority; this just keeps the button honest on re-open). */
const sentThisSession = new Set<string>();

const SPARKS = [0, 60, 120, 180, 240, 300];

/**
 * "High five" for another user's card: one button that carries the running
 * count. One per person per 24 h (server rule); once sent - or when the server
 * says it was already sent today - it stays pressed as "High-fived today".
 *
 * Feedback (transform/opacity only, skipped under reduced motion): the hand
 * slaps, a "+1" floats up and a small burst goes off; the count ticks over.
 */
export const HighFiveButton: React.FC<{ userId: string; token: string; count: number }> = ({ userId, token, count }) => {
    const [done, setDone] = useState(() => sentThisSession.has(userId));
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
                sentThisSession.add(userId); setDone(true); setBumped(shown + 1); setBurst(Date.now()); invalidateProfile(userId);
            }
        } catch (e) {
            const status = (e as { response?: { status?: number; data?: { message?: unknown } } })?.response?.status;
            const msg = (e as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
            const r = highFiveResultOf(status, msg);
            if (r === 'already') { sentThisSession.add(userId); setDone(true); }
            else setErr(r === 'gone' ? 'Unavailable right now.' : 'Could not send. Try again.');
        } finally {
            setBusy(false);
        }
    };

    const label = done ? `High-fived today. ${shown} high-five${shown === 1 ? '' : 's'}` : `Send a high five. ${shown} high-five${shown === 1 ? '' : 's'} so far`;
    return (
        <span className="pcd-hf" data-testid="high-five" data-burst={burst ? "true" : undefined}>
            <button
                type="button" className="pcd-hf-btn" data-done={done ? 'true' : undefined}
                onClick={(e) => { e.stopPropagation(); void send(); }}
                disabled={busy} aria-disabled={done} aria-pressed={done} aria-label={label}
                title={done ? 'High-fived today' : 'High five'}
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
