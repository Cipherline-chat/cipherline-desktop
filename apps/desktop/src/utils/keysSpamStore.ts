/**
 * Where the Home spam egg's rotation (utils/keysSpam.ts) is kept, per
 * account, encrypted at rest: `secureLocalStore` (never raw localStorage),
 * under a key that carries the account id, so the store seals it under that
 * account's own subkey. Excluded from backups (services/backupRegistry.ts):
 * which show is next is not account data.
 *
 * Without an account (or before the store is ready) the rotation still
 * works, in memory, for the session.
 */
import secureLocalStore from './secureLocalStore';
import { EMPTY_BAG, parseBag, type SpamBag } from './keysSpam';

export const spamBagKey = (userId: string) => `cipherline_keys_spam_bag_${userId}`;

const memory = new Map<string, SpamBag>();

export function readSpamBag(userId: string | null | undefined): SpamBag {
    const id = userId || '';
    if (id) {
        try {
            const raw = secureLocalStore.getItem(spamBagKey(id));
            if (raw !== null) return parseBag(raw);
        } catch { /* not ready: fall back to this session's copy */ }
    }
    return memory.get(id) ?? EMPTY_BAG;
}

export function writeSpamBag(userId: string | null | undefined, bag: SpamBag): void {
    const id = userId || '';
    memory.set(id, bag);
    if (!id) return;
    try {
        secureLocalStore.setItem(`cipherline_keys_spam_bag_${id}`, JSON.stringify(bag));
    } catch { /* the in-memory copy carries the session */ }
}

/** Test-only. */
export function __resetSpamBagMemory(): void {
    memory.clear();
}
