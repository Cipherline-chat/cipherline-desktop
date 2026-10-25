/**
 * useSpeakerPromotion — the stable "who is talking" list that drives
 * overflow ordering in the call sidebar AND the fullscreen strip.
 *
 * Extracted verbatim from SidebarConference so both surfaces share one
 * timer + one set of rules (utils/overflowPriority.ts owns the numbers).
 *
 *  - Counters live in a ref: a functional setState that returned `prev` on
 *    no-promotion ticks used to discard increments and pin counts at 0
 *    (P2-REND-2).
 *  - `promotedIds`: most-recently-promoted first. A speaker is added after
 *    PROMOTE_AFTER_TICKS consecutive speaking ticks and removed
 *    DEMOTE_AFTER_MS after they fall quiet; a speaker who resumes inside that
 *    window cancels the demotion. So the list changes at most once per
 *    speaking burst, never on every tick.
 *  - `speakOrder`: everyone who has spoken this call, latest first. Never
 *    shrinks (it is the decode cap's priority; ids that left are ignored by
 *    its reader).
 */
import { useEffect, useRef, useState } from 'react';
import { DEMOTE_AFTER_MS, advanceSpeakerTicks } from '../utils/overflowPriority';

export function useSpeakerPromotion(
    participants: readonly { identity: string; isSpeaking: boolean }[],
): { promotedIds: string[]; speakOrder: string[] } {
    const ticksRef = useRef<Record<string, number>>({});
    const participantsRef = useRef(participants);
    useEffect(() => { participantsRef.current = participants; }, [participants]);
    const [promotedIds, setPromotedIds] = useState<string[]>([]);
    const [speakOrder, setSpeakOrder] = useState<string[]>([]);
    const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

    useEffect(() => {
        const timers = timersRef.current;
        const interval = setInterval(() => {
            const { promote, demote } = advanceSpeakerTicks(ticksRef.current, participantsRef.current);
            for (const id of promote) {
                // Cancel a pending demotion so a speaker who pauses briefly and
                // resumes is not demoted mid-burst.
                const t = timers.get(id);
                if (t) { clearTimeout(t); timers.delete(id); }
                setPromotedIds(prev => [id, ...prev.filter(x => x !== id)]);
                setSpeakOrder(prev => (prev[0] === id ? prev : [id, ...prev.filter(x => x !== id)]));
            }
            for (const id of demote) {
                if (timers.has(id)) continue;
                timers.set(id, setTimeout(() => {
                    setPromotedIds(prev => prev.filter(x => x !== id));
                    timers.delete(id);
                }, DEMOTE_AFTER_MS));
            }
        }, 1000);
        return () => {
            clearInterval(interval);
            timers.forEach(t => clearTimeout(t));
            timers.clear();
        };
    }, []);

    // Drop state for participants who left the call.
    useEffect(() => {
        const ids = new Set(participants.map(p => p.identity));
        setPromotedIds(prev => {
            const filtered = prev.filter(id => ids.has(id));
            return filtered.length === prev.length ? prev : filtered;
        });
        const ticks = ticksRef.current;
        Object.keys(ticks).forEach(id => { if (!ids.has(id)) delete ticks[id]; });
        timersRef.current.forEach((timer, id) => {
            if (!ids.has(id)) { clearTimeout(timer); timersRef.current.delete(id); }
        });
    }, [participants]);

    return { promotedIds, speakOrder };
}
