/**
 * Desktop side of a Calls channel's "Call names" setting.
 *
 * The policy itself (styles, the game rule, who may rename, validation) lives
 * in @cipherline/shared/call-naming.ts so the API and this client can never
 * disagree on it. This file is the client glue: reading the setting off a
 * channel, the live title a call card shows, the rename gate the UI mirrors,
 * the settings form's wire value + preview, and recognising the server's
 * "not allowed here" answers so they stay quiet.
 *
 * The API is the authority for the STORED name (it picks the name a call
 * starts with and refuses renames the channel forbids). The game title is a
 * display rule each viewer applies to presence it already has — no rename is
 * ever sent for it — so honouring `game` / `locked` here is the whole
 * enforcement for that part. Builds from before the setting existed keep
 * showing game titles until they update; they cannot be made not to.
 */
import {
    normalizeCallNaming,
    validateCallNaming,
    renderBaseCallName,
    callDisplayName,
    decideCallRename,
    isDefaultCallNaming,
    templateError,
    fixedNameError,
    CALL_NAMES_LOCKED,
    CALL_RENAME_MANAGERS_ONLY,
    type CallNamingSettings,
} from '@cipherline/shared';

export type { CallNamingSettings };

/** The setting carried on a channel from the API (defaults when absent —
 *  an older API, or a channel that never changed it). */
export function callNamingOf(channel: { call_naming?: unknown } | null | undefined): CallNamingSettings {
    return normalizeCallNaming(channel?.call_naming);
}

/** The title a live call shows to this viewer. `gameOf` returns the game a
 *  participant is playing as far as this viewer knows (null = none / unknown). */
export function liveCallTitle(
    storedName: string,
    participantIds: readonly string[],
    setting: CallNamingSettings,
    gameOf: (userId: string) => string | null | undefined,
): string {
    if (setting.locked || setting.game === 'off') return storedName;
    return callDisplayName(storedName, participantIds.map(gameOf), setting);
}

/** UX mirror of the server's rename rule — whether to offer "Rename". */
export function canRenameHuddleCall(
    setting: CallNamingSettings,
    who: { isStarter: boolean; canManageChannels: boolean },
): boolean {
    if (!who.isStarter && !who.canManageChannels) return false;
    return decideCallRename(setting, who).ok;
}

/** True when a failed rename is the channel's setting saying no (the UI was
 *  stale — e.g. an admin locked names a moment ago). Callers swallow these
 *  quietly; the next channel refresh hides the action. */
export function isQuietRenameRefusal(err: unknown): boolean {
    const code = (err as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
    return code === CALL_NAMES_LOCKED || code === CALL_RENAME_MANAGERS_ONLY;
}

// ── Settings form ──────────────────────────────────────────────────────────

/** Form state → wire value: an empty text box means "not set". */
export function callNamingToWire(draft: CallNamingSettings): CallNamingSettings {
    return {
        ...draft,
        fixed_name: draft.fixed_name && draft.fixed_name.trim() ? draft.fixed_name : null,
        template: draft.template && draft.template.trim() ? draft.template : null,
    };
}

/** The form's draft as it would be sent: empty boxes are "not set", and a
 *  half-typed value in the box of a style that is NOT selected is dropped
 *  rather than blocking the save (it stays in the form). */
function prune(draft: CallNamingSettings): CallNamingSettings {
    const wire = callNamingToWire(draft);
    if (draft.style !== 'template' && wire.template !== null && templateError(wire.template)) wire.template = null;
    if (draft.style !== 'fixed' && wire.fixed_name !== null && fixedNameError(wire.fixed_name)) wire.fixed_name = null;
    return wire;
}

/** Error to show under the form, or null when it can be saved. */
export function callNamingFormError(draft: CallNamingSettings): string | null {
    const r = validateCallNaming(prune(draft));
    return r.ok ? null : r.error;
}

/** The value a save sends (trimmed, validated). Only meaningful when
 *  callNamingFormError(draft) is null. */
export function callNamingPayload(draft: CallNamingSettings): CallNamingSettings {
    const r = validateCallNaming(prune(draft));
    return r.ok ? r.value : prune(draft);
}

export function callNamingEqual(a: CallNamingSettings, b: CallNamingSettings): boolean {
    const x = callNamingToWire(a);
    const y = callNamingToWire(b);
    return x.style === y.style && x.game === y.game && x.locked === y.locked
        && x.starter_can_rename === y.starter_can_rename
        && (x.fixed_name ?? '').trim() === (y.fixed_name ?? '').trim()
        && (x.template ?? '').trim() === (y.template ?? '').trim();
}

export { isDefaultCallNaming };

export interface CallNamePreview {
    /** What a new call is named. */
    start: string;
    /** What it shows while the example game is played — null if it never changes. */
    whilePlaying: string | null;
}

/** "Example: Alex's Call → Elden Ring" for the settings form. */
export function previewCallNames(
    draft: CallNamingSettings,
    ctx: { host: string; channel: string; game: string },
): CallNamePreview {
    const s = normalizeCallNaming(callNamingToWire(draft));
    // An invalid / empty template previews as the default style until fixed.
    const start = renderBaseCallName(s, { host: ctx.host, channel: ctx.channel || 'General' });
    const playing = callDisplayName(start, [ctx.game], s);
    return { start, whilePlaying: playing === start ? null : playing };
}

/**
 * The name the server will give a call this user starts in `channel` — the
 * same renderBaseCallName the API runs (huddles.service → baseCallName), fed
 * what the client knows: the channel's naming setting, the host's server
 * nickname (or username), and the names of the calls already in it. Used for
 * the client-side call card shown while the spawn request is in flight
 * (utils/joinView.ts); the server's real name replaces it the moment the
 * request returns. Display only.
 */
export function predictSpawnedCallName(
    channel: { name: string; call_naming?: unknown },
    host: string,
    takenNames: string[],
): string {
    return renderBaseCallName(callNamingOf(channel), { host, channel: channel.name, takenNames });
}
