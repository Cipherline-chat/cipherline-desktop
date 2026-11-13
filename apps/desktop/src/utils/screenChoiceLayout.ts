/**
 * Geometry for the "Which screen are you sharing?" chooser: Electron's logical display
 * rectangles scaled into a box, preserving their relative positions, so the dialog shows the
 * user's real desk layout. Pure so it is unit-tested without a DOM.
 */
import type { OverlayScreenChoice } from './annotationOverlayTypes';

export interface ScreenTile {
    id: number;
    /** 1-based, left-to-right then top-to-bottom: the number a person would say aloud. */
    number: number;
    left: number; top: number; width: number; height: number;
    /** Logical size, for the label. */
    pxWidth: number; pxHeight: number;
    primary: boolean;
    selectable: boolean;
}

export function layoutScreenChoice(choice: OverlayScreenChoice, boxW: number, boxH: number, gap = 4): ScreenTile[] {
    const ds = choice.displays;
    if (!ds.length || !(boxW > 0) || !(boxH > 0)) return [];
    const minX = Math.min(...ds.map(d => d.x)), minY = Math.min(...ds.map(d => d.y));
    const maxX = Math.max(...ds.map(d => d.x + d.width)), maxY = Math.max(...ds.map(d => d.y + d.height));
    const k = Math.min(boxW / (maxX - minX), boxH / (maxY - minY));
    const offX = (boxW - (maxX - minX) * k) / 2, offY = (boxH - (maxY - minY) * k) / 2;
    const order = [...ds].sort((a, b) => a.x - b.x || a.y - b.y);
    const numberOf = new Map(order.map((d, i) => [d.id, i + 1]));
    return ds.map(d => ({
        id: d.id,
        number: numberOf.get(d.id) ?? 0,
        left: offX + (d.x - minX) * k + gap / 2,
        top: offY + (d.y - minY) * k + gap / 2,
        width: Math.max(1, d.width * k - gap),
        height: Math.max(1, d.height * k - gap),
        pxWidth: d.width, pxHeight: d.height,
        primary: d.primary,
        selectable: choice.candidates.includes(d.id),
    }));
}
