/**
 * The auto-map notice (Discord import phase 3; plan B6.3 "Auto-map", D28):
 * "Your Discord messages imported into <server> now show as you. Review ·
 * Unclaim · Report", and for a linked user with automatic claiming off, the
 * confirm prompt for messages they can claim.
 *
 * Driven by `GET /v1/discord/claims` at sign-in and whenever the server says
 * `discord:claims_changed` (an import finished). Which notices you already
 * acknowledged is kept on this device (secureLocalStore, encrypted, per
 * account; classified in services/backupRegistry.ts), never on the server.
 * One notice at a time.
 */
import React, { useCallback, useEffect, useState } from 'react';
import secureLocalStore from '../../../utils/secureLocalStore';
import {
    claimNoticesSeenKey, fetchMyClaims, parseSeen, pendingClaimNotices, requestOpenImportedMessage,
    type ClaimableAuthor,
} from '../../../utils/discordClaims';
import { ClaimImportDialog } from './ClaimImportDialog';
import { DiscordLinkMovedNotice } from './DiscordLinkMovedNotice';
import { useDiscordLink } from '../../../hooks/useDiscordLink';

export const DiscordClaimNotices: React.FC<{
    token: string | null;
    userId: string | null | undefined;
    /** Bumped by `discord:claims_changed`. */
    changedTick: number;
    channelName?: (serverId: string, channelId: string) => string | null;
}> = ({ token, userId, changedTick, channelName }) => {
    const [queue, setQueue] = useState<Array<{ kind: 'auto' | 'claimable'; author: ClaimableAuthor }>>([]);
    // The shared link store: read at sign-in (so a link moved away while you
    // were offline is noticed), live on `discord:link_changed` (useRealtime).
    const link = useDiscordLink(token);

    useEffect(() => {
        if (!token || !userId) return;
        let live = true;
        void (async () => {
            await secureLocalStore.whenAccountReady();
            try {
                const { linked, authors } = await fetchMyClaims(token);
                if (!live || !linked) return;
                const seen = parseSeen(secureLocalStore.getItem(claimNoticesSeenKey(userId)));
                setQueue(pendingClaimNotices(authors, seen));
            } catch { /* not available on this server, or offline: no notice */ }
        })();
        return () => { live = false; };
    }, [token, userId, changedTick]);

    const acknowledge = useCallback((authorId: string) => {
        if (userId) {
            const seen = parseSeen(secureLocalStore.getItem(claimNoticesSeenKey(userId)));
            seen.add(authorId);
            secureLocalStore.setItem(claimNoticesSeenKey(userId), JSON.stringify([...seen].slice(-500)));
        }
        setQueue(q => q.filter(n => n.author.author_id !== authorId));
    }, [userId]);

    // Phase 3b: "your Discord link was moved to another account" comes first;
    // one dialog at a time, so the claim notices wait behind it.
    if (link.status && !link.status.linked && link.status.moved_away_at) return <DiscordLinkMovedNotice link={link} />;

    const head = queue[0];
    if (!head) return null;
    return (
        <ClaimImportDialog
            key={head.author.author_id}
            open
            mode={head.kind === 'auto' ? 'auto' : 'claim'}
            author={head.author}
            token={token}
            channelName={channelName ? (cid) => channelName(head.author.server_id, cid) : undefined}
            onOpenMessage={head.author.member ? requestOpenImportedMessage : undefined}
            onClose={() => acknowledge(head.author.author_id)}
        />
    );
};

export default DiscordClaimNotices;
