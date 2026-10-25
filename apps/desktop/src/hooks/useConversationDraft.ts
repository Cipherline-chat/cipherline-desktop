/**
 * Live read of one conversation's unsent draft, for the conversation list.
 *
 * Subscribes to the draft store per row: a keystroke in the open composer only
 * re-renders a row whose own text changed (and the open conversation's row
 * reads '' — see utils/draftPreview.ts — so it never re-renders at all), not
 * the whole Dashboard.
 *
 * Right after an explicit sign-in the account's records are cold and `get`
 * returns ''; this re-reads once they are readable
 * (secure_local_store_account_rebind). Reads never write.
 */
import { useEffect, useReducer, useSyncExternalStore } from 'react';
import secureLocalStore from '../utils/secureLocalStore';
import { composerDrafts } from '../utils/composerDraftStore';
import { dmDraftKey, listDraftFor } from '../utils/draftPreview';

export function useConversationDraft(
    userId: string | null | undefined,
    conversationId: string,
    isActive: boolean,
): string {
    const read = () => (userId && !isActive
        ? listDraftFor(composerDrafts.get(userId, dmDraftKey(conversationId)), isActive)
        : '');
    const text = useSyncExternalStore(composerDrafts.subscribe, read, read);

    const [, bump] = useReducer((n: number) => n + 1, 0);
    useEffect(() => {
        if (!userId || secureLocalStore.isAccountReady(userId)) return;
        let cancelled = false;
        void composerDrafts.whenReady().then(() => { if (!cancelled) bump(); }, () => { /* stays empty */ });
        return () => { cancelled = true; };
    }, [userId]);

    return text;
}
