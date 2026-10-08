import { useEffect, useRef } from 'react';
import { getAvatarBlob } from '../utils/attachmentCache';
import { loadAvatarToCache } from './useEncryptedAvatar';
import { syncPublicAvatar } from '../utils/publicAvatar';

/** Long enough to stay clear of the boot burst (messages, presence, avatar
 *  warming all spend the same API budget first). */
const START_DELAY_MS = 20_000;
/** requestIdleCallback deadline: run even if the renderer never goes idle. */
const IDLE_TIMEOUT_MS = 30_000;

type IdleWindow = Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (id: number) => void;
};

/**
 * The decrypted avatar the client already has: the persistent decrypted-blob
 * cache first, else the normal authenticated download + client-side decrypt
 * (the same path every avatar render uses). Never a new kind of request.
 */
async function loadOwnDecryptedAvatar(attachmentId: string, token: string): Promise<Blob | null> {
    const cached = await getAvatarBlob(attachmentId).catch(() => null);
    if (cached) return cached;
    const url = await loadAvatarToCache(attachmentId, token);
    if (!url) return null;
    const persisted = await getAvatarBlob(attachmentId).catch(() => null);
    if (persisted) return persisted;
    try {
        return await (await fetch(url)).blob();
    } catch {
        return null;
    }
}

/**
 * Startup backfill / self-heal for the PUBLIC profile picture (utils/
 * publicAvatar.ts). Existing users set their avatar before the public copy
 * existed, and an avatar changed from a client that does not publish leaves
 * no current copy; this uploads one once, in the background:
 *
 *   - off the render path: waits {@link START_DELAY_MS}, then for an idle
 *     slot; never awaited by anything, never blocks startup;
 *   - at most one status GET + one write per (account, avatar) per session;
 *   - sends only the avatar image (decrypted from what this client already
 *     has) and the encrypted avatar's attachment id.
 *
 * Avatar CHANGES made in this session are published by `uploadAvatarBlob`
 * directly; this only reacts to them if the profile's avatar id changes to
 * one the server has no copy of (another device / client).
 */
export function usePublicAvatarSync(opts: {
    token: string | null;
    userId: string | null;
    avatarUrl: string | null | undefined;
}): void {
    const { token, userId } = opts;
    const avatarUrl = opts.avatarUrl || null;
    const doneFor = useRef<Set<string>>(new Set());
    const tokenRef = useRef(token);
    useEffect(() => { tokenRef.current = token; }, [token]);

    useEffect(() => {
        if (!token || !userId) return;
        const key = `${userId}:${avatarUrl ?? ''}`;
        if (doneFor.current.has(key)) return;

        let cancelled = false;
        let idleId: number | undefined;
        const w = window as IdleWindow;
        const run = () => {
            if (cancelled) return;
            const t = tokenRef.current;
            if (!t) return;
            doneFor.current.add(key);
            void syncPublicAvatar({
                token: t,
                avatarUrl,
                loadDecryptedAvatar: (id) => loadOwnDecryptedAvatar(id, t),
            });
        };
        const timer = window.setTimeout(() => {
            if (cancelled) return;
            if (w.requestIdleCallback) idleId = w.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
            else run();
        }, START_DELAY_MS);

        return () => {
            cancelled = true;
            window.clearTimeout(timer);
            if (idleId !== undefined) w.cancelIdleCallback?.(idleId);
        };
        // token is read through tokenRef: a refreshed token must not restart the wait.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [userId, avatarUrl, !!token]);
}
