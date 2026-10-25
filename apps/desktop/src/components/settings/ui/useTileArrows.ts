import type React from 'react';

/** Arrow / Home / End roving over `button[data-tile]` inside `ref`, shared by every picker panel. */
export function useTileArrows(ref: React.RefObject<HTMLElement | null>) {
    return (e: React.KeyboardEvent) => {
        if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
        const tiles = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button[data-tile]') ?? [])];
        const at = tiles.indexOf(document.activeElement as HTMLButtonElement);
        if (at < 0 || tiles.length === 0) return;
        e.preventDefault();
        const n = tiles.length;
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1
            : (at + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        tiles[next].focus();
    };
}
