import { API_BASE } from '../constants';

/** The host appends `/v1/...` itself, so it is handed the origin. */
export function nearApiBase(base: string = API_BASE): string {
    return base.replace(/\/v1\/?$/, '');
}

/** `window.electronAPI`, but only when it has the near transfer members the screens call (never throws). The proximity sign-in
 *  members (`nearShowStart` ...) are not part of the transfer build, so the own-device request member is the marker. */
export function nearBridge(): NonNullable<Window['electronAPI']> | null {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    return api && typeof api.nearTransferRequest === 'function' ? api : null;
}

/** A short, human message for a rejected bridge call. */
export function bridgeMessage(e: unknown, fallback: string): string {
    const m = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
    return m && m.length < 200 ? m : fallback;
}

/**
 * The host runs ONE near session at a time and refuses a start while another is running ("a near session is already
 * running"). Cancelling is asynchronous, so a screen that replaces a session cancels first and then retries the start
 * for up to ~1 s. Any other error is returned at once.
 */
export async function startAfterCancel<T>(
    api: { nearCancel?: () => Promise<void> },
    start: () => Promise<T>,
    wait: (ms: number) => Promise<void> = (ms) => new Promise(r => setTimeout(r, ms)),
): Promise<T> {
    try { await api.nearCancel?.(); } catch { /* nothing was running */ }
    for (let i = 0; ; i++) {
        try { return await start(); } catch (e) {
            if (i >= 10 || !/already running/i.test(bridgeMessage(e, ''))) throw e;
            await wait(100);
        }
    }
}

/**
 * `K_xfer` from the host as raw bytes (contract 11.15), or null when this build has no near bridge or the host will not release
 * it (before approval). Main hands it over as a 32-byte Uint8Array (security finding I2: never a JS string, which cannot be
 * zeroed); the caller (the history port) zeroes the bytes after use. A base64 string (an older main) is still accepted.
 */
export async function nearTransferKeyBytes(api: { nearTransferKey?: () => Promise<Uint8Array | string> } | null | undefined = typeof window !== 'undefined' ? window.electronAPI : undefined): Promise<Uint8Array | null> {
    if (typeof api?.nearTransferKey !== 'function') return null;
    try {
        const k = await api.nearTransferKey();
        if (k instanceof Uint8Array) {
            if (k.length === 32) return k;
            k.fill(0);
            return null;
        }
        if (typeof k !== 'string' || k.length !== 44) return null;
        const bin = atob(k);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out.length === 32 ? out : null;
    } catch { return null; }
}
