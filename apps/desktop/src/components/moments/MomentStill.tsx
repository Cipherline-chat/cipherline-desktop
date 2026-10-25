import React from 'react';
import { Keys } from '../mascot/Keys';

/**
 * Reduced motion (doctrine rule 9 / the moment contract): nothing travels,
 * nothing pops — a still card with Keys and the punchline, for stillMs(id)
 * (reading time for both lines + the 1 s hold; the echo's waits for a click), then
 * gone. Same words as the animated version, so nobody loses the joke.
 */
export const MomentStill: React.FC<{ headline: string; line: string }> = ({ headline, line }) => (
    <div className="mo-still-wrap" aria-hidden="true">
        <div className="mo-still" data-testid="moment-still">
            <Keys size={64} interactive={false} waveOnMount={false} idleSway={false} />
            <div>
                <div className="mo-still-headline">{headline}</div>
                <div className="mo-still-line">{line}</div>
            </div>
        </div>
    </div>
);

export default MomentStill;
