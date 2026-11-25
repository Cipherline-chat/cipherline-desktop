/**
 * One playing embed per chat view (docs/plans/embeds.md §3, §6).
 *
 * Each inline player (the YouTube iframe, an inline <video>) claims the scope
 * when it starts; whoever held it before is told to stop. A YouTube player
 * stops by unmounting back to its facade (a cross-origin iframe cannot be
 * paused from here); a <video> pauses.
 *
 * ChatPane provides one scope per chat view. Without a provider every embed
 * shares the app-wide default, which is stricter, never looser.
 */
import { createContext, useCallback, useContext, useEffect, useId, useSyncExternalStore } from 'react';

export class PlaybackScope {
    private active: string | null = null;
    private readonly listeners = new Set<() => void>();

    current(): string | null { return this.active; }

    /** `key` becomes the one playing embed; the previous one is told to stop. */
    claim(key: string): void {
        if (this.active === key) return;
        this.active = key;
        this.emit();
    }

    /** Releases the scope if `key` still holds it. */
    release(key: string): void {
        if (this.active !== key) return;
        this.active = null;
        this.emit();
    }

    subscribe(fn: () => void): () => void {
        this.listeners.add(fn);
        return () => { this.listeners.delete(fn); };
    }

    private emit(): void {
        for (const fn of [...this.listeners]) fn();
    }
}

const defaultScope = new PlaybackScope();
export const EmbedPlaybackContext = createContext<PlaybackScope>(defaultScope);

/**
 * `[isActive, claim, release, holdsNow]` for one embed instance. Unmounting
 * releases. `isActive` turns false the moment another embed in the scope
 * claims it; `holdsNow()` reads the same thing outside render (after an await).
 */
export function useExclusivePlayback(): [boolean, () => void, () => void, () => boolean] {
    const scope = useContext(EmbedPlaybackContext);
    const key = useId();
    const active = useSyncExternalStore(
        useCallback((fn: () => void) => scope.subscribe(fn), [scope]),
        () => scope.current() === key,
        () => false,
    );
    const claim = useCallback(() => scope.claim(key), [scope, key]);
    const release = useCallback(() => scope.release(key), [scope, key]);
    const holdsNow = useCallback(() => scope.current() === key, [scope, key]);
    useEffect(() => () => scope.release(key), [scope, key]);
    return [active, claim, release, holdsNow];
}
