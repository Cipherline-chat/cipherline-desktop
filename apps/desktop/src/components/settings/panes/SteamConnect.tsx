import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { BadgeCheck, ExternalLink, Loader2 } from 'lucide-react';
import { ClButton } from '../../cl';
import { API_BASE } from '../../../constants';
import { useToast } from '../../../contexts/ToastContext';
import { ProfileLinkIcon } from '../../ProfileLinkIcon';
import { openExternalLink } from '../../../utils/openExternalLink';
import { steamProfileUrl } from '../../../utils/profileLinks';
import { patchErrorMessage } from '../../../utils/patchErrorMessage';
import { forgetSteamCard, type SteamCard } from '../../../hooks/useProfileRelations';

/**
 * Settings > Profile > Showcase > Steam: connect a VERIFIED Steam account.
 *
 * "Connect Steam" asks the server for a one-time link (10 minutes, single
 * use, bound to this account) and opens it in the system browser through the
 * validated external-link path. You sign in on Steam's own page; the server
 * checks Steam's answer with Steam and only then records your SteamID - this
 * client never sends one. While that happens this section waits, re-reading
 * your profile every few seconds and whenever the window regains focus.
 */

const POLL_MS = 3000;
const WAIT_MAX_MS = 10 * 60 * 1000;

export const SteamConnect: React.FC<{
    token: string | null;
    userId: string | undefined;
    linked: boolean;
    card: SteamCard | null;
    /** Re-read /auth/me (the caller's refreshProfile). */
    onChanged: () => void | Promise<void>;
}> = ({ token, userId, linked, card, onChanged }) => {
    const toast = useToast();
    const [waitingSince, setWaitingSince] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);
    const [confirmUnlink, setConfirmUnlink] = useState(false);
    const waiting = waitingSince !== null && !linked;

    // Linked while we waited: say so once (a side effect, so it runs after render).
    const waitedRef = useRef(false);
    useEffect(() => { waitedRef.current = waitingSince !== null; }, [waitingSince]);
    useEffect(() => {
        if (!linked || !waitedRef.current) return;
        waitedRef.current = false;
        setWaitingSince(null); // the wait ends when the server says linked
        toast.push({ kind: 'success', title: 'Steam linked', message: 'Your Steam account now shows as verified.' });
    }, [linked, toast]);

    useEffect(() => {
        if (!waiting || waitingSince === null) return;
        const poll = () => {
            if (Date.now() - waitingSince > WAIT_MAX_MS) { setWaitingSince(null); return; }
            void onChanged();
        };
        const t = window.setInterval(poll, POLL_MS);
        window.addEventListener('focus', poll);
        return () => { window.clearInterval(t); window.removeEventListener('focus', poll); };
    }, [waiting, waitingSince, onChanged]);

    const connect = async () => {
        if (!token || busy) return;
        setBusy(true);
        try {
            const res = await axios.post(`${API_BASE}/steam/link`, {}, { headers: { Authorization: `Bearer ${token}` } });
            const url = typeof res.data?.url === 'string' ? res.data.url : '';
            if (!openExternalLink(url).ok) throw new Error('bad url');
            forgetSteamCard(userId);
            setWaitingSince(Date.now());
        } catch (err) {
            toast.push({ kind: 'error', title: 'Could not start', message: patchErrorMessage(err, 'Steam linking is unavailable right now. Try again in a minute.') });
        } finally {
            setBusy(false);
        }
    };

    const unlink = async () => {
        if (!token || busy) return;
        setBusy(true);
        try {
            await axios.delete(`${API_BASE}/steam/link`, { headers: { Authorization: `Bearer ${token}` } });
            forgetSteamCard(userId);
            setConfirmUnlink(false);
            await onChanged();
        } catch (err) {
            toast.push({ kind: 'error', title: 'Not unlinked', message: patchErrorMessage(err, 'Could not unlink Steam. Try again.') });
        } finally {
            setBusy(false);
        }
    };

    if (linked) {
        return (
            <div className="ps-steam" data-testid="steam-linked">
                <span className="ps-steam-av">
                    {card?.avatar ? <img src={card.avatar} alt="" draggable={false} /> : <ProfileLinkIcon platform="steam" size={20} />}
                </span>
                <span className="ps-steam-txt">
                    <b>{card?.persona_name ?? 'Steam account'}</b>
                    <span className="ps-steam-ok"><BadgeCheck size={12} strokeWidth={2.5} aria-hidden="true" /> Verified by Steam</span>
                </span>
                {confirmUnlink ? (
                    <span className="ps-steam-actions" role="group" aria-label="Unlink Steam?">
                        <span className="ps-steam-q">Unlink?</span>
                        <ClButton size="sm" variant="ghost" onClick={() => setConfirmUnlink(false)} disabled={busy}>Keep</ClButton>
                        <ClButton size="sm" variant="danger" onClick={() => void unlink()} loading={busy}>Unlink</ClButton>
                    </span>
                ) : (
                    <span className="ps-steam-actions">
                        {card && (
                            <button type="button" className="su-iconbtn" aria-label="Open your Steam profile" title="Open your Steam profile"
                                onClick={() => openExternalLink(steamProfileUrl(card.steam_id))}>
                                <ExternalLink size={14} />
                            </button>
                        )}
                        <ClButton size="sm" variant="ghost" onClick={() => setConfirmUnlink(true)}>Unlink</ClButton>
                    </span>
                )}
            </div>
        );
    }

    return (
        <div className="ps-steam ps-steam--connect" data-testid="steam-connect" aria-live="polite">
            <span className="ps-steam-av"><ProfileLinkIcon platform="steam" size={20} /></span>
            <span className="ps-steam-txt">
                {waiting ? (
                    <>
                        <b>Finish in your browser</b>
                        <span>Sign in on Steam&rsquo;s page, then come back. This updates by itself.</span>
                    </>
                ) : (
                    <>
                        <b>Show a verified Steam account</b>
                        <span>You sign in on Steam&rsquo;s own page. Cipherline only learns your SteamID, never your password.</span>
                    </>
                )}
            </span>
            <span className="ps-steam-actions">
                {waiting ? (
                    <>
                        <Loader2 size={16} className="ps-spin" aria-label="Waiting for Steam" />
                        <ClButton size="sm" variant="ghost" onClick={() => setWaitingSince(null)}>Cancel</ClButton>
                    </>
                ) : (
                    <ClButton size="sm" onClick={() => void connect()} loading={busy}>Connect Steam</ClButton>
                )}
            </span>
        </div>
    );
};
