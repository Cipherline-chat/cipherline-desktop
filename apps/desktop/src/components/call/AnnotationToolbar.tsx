/**
 * AnnotationToolbar - the drawing controls, floating in a video tile's
 * top-right corner as a translucent cluster (the same treatment as the
 * resolution label that already lives there).
 *
 * There is ONE tool, the laser, so there is nothing to choose: no pen/laser
 * pair, and with every stroke retiring itself after LASER_TTL_MS, no undo and
 * no clear either - none of those three had anything left to act on once the
 * permanent mark went away. What is left is the smallest thing that is still
 * a tool: draw or don't, and in what colour.
 *
 * Collapsed: one pencil. Expanded (draw mode on): six colours and the same
 * button again to stop. Everything is keyboard reachable and carries a name
 * for assistive tech; colour swatches use aria-pressed so the current one is
 * announced.
 */
import React from 'react';
import { Pencil, X } from 'lucide-react';
import { annotationStore, useAnnotationStore, PALETTE } from '../../utils/annotationStore';
import { useEscape } from '../../hooks/useEscape';

/**
 * No props: draw mode and colour are call-wide, and nothing left in here acts
 * on one track. (Undo and clear were the only per-tile actions, and both went
 * with the pen.)
 */
const btn = 'inline-flex items-center justify-center rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cl-lume/70';
const size = { width: 26, height: 26 } as const;

export const AnnotationToolbar: React.FC = () => {
    const enabled = useAnnotationStore(s => s.enabled);
    const color = useAnnotationStore(s => s.color);
    // Esc leaves drawing mode, the same as the X. The auto-arm announces
    // "Esc to stop", and it is the one key that works when the pointer is busy
    // drawing. Goes through the shared Escape stack, so a press backs out of
    // exactly one thing: this first, then (next press) fullscreen underneath.
    useEscape(() => annotationStore.setEnabled(false), enabled);

    return (
        <div
            role="toolbar"
            aria-label="Annotation"
            className="flex items-center gap-1 bg-black/35 backdrop-blur-sm rounded-lg px-1.5 py-1 pointer-events-auto"
            // Stop the tile from treating clicks here as "focus / fullscreen".
            onClick={e => e.stopPropagation()}
            onDoubleClick={e => e.stopPropagation()}
            onPointerDown={e => e.stopPropagation()}
        >
            {enabled && (
                <>
                    {PALETTE.map(c => (
                        <button
                            key={c}
                            type="button"
                            title={c}
                            aria-label={`Colour ${c}`}
                            aria-pressed={color === c}
                            onClick={() => annotationStore.setColor(c)}
                            className="rounded-full shrink-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                            style={{
                                width: 14, height: 14, background: c, border: 'none', padding: 0, cursor: 'pointer',
                                boxShadow: color === c ? '0 0 0 2px rgba(255,255,255,0.95)' : '0 0 0 1px rgba(0,0,0,0.35)',
                                margin: '0 2px',
                            }}
                        />
                    ))}
                    <span className="w-px h-4 bg-white/15 mx-0.5" aria-hidden="true" />
                </>
            )}
            <button
                type="button"
                title={enabled ? 'Stop drawing' : 'Draw on this video (fades as you go)'}
                aria-label={enabled ? 'Stop drawing' : 'Draw on this video'}
                aria-pressed={enabled}
                onClick={() => annotationStore.setEnabled(!enabled)}
                className={`${btn} ${enabled ? 'bg-cl-lume text-cl-on-lume' : 'text-white/85 hover:text-white hover:bg-white/10'}`}
                style={size}
            >
                {enabled ? <X size={14} /> : <Pencil size={14} />}
            </button>
        </div>
    );
};
