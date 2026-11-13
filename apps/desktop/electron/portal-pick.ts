/**
 * The PICK of a share taken through the desktop's portal (Linux Wayland): what makes a later capture
 * of that share open with no dialog, and a different one open with one.
 *
 * MEASURED (harness/linux-share-matrix, Electron 43.8.1, GNOME = mutter + xdg-desktop-portal-gnome, the
 * dialogs counted from the portal backend's own log, not from `ScreenCast.Start` calls):
 *
 *   a listing (desktopCapturer.getSources) ........................ 1 dialog, and a restore token is kept
 *   a capture answered with the LISTED id ......................... 0 dialogs (restore_token sent, frames flow)
 *   applyConstraints on that capture (fps and size, up and down) .. 0 dialogs per change, the track stays live
 *   a capture answered with a MADE-UP id (no listing) ............. 1 dialog, no token
 *   applyConstraints on that capture .............................. 1 dialog per change
 *
 * So a `ScreenCast.Start` is not "a chooser": a Start that carries the restore token Chromium holds for a
 * listed source is restored silently by the backend. The token is bound to the LISTED source's id, so a
 * capture, a restart (applyConstraints) or a republish that uses that id gets exactly the source the user
 * picked and nothing else; a made-up id has no token and asks.
 *
 * The share therefore takes ONE listing as its pick (the one dialog) and captures with the listed id:
 *   - a NEW placeholder from the renderer (Start / Change source) = a new pick = list again = one dialog.
 *     It is never answered from an older pick: "Change source" must ask, never silently keep the old source;
 *   - the SAME placeholder again (a republish or "apply to current share" on the running share) = the same
 *     pick, answered with the same listed id: restored with no dialog, the same source.
 * A listing that comes back empty or fails is the user closing the dialog: no pick, no capture, and the
 * pick the running share holds is left exactly as it was.
 *
 * Pure (no electron import): portal-pick.test.ts.
 */

export interface PickedSource { id: string; name: string }

export interface PortalPicks {
    /** The source this placeholder was resolved to, if it was. */
    get(placeholder: string): PickedSource | undefined;
    /** Remember the pick of `placeholder`. Oldest picks fall out past `limit`. */
    set(placeholder: string, source: PickedSource): void;
    size(): number;
}

/** A few, not one: the running share's pick must survive a Change source the user cancels or that fails. */
export const PORTAL_PICKS_KEPT = 4;

export function createPortalPicks(limit: number = PORTAL_PICKS_KEPT): PortalPicks {
    const map = new Map<string, PickedSource>();
    return {
        get: (p) => map.get(p),
        set: (p, s) => {
            map.delete(p);
            map.set(p, s);
            while (map.size > Math.max(1, limit)) map.delete(map.keys().next().value as string);
        },
        size: () => map.size,
    };
}

export type PortalPickPlan =
    | { action: 'reuse'; source: PickedSource }
    | { action: 'list' };

/** Same placeholder = same pick; any other placeholder = a new pick, which asks. */
export function planPortalPick(picks: PortalPicks, placeholder: string): PortalPickPlan {
    const held = picks.get(placeholder);
    return held ? { action: 'reuse', source: held } : { action: 'list' };
}

/**
 * The pick out of a listing. On Wayland the list is the single entry the user chose in the desktop's dialog; an
 * empty list (or entries with no usable id) means the dialog was closed. Only an id Chromium can parse as a
 * desktop media id is accepted, and the first one wins.
 */
export function pickFromListing(sources: ReadonlyArray<{ id?: unknown; name?: unknown }> | null | undefined): PickedSource | null {
    for (const s of sources ?? []) {
        if (typeof s?.id === 'string' && /^(screen|window):\d+:\d+(:\w+)?$/.test(s.id)) {
            return { id: s.id, name: typeof s.name === 'string' && s.name ? s.name : 'Screen or window' };
        }
    }
    return null;
}
