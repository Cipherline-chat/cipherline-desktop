/**
 * Persistence for the crash-recovery rejoin record — see callRejoinPolicy.ts
 * for what it holds, why, and how long it lives.
 *
 * One record per account in the encrypted secureLocalStore (AES-256-GCM
 * IndexedDB under the device master key), never raw localStorage. The key
 * names the account so a different user signing in on the same device can
 * never be offered — or read — someone else's call.
 *
 * Every function is total: storage being locked/unavailable degrades to "no
 * rejoin offer", never an exception into the call UI.
 */
import secureLocalStore from './secureLocalStore';
import { parseDescriptor, type CallRejoinDescriptor } from './callRejoinPolicy';

export function saveRejoinDescriptor(userId: string, d: CallRejoinDescriptor): void {
    if (!userId) return;
    try {
        // The literal key head is inlined (not routed through a helper) so the
        // backupRegistry source scan sees this call and checks the key against
        // KV_RULES — it must stay classified as EXCLUDED from backups.
        secureLocalStore.setItem(`cipherline_call_rejoin_${userId}`, JSON.stringify(d));
    } catch { /* non-fatal: no rejoin offer after a crash, nothing else */ }
}

export function loadRejoinDescriptor(userId: string): CallRejoinDescriptor | null {
    if (!userId) return null;
    try {
        return parseDescriptor(secureLocalStore.getItem(`cipherline_call_rejoin_${userId}`));
    } catch {
        return null;
    }
}

export function clearRejoinDescriptor(userId: string): void {
    if (!userId) return;
    try {
        secureLocalStore.removeItem(`cipherline_call_rejoin_${userId}`);
    } catch { /* ignore */ }
}
