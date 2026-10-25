/**
 * Drops saved composer drafts for conversations the account no longer has
 * (a DM that was removed, a server that was left, a channel that was deleted
 * or became private). See utils/composerDrafts.ts.
 *
 * Conservative by construction: a list that has not loaded — or loaded EMPTY,
 * which is what a failed fetch looks like — never prunes anything, because the
 * alternative is a flaky boot eating real drafts.
 */
import { useEffect } from 'react';
import secureLocalStore from '../utils/secureLocalStore';
import { composerDrafts } from '../utils/composerDraftStore';
import type { KnownConversations } from '../utils/composerDrafts';

export interface PruneInputs {
    /** Dashboard's conversation list: rows are keyed `conversation_id` (NOT `id`)
     *  — the id ChatPane files a DM / group draft under (`activeChat.id`). */
    conversations: ReadonlyArray<{ conversation_id?: string }>;
    servers: ReadonlyArray<{ server_id?: string }>;
    serverChannels: Readonly<Record<string, ReadonlyArray<{ channel_id?: string }> | undefined>>;
    /** useServers' first fetch has finished. */
    serversLoaded: boolean;
}

export function buildKnownConversations(i: PruneInputs): KnownConversations {
    // A list that yields no ids at all is "unknown", never "every conversation
    // is gone": reading the wrong field once made this an EMPTY set, and every
    // DM / group draft was pruned on the first list load (channel drafts, keyed
    // off servers/channels, were untouched — which is how it went unnoticed).
    const dmIdSet = new Set(i.conversations.map(c => c.conversation_id).filter((x): x is string => !!x));
    const dmIds = dmIdSet.size > 0 ? dmIdSet : null;
    const serverIds = i.serversLoaded && i.servers.length > 0
        ? new Set(i.servers.map(s => s.server_id).filter((x): x is string => !!x))
        : null;
    const channelIdsByServer: Record<string, ReadonlySet<string> | null> = {};
    if (i.serversLoaded) {
        for (const [sid, chans] of Object.entries(i.serverChannels)) {
            channelIdsByServer[sid] = chans && chans.length > 0
                ? new Set(chans.map(c => c.channel_id).filter((x): x is string => !!x))
                : null;
        }
    }
    return { dmIds, serverIds, channelIdsByServer };
}

export function useComposerDraftPrune(userId: string | null | undefined, inputs: PruneInputs): void {
    const { conversations, servers, serverChannels, serversLoaded } = inputs;
    useEffect(() => {
        if (!userId) return;
        let cancelled = false;
        const run = () => {
            // Pruning rewrites the record, so it waits for the account's
            // records to be readable (secure_local_store_account_rebind).
            if (cancelled || !secureLocalStore.isAccountReady(userId)) return;
            composerDrafts.prune(userId, buildKnownConversations({ conversations, servers, serverChannels, serversLoaded }));
        };
        if (secureLocalStore.isAccountReady(userId)) run();
        else void composerDrafts.whenReady().then(run, () => { /* nothing to prune */ });
        return () => { cancelled = true; };
    }, [userId, conversations, servers, serverChannels, serversLoaded]);
}
