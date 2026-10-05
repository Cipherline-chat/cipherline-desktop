/**
 * Pure merge of stored notification prefs over defaults.
 *
 * Extracted from NotificationContext so it's testable in the node vitest env
 * (the context drags in React/AuthContext/secureLocalStore), and — the real
 * point — so `sounds` completeness is DERIVED rather than hand-maintained.
 *
 * History: the context used to rebuild `sounds` from an explicit per-category
 * list, with a comment warning that a forgotten category would go silently
 * mute for existing users. Four categories later (ringing/screenshare_on/
 * screenshare_off/celebration), the list wasn't updated, and the symptom was
 * worse than mute: any account with saved prefs got a `sounds` object missing
 * those keys, and NotificationsTab's `prefs.sounds[cat].enabled` crashed the
 * whole renderer tree the moment the Notifications settings opened. Fresh
 * installs never hit it (no stored prefs → pure defaults), which is why it
 * survived testing.
 *
 * This version iterates the DEFAULTS' own keys: TypeScript requires
 * `DEFAULT_PREFS.sounds` to be total over `SoundCategory`, so a newly added
 * category without a default is a compile error, and the merge can never
 * produce an incomplete `sounds` object at runtime.
 */

interface SoundLikePrefs { enabled: boolean; volume: number; file: string }
interface GroupLikePrefs { enabled: boolean; volume: number }

export interface MergeablePrefs {
    dnd_schedule: object;
    dnd_auto: object;
    sounds: Record<string, SoundLikePrefs>;
    sound_groups: Record<string, GroupLikePrefs>;
}

export function mergeStoredPrefs<T extends MergeablePrefs>(defaults: T, parsed: unknown): T {
    const p = (parsed && typeof parsed === 'object' ? parsed : {}) as Partial<T> & {
        dnd_schedule?: object;
        dnd_auto?: object;
        sounds?: Record<string, Partial<SoundLikePrefs>>;
        sound_groups?: Record<string, Partial<GroupLikePrefs>>;
    };
    return {
        ...defaults,
        ...p,
        dnd_schedule: { ...defaults.dnd_schedule, ...(p.dnd_schedule ?? {}) },
        dnd_auto:     { ...defaults.dnd_auto,     ...(p.dnd_auto     ?? {}) },
        sounds: Object.fromEntries(
            Object.keys(defaults.sounds).map(cat => [
                cat,
                { ...defaults.sounds[cat], ...(p.sounds?.[cat] ?? {}) },
            ]),
        ) as T['sounds'],
        // Same derived-from-defaults treatment as `sounds`, for the same
        // reason: a stored blob that predates a group must still come back
        // with every group present, or the settings page reads `.enabled` off
        // undefined and takes the renderer with it.
        sound_groups: Object.fromEntries(
            Object.keys(defaults.sound_groups).map(g => [
                g,
                { ...defaults.sound_groups[g], ...(p.sound_groups?.[g] ?? {}) },
            ]),
        ) as T['sound_groups'],
    };
}

/**
 * Second migration step, run after mergeStoredPrefs: give a prefs blob written
 * before sound groups existed a group enable that matches what the user was
 * actually hearing.
 *
 * `sound_groups` did not exist in any shipped version before this one, so its
 * absence from `parsed` is a reliable "this user predates groups" signal — the
 * one place in these prefs where "never set" IS distinguishable from "set to
 * the default", because the field itself is new.
 *
 * The derivation: the group is ON if the user had ANY of its member categories
 * enabled. All-off stays off (a user who muted every cue individually does not
 * get them back), any-on becomes on (so nothing that was audible goes silent).
 * Only categories the STORED blob actually contained get a vote — see the
 * `knownCategories` note in the body.
 *
 * What it deliberately does NOT do is rewrite the member categories' own
 * `enabled` flags. Those are still AND-ed in at playback (see
 * notificationSounds' resolve()), so a user who had muted exactly one cue keeps
 * that mute instead of having it silently undone by a group defaulting to on.
 * The settings UI no longer exposes those individual flags, so it re-writes all
 * of them whenever the group toggle is used — which is also the way out of an
 * inherited per-category mute.
 */
export function deriveSoundGroups<T extends MergeablePrefs>(
    merged: T,
    parsed: unknown,
    groupOf: (category: string) => string,
): T {
    const stored = (parsed && typeof parsed === 'object'
        ? (parsed as { sound_groups?: unknown }).sound_groups
        : undefined);
    const storedGroups = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;

    // Which categories the stored blob actually knew about. A category added
    // AFTER the user last saved is not evidence about what they were hearing —
    // it merged in at its own `enabled: true` default, and counting it would
    // make `members.some(enabled)` true for a user who had deliberately
    // silenced every cue that existed at the time. ("Every cue is off" then
    // flips back to "the group is on" the moment anyone adds a category to the
    // app group, which is a trap for whoever adds the next one, not a decision
    // anybody made.)
    //
    // `null` means the blob carried no `sounds` object at all — then there is
    // nothing to narrow by and every member counts, which is the old
    // behaviour and the right one for a blob that predates per-category prefs.
    const storedSounds = (parsed && typeof parsed === 'object'
        ? (parsed as { sounds?: unknown }).sounds
        : undefined);
    const knownCategories = storedSounds && typeof storedSounds === 'object'
        ? new Set(Object.keys(storedSounds as Record<string, unknown>))
        : null;

    const sound_groups = { ...merged.sound_groups };
    let touched = false;

    for (const g of Object.keys(merged.sound_groups)) {
        // Explicitly persisted by a version that knows about groups — the
        // user's own value, leave it exactly alone.
        if (storedGroups[g] && typeof storedGroups[g] === 'object') continue;

        const members = Object.keys(merged.sounds)
            .filter(cat => groupOf(cat) === g)
            .filter(cat => knownCategories === null || knownCategories.has(cat));
        // No members (a group whose categories were all removed) → nothing to
        // derive from; keep the default rather than inventing `false`.
        if (members.length === 0) continue;

        sound_groups[g] = {
            ...merged.sound_groups[g],
            enabled: members.some(cat => !!merged.sounds[cat]?.enabled),
        };
        touched = true;
    }

    return touched ? { ...merged, sound_groups } : merged;
}
