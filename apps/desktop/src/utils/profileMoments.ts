/**
 * Small profile "moments": friend anniversaries and incoming high-fives.
 *
 * Friend anniversaries use the accepted instant the friends list ALREADY
 * carries (`friends_since` on GET /v1/friends); the profile endpoint itself
 * only ever sends the month. The day-level maths is on this device, in local
 * time (utils/profileExtras.ts `anniversaryYears`). A per-device ledger keeps
 * the open-the-app toast to once per friend per year.
 */
import { anniversaryYears } from './profileExtras';

/** Window event fired by useRealtime on `user:high_five`. detail: HighFiveEventDetail */
export const HIGH_FIVE_EVENT = 'cipherline:high-five';
/** Window event that plays the Keys high-five (HighFiveOverlay listens). */
export const HIGH_FIVE_PLAY_EVENT = 'cipherline:high-five-play';

export interface HighFiveEventDetail { from_user_id: string; from_username: string; count: number }

/** Classified in services/backupRegistry.ts (device-local, not in a backup). */
export const anniversariesKey = (userId: string) => `cipherline_friend_anniversaries_${userId}`;

export interface FriendRow { user_id: string; username?: string; friends_since?: string | null }

const sinceByFriend = new Map<string, string>();

/** Remember each accepted friend's accepted instant so an opened card can celebrate. */
export function registerFriendsSince(accepted: readonly FriendRow[]): void {
    sinceByFriend.clear();
    for (const f of accepted) if (f?.user_id && typeof f.friends_since === 'string') sinceByFriend.set(f.user_id, f.friends_since);
}

/** Years of friendship if today (local) is the anniversary with `userId`, else 0. */
export function anniversaryYearsFor(userId: string, now = new Date()): number {
    return anniversaryYears(sinceByFriend.get(userId), now);
}

export type AnniversaryLedger = Record<string, number>;

export function parseLedger(raw: string | null | undefined): AnniversaryLedger {
    try {
        const o = JSON.parse(raw ?? 'null');
        if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
        const out: AnniversaryLedger = {};
        for (const [k, v] of Object.entries(o)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
        return out;
    } catch { return {}; }
}

export interface DueAnniversary { user_id: string; username: string; years: number }

/** Friends whose anniversary is today (local) and who have not been toasted this year. */
export function dueAnniversaries(accepted: readonly FriendRow[], now: Date, ledger: AnniversaryLedger): DueAnniversary[] {
    const out: DueAnniversary[] = [];
    for (const f of accepted) {
        if (!f?.user_id) continue;
        const years = anniversaryYears(f.friends_since, now);
        if (years > 0 && ledger[f.user_id] !== now.getFullYear()) out.push({ user_id: f.user_id, username: f.username || 'a friend', years });
    }
    return out;
}

/** The toast text for the day's anniversaries (one line, however many). */
export function anniversaryToastText(due: readonly DueAnniversary[]): string | null {
    if (due.length === 0) return null;
    const first = due[0];
    const yrs = first.years === 1 ? 'one year' : `${first.years} years`;
    return due.length === 1
        ? `You and ${first.username} have been friends for ${yrs} today.`
        : `${first.username} (${yrs}) and ${due.length - 1} more friend ${due.length === 2 ? 'anniversary' : 'anniversaries'} today.`;
}
