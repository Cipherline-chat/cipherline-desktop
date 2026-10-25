/**
 * Binding of at-rest records to their NAME via AES-GCM additional data (AAD).
 *
 * Both local encrypted stores — SecureStore (`secure-store.json`, main) and
 * the renderer's KV store (records sealed by kv-crypto.ts) — encrypt each
 * value independently under one key. Without AAD nothing ties a ciphertext to
 * the name it is stored under, so someone who can write the files offline can
 * move a valid ciphertext from one name to another (e.g. between two channels'
 * key slots) and it still authenticates. With AAD = (domain, owner, name) the
 * moved record fails its GCM tag check instead.
 *
 * ── Rollout: READ now, WRITE later (WRITE_BOUND_RECORDS) ────────────────────
 * Readers of BOTH formats ship now. Writing bound records is switched off:
 * a build without the new reader treats a bound record as corrupt, and for
 * SecureStore that is not a soft failure — an unreadable `identity_priv`
 * makes ensureSignalIdentity() mint a NEW device identity. Builds without the
 * reader are still in circulation (older stable/staging installs, website
 * downloads that lag the installed version, and any branch the Windows test
 * PC runs against the same profile), and a downgrade to one of them after a
 * bound write would lose data. So:
 *
 *   phase 1 (this change): read both formats, write legacy. No behaviour change.
 *   phase 2 (a later release, once every build users can install reads bound
 *            records): set WRITE_BOUND_RECORDS = true. New writes are bound and
 *            legacy records are re-written bound as they are read.
 *
 * Never flip it in the same release that introduces the reader.
 *
 * No `electron` import (unit-testable, and reachable from the renderer's
 * tsconfig through kv-crypto.ts).
 */

import * as crypto from 'node:crypto';

/** Phase-2 switch — see the module doc before changing. */
export const WRITE_BOUND_RECORDS = false;

const ALG = 'aes-256-gcm';

/** AAD for a SecureStore entry. JSON array encoding keeps (domain, name) unambiguous. */
export function secureStoreEntryAad(name: string): Buffer {
    return Buffer.from(JSON.stringify(['cl-securestore/v2', name]), 'utf8');
}

/** AAD for a KV record: owner (null = master tier) and store key. */
export function kvRecordAad(owner: string | null, name: string): Buffer {
    return Buffer.from(JSON.stringify(['cl-kv/v2', owner, name]), 'utf8');
}

/** A SecureStore entry. `a: 1` marks one sealed with {@link secureStoreEntryAad}. */
export interface EncryptedEntry {
    iv: string;
    authTag: string;
    ciphertext: string;
    a?: 1;
}

export function isBoundEntry(entry: EncryptedEntry): boolean {
    return entry.a === 1;
}

export function encryptEntry(masterKey: Buffer, name: string, plaintext: string, bind: boolean): EncryptedEntry {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALG, masterKey, iv);
    if (bind) cipher.setAAD(secureStoreEntryAad(name));
    let ciphertext = cipher.update(plaintext, 'utf8', 'base64');
    ciphertext += cipher.final('base64');
    const authTag = cipher.getAuthTag().toString('base64');
    const entry: EncryptedEntry = { iv: iv.toString('base64'), authTag, ciphertext };
    if (bind) entry.a = 1;
    return entry;
}

/** Decrypt either format. A bound entry only opens under the name it was sealed for. */
export function decryptEntry(masterKey: Buffer, name: string, entry: EncryptedEntry): string {
    const decipher = crypto.createDecipheriv(ALG, masterKey, Buffer.from(entry.iv, 'base64'));
    if (isBoundEntry(entry)) decipher.setAAD(secureStoreEntryAad(name));
    decipher.setAuthTag(Buffer.from(entry.authTag, 'base64'));
    let plaintext = decipher.update(entry.ciphertext, 'base64', 'utf8');
    plaintext += decipher.final('utf8');
    return plaintext;
}

/**
 * Re-seal every legacy (unbound) entry of a SecureStore map as a bound one.
 * Returns how many were migrated. An entry that does not decrypt is left
 * exactly as it is (never dropped, never rewritten) so nothing is lost to a
 * migration; reading it keeps failing the same way it already did.
 */
export function migrateEntriesToBound(masterKey: Buffer, data: Record<string, EncryptedEntry>): number {
    let migrated = 0;
    for (const name of Object.keys(data)) {
        const entry = data[name];
        if (isBoundEntry(entry)) continue;
        let plain: string;
        try { plain = decryptEntry(masterKey, name, entry); } catch { continue; }
        data[name] = encryptEntry(masterKey, name, plain, true);
        migrated++;
    }
    return migrated;
}
