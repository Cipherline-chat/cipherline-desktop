import secureLocalStore from '../utils/secureLocalStore';
import { useCallback, useEffect, useRef, useState } from 'react';
import { deriveBackupKey } from '../utils/crypto';

/**
 * Screen Lock — a local, PIN-gated UI overlay ("walked away from your desk")
 * modeled after Signal Desktop's screen lock. This is NOT an extra layer of
 * at-rest encryption: the PIN never touches the E2EE key hierarchy, the
 * server, or secureLocalStore's own master key. It's a client-side visual
 * gate with the same threat model as your OS's screen lock.
 *
 * The PIN itself is never stored, hashed-and-compared, or logged. We derive
 * an AES-256-GCM key from it via PBKDF2 (the same `deriveBackupKey` helper
 * the encrypted-backup protocol uses — see crypto.ts) and use it to encrypt
 * a random 32-byte verifier at setup time. To check a candidate PIN we just
 * attempt to decrypt that verifier: AES-GCM's auth tag makes a wrong PIN
 * fail loudly (no plaintext ever recovered), so this is equivalent to a
 * salted-hash comparison without hand-rolling one.
 */

const STORAGE_KEY = 'cipherline_screenlock_settings';
const PIN_ITERATIONS = 210_000; // OWASP-2023-floor PBKDF2-SHA256; local lock, not a backup key, so kept snappy
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 30_000;
/** How often the inactivity timer is checked — frequent enough that a short
 *  timeout (e.g. 1 minute) still fires close to on time. */
const ACTIVITY_POLL_MS = 5_000;
/** DOM events that count as "using Cipherline" for the inactivity timer. */
const ACTIVITY_EVENTS = ['mousedown', 'mousemove', 'keydown', 'wheel', 'touchstart'] as const;

export const TIMEOUT_OPTIONS = [
    { value: 0, label: 'Never (manual only)' },
    { value: 1, label: '1 minute' },
    { value: 5, label: '5 minutes' },
    { value: 15, label: '15 minutes' },
    { value: 30, label: '30 minutes' },
    { value: 60, label: '1 hour' },
] as const;

interface PinVerifier {
    saltB64: string;
    ivB64: string;
    ctB64: string;
    iterations: number;
}

interface ScreenLockSettings {
    enabled: boolean;
    /** Minutes without any mouse/keyboard activity IN Cipherline before
     *  auto-locking — not the system-wide idle time, so it still locks even
     *  while you're busy in another app. 0 = only manual/keybind/OS-lock. */
    timeoutMinutes: number;
    /** Lock immediately when the OS reports its own screen lock/sleep (Windows + macOS). */
    lockOnOsLock: boolean;
    verifier: PinVerifier | null;
    /** 4 or 6 digits, chosen at setup/change time — makeVerifier/checkVerifier
     *  don't care (they derive a key from whatever string they're given), this
     *  is purely so the UI knows how many slots to render. Absent in settings
     *  persisted before this field existed; loadSettings()'s DEFAULTS-merge
     *  below defaults it to 6 so an existing user's already-6-digit PIN keeps
     *  working with no re-setup required. */
    pinLength: 4 | 6;
}

const DEFAULTS: ScreenLockSettings = {
    enabled: false,
    timeoutMinutes: 5,
    lockOnOsLock: true,
    verifier: null,
    pinLength: 6,
};

function loadSettings(): ScreenLockSettings {
    try {
        const raw = secureLocalStore.getItem(STORAGE_KEY);
        if (!raw) return { ...DEFAULTS };
        return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {
        return { ...DEFAULTS };
    }
}

function bufToB64(buf: ArrayBuffer | Uint8Array): string {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
}
function b64ToBuf(b64: string): Uint8Array {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

/** Encrypt a fresh random verifier under a PIN-derived key. */
async function makeVerifier(pin: string): Promise<PinVerifier> {
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const token = window.crypto.getRandomValues(new Uint8Array(32));
    const key = await deriveBackupKey(pin, salt, PIN_ITERATIONS, 'SHA-256');
    const ct = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv.buffer as ArrayBuffer }, key, token);
    return { saltB64: bufToB64(salt), ivB64: bufToB64(iv), ctB64: bufToB64(new Uint8Array(ct)), iterations: PIN_ITERATIONS };
}

/** True iff `pin` decrypts `verifier`'s token (i.e. it's the PIN that made it). */
async function checkVerifier(pin: string, verifier: PinVerifier): Promise<boolean> {
    try {
        const salt = b64ToBuf(verifier.saltB64);
        const iv = b64ToBuf(verifier.ivB64);
        const ct = b64ToBuf(verifier.ctB64);
        const key = await deriveBackupKey(pin, salt, verifier.iterations, 'SHA-256');
        await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv.buffer as ArrayBuffer }, key, ct.buffer as ArrayBuffer);
        return true;
    } catch {
        return false; // GCM auth-tag mismatch → wrong PIN
    }
}

export function useScreenLock() {
    const [settings, setSettings] = useState<ScreenLockSettings>(loadSettings);
    // Session-only: locks on mount (app launch / re-login) when a PIN is configured.
    const [isLocked, setIsLocked] = useState(() => loadSettings().enabled);
    const [attempts, setAttempts] = useState(0);
    const [lockedOutUntil, setLockedOutUntil] = useState<number | null>(null);

    // Latest `settings` for callbacks (lockNow, the idle-poll interval) that
    // need the current value without resubscribing on every settings change.
    const settingsRef = useRef(settings);
    useEffect(() => { settingsRef.current = settings; }, [settings]);

    // Persist config (never the PIN itself, only its encrypted verifier) on change.
    useEffect(() => {
        try { secureLocalStore.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch {}
    }, [settings]);

    const lockNow = useCallback(() => {
        if (!settingsRef.current.enabled || !settingsRef.current.verifier) return; // nothing configured to lock into
        setIsLocked(true);
    }, []);

    // ── Inactivity auto-lock — tracks activity IN Cipherline, not system-wide idle
    // time (electron's getSystemIdleTime would only fire once the whole PC has
    // been untouched, so Cipherline would never lock while you're working in
    // another app). Purely renderer-side: DOM activity listeners update
    // lastActiveAt, gated on document.hasFocus() so a stray mousemove over an
    // unfocused-but-visible window doesn't reset the clock.
    useEffect(() => {
        if (!settings.enabled || settings.timeoutMinutes <= 0 || isLocked) return;

        const thresholdMs = settings.timeoutMinutes * 60_000;
        let lastActiveAt = Date.now();
        const markActive = () => { if (document.hasFocus()) lastActiveAt = Date.now(); };

        for (const evt of ACTIVITY_EVENTS) window.addEventListener(evt, markActive, { passive: true });

        const id = window.setInterval(() => {
            if (Date.now() - lastActiveAt >= thresholdMs) lockNow();
        }, ACTIVITY_POLL_MS);

        return () => {
            for (const evt of ACTIVITY_EVENTS) window.removeEventListener(evt, markActive);
            window.clearInterval(id);
        };
    }, [settings.enabled, settings.timeoutMinutes, isLocked, lockNow]);

    // ── Lock when the OS screen locks / sleeps (Windows + macOS; best-effort elsewhere) ──
    useEffect(() => {
        if (!settings.enabled || !settings.lockOnOsLock) return;
        const api = (window as any).electronAPI;
        return api?.onOsLockScreen?.(() => lockNow());
    }, [settings.enabled, settings.lockOnOsLock, lockNow]);

    /** Attempt to unlock with `pin`. Returns true on success. Applies a short
     *  cooldown after repeated failures — a shoulder-surfing/opportunistic
     *  deterrent, not a real security boundary (this is a local convenience
     *  lock, same threat model as the OS's own screen lock). */
    const unlock = useCallback(async (pin: string): Promise<boolean> => {
        const now = Date.now();
        if (lockedOutUntil && now < lockedOutUntil) return false;
        const verifier = settingsRef.current.verifier;
        if (!verifier) { setIsLocked(false); return true; } // nothing configured — shouldn't normally be reachable while locked
        const ok = await checkVerifier(pin, verifier);
        if (ok) {
            setAttempts(0);
            setLockedOutUntil(null);
            setIsLocked(false);
            return true;
        }
        setAttempts(prev => {
            const next = prev + 1;
            if (next >= MAX_ATTEMPTS) {
                setLockedOutUntil(Date.now() + LOCKOUT_MS);
                return 0;
            }
            return next;
        });
        return false;
    }, [lockedOutUntil]);

    /** Set up (or replace) the PIN and turn the lock on. `pinLength` is
     *  persisted alongside the verifier purely for the UI (slot count on the
     *  overlay/settings) — the verifier itself works with any-length PIN. */
    const setPin = useCallback(async (pin: string, pinLength: 4 | 6) => {
        const verifier = await makeVerifier(pin);
        setSettings(prev => ({ ...prev, enabled: true, verifier, pinLength }));
    }, []);

    /** Change the PIN (and optionally its length) — requires the current PIN. */
    const changePin = useCallback(async (currentPin: string, newPin: string, newPinLength: 4 | 6): Promise<boolean> => {
        const verifier = settingsRef.current.verifier;
        if (!verifier || !(await checkVerifier(currentPin, verifier))) return false;
        await setPin(newPin, newPinLength);
        return true;
    }, [setPin]);

    /** Turn the lock off — requires the current PIN. */
    const disable = useCallback(async (currentPin: string): Promise<boolean> => {
        const verifier = settingsRef.current.verifier;
        if (!verifier || !(await checkVerifier(currentPin, verifier))) return false;
        setSettings(prev => ({ ...prev, enabled: false, verifier: null }));
        setIsLocked(false);
        setAttempts(0);
        setLockedOutUntil(null);
        return true;
    }, []);

    /** Escape hatch for a forgotten PIN — clears the local lock config WITHOUT
     *  verifying the PIN. Only meaningful paired with a sign-out: it doesn't
     *  expose any data by itself (nothing is encrypted under the PIN), and
     *  getting back into the account after signing out requires the account
     *  password again, which is the real gate here. */
    const forgotPinReset = useCallback(() => {
        setSettings(prev => ({ ...prev, enabled: false, verifier: null }));
        setIsLocked(false);
        setAttempts(0);
        setLockedOutUntil(null);
    }, []);

    const setTimeoutMinutes = useCallback((minutes: number) => {
        setSettings(prev => ({ ...prev, timeoutMinutes: minutes }));
    }, []);

    const setLockOnOsLock = useCallback((v: boolean) => {
        setSettings(prev => ({ ...prev, lockOnOsLock: v }));
    }, []);

    return {
        settings,
        isLocked,
        attempts,
        lockedOutUntil,
        lockNow,
        unlock,
        setPin,
        changePin,
        disable,
        forgotPinReset,
        setTimeoutMinutes,
        setLockOnOsLock,
    };
}

export type ScreenLockHook = ReturnType<typeof useScreenLock>;
