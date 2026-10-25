/**
 * The device-local bookkeeping behind two clock-gated composer touches
 * (utils/composerFun.ts). Both live in the existing egg SEEN-LEDGER
 * (`cipherline_egg_seen`, utils/easterEggs.ts — device-local and already
 * excluded from backups), so no new persisted key exists and backupRegistry
 * needs no new row. Each entry is an id, a count and a timestamp: nothing
 * about the message, the conversation or who it went to.
 */
import { secureLocalStore } from './secureLocalStore';
import { EGG_LEDGER_KEY, claimEgg, noteEgg, parseLedger, type EggStore } from './easterEggs';
import { isFirstSendOfDay, isOnTheHour } from './composerFun';

const defaultStore: EggStore = {
    getItem: (k: string) => secureLocalStore.getItem(k),
    setItem: (k: string, v: string) => secureLocalStore.setItem(k, v),
};

/** Ledger ids (rate-limit bookkeeping, not registry eggs). */
export const FIRST_TODAY_LEDGER_ID = 'composer-first-today';
export const ON_THE_HOUR_LEDGER_ID = 'composer-on-the-hour';

/** True (and recorded) for the first send of this local calendar day on this device. */
export function claimFirstSendOfDay(now: Date = new Date(), st: EggStore = defaultStore): boolean {
    try {
        const last = parseLedger(st.getItem(EGG_LEDGER_KEY))[FIRST_TODAY_LEDGER_ID]?.last;
        if (!isFirstSendOfDay(last, now)) return false;
        noteEgg(st, FIRST_TODAY_LEDGER_ID, now.getTime());
        return true;
    } catch {
        return false;
    }
}

/** True (and recorded) for a send in the :00 minute — at most once per hour. */
export function claimOnTheHour(now: Date = new Date(), st: EggStore = defaultStore): boolean {
    if (!isOnTheHour(now)) return false;
    try {
        return claimEgg(st, ON_THE_HOUR_LEDGER_ID, now.getTime(), { cooldownMs: 50 * 60 * 1000 });
    } catch {
        return false;
    }
}
