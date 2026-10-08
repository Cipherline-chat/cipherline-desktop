import React from 'react';
import { wordmarkSide } from './wordmarkSide';

/**
 * "Cipherline" text mark for the custom title bar (no logo icon — the rail
 * already carries the mascot). Rendered INSIDE the drag region as a plain
 * flex child: it is draggable, unselectable, and never `no-drag`, so it can't
 * punch a hole in the drag area. Left on Windows/Linux, right on macOS — see
 * wordmarkSide.ts for why.
 */
export const TitleBarWordmark: React.FC = () => {
    const side = wordmarkSide(window.electronAPI?.platform, navigator.userAgent);
    return (
        <span
            className={`cl-titlebar-wordmark${side === 'right' ? ' ml-auto' : ''}`}
            data-testid="titlebar-wordmark"
            data-side={side}
            aria-hidden
        >
            Cipherline
        </span>
    );
};

export default TitleBarWordmark;
