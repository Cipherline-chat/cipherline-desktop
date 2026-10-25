import React, { useRef, useState } from 'react';
import { GripVertical, X } from 'lucide-react';

/**
 * A row of chips you can reorder by dragging (pointer) or with Alt + Left /
 * Right (keyboard, on the focused chip), and remove with their ×. Used by the
 * Settings > Profile tag-style editors (favorite games, links). Pure UI: every
 * change goes out through `onChange` with the whole new list.
 */
export interface ChipItem { key: string; label: React.ReactNode; name: string; icon?: React.ReactNode; locked?: boolean; trailing?: React.ReactNode }

export const ReorderChips: React.FC<{
    items: readonly ChipItem[];
    disabled?: boolean;
    label: string;
    onMove: (from: number, to: number) => void;
    onRemove: (index: number) => void;
}> = ({ items, disabled, label, onMove, onRemove }) => {
    const [drag, setDrag] = useState<number | null>(null);
    const [over, setOver] = useState<number | null>(null);
    const listRef = useRef<HTMLUListElement>(null);
    const focusChip = (i: number) => requestAnimationFrame(() => listRef.current?.querySelectorAll<HTMLElement>('[data-chip]')[i]?.focus());
    if (items.length === 0) return null;
    return (
        <ul ref={listRef} className="ps-rchips" aria-label={label}>
            {items.map((it, i) => (
                <li
                    key={it.key}
                    className="ps-rchip"
                    data-chip
                    data-locked={it.locked ? 'true' : undefined}
                    data-drag={drag === i ? 'true' : undefined}
                    data-over={over === i && drag !== null && drag !== i ? (drag < i ? 'after' : 'before') : undefined}
                    tabIndex={0}
                    aria-label={`${it.name}, ${i + 1} of ${items.length}`}
                    aria-description={it.locked || disabled ? undefined : 'Alt plus left or right arrow to move, Delete to remove'}
                    draggable={!disabled && !it.locked}
                    onDragStart={(e) => { setDrag(i); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', it.key); }}
                    onDragEnd={() => { setDrag(null); setOver(null); }}
                    onDragOver={(e) => { if (drag === null || items[i].locked) return; e.preventDefault(); setOver(i); }}
                    onDragLeave={() => setOver((o) => (o === i ? null : o))}
                    onDrop={(e) => { e.preventDefault(); if (drag !== null && drag !== i && !items[i].locked) onMove(drag, i); setDrag(null); setOver(null); }}
                    onKeyDown={(e) => {
                        if (disabled || it.locked || e.target !== e.currentTarget) return;
                        if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
                            const j = i + (e.key === 'ArrowLeft' ? -1 : 1);
                            if (j < 0 || j >= items.length || items[j].locked) return;
                            e.preventDefault(); onMove(i, j); focusChip(j);
                        } else if (e.key === 'Delete' || e.key === 'Backspace') {
                            e.preventDefault(); onRemove(i); focusChip(Math.max(0, i - 1));
                        }
                    }}
                >
                    {!it.locked && <GripVertical size={12} className="ps-rchip-grip" aria-hidden="true" />}
                    {it.icon}
                    <span className="ps-rchip-label">{it.label}</span>
                    {it.trailing}
                    {!it.locked && (
                        <button type="button" className="ps-rchip-x" aria-label={`Remove ${it.name}`} disabled={disabled} tabIndex={-1}
                            onClick={() => onRemove(i)}>
                            <X size={12} aria-hidden="true" />
                        </button>
                    )}
                </li>
            ))}
        </ul>
    );
};
