/**
 * In-memory clipboard for permission overrides — shared by every open
 * channel / category editor so you can copy in one dialog and paste in the
 * next.
 *
 * Deliberately NOT the system clipboard and NOT persisted: it is session
 * state, role ids are meaningless outside their own server, and nothing here
 * needs to survive a restart. Both slots remember which server they came
 * from and refuse to paste anywhere else.
 */

import { useSyncExternalStore } from 'react';
import type { DraftMap, OverrideBits } from './overrideDraft';

export interface RoleClip {
    serverId: string;
    /** e.g. "@Moderator in #general" — shown on the Paste button. */
    label: string;
    bits: OverrideBits;
    /** The mask the bits were copied under (what the source editor showed). */
    mask: bigint;
}

export interface ChannelClip {
    serverId: string;
    label: string;
    draft: DraftMap;
    mask: bigint;
}

interface ClipState {
    role: RoleClip | null;
    channel: ChannelClip | null;
}

let state: ClipState = { role: null, channel: null };
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

export const permClipboard = {
    get: (): ClipState => state,
    copyRole(clip: RoleClip) { state = { ...state, role: clip }; emit(); },
    copyChannel(clip: ChannelClip) { state = { ...state, channel: clip }; emit(); },
    clear() { state = { role: null, channel: null }; emit(); },
    subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
};

/** React binding; returns the clips usable in `serverId` (null otherwise). */
export function usePermClipboard(serverId: string): { role: RoleClip | null; channel: ChannelClip | null } {
    const s = useSyncExternalStore(permClipboard.subscribe, permClipboard.get, permClipboard.get);
    return {
        role: s.role && s.role.serverId === serverId ? s.role : null,
        channel: s.channel && s.channel.serverId === serverId ? s.channel : null,
    };
}
