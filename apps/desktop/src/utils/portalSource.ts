/**
 * The share "source" when the capture goes through the desktop's portal (Linux Wayland).
 * Read electron/portal-source.ts first: on the portal the thing shared is chosen in the desktop's
 * own chooser WHILE the capture starts, so there is nothing to list and nothing to name before
 * it. The picker hands the share a placeholder id instead, and a NEW one each time the user
 * chooses - that difference is how a change of source is told from a retune.
 *
 *   `screen:portal-<nonce>:0`
 *
 * Mirrored in electron/portal-source.ts (main admits only ids of this shape on the portal); a
 * test pins that the two agree.
 */

const PORTAL_SOURCE_RE = /^screen:portal-[0-9a-z]{1,16}:0$/;

let counter = 0;

/** A new placeholder for one "Choose what to share…". Unique per call in this renderer. */
export function newPortalSourceId(nonce?: string): string {
    const n = nonce ?? `${Date.now().toString(36)}${(counter++).toString(36)}`;
    return `screen:portal-${n}:0`;
}

export function isPortalSourceId(v: unknown): v is string {
    return typeof v === 'string' && PORTAL_SOURCE_RE.test(v);
}
