/** Storage keys + window events for achievements (classified in services/backupRegistry.ts). */

/** Progress snapshot (counters, sets, unlocks, opt-in). In the backup: a restore keeps your progress. */
export const achievementsKey = (userId: string) => `cipherline_achievements_${userId}`;
/** Rolling per-day play time on THIS device. Device-local; never in a backup. */
export const weeklyGamesKey = (userId: string) => `cipherline_weekly_games_${userId}`;

/** Window event: an achievement unlocked on this device. detail: { id } */
export const ACHIEVEMENT_UNLOCK_EVENT = 'cipherline:achievement-unlocked';
