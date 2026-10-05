/**
 * Wire shape for the desktop annotation overlay (docs/video-annotation-
 * design.md, Phase 5) — deliberately isolated from both the renderer's
 * `desktopAnnotationOverlay.ts` (imports `livekit-client`) and the main
 * process's `electron/annotation-overlay.ts` (imports `electron`).
 *
 * `apps/website`'s isolated build type-checks `src/env.d.ts` (the one
 * desktop file it includes, for the shared `window.electronAPI` ambient
 * type) but only installs its own package.json's dependencies — it has
 * neither `livekit-client` nor `electron`. `env.d.ts`'s
 * `annotationOverlayPush` signature previously imported `OverlayDelta` from
 * the renderer file, which pulled `livekit-client` into the website's
 * compilation graph via TypeScript's module resolution (even though the
 * type itself never referenced it) and broke `apps/website`'s production
 * build with `TS2307: Cannot find module 'livekit-client'`.
 *
 * Both `desktopAnnotationOverlay.ts` and `electron/annotation-overlay.ts`
 * now import this shared shape instead of each hand-maintaining their own
 * copy — closing the "keep two copies in sync by hand" duplication risk
 * this file's prior split point already documented, not just working
 * around the website build failure.
 */
export interface OverlayPoint { x: number; y: number }

export interface OverlayStroke {
    id: string;
    color: string;
    width: number;
    points: OverlayPoint[];
    /**
     * ms epoch of the last point (annotationStore.Stroke.updatedAt). Drives the
     * overlay's own copy of the abandonment WATCHDOG.
     *
     * The overlay ages strokes on its OWN clock rather than waiting to be told
     * what to remove: main and renderer share a machine, so `Date.now()` agrees
     * on both sides, and the overlay keeps fading smoothly between deltas
     * instead of freezing whenever the store stops changing. Without it the
     * overlay held the last frame it was sent forever whenever the store went
     * quiet — including a stroke abandoned mid-draw.
     */
    updatedAt: number;
    /**
     * ms epoch at which the stroke closed and began to fade; 0 while the pen is
     * still down (annotationStore.Stroke.closedAt). A live stroke is drawn
     * whole, at full opacity — the overlay must never erode it.
     */
    closedAt: number;
}

export interface OverlayDelta {
    reset?: boolean;
    upsert?: OverlayStroke[];
    append?: Array<{ id: string; points: OverlayPoint[]; updatedAt: number; closedAt: number }>;
    remove?: string[];
}
