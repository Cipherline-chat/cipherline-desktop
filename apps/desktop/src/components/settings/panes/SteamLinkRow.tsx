import React, { useState } from 'react';
import { BadgeCheck, Loader2 } from 'lucide-react';
import { ClButton } from '../../cl';
import { ProfileLinkIcon } from '../../ProfileLinkIcon';
import type { SteamCard } from '../../../hooks/useProfileRelations';
import { useSteamConnect } from '../../../hooks/useSteamConnect';

export interface SteamLinkRowProps {
    token: string | null;
    userId: string | undefined;
    /** The server says this account has a verified Steam link. */
    linked: boolean;
    card: SteamCard | null;
    /** Re-read /auth/me (the caller's refreshProfile). */
    onChanged: () => void | Promise<void>;
    disabled?: boolean;
}

/**
 * The Steam row at the top of the Links editor. Steam is never a pasted link:
 * it is either VERIFIED (Steam OpenID: you sign in on Steam's own page, the
 * server checks Steam's answer) or absent. Not connected: a compact "Connect
 * Steam" button running the same flow as Settings > Steam (`useSteamConnect`).
 * Connected: the verified account with an Unlink (asks first).
 */
export const SteamLinkRow: React.FC<SteamLinkRowProps> = ({ token, userId, linked, card, onChanged, disabled }) => {
    const { waiting, busy, error, connect, cancel, unlink: doUnlink } = useSteamConnect({ token, userId, linked, onChanged });
    const [confirmUnlink, setConfirmUnlink] = useState(false);
    const unlink = async () => { if (await doUnlink()) setConfirmUnlink(false); };
    const name = card?.persona_name ?? 'Steam account';

    if (linked) {
        return (
            <div className="ps-steam ps-steam--row" data-testid="steam-link-row" data-state="verified">
                <span className="ps-steam-av">
                    {card?.avatar ? <img src={card.avatar} alt="" draggable={false} /> : <ProfileLinkIcon platform="steam" size={16} />}
                </span>
                <span className="ps-steam-txt">
                    <b>{name}</b>
                    <span className="ps-steam-ok"><BadgeCheck size={12} strokeWidth={2.5} aria-hidden="true" /> Steam, verified</span>
                </span>
                {confirmUnlink ? (
                    <span className="ps-steam-actions" role="group" aria-label="Unlink Steam?">
                        <span className="ps-steam-q">Unlink?</span>
                        <ClButton size="sm" variant="ghost" onClick={() => setConfirmUnlink(false)} disabled={busy}>Keep</ClButton>
                        <ClButton size="sm" variant="danger" onClick={() => void unlink()} loading={busy}>Unlink</ClButton>
                    </span>
                ) : (
                    <span className="ps-steam-actions">
                        <ClButton size="sm" variant="ghost" onClick={() => setConfirmUnlink(true)} disabled={disabled}>Unlink</ClButton>
                    </span>
                )}
                {error && <p className="ps-inline-err ps-steam-err" role="alert">{error}</p>}
            </div>
        );
    }

    return (
        <div className="ps-steam ps-steam--row" data-testid="steam-link-row" data-state={waiting ? 'waiting' : 'connect'} aria-live="polite">
            <span className="ps-steam-av"><ProfileLinkIcon platform="steam" size={16} /></span>
            <span className="ps-steam-txt">
                {waiting ? (
                    <>
                        <b>Finish in your browser</b>
                        <span>Sign in on Steam&rsquo;s page, then come back. This updates by itself.</span>
                    </>
                ) : (
                    <>
                        <b>Steam</b>
                        <span>Sign in with Steam to show your verified account.</span>
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
                    <ClButton size="sm" onClick={() => void connect()} loading={busy} disabled={disabled || !token}>Connect Steam</ClButton>
                )}
            </span>
            {error && !waiting && <p className="ps-inline-err ps-steam-err" role="alert">{error}</p>}
        </div>
    );
};
