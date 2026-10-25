import { useEffect, useState } from 'react';
import { getTracker, subscribeBind } from '../utils/achievements/tracker';

export interface AchievementSignalInput {
    /** The active call or voice channel, if any. */
    callId: string | null;
    /** The media room is connected. */
    connected: boolean;
    /** People in the call including you. */
    people: number;
    /** You started this call (false for a voice channel). */
    isHost: boolean;
    /** The detected game's display name, or null. */
    game: string | null;
}

/**
 * Dashboard's one-line feed into the achievements tracker: the call/voice
 * lifecycle and the detected game. Nothing leaves the device; the tracker only
 * turns elapsed time into local counters (utils/achievements/tracker.ts).
 */
export function useAchievementSignals({ callId, connected, people, isHost, game }: AchievementSignalInput): void {
    // The tracker binds asynchronously after sign-in: re-send the current state when it does.
    const [bound, setBound] = useState(0);
    useEffect(() => subscribeBind(() => setBound(n => n + 1)), []);

    useEffect(() => {
        getTracker()?.signalCall(callId ? { id: callId, connected, people, isHost } : null);
    }, [callId, connected, people, isHost, bound]);

    useEffect(() => {
        getTracker()?.signalGame(game);
    }, [game, bound]);
}
