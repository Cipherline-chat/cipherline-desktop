import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { secureLocalStore } from '../utils/secureLocalStore';
import {
    type MuteDuration, type MuteMap, isMuted, mutesStoreKey, nextExpiry,
} from '../utils/channelMute';
import {
    type MuteState, emptyMuteState, liveMuteMap, migrateLegacyConvMutes, muteStateFor, parseMuteState, pruneMuteState, serializeMuteState, unmuteState,
} from '../utils/muteSync';
import { MUTES_CHANGED_EVENT, MUTES_USER_EDIT_EVENT } from '../services/muteSyncEnv';

/**
 * Per-channel / category / server mute state for the signed-in account.
 * See utils/channelMute.ts for the rules and utils/muteSync.ts for the record
 * (v2: stamped entries + tombstones, synced through the `mutes` own-device slot
 * by hooks/useMuteSync.ts). `mutes` stays the plain live `{id:{until}}` map so
 * every decision rule is unchanged; the stamps/tombstones live in `state`.
 *
 * Writes happen ONLY from user actions and from an actual expiry (never on
 * mount): the store is cold until the account is bound, and a mount-time write
 * would persist an empty map over the real one.
 */
export interface ChannelMuteApi {
    mutes: MuteMap;
    /** The clock the mutes were last judged against (bumps on expiry/focus). */
    now: number;
    isMuted: (id: string | null | undefined) => boolean;
    mute: (id: string, duration: MuteDuration) => void;
    unmute: (id: string) => void;
    /**
     * One-time, idempotent: fold the legacy per-conversation "Mute" (notif prefs mode 'none') into the shared
     * record as until-I-turn-it-back-on mutes. Returns the prefs with those entries reset, or null if nothing changed.
     */
    adoptLegacyConvMutes: (prefs: Record<string, 'all' | 'mentions' | 'none'>) => Record<string, 'all' | 'mentions' | 'none'> | null;
}

const NOOP: ChannelMuteApi = { mutes: {}, now: 0, isMuted: () => false, mute: () => {}, unmute: () => {}, adoptLegacyConvMutes: () => null };
const Ctx = createContext<ChannelMuteApi>(NOOP);
export const useChannelMutes = (): ChannelMuteApi => useContext(Ctx);

/** Owns the state. Dashboard calls this and hands the value to the provider. */
export function useChannelMuteState(userId: string | null | undefined): ChannelMuteApi {
    const read = useCallback((): MuteState => {
        if (!userId) return emptyMuteState();
        try { return parseMuteState(secureLocalStore.getItem(mutesStoreKey(userId)), Date.now()); } catch { return emptyMuteState(); }
    }, [userId]);
    const [state, setState] = useState<MuteState>(read);
    const [now, setNow] = useState(() => Date.now());
    const stateRef = useRef(state);
    stateRef.current = state;
    const mutes = useMemo<MuteMap>(() => liveMuteMap(state, now), [state, now]);

    const persist = useCallback((next: MuteState) => {
        if (!userId) return;
        try { secureLocalStore.setItem(mutesStoreKey(userId), serializeMuteState(next)); } catch { /* best effort */ }
    }, [userId]);
    const announceEdit = useCallback(() => {
        try { window.dispatchEvent(new CustomEvent(MUTES_USER_EDIT_EVENT, { detail: { userId } })); } catch { /* non-fatal */ }
    }, [userId]);

    // Account rebind: re-read (never write) once the per-account store is hot.
    useEffect(() => {
        if (!userId) { setState(emptyMuteState()); return; }
        let cancelled = false;
        void secureLocalStore.whenAccountReady().then(() => {
            if (!cancelled && secureLocalStore.isAccountReady(userId)) setState(read());
        });
        return () => { cancelled = true; };
    }, [userId, read]);

    // Another device's mutes were adopted (or a backup restored): re-read, never write.
    useEffect(() => {
        if (!userId) return;
        const onChanged = (e: Event) => {
            const uid = (e as CustomEvent<{ userId?: string }>).detail?.userId;
            if (uid && uid !== userId) return;
            if (secureLocalStore.isAccountReady(userId)) { setNow(Date.now()); setState(read()); }
        };
        window.addEventListener(MUTES_CHANGED_EVENT, onChanged);
        return () => window.removeEventListener(MUTES_CHANGED_EVENT, onChanged);
    }, [userId, read]);

    const sweep = useCallback(() => {
        const t = Date.now();
        setNow(t);
        // A lapsed mute becomes a tombstone (same stamp) so an older copy elsewhere cannot revive it.
        const pruned = pruneMuteState(stateRef.current, t);
        if (pruned !== stateRef.current) { stateRef.current = pruned; setState(pruned); persist(pruned); }
    }, [persist]);

    // One timer to the next lapse, plus a re-check on focus / wake / visibility
    // (a sleeping laptop's timer fires late or not at all).
    useEffect(() => {
        const next = nextExpiry(mutes, Date.now());
        // setTimeout caps at ~24.8 days; clamp, and the sweep re-arms the rest.
        const timer = next === null ? null : setTimeout(sweep, Math.min(Math.max(next - Date.now(), 0) + 50, 2_000_000_000));
        return () => { if (timer) clearTimeout(timer); };
    }, [mutes, sweep]);
    useEffect(() => {
        const onWake = () => { if (document.visibilityState !== 'hidden') sweep(); };
        window.addEventListener('focus', onWake);
        document.addEventListener('visibilitychange', onWake);
        return () => { window.removeEventListener('focus', onWake); document.removeEventListener('visibilitychange', onWake); };
    }, [sweep]);

    const mute = useCallback((id: string, duration: MuteDuration) => {
        const t = Date.now();
        const next = muteStateFor(stateRef.current, id, duration, t);
        if (next === stateRef.current) return;
        stateRef.current = next; setNow(t); setState(next); persist(next); announceEdit();
    }, [persist, announceEdit]);
    const unmuteFn = useCallback((id: string) => {
        const next = unmuteState(stateRef.current, id, Date.now());
        if (next === stateRef.current) return;
        stateRef.current = next; setState(next); persist(next); announceEdit();
    }, [persist, announceEdit]);

    const adoptLegacyConvMutes = useCallback((prefs: Record<string, 'all' | 'mentions' | 'none'>) => {
        const t = Date.now();
        const r = migrateLegacyConvMutes(prefs, stateRef.current, t);
        if (!r) return null;
        if (r.state !== stateRef.current) { stateRef.current = r.state; setNow(t); setState(r.state); persist(r.state); announceEdit(); }
        return r.prefs;
    }, [persist, announceEdit]);

    return useMemo<ChannelMuteApi>(() => ({
        mutes, now,
        isMuted: (id) => isMuted(mutes, id, now),
        mute, unmute: unmuteFn, adoptLegacyConvMutes,
    }), [mutes, now, mute, unmuteFn, adoptLegacyConvMutes]);
}

export const ChannelMuteProvider: React.FC<{ value: ChannelMuteApi; children: React.ReactNode }> = ({ value, children }) => (
    <Ctx.Provider value={value}>{children}</Ctx.Provider>
);
