/**
 * The "source" of a screen share taken through the desktop's portal (Linux Wayland).
 *
 * THERE IS NO SOURCE TO NAME. On a native Wayland session the thing that is captured is chosen
 * in the desktop's own ScreenCast chooser (xdg-desktop-portal), at the moment the capture asks:
 * Chromium's PipeWire capturer opens a portal session, and the session's `Start` IS the chooser.
 * The id the display-media handler answers with is not looked at. Measured with the shipping
 * Electron 43.8.1 (harness/linux-share-matrix/app/main.js stage `probe`, sway, frames pulled):
 *
 *   handler answers `screen:0:0` (made up, no listing) ..... 1 ScreenCast.Start, frames flow
 *   handler answers `window:0:0` (made up, no listing) ..... 1 ScreenCast.Start, frames flow
 *   handler lists first (desktopCapturer.getSources), then
 *     answers with the listed source ........................ 2 Start (the listing's chooser, then the capture's own)
 *
 * So the listing is not a way of finding out what to capture, it is a SECOND chooser, and the
 * only way to a single one is not to list: answer the capture with a placeholder and let the
 * capture's own chooser decide. (That counted ScreenCast.Start calls. Counting the DIALOGS from the
 * backend's own log on GNOME later showed a capture answered with a LISTED id carries Chromium's restore
 * token and opens with no dialog, and so does every applyConstraints on it - electron/portal-pick.ts,
 * which uses the listing as the pick where that was measured. Everywhere else this module's placeholder
 * answer stands: one made-up id, one dialog, a capture that is opened once.)
 * This module is that placeholder.
 *
 * What the renderer holds instead of a real source id is a PLACEHOLDER id of its own making
 * (`screen:portal-<nonce>:0`, src/utils/portalSource.ts): a new one each time the user chooses,
 * the same one for as long as the share runs. A different id is how the share code knows "this
 * is another capture" (change of source: one more chooser, acquired while the old share keeps
 * running); the same id is a retune, an audio change or a republish (no chooser). The prefix
 * says nothing about what is shared (nobody knows until the desktop's dialog is answered, and
 * the app never learns it): audio is whatever the picker was told, system audio (everything
 * except Cipherline) or one app's (electron/app-audio.ts).
 *
 * Deliberately free of any `electron` import (portal-source.test.ts).
 */

/** `screen:portal-<nonce>:0`. Mirrored in src/utils/portalSource.ts (a test pins that they agree). */
const PORTAL_SOURCE_RE = /^screen:portal-[0-9a-z]{1,16}:0$/;

export function isPortalSourceId(v: unknown): v is string {
    return typeof v === 'string' && PORTAL_SOURCE_RE.test(v);
}

/** What the placeholder is called in a dialog or a track label: the truth, that it is the desktop's to name. */
export const PORTAL_SOURCE_NAME = 'Screen or window';

/**
 * What Chromium is handed for a placeholder. The id must PARSE as a desktop media id (numeric
 * middle part) or the capture fails before it starts; the portal capturer does not read it.
 *
 * It must also be NEW for every capture. Measured (harness stage `flow-after`, Electron 43.8.1): a
 * second capture answered with the SAME id as a running one attaches to it - no new portal session,
 * so no chooser, and the user's second answer is never asked for: "Change source" would silently keep
 * the old content. With a new id each time every capture is its own session, i.e. exactly one chooser.
 * `seq` is main's own counter of captures it has answered (never the renderer's).
 */
export function portalCaptureVideo(seq: number): { id: string; name: string } {
    const n = 1000 + ((Number.isFinite(seq) ? Math.abs(Math.trunc(seq)) : 0) % 1_000_000);
    return { id: `screen:${n}:0`, name: PORTAL_SOURCE_NAME };
}
