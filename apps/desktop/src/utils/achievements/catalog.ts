/**
 * The achievement catalog: names, descriptions and the UNLOCK RULES.
 *
 * `id` / `tier` / `secret` are MIRRORED BY HAND in
 * `apps/api/src/achievements/achievement-registry.ts`; `catalog.test.ts` reads
 * that file and fails on drift. Ids are stable and never reused.
 *
 * TRUST MODEL: progress is counted on this device from events the client
 * already sees, and unlocks are client-attested (a modified client can claim
 * anything). That is accepted because achievements may drive COSMETICS ONLY
 * (the profile level: showcase slots + decoration colours, see
 * utils/profileExtras.ts): never a badge, limit, permission or entitlement.
 * Do not change that without moving the checks server-side.
 *
 * Rules are deliberately long-term. `progress` is the only place a rule lives:
 * unlocked <=> current >= target, and the same numbers drive the progress bar
 * (self only, never sent anywhere).
 */
import type { Totals } from './state';

export type AchievementTier = 'bronze' | 'silver' | 'gold';

/** How a progress number is shown. */
export type ProgressUnit = 'hours' | 'count' | 'days' | 'people';

export interface Progress {
    current: number;
    target: number;
}

export interface AchievementDef {
    id: string;
    name: string;
    description: string;
    tier: AchievementTier;
    secret: boolean;
    /** Key into the icon map in AchievementsPanel (kept out of here so this stays node-testable). */
    icon: string;
    unit: ProgressUnit;
    progress: (t: Totals) => Progress;
}

const at = (current: number, target: number): Progress => ({ current, target });

export const ACHIEVEMENTS: readonly AchievementDef[] = [
    { id: 'voice-100h', name: 'Deep Listener', tier: 'bronze', secret: false, icon: 'mic', unit: 'hours',
      description: 'Spend 100 hours in calls and voice channels.', progress: t => at(t.voiceHours, 100) },
    { id: 'voice-500h', name: 'Abyssal Voice', tier: 'silver', secret: false, icon: 'mic', unit: 'hours',
      description: 'Spend 500 hours in calls and voice channels.', progress: t => at(t.voiceHours, 500) },
    { id: 'voice-2000h', name: 'Foghorn', tier: 'gold', secret: false, icon: 'mic', unit: 'hours',
      description: 'Spend 2,000 hours in calls and voice channels.', progress: t => at(t.voiceHours, 2000) },
    { id: 'marathon-call', name: 'Marathon', tier: 'silver', secret: false, icon: 'timer', unit: 'hours',
      description: 'Stay connected to a single call for 6 hours straight.', progress: t => at(t.longestCallHours, 6) },
    { id: 'host-8', name: 'Full House', tier: 'silver', secret: false, icon: 'users', unit: 'people',
      description: 'Start a call that reaches 8 or more people at once.', progress: t => at(t.hostedPeak, 8) },
    { id: 'crowd-20', name: 'Packed Hall', tier: 'gold', secret: false, icon: 'users', unit: 'people',
      description: 'Be in a call with 20 or more people at once.', progress: t => at(t.peakCallPeople, 20) },
    { id: 'streak-30', name: 'Regular', tier: 'bronze', secret: false, icon: 'flame', unit: 'days',
      description: 'Be active 30 days in a row (a message sent or time in a call).', progress: t => at(t.bestStreak, 30) },
    { id: 'streak-100', name: 'Tide Keeper', tier: 'silver', secret: false, icon: 'flame', unit: 'days',
      description: 'Be active 100 days in a row.', progress: t => at(t.bestStreak, 100) },
    { id: 'streak-365', name: 'Evergreen', tier: 'gold', secret: false, icon: 'flame', unit: 'days',
      description: 'Be active 365 days in a row.', progress: t => at(t.bestStreak, 365) },
    { id: 'verify-5', name: 'Trust Anchor', tier: 'bronze', secret: false, icon: 'shield', unit: 'count',
      description: 'Verify safety numbers with 5 friends.', progress: t => at(t.verified, 5) },
    { id: 'verify-15', name: 'Chain of Trust', tier: 'silver', secret: false, icon: 'shield', unit: 'count',
      description: 'Verify safety numbers with 15 friends.', progress: t => at(t.verified, 15) },
    { id: 'verify-30', name: 'Web of Trust', tier: 'gold', secret: false, icon: 'shield', unit: 'count',
      description: 'Verify safety numbers with 30 friends.', progress: t => at(t.verified, 30) },
    { id: 'servers-10', name: 'Wanderer', tier: 'silver', secret: false, icon: 'server', unit: 'count',
      description: 'Send messages in 10 different servers.', progress: t => at(t.servers, 10) },
    { id: 'msgs-5000', name: 'Wordsmith', tier: 'bronze', secret: false, icon: 'message', unit: 'count',
      description: 'Send 5,000 messages.', progress: t => at(t.messages, 5000) },
    { id: 'msgs-50000', name: 'Chronicler', tier: 'gold', secret: false, icon: 'message', unit: 'count',
      description: 'Send 50,000 messages.', progress: t => at(t.messages, 50000) },
    { id: 'eggs-30', name: 'Egg Collector', tier: 'silver', secret: false, icon: 'egg', unit: 'count',
      description: 'Find 30 easter eggs.', progress: t => at(t.eggs, 30) },
    { id: 'eggs-50', name: 'Shell Shocked', tier: 'gold', secret: false, icon: 'egg', unit: 'count',
      description: 'Find 50 easter eggs.', progress: t => at(t.eggs, 50) },
    { id: 'year-1', name: 'Barnacle', tier: 'bronze', secret: false, icon: 'calendar', unit: 'days',
      description: 'Be a member for one year.', progress: t => at(t.accountAgeDays, 365) },
    { id: 'year-2', name: 'Old Salt', tier: 'gold', secret: false, icon: 'calendar', unit: 'days',
      description: 'Be a member for two years.', progress: t => at(t.accountAgeDays, 730) },
    { id: 'game-200h', name: 'Main Character', tier: 'silver', secret: false, icon: 'gamepad', unit: 'hours',
      description: 'Play a single game for 200 hours.', progress: t => at(t.bestGameHours, 200) },
    { id: 'games-15', name: 'Variety Pack', tier: 'bronze', secret: false, icon: 'gamepad', unit: 'count',
      description: 'Play 15 different games for at least an hour each.', progress: t => at(t.gamesPlayed, 15) },
    // Secret: shown as "???" until unlocked.
    { id: 'night-shift', name: 'Night Shift', tier: 'silver', secret: true, icon: 'moon', unit: 'hours',
      description: 'Spend 10 hours in calls between 2 and 5 in the morning.', progress: t => at(t.lateNightHours, 10) },
    { id: 'echo-chamber', name: 'Echo Chamber', tier: 'bronze', secret: true, icon: 'ear', unit: 'hours',
      description: 'Spend 3 hours alone in a call.', progress: t => at(t.aloneHours, 3) },
    { id: 'fleet', name: 'Fleet', tier: 'silver', secret: true, icon: 'laptop', unit: 'count',
      description: 'Be active on 3 different devices.', progress: t => at(t.activeDevices, 3) },
];

const BY_ID = new Map(ACHIEVEMENTS.map(a => [a.id, a]));
export const achievementById = (id: string): AchievementDef | undefined => BY_ID.get(id);
export const ACHIEVEMENT_IDS: readonly string[] = ACHIEVEMENTS.map(a => a.id);

/** Every achievement whose rule is met by `t` (pure; the caller diffs against what is already unlocked). */
export function satisfied(t: Totals): string[] {
    return ACHIEVEMENTS.filter(a => {
        const p = a.progress(t);
        return p.current >= p.target;
    }).map(a => a.id);
}
