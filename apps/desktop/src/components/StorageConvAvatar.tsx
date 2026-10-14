import React from 'react';
import { Archive } from 'lucide-react';
import { EncryptedAvatar } from './EncryptedAvatar';

/** The slice of a conversation row this needs (the same fields the sidebar reads). */
export interface StorageConvAvatarConv {
    type?: string;
    avatar_url?: string | null;
    other_user_id?: string | null;
}

/**
 * Leading visual for a Settings -> Storage conversation row, matching the
 * sidebar's conversation list: a DM shows the other person's avatar, a group
 * shows its own icon, both through `EncryptedAvatar` (so they share the same
 * cache, the same friend privacy gate and the same initials / group fallback).
 * Nothing is fetched here that the sidebar has not already resolved - the
 * hook behind EncryptedAvatar is the shared in-memory + IndexedDB cache.
 *
 * Same footprint as the server rows' icon (32px). A conversation that is no
 * longer in the list ("deleted") gets the same archive placeholder the
 * left-server rows use.
 */
export const StorageConvAvatar: React.FC<{
    conv: StorageConvAvatarConv | null | undefined;
    token: string | null;
}> = ({ conv, token }) => {
    if (!conv) {
        return (
            <span className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center" style={{ background: 'rgba(255,255,255,.05)', color: 'var(--cl-faint)' }}>
                <Archive className="w-4 h-4" aria-hidden="true" />
            </span>
        );
    }
    // Mirrors Dashboard's list: `conv.type === 'dm'` -> user avatar, anything else -> group.
    const isDm = conv.type === 'dm';
    return (
        <div className="w-8 h-8 rounded-full shrink-0 flex items-center justify-center overflow-hidden">
            <EncryptedAvatar
                attachmentId={conv.avatar_url ?? null}
                userId={isDm ? (conv.other_user_id ?? null) : null}
                isGroup={!isDm}
                token={token}
                className="w-full h-full"
                fallbackSize={13}
                disableClickProfile
            />
        </div>
    );
};
