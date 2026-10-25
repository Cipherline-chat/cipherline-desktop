import { useEffect } from 'react';
import { recordEggFound } from '../utils/eggProgress';

/**
 * Renders nothing; records `id` as found once it MOUNTS. For an egg whose
 * payoff is "this element is on screen" (e.g. the deep-sea chat-list divider)
 * where the render path itself must stay free of side effects.
 */
export function EggSeen({ id }: { id: string }): null {
    useEffect(() => { recordEggFound(id); }, [id]);
    return null;
}

export default EggSeen;
