import React, { useState } from 'react';
import { BadgeCheck, ExternalLink, Loader2 } from 'lucide-react';
import { ClButton } from '../../cl';
import { ProfileLinkIcon } from '../../ProfileLinkIcon';
import { openExternalLink } from '../../../utils/openExternalLink';
import { steamProfileUrl } from '../../../utils/profileLinks';
import type { SteamCard } from '../../../hooks/useProfileRelations';
import { useSteamConnect } from '../../../hooks/useSteamConnect';

/**
 * Settings > Profile > Showcase > Steam: connect a VERIFIED Steam account.
 *
 * "Connect Steam" asks the server for a one-time link (10 minutes, single
 * use, bound to this account) and opens it in the system browser through the
 * validated external-link path. You sign in on Steam's own page; the server
 * checks Steam's answer with Steam and only then records your SteamID - this
 * client never sends one. While that happens this section waits, re-reading
 * your profile every few seconds and whenever the window regains focus.
 * The flow itself is `useSteamConnect`, shared with the Links editor's Steam row.
 */

export const SteamConnect: React.FC<{
    token: string | null;
    userId: string | undefined;
    linked: boolean;
    card: SteamCard | null;
    /** Re-read /auth/me (the caller's refreshProfile). */
    onChanged: () => void | Promise<void>;
}> = ({ token, userId, linked, card, onChanged }) => {
    const { waiting, busy, connect, cancel, unlink: doUnlink } = useSteamConnect({ token, userId, linked, onChanged });
    const [confirmUnlink, setConfirmUnlink] = useState(false);
    const unlink = async () => { if (await doUnlink()) setConfirmUnlink(false); };

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
                        <ClButton size="sm" variant="ghost" onClick={cancel}>Cancel</ClButton>
                    </>
                ) : (
                    <ClButton size="sm" onClick={() => void connect()} loading={busy}>Connect Steam</ClButton>
                )}
            </span>
        </div>
    );
};
