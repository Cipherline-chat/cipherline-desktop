/**
 * "Is this you? Claim with Discord" inside the "Not on Cipherline yet" card
 * (Discord import phase 3; plan B6.2 rule 5, B6.3 entry point a).
 *
 *   not linked  -> "Claim with Discord" starts Discord sign-in in the system
 *                  browser (useDiscordLink); the card updates by itself.
 *   linked      -> asks the server which author in THIS server matches your
 *                  proven Discord account (only ever your own); a match offers
 *                  "Claim these messages" (the confirm dialog), anything else
 *                  says your Discord account did not write them.
 *   unavailable -> one quiet line (the server has not set Discord sign-in up).
 *
 * Text only: no Discord logo (owner rule; plan C3).
 */
import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { ClButton } from '../../cl';
import { useDiscordLink } from '../../../hooks/useDiscordLink';
import { CLAIMS_UNAVAILABLE_MESSAGE, claimErrorMessage, fetchClaimable, isUnavailable, type ClaimableAuthor } from '../../../utils/discordClaims';

export const ClaimSlot: React.FC<{
    token: string | null;
    serverId: string | null;
    authorRef: string;
    /** Open the confirm dialog (the card closes first: the dialog outlives it). */
    onClaim: (author: ClaimableAuthor) => void;
}> = ({ token, serverId, authorRef, onClaim }) => {
    const link = useDiscordLink(token);
    const [match, setMatch] = useState<ClaimableAuthor | null | undefined>(undefined);
    const [error, setError] = useState<string | null>(null);
    const linked = link.status?.linked === true;

    useEffect(() => {
        if (!linked || !token || !serverId) { setMatch(undefined); return; }
        let live = true;
        setMatch(undefined); setError(null);
        fetchClaimable(token, serverId)
            .then(r => { if (live) setMatch(r.authors.find(a => a.author_id === authorRef) ?? null); })
            .catch(err => { if (live) { setMatch(null); setError(isUnavailable(err) ? CLAIMS_UNAVAILABLE_MESSAGE : claimErrorMessage(err, 'Could not check right now. Try again.')); } });
        return () => { live = false; };
    }, [linked, token, serverId, authorRef, link.linkedTick]);

    const box = (children: React.ReactNode) => (
        <div className="mt-3 rounded-lg border px-3 py-2.5" style={{ borderColor: 'var(--cl-border)' }} data-claim-slot aria-live="polite">{children}</div>
    );
    const line = (text: string) => <div className="text-[12.5px] leading-snug" style={{ color: 'var(--cl-muted)' }}>{text}</div>;

    if (!token || !serverId) return null;
    if (!link.status) return box(<div className="flex items-center gap-2">{line('Checking…')}</div>);
    if (!link.status.available) return box(line('Claiming imported messages isn\'t available on this Cipherline server yet.'));

    if (!linked) {
        return box(link.waiting ? (
            <div className="flex items-center gap-2">
                <Loader2 size={15} className="animate-spin shrink-0" aria-hidden="true" style={{ color: 'var(--cl-faint)' }} />
                <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-semibold" style={{ color: 'var(--cl-bright)' }}>Finish in your browser</div>
                    {line('Approve on Discord\'s page, then come back. This updates by itself.')}
                </div>
                <ClButton size="sm" variant="ghost" onClick={link.cancel}>Cancel</ClButton>
            </div>
        ) : (
            <>
                <div className="text-[12.5px] font-semibold" style={{ color: 'var(--cl-bright)' }}>Is this you?</div>
                {line('Sign in with Discord to prove it. These messages then show with your Cipherline name and picture.')}
                {link.error && <div className="mt-1 text-[12px]" role="alert" style={{ color: 'var(--cl-danger-text)' }}>{link.error}</div>}
                <div className="mt-2">
                    <ClButton size="sm" onClick={() => void link.connect()} loading={link.busy}>Claim with Discord</ClButton>
                </div>
            </>
        ));
    }

    if (match === undefined && !error) return box(<div className="flex items-center gap-2"><Loader2 size={14} className="animate-spin" aria-hidden="true" style={{ color: 'var(--cl-faint)' }} />{line('Checking your Discord account…')}</div>);
    if (error) return box(<div role="alert">{line(error)}</div>);
    if (!match) return box(line('Your linked Discord account didn\'t write these messages.'));
    if (match.claimed) return box(line('You already claimed these messages.'));
    return box(
        <>
            <div className="text-[12.5px] font-semibold" style={{ color: 'var(--cl-bright)' }}>These are yours</div>
            {line('Your linked Discord account wrote these messages.')}
            <div className="mt-2">
                <ClButton size="sm" onClick={() => onClaim(match)}>Claim these messages</ClButton>
            </div>
        </>,
    );
};

export default ClaimSlot;
