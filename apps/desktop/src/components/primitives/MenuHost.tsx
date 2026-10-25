import React from 'react';

/** The menu is a portal, but React still bubbles its events to this component's
 *  parents (a message row, a reaction chip that toggles on click). Stop them here. */
export const MenuHost: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    if (!children) return null;
    const stop = (e: React.SyntheticEvent) => e.stopPropagation();
    return <span style={{ display: 'contents' }} onClick={stop} onMouseDown={stop} onContextMenu={stop} onKeyDown={stop}>{children}</span>;
};
