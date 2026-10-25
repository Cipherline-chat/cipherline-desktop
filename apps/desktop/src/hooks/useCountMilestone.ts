import { useEffect, useRef } from 'react';
import { crossedMilestone, requestMoment, type MomentId } from '../utils/moments';

/**
 * Ask for `id` when `count` is SEEN crossing `n` (utils/moments.ts
 * crossedMilestone): pass null while the count is unknown (still loading).
 * Only ever sees a number — the friends list or server list itself never
 * reaches the moment machinery.
 */
export function useCountMilestone(count: number | null, n: number, id: MomentId): void {
    const prev = useRef<number | null>(null);
    useEffect(() => {
        if (count === null) return;
        if (crossedMilestone(prev.current, count, n)) requestMoment(id);
        prev.current = count;
    }, [count, n, id]);
}
