import { useSyncExternalStore } from 'react';
import secureLocalStore from './secureLocalStore';

/**
 * "Another app is getting this game's Rich Presence" — a one-time tip
 * (components/RichPresenceHeldTip.tsx).
 *
 * When main sees (electron/rich-presence.ts HeldHintTracker): a game known to
 * announce Rich Presence is running, another Rich Presence server holds the
 * local endpoint (in practice the Discord app), and nothing has reached
 * Cipherline for ~30 s. Main never runs the listener — and so never sends
 * this — under the CI smoke test or with game activity off; the renderer
 * checks game activity again here.
 *
 * Why the copy says "quit", not "change a setting": the game connects to the
 * FIRST Rich Presence endpoint that answers (discord-ipc-0), which the
 * Discord client opens whenever it runs. Its "Share your detected activities
 * with others" privacy switch only hides activity from other Discord users;
 * the client still owns the endpoint and still receives the game's updates.
 * Nothing in Discord's settings releases it, so the only accurate advice is
 * to quit Discord (including from the system tray).
 *
 * Frequency: "Got it" = not again for THIS game; "Don't show again" = never,
 * for any game. Device-global (not per account: it is about this machine),
 * kept in secureLocalStore, EXCLUDED from backups (services/backupRegistry.ts).
 */
export const RPC_HELD_TIP_KEY = 'cipherline_rpc_held_tip';
const MAX_GAMES = 50;

interface TipRecord { never: boolean; games: string[] }

const gameKey = (name: string) => name.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function read(): TipRecord {
    try {
        const raw = secureLocalStore.getItem(RPC_HELD_TIP_KEY);
        if (!raw) return { never: false, games: [] };
        const v = JSON.parse(raw) as Partial<TipRecord>;
        return {
            never: v.never === true,
            games: Array.isArray(v.games) ? v.games.filter((g): g is string => typeof g === 'string').slice(-MAX_GAMES) : [],
        };
    } catch {
        return { never: false, games: [] };
    }
}

function write(r: TipRecord): void {
    try { secureLocalStore.setItem(RPC_HELD_TIP_KEY, JSON.stringify({ never: r.never, games: r.games.slice(-MAX_GAMES) })); } catch { /* best-effort */ }
}

let pending: { name: string } | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

/** Pure decision: show the tip for this game? */
export function shouldOfferHeldTip(rec: TipRecord, name: string, gameActivityOn: boolean, alreadyShowing: boolean): boolean {
    if (!gameActivityOn || alreadyShowing || rec.never) return false;
    const k = gameKey(name);
    return !!k && !rec.games.includes(k);
}

/** Main said a game's Rich Presence is held elsewhere. */
export function offerRichPresenceHeldTip(name: string, gameActivityOn: boolean): boolean {
    if (!shouldOfferHeldTip(read(), name, gameActivityOn, pending !== null)) return false;
    pending = { name };
    emit();
    return true;
}

/** "Got it": not again for this game. */
export function acknowledgeHeldTip(): void {
    if (!pending) return;
    const r = read();
    const k = gameKey(pending.name);
    if (k && !r.games.includes(k)) r.games.push(k);
    write(r);
    pending = null;
    emit();
}

/** "Don't show again": never, for any game. */
export function neverShowHeldTip(): void {
    const r = read();
    r.never = true;
    write(r);
    pending = null;
    emit();
}

/** Game activity switched off while it was up: withdraw without recording anything. */
export function withdrawHeldTip(): void {
    if (!pending) return;
    pending = null;
    emit();
}

export const heldTipStore = {
    subscribe(l: () => void): () => void { listeners.add(l); return () => listeners.delete(l); },
    get(): { name: string } | null { return pending; },
};

export function useRichPresenceHeldTip(): { name: string } | null {
    return useSyncExternalStore(heldTipStore.subscribe, heldTipStore.get, () => null);
}

/** Test hook. */
export function __resetHeldTipForTests(): void { pending = null; listeners.clear(); }
