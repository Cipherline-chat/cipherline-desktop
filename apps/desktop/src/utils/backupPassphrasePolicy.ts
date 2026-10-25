/**
 * Strength rule for a NEW backup passphrase (F9).
 *
 * A backup container is encrypted under a key derived from the passphrase
 * (PBKDF2-HMAC-SHA512, 600 000 iterations — backupContainer.ts), and the file
 * lives wherever the user put it: a local folder, a synced folder, Google
 * Drive. Whoever obtains the file can guess passphrases offline, so the
 * passphrase is the whole of its protection. Until now any non-empty string
 * was accepted.
 *
 * The rule is the one registration already applies to the account password:
 * zxcvbn score >= 3. It applies only to a passphrase being CHOSEN — one that
 * differs from the passphrase this device already has saved. An existing
 * passphrase keeps working for scheduled and manual backups, and restore never
 * checks strength at all: an old backup must stay openable with whatever it
 * was written under.
 */

/** Same bar as registration / password change (AuthScreen). */
export const MIN_BACKUP_PASSPHRASE_SCORE = 3;

export interface ZxcvbnLike {
    (password: string, userInputs?: string[]): { score: number; feedback?: { warning?: string; suggestions?: string[] } };
}

export interface PassphraseVerdict {
    ok: boolean;
    /** True when the passphrase is the one already saved on this device. */
    existing: boolean;
    /** zxcvbn score, or null when not computed (existing / empty). */
    score: number | null;
    /** User-facing reason when !ok. */
    message: string | null;
}

/**
 * Judge a backup passphrase. `savedPassphrase` is what this device already
 * has cached (null when nothing is saved); `userInputs` are account words
 * zxcvbn should treat as guessable (username, email).
 */
export function judgeBackupPassphrase(
    passphrase: string,
    savedPassphrase: string | null,
    zxcvbn: ZxcvbnLike,
    userInputs: string[] = [],
): PassphraseVerdict {
    if (!passphrase) return { ok: false, existing: false, score: null, message: 'Enter a backup passphrase first.' };
    if (savedPassphrase !== null && passphrase === savedPassphrase) {
        return { ok: true, existing: true, score: null, message: null };
    }
    // The product's own name is the first thing a guesser tries.
    const r = zxcvbn(passphrase, [...userInputs.filter(Boolean), 'cipherline', 'backup']);
    if (r.score >= MIN_BACKUP_PASSPHRASE_SCORE) return { ok: true, existing: false, score: r.score, message: null };
    const hint = r.feedback?.warning || r.feedback?.suggestions?.[0] || '';
    return {
        ok: false,
        existing: false,
        score: r.score,
        message: 'Choose a stronger passphrase — anyone who gets the backup file can try guesses offline. '
            + 'A few unrelated words works well.' + (hint ? ` (${hint})` : ''),
    };
}
