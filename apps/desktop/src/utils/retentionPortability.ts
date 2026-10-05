import secureLocalStore from './secureLocalStore';
import { storagePolicyKey, notifyStoragePolicyChanged } from './deviceStorageSetup';

/**
 * retentionPortability — the ONE piece of retention state that still travels
 * in a backup / history transfer, and why.
 *
 * Retention SETTINGS are per-device and never leave the device (see
 * deviceStorageSetup.ts). StoragePolicy also carries four id lists, though,
 * and they are not all settings:
 *
 *   savedMessageIds / savedAttachmentIds — the user explicitly said "keep
 *     this". That is intent about a MESSAGE, not a preference about a DEVICE.
 *     Dropping it on restore would let the new device's (possibly shorter)
 *     window sweep exactly the things the user asked never to lose. So these
 *     travel, and restore UNIONS them into this device's policy — a restore
 *     can only ever add protection, never remove it.
 *
 *   unsavedMessageIds / unsavedAttachmentIds (+ timestamps) — "let this
 *     expire". Carrying these could make a device that keeps things longer
 *     delete something it would otherwise keep, i.e. the lossy direction. They
 *     stay device-local, exactly like the retention windows.
 *
 * A saved id restored onto a device where the same id is explicitly unsaved
 * is resolved in favour of SAVED (removed from the unsaved list) — the same
 * resolution `saveMessage` applies, and the one that cannot lose data.
 *
 * Old vaults carry the whole StoragePolicy as `retentionPolicy`. It is still
 * READ, but only for its saved-id lists; its retention windows and unsaved
 * lists are ignored.
 */

export interface PortableRetentionSaves {
    savedMessageIds: string[];
    savedAttachmentIds: string[];
}

const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];

const asObj = (v: unknown): Record<string, unknown> | null =>
    v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;

/** Export side: pull only the saved-id lists out of a stored policy record.
 *  `undefined` when there is nothing to carry (keeps the vault small). */
export function extractPortableSaves(policyRaw: string | null | undefined): PortableRetentionSaves | undefined {
    if (!policyRaw) return undefined;
    let p: Record<string, unknown> | null = null;
    try { p = asObj(JSON.parse(policyRaw)); } catch { return undefined; }
    if (!p) return undefined;
    const savedMessageIds = strArr(p.savedMessageIds);
    const savedAttachmentIds = strArr(p.savedAttachmentIds);
    if (!savedMessageIds.length && !savedAttachmentIds.length) return undefined;
    return { savedMessageIds, savedAttachmentIds };
}

/** Import side: the saved ids a vault carries, from the current field
 *  (`retentionSaves`) and/or a legacy full `retentionPolicy`. Never throws on
 *  a malformed vault — anything unrecognised is simply no saves. */
export function portableSavesFromVault(vault: unknown): PortableRetentionSaves {
    const v = asObj(vault);
    const msg = new Set<string>();
    const att = new Set<string>();
    for (const src of [asObj(v?.retentionSaves), asObj(v?.retentionPolicy)]) {
        if (!src) continue;
        for (const id of strArr(src.savedMessageIds)) msg.add(id);
        for (const id of strArr(src.savedAttachmentIds)) att.add(id);
    }
    return { savedMessageIds: [...msg], savedAttachmentIds: [...att] };
}

/**
 * Pure merge of restored saves into this device's stored policy record.
 * Returns the new JSON, or `null` when nothing would change.
 *
 * Only the id lists are touched. With no local record, the result holds ONLY
 * the saved lists — no retention fields — so it does not count as this device
 * having chosen a retention (deviceStorageSetup.policyHasRetentionChoice) and
 * the first-run prompt still appears.
 */
export function mergeSavesIntoPolicy(existingRaw: string | null | undefined, saves: PortableRetentionSaves): string | null {
    if (!saves.savedMessageIds.length && !saves.savedAttachmentIds.length) return null;
    let base: Record<string, unknown> = {};
    try { base = asObj(existingRaw ? JSON.parse(existingRaw) : null) ?? {}; } catch { base = {}; }

    const savedMsg = strArr(base.savedMessageIds);
    const savedAtt = strArr(base.savedAttachmentIds);
    const msgSet = new Set(savedMsg);
    const attSet = new Set(savedAtt);
    const newMsg = saves.savedMessageIds.filter(id => !msgSet.has(id));
    const newAtt = saves.savedAttachmentIds.filter(id => !attSet.has(id));

    const restoredMsg = new Set(saves.savedMessageIds);
    const restoredAtt = new Set(saves.savedAttachmentIds);
    const unsavedMsg = strArr(base.unsavedMessageIds);
    const unsavedAtt = strArr(base.unsavedAttachmentIds);
    const keptUnsavedMsg = unsavedMsg.filter(id => !restoredMsg.has(id));
    const keptUnsavedAtt = unsavedAtt.filter(id => !restoredAtt.has(id));

    if (!newMsg.length && !newAtt.length
        && keptUnsavedMsg.length === unsavedMsg.length && keptUnsavedAtt.length === unsavedAtt.length) {
        return null;
    }

    const out: Record<string, unknown> = { ...base, savedMessageIds: [...savedMsg, ...newMsg], savedAttachmentIds: [...savedAtt, ...newAtt] };
    if (Array.isArray(base.unsavedMessageIds)) out.unsavedMessageIds = keptUnsavedMsg;
    if (Array.isArray(base.unsavedAttachmentIds)) out.unsavedAttachmentIds = keptUnsavedAtt;
    const dropTs = (key: 'unsavedMessageTimestamps' | 'unsavedAttachmentTimestamps', ids: Set<string>) => {
        const ts = asObj(base[key]);
        if (!ts) return;
        const next: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(ts)) if (!ids.has(k)) next[k] = val;
        out[key] = next;
    };
    dropTs('unsavedMessageTimestamps', restoredMsg);
    dropTs('unsavedAttachmentTimestamps', restoredAtt);
    return JSON.stringify(out);
}

/** Apply restored saves to this device's policy and tell the live hook. */
export function applyRestoredSaves(userId: string, saves: PortableRetentionSaves): void {
    if (!userId) return;
    const next = mergeSavesIntoPolicy(secureLocalStore.getItem(storagePolicyKey(userId)), saves);
    if (next === null) return;
    secureLocalStore.setItem(`cipherline_storage_policy_${userId}`, next);
    notifyStoragePolicyChanged(userId);
}
