/**
 * secure-store-policy — what the RENDERER is allowed to name when it talks to
 * the encrypted keystore through the bulk `secure:*` IPC channels.
 *
 * The keystore (electron/storage.ts) holds the device's long-term secrets:
 * the Signal identity private key, signed prekeys, one-time prekeys, channel
 * keys, avatar keys, the Drive OAuth tokens. Putting the crypto engine in the
 * main process is only worth something if that material cannot simply be
 * ASKED for from the other side of the bridge — and until this file existed,
 * it could be: `secure:get-many` took an arbitrary array of key names and
 * returned whatever it found, and `secure:replace-many` / `secure:delete-many`
 * took arbitrary names to overwrite or destroy. A renderer running attacker
 * code read (or replaced) every private key in one call.
 *
 * The sender guard on those handlers does not help here. It answers "is this
 * really our renderer?", which is a different question from "may our renderer
 * have this?" — and the renderer is exactly the compromised party in the
 * threat model this list exists for.
 *
 * So: the bulk channels are a NAMED, closed set, not a generic key/value API.
 * Everything below is either a non-secret UI preference or a credential the
 * renderer demonstrably has to hold in order to do its job. Anything else is
 * unreachable by name, which means adding a new renderer-visible key is a
 * deliberate edit here rather than an accident at a call site.
 *
 * Keep in sync with `src/services/backupRegistry.ts` (APP_PREF_KEYS) — that
 * module decides what goes INTO a backup, this one decides what the renderer
 * may touch at all, and the two lists overlap by construction.
 * `secureStorePolicy.test.ts` asserts they agree; it cannot be an import
 * because electron/ must never import from src/ (doing so nests the emitted
 * dist-electron output and breaks packaging).
 */

/**
 * App preferences. Not secrets: they are read by the backup exporter and
 * written back by the restore importer, and the renderer owns the UI for all
 * of them. Mirrors APP_PREF_KEYS in src/services/backupRegistry.ts.
 */
const APP_PREF_KEYS = [
    'minimizeToTray',
    'startMinimized',
    // 'updateChannel' is DELIBERATELY ABSENT — do not add it back.
    //
    // It decides which release channel autoUpdater pulls from, and
    // autoDownload + autoInstallOnAppQuit are both on, so whoever controls it
    // controls which binaries this machine installs. `updater:set-channel`
    // guards that with an unforgeable native dialog — but while this key sat
    // in APP_PREF_KEYS the renderer could write it straight through
    // `secure:replace-many`, and readChannel() feeds it to
    // `autoUpdater.channel` at the next launch without ever consulting the
    // dialog. The guard was real and the state it guarded was writable around
    // it. A restored backup flipped the channel the same silent way, which is
    // why it is excluded in src/services/backupRegistry.ts too.
    //
    // Nothing in the renderer needs it: AdvancedSettings changes the channel
    // exclusively through the setUpdateChannel IPC (preload.ts:590).
    'gameCustomGames',
    'gameIgnoredProcesses',
] as const;

/**
 * The user's backup passphrase, cached so scheduled backups can run without
 * re-prompting. This one IS a credential, and it is on the list because the
 * renderer is where backup encryption happens: backupContainer.ts derives the
 * PBKDF2 key and does every AES-GCM operation in renderer WebCrypto, so the
 * passphrase has to be there. Moving it behind the bridge would mean moving
 * the whole container writer into main — worth doing, not done here.
 *
 * Note what this does NOT expose: the backup passphrase is not the device
 * master key and unwraps nothing in the keystore.
 */
const RENDERER_CREDENTIAL_KEYS = ['drive_backup_password'] as const;

/** Every key the renderer may read, write or delete by name. */
export const RENDERER_SECURE_KEYS: readonly string[] = [
    ...APP_PREF_KEYS,
    ...RENDERER_CREDENTIAL_KEYS,
];

const ALLOWED = new Set<string>(RENDERER_SECURE_KEYS);

/**
 * Whether the renderer may name this keystore key on a bulk `secure:*`
 * channel. Deliberately an exact-match set: no prefixes, no patterns. A
 * prefix rule is how `avatar_key:` style namespaces leak — one caller passing
 * a crafted id widens the whole class — and there is nothing here that needs
 * one.
 */
export function isRendererSecureKey(key: unknown): key is string {
    return typeof key === 'string' && ALLOWED.has(key);
}

/** Keep only the entries the renderer is allowed to name. */
export function filterRendererSecureKeys(keys: unknown[]): string[] {
    return keys.filter(isRendererSecureKey);
}
