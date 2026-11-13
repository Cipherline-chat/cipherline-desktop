/** React's view of utils/shareFallbackNotice.ts, for one share's tile. */
import React from 'react';
import { shareFallbackNotice, type ShareFallbackNotice } from '../utils/shareFallbackNotice';

const emptySubscribe = () => () => { /* not a watched remote share: nothing to follow */ };

export function useShareFallbackNotice(sid: string | null | undefined): ShareFallbackNotice | null {
    return React.useSyncExternalStore(
        sid ? shareFallbackNotice.subscribe : emptySubscribe,
        () => shareFallbackNotice.notice(sid),
    );
}
