/**
 * Profile visibility — client side of the presets (step 1).
 *
 * The SERVER enforces every rule (apps/api/src/auth/profile-visibility.ts);
 * this module only mirrors the preset table for UX: the editor's segmented
 * control, the "Custom" label, the "View as" preview and the optimistic
 * update. Keep PRESET_FIELDS in sync with the API's table.
 *
 * Always public (never gated): username, discriminator, avatar, badges,
 * theme, decoration, effect and the egg showcase. Custom status / current game keep their existing presence gating and
 * are not part of these settings.
 */

export const VISIBILITY_FIELDS = ['bio', 'banner', 'local_time', 'widgets', 'links'] as const;
export type VisibilityField = (typeof VISIBILITY_FIELDS)[number];
export type VisibilityPreset = 'public' | 'friends_more' | 'private';
export type Audience = 'everyone' | 'friends';

/** The stored shape (`profile_visibility` on /auth/me). `{}` = Public. */
export interface ProfileVisibility {
    preset?: VisibilityPreset;
    fields?: Partial<Record<VisibilityField, Audience>>;
}
export type ResolvedVisibility = Record<VisibilityField, Audience>;

export const PRESET_FIELDS: Record<VisibilityPreset, ResolvedVisibility> = {
    public: { bio: 'everyone', banner: 'everyone', local_time: 'everyone', widgets: 'everyone', links: 'everyone' },
    friends_more: { bio: 'everyone', banner: 'everyone', local_time: 'friends', widgets: 'friends', links: 'friends' },
    private: { bio: 'friends', banner: 'friends', local_time: 'friends', widgets: 'friends', links: 'friends' },
};

export const PRESET_LABELS: Record<VisibilityPreset, { label: string; blurb: string }> = {
    public: { label: 'Public', blurb: 'Everyone sees your whole profile.' },
    friends_more: { label: 'Friends see more', blurb: 'Local time, favorite games and links are for friends only.' },
    private: { label: 'Private', blurb: 'Bio, banner, local time, favorite games and links are for friends only.' },
};

export const FIELD_LABELS: Record<VisibilityField, string> = {
    bio: 'About me',
    banner: 'Banner',
    local_time: 'Local time',
    widgets: 'Games and interests',
    links: 'Links',
};

const PRESETS: readonly VisibilityPreset[] = ['public', 'friends_more', 'private'];
const isAudience = (v: unknown): v is Audience => v === 'everyone' || v === 'friends';

/** Effective audience per field (same fail-narrow rules as the server). */
export function resolveVisibility(stored: unknown): ResolvedVisibility {
    const v = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
    const preset = PRESETS.includes(v.preset as VisibilityPreset) ? (v.preset as VisibilityPreset) : 'public';
    const out: ResolvedVisibility = { ...PRESET_FIELDS[preset] };
    const fields = (v.fields && typeof v.fields === 'object' ? v.fields : {}) as Record<string, unknown>;
    for (const f of VISIBILITY_FIELDS) {
        if (fields[f] === undefined) continue;
        out[f] = isAudience(fields[f]) ? (fields[f] as Audience) : 'friends';
    }
    return out;
}

/** Which preset the effective settings equal, or 'custom' when none does. */
export function detectPreset(stored: unknown): VisibilityPreset | 'custom' {
    const r = resolveVisibility(stored);
    for (const p of PRESETS) {
        if (VISIBILITY_FIELDS.every((f) => r[f] === PRESET_FIELDS[p][f])) return p;
    }
    return 'custom';
}

/** PATCH `profile_visibility` body for picking a preset (clears overrides). */
export function presetPatch(preset: VisibilityPreset): ProfileVisibility {
    return { preset };
}

/** PATCH `profile_visibility` body for toggling one field. */
export function fieldPatch(field: VisibilityField, audience: Audience): ProfileVisibility {
    return { fields: { [field]: audience } };
}

/**
 * What the server will store after `patch` — the same canonicalisation as the
 * API's mergeProfileVisibility, used for the optimistic update so the UI
 * matches the response without waiting for it.
 */
export function applyVisibilityPatch(current: unknown, patch: ProfileVisibility): ProfileVisibility {
    const cur = (current && typeof current === 'object' ? current : {}) as ProfileVisibility;
    const curPreset: VisibilityPreset = PRESETS.includes(cur.preset as VisibilityPreset) ? (cur.preset as VisibilityPreset) : 'public';
    const preset = patch.preset ?? curPreset;
    const overrides: Partial<Record<VisibilityField, Audience>> = patch.preset
        ? { ...(patch.fields ?? {}) }
        : { ...(cur.fields ?? {}), ...(patch.fields ?? {}) };
    const fields: Partial<Record<VisibilityField, Audience>> = {};
    for (const f of VISIBILITY_FIELDS) {
        const v = overrides[f];
        if (isAudience(v) && v !== PRESET_FIELDS[preset][f]) fields[f] = v;
    }
    const out: ProfileVisibility = {};
    if (preset !== 'public') out.preset = preset;
    if (Object.keys(fields).length) out.fields = fields;
    return out;
}

/** Is `field` listed as friends-only in a profile's `friends_only_fields`? */
export function isFriendsOnly(friendsOnlyFields: readonly string[] | null | undefined, field: VisibilityField): boolean {
    return !!friendsOnlyFields && friendsOnlyFields.includes(field);
}

// ── Time zone ────────────────────────────────────────────────────────────────

export function isValidTimeZone(tz: string): boolean {
    if (!tz || tz.length > 64) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

/** This device's zone, or null when the runtime can't say. Only ever a
 *  SUGGESTION in the editor: nothing is shared until the user saves it. */
export function deviceTimeZone(): string | null {
    try {
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return tz && isValidTimeZone(tz) ? tz : null;
    } catch {
        return null;
    }
}

export function listTimeZones(): string[] {
    try {
        const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
        if (sv) return sv('timeZone');
    } catch { /* fall through */ }
    const d = deviceTimeZone();
    return d ? [d] : [];
}

/** "3:42 PM local time", computed on this device from the sender's zone.
 *  Null for an absent / invalid zone (never throws). */
export function formatLocalTime(timeZone: string | null | undefined, now: Date = new Date()): string | null {
    if (!timeZone || !isValidTimeZone(timeZone)) return null;
    try {
        const t = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone }).format(now);
        return `${t} local time`;
    } catch {
        return null;
    }
}

// ── "View as" preview ────────────────────────────────────────────────────────

export type ViewAs = 'everyone' | 'friend';

/** Which of your fields a viewer of that kind would see. */
export function visibleFor(stored: unknown, viewAs: ViewAs): Record<VisibilityField, boolean> {
    const r = resolveVisibility(stored);
    const out = {} as Record<VisibilityField, boolean>;
    for (const f of VISIBILITY_FIELDS) out[f] = viewAs === 'friend' || r[f] === 'everyone';
    return out;
}
