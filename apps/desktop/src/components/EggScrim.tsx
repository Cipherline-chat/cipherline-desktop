import React from 'react';
import '../styles/egg-scrim.css';

/**
 * The one backdrop an easter-egg moment sits on (styles/egg-scrim.css has the
 * why, the colour token and why there is no blur). Render it as the FIRST
 * child of the egg's own fixed, full-window layer, so the art paints above it
 * and the toast stack (z 60000) stays above both.
 *
 * Times are in ms. `outAt` omitted = the scrim stays until its owner unmounts
 * it (a moment that waits on its button). Its passive skip contract (Escape
 * or a click ends the egg) is hooks/useEggSkip.ts.
 */
export const EggScrim: React.FC<{ inMs?: number; outAtMs?: number; outMs?: number }> = ({ inMs, outAtMs, outMs }) => {
    const style: Record<string, string> = {};
    if (inMs !== undefined) style['--egg-scrim-in'] = `${inMs}ms`;
    if (outAtMs !== undefined) style['--egg-scrim-out-at'] = `${outAtMs}ms`;
    if (outMs !== undefined) style['--egg-scrim-out'] = `${outMs}ms`;
    return <div className="egg-scrim" data-testid="egg-scrim" aria-hidden="true" style={style as React.CSSProperties} />;
};

export default EggScrim;
