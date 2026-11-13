import type { PaneId } from './SettingsScreen';

/**
 * Where an "open Settings on X" request actually lands.
 *
 * Settings > Connections and Settings > Personalize were merged into one
 * section, Activity & Style (owner, 2026-10-28), and Steam moved under
 * Profile. The old ids stay valid FOREVER as aliases: anything that still asks
 * for them (an older call site, a test, a future deep link someone copied)
 * lands on the right section, and on the right setting inside it, instead of
 * on nothing. There is no persisted "last open pane" today; if one is ever
 * added, read it through `resolveSettingsTarget` too, so a stored old id maps
 * the same way.
 *
 * Aliases may name a SETTING as well (its search-index label): SettingsScreen
 * scrolls to it and opens whatever disclosure or Profile tab it is folded into
 * (revealSetting.ts), exactly like a settings-search hit.
 */

/** Every pane the Descent can show, in gauge order. Kept in sync with DepthGauge's ZONES by paneAliases.test.ts. */
export const PANE_IDS = [
    'profile', 'activityStyle', 'appearance',
    'devices', 'voice', 'notifications', 'keybinds', 'activity',
    'privacy', 'storage', 'billing',
    'advanced', 'danger',
] as const satisfies readonly PaneId[];

export type LegacyPaneId = 'connections' | 'personalize' | 'steam';

/** Anything `requestOpenSettings` / `SettingsScreen.initialTab` accepts. */
export type SettingsTarget = PaneId | LegacyPaneId;

export interface ResolvedSettingsTarget {
    pane: PaneId;
    /** A setting label to reveal once the pane is up (settingsSearchIndex label). */
    setting?: string;
}

export const PANE_ALIASES: Readonly<Record<LegacyPaneId, ResolvedSettingsTarget>> = {
    /** The old Connections pane: its listening / Spotify cards open Activity & Style. (Its Steam card is now in Profile.) */
    connections: { pane: 'activityStyle' },
    /** The old Personalize pane, asked for by the emoji picker's "My Emojis" empty state. */
    personalize: { pane: 'activityStyle', setting: 'My Emojis' },
    /** Your Steam account: Profile > Showcase > Steam ("Connect accounts" on your own full profile). */
    steam: { pane: 'profile', setting: 'Steam account' },
};

const PANES: ReadonlySet<string> = new Set(PANE_IDS);

export function isPaneId(v: unknown): v is PaneId {
    return typeof v === 'string' && PANES.has(v);
}

/** Old ids map through PANE_ALIASES; an unknown or missing value opens Profile, the top of the Descent. */
export function resolveSettingsTarget(target: SettingsTarget | string | null | undefined): ResolvedSettingsTarget {
    if (isPaneId(target)) return { pane: target };
    if (typeof target === 'string' && Object.prototype.hasOwnProperty.call(PANE_ALIASES, target)) {
        return PANE_ALIASES[target as LegacyPaneId];
    }
    return { pane: 'profile' };
}
