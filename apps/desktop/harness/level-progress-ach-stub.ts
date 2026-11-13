/* eslint-disable -- harness stub, not shipped */
// Stand-in for hooks/useUserAchievements in the level-progress harness only: the
// "server" answer is window.__ach (no network), and your own local progress is
// window.__progress (null for someone else's profile, exactly like the real hook's caller).
export interface AchievementsData { unlocked: Array<{ id: string; month: string }> }
export function invalidateAchievements(): void {}
export function useUserAchievements(userId: string | null | undefined) {
    const w = window as any;
    return { data: userId ? (w.__ach ?? null) : null, loading: false, error: false, reload: () => {} };
}
export function useAchievementProgress() { return (window as any).__progress ?? null; }
