import secureLocalStore from '../utils/secureLocalStore';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CustomGameEntry {
    processName: string;   // lowercase exe name without extension
    displayName: string;   // user-chosen display name
}

export interface GameSettings {
    showGameActivity: boolean;
    customGames: CustomGameEntry[];
    ignoredProcesses: string[];
}

/** Pre-2026-09 key: one record shared by EVERY account on the device, so
 *  signing into a second account replaced the first account's ignored games.
 *  Read once as a migration source; never written again. */
const LEGACY_STORAGE_KEY = 'cipherline_game_settings';
export const gameSettingsKey = (userId: string) => `cipherline_game_settings_${userId}`;

const DEFAULTS: GameSettings = {
    showGameActivity: true,
    customGames: [],
    ignoredProcesses: [],
};

// ── Hook ──────────────────────────────────────────────────────────────────────

function loadSettings(userId: string | null | undefined): GameSettings {
    try {
        const raw = (userId ? secureLocalStore.getItem(gameSettingsKey(userId)) : null)
            ?? secureLocalStore.getItem(LEGACY_STORAGE_KEY); // migration: first sign-in after the per-account split
        if (!raw) return { ...DEFAULTS };
        return { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {
        return { ...DEFAULTS };
    }
}

export function useGameSettings(userId?: string | null) {
    const [settings, setSettings] = useState<GameSettings>(() => loadSettings(userId));
    // Only persist what the USER changed. Mount used to write the freshly
    // loaded state straight back - so any read miss (a cold account namespace
    // right after sign-in, a decrypt failure) became defaults on disk, and the
    // same effect pushed an empty ignore list into the main process too.
    const dirtyRef = useRef(false);

    // Account switch within a session: reload for the new account.
    const boundUserRef = useRef(userId);
    useEffect(() => {
        if (boundUserRef.current === userId) return;
        boundUserRef.current = userId;
        dirtyRef.current = false;
        setSettings(loadSettings(userId));
    }, [userId]);

    useEffect(() => {
        if (!dirtyRef.current || !userId || !secureLocalStore.isAccountReady(userId)) return;
        try { secureLocalStore.setItem(gameSettingsKey(userId), JSON.stringify(settings)); } catch {}
    }, [settings, userId]);

    // Sync custom games and ignored processes to Electron main process
    useEffect(() => {
        const electronAPI = (window as any).electronAPI;
        if (!electronAPI?.setCustomGames) return;
        electronAPI.setCustomGames(settings.customGames);
    }, [settings.customGames]);

    useEffect(() => {
        const electronAPI = (window as any).electronAPI;
        if (!electronAPI?.setIgnoredProcesses) return;
        electronAPI.setIgnoredProcesses(settings.ignoredProcesses);
    }, [settings.ignoredProcesses]);

    const setShowGameActivity = useCallback((v: boolean) => {
        dirtyRef.current = true;
        setSettings(prev => ({ ...prev, showGameActivity: v }));
    }, []);

    const addCustomGame = useCallback((processName: string, displayName: string) => {
        dirtyRef.current = true;
        setSettings(prev => {
            const normalized = processName.toLowerCase();
            // Don't add duplicates
            if (prev.customGames.some(g => g.processName === normalized)) return prev;
            return {
                ...prev,
                customGames: [...prev.customGames, { processName: normalized, displayName }],
            };
        });
    }, []);

    const removeCustomGame = useCallback((processName: string) => {
        dirtyRef.current = true;
        setSettings(prev => ({
            ...prev,
            customGames: prev.customGames.filter(g => g.processName !== processName),
        }));
    }, []);

    const addIgnoredProcess = useCallback((processName: string) => {
        dirtyRef.current = true;
        setSettings(prev => {
            const normalized = processName.toLowerCase();
            if (prev.ignoredProcesses.includes(normalized)) return prev;
            return {
                ...prev,
                ignoredProcesses: [...prev.ignoredProcesses, normalized],
            };
        });
    }, []);

    const removeIgnoredProcess = useCallback((processName: string) => {
        dirtyRef.current = true;
        setSettings(prev => ({
            ...prev,
            ignoredProcesses: prev.ignoredProcesses.filter(p => p !== processName),
        }));
    }, []);

    return useMemo(() => ({
        settings,
        setShowGameActivity,
        addCustomGame,
        removeCustomGame,
        addIgnoredProcess,
        removeIgnoredProcess,
    }), [
        settings,
        setShowGameActivity,
        addCustomGame,
        removeCustomGame,
        addIgnoredProcess,
        removeIgnoredProcess,
    ]);
}

export type GameSettingsHook = ReturnType<typeof useGameSettings>;
