import secureLocalStore from './secureLocalStore';
import type { MessageRetention, AttachmentRetention, StoragePolicy } from '../hooks/useRetentionPolicy';

/**
 * deviceStorageSetup — "this account has chosen its storage retention ON THIS
 * DEVICE".
 *
 * Retention settings are PER DEVICE (owner decision, 2026-09): a laptop that
 * keeps everything forever and a work machine that keeps a week are both
 * legitimate, so nothing about retention — the global/per-type policy, the
 * per-conversation and per-server overrides, the purge ledger — travels in a
 * backup, a history transfer or any sync. See backupRegistry.ts and
 * retentionPortability.ts for the export/import side.
 *
 * The consequence: a device the account has never used has NO retention
 * choice at all, so it must ask. This module owns that one decision.
 *
 * ── Hook point (desktop AND mobile should mirror this) ──────────────────────
 * The prompt is keyed off STATE, not off a login path. Every way an account
 * can arrive on a device — password sign-in, a future QR/device-link sign-in,
 * a sign-in followed by a backup restore or a history transfer — ends with the
 * account signed in on a device whose store has no marker. `useDeviceStorageSetup`
 * (mounted once by Dashboard) reads it after `secureLocalStore.whenAccountReady()`
 * and prompts. A new login path gets the prompt for free; it must NOT write the
 * marker itself. Only three things do:
 *   1. the prompt's Save / Use recommended (`saveDeviceStorageChoice`),
 *   2. signup, whose wizard already asked (AuthScreen `handleWizardComplete`),
 *   3. the silent adoption of a pre-existing install (below).
 *
 * Keys (both device-local, both excluded from backups in backupRegistry.ts):
 *   `cipherline_device_storage_setup_<uid>` — the marker (JSON, see SetupMarker)
 *   `cipherline_storage_policy_<uid>`       — the StoragePolicy itself
 *
 * Rule (`decideDeviceStorageSetup`, pure):
 *   marker present                                → 'done'
 *   no marker, stored policy carries a retention  → 'adopt-existing'
 *     choice (an install from before this feature;   (write marker silently, no nag)
 *     old builds always wrote the full policy)
 *   otherwise                                     → 'prompt'
 *
 * "Carries a retention choice" deliberately means a retention FIELD, not "the
 * key exists": a restore may write a policy record holding nothing but the
 * restored saved-message ids (retentionPortability.applyRestoredSaves), and
 * that must not count as having chosen anything.
 */

export type SetupHow = 'chosen' | 'recommended' | 'signup' | 'existing-install';

export interface SetupMarker {
    v: 1;
    /** ms since epoch the choice was made on this device. */
    at: number;
    how: SetupHow;
}

export type DeviceStorageDecision = 'done' | 'adopt-existing' | 'prompt';

/** The six per-type retention choices the prompt (and the signup wizard) asks for. */
export interface DeviceRetentionChoice {
    dmMessageRetention: MessageRetention;
    dmAttachmentRetention: AttachmentRetention;
    groupMessageRetention: MessageRetention;
    groupAttachmentRetention: AttachmentRetention;
    serverMessageRetention: MessageRetention;
    serverAttachmentRetention: AttachmentRetention;
}

/** Same defaults the signup wizard starts from — long enough to be useful,
 *  short enough that nothing lingers on-device forever by accident. */
export const RECOMMENDED_RETENTION: Readonly<DeviceRetentionChoice> = Object.freeze({
    dmMessageRetention: '1y',
    dmAttachmentRetention: '1mo',
    groupMessageRetention: '6mo',
    groupAttachmentRetention: '1wk',
    serverMessageRetention: '6mo',
    serverAttachmentRetention: '1wk',
});

/** Fired on window whenever this module (or a restore) rewrites the stored
 *  policy behind useRetentionPolicy's back, so the live hook reloads it. */
export const STORAGE_POLICY_CHANGED_EVENT = 'cipherline:storage-policy-changed';

export function deviceStorageSetupKey(userId: string): string {
    return `cipherline_device_storage_setup_${userId}`;
}
export function storagePolicyKey(userId: string): string {
    return `cipherline_storage_policy_${userId}`;
}

const RETENTION_FIELDS = [
    'messageRetention', 'attachmentRetention',
    'dmMessageRetention', 'dmAttachmentRetention',
    'groupMessageRetention', 'groupAttachmentRetention',
    'serverMessageRetention', 'serverAttachmentRetention',
] as const;

/** Whether a stored policy record expresses an actual retention choice (as
 *  opposed to being absent, corrupt, or a saves-only record from a restore). */
export function policyHasRetentionChoice(raw: string | null | undefined): boolean {
    if (!raw) return false;
    try {
        const p = JSON.parse(raw);
        if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
        return RETENTION_FIELDS.some(f => typeof (p as Record<string, unknown>)[f] === 'string');
    } catch {
        return false;
    }
}

/** Pure decision — see the module comment for the rule. */
export function decideDeviceStorageSetup(
    markerRaw: string | null | undefined,
    policyRaw: string | null | undefined,
): DeviceStorageDecision {
    if (markerRaw) return 'done';
    if (policyHasRetentionChoice(policyRaw)) return 'adopt-existing';
    return 'prompt';
}

/** Read both keys for `userId` and decide. The caller MUST have awaited
 *  `secureLocalStore.whenAccountReady()` and checked `isAccountReady(userId)`
 *  first — a cold namespace reads null for both and would prompt an account
 *  that has already chosen. */
export function readDeviceStorageDecision(userId: string): DeviceStorageDecision {
    return decideDeviceStorageSetup(
        secureLocalStore.getItem(deviceStorageSetupKey(userId)),
        secureLocalStore.getItem(storagePolicyKey(userId)),
    );
}

export function markDeviceStorageSetupDone(userId: string, how: SetupHow, now: number = Date.now()): void {
    if (!userId) return;
    const marker: SetupMarker = { v: 1, at: now, how };
    secureLocalStore.setItem(`cipherline_device_storage_setup_${userId}`, JSON.stringify(marker));
}

/**
 * Build the policy to store for a choice, keeping everything in the existing
 * record that is not a retention window (saved / unsaved ids, restored saves).
 * Shape matches what signup writes: global fallbacks 'never', per-type fields
 * carry the choice. Pure.
 */
export function buildPolicyFromChoice(existingRaw: string | null | undefined, choice: DeviceRetentionChoice): StoragePolicy {
    let existing: Partial<StoragePolicy> = {};
    try {
        const p = existingRaw ? JSON.parse(existingRaw) : null;
        if (p && typeof p === 'object' && !Array.isArray(p)) existing = p;
    } catch { /* corrupt — start clean */ }
    const arr = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    const rec = (v: unknown): Record<string, number> => (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, number> : {};
    return {
        messageRetention: 'never',
        attachmentRetention: 'never',
        dmMessageRetention:        choice.dmMessageRetention,
        dmAttachmentRetention:     choice.dmAttachmentRetention,
        groupMessageRetention:     choice.groupMessageRetention,
        groupAttachmentRetention:  choice.groupAttachmentRetention,
        serverMessageRetention:    choice.serverMessageRetention,
        serverAttachmentRetention: choice.serverAttachmentRetention,
        savedAttachmentIds:   arr(existing.savedAttachmentIds),
        unsavedAttachmentIds: arr(existing.unsavedAttachmentIds),
        savedMessageIds:      arr(existing.savedMessageIds),
        unsavedMessageIds:    arr(existing.unsavedMessageIds),
        unsavedMessageTimestamps:    rec(existing.unsavedMessageTimestamps),
        unsavedAttachmentTimestamps: rec(existing.unsavedAttachmentTimestamps),
    };
}

export function notifyStoragePolicyChanged(userId: string): void {
    try {
        window.dispatchEvent(new CustomEvent(STORAGE_POLICY_CHANGED_EVENT, { detail: { userId } }));
    } catch { /* no window (tests / worker) */ }
}

/**
 * Persist the prompt's answer: policy first, marker second (a crash between
 * the two re-prompts rather than marking done with nothing chosen), then tell
 * the live retention hook. Throws if the store refuses the write so the
 * prompt can show an error instead of closing on a choice that wasn't kept.
 */
export function saveDeviceStorageChoice(userId: string, choice: DeviceRetentionChoice, how: SetupHow): void {
    if (!userId) throw new Error('No signed-in account');
    if (!secureLocalStore.isAccountReady(userId)) throw new Error('This account’s storage is still loading — try again in a moment.');
    const policy = buildPolicyFromChoice(secureLocalStore.getItem(storagePolicyKey(userId)), choice);
    const json = JSON.stringify(policy);
    secureLocalStore.setItem(`cipherline_storage_policy_${userId}`, json);
    // setItem is a silent no-op on a locked store — verify it actually landed.
    if (secureLocalStore.getItem(storagePolicyKey(userId)) !== json) {
        throw new Error('Couldn’t save to this device’s secure storage.');
    }
    markDeviceStorageSetupDone(userId, how);
    notifyStoragePolicyChanged(userId);
}
