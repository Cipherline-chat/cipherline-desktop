// ============================================================================
// Origin policy for session.setPermissionRequestHandler.
//
// Pure (no `electron` import) so it is unit-testable. The main window embeds
// third-party frames that the CSP's frame-src allows (YouTube, Stripe,
// Turnstile, Google sign-in); a permission request from one of those frames
// arrives at the same handler as one from our own renderer. Without an origin
// check every frame on the page would be granted the microphone, camera,
// speaker selection and fullscreen that the app itself needs.
//
// Policy (deny by default):
//   * The window's top-level page must be the app's own origin.
//   * media / speaker-selection: only the app origin, only its main frame.
//   * fullscreen: the app origin (any of its own frames), or a whitelisted
//     video embed's frame (YouTube's player calls requestFullscreen from its
//     own iframe — the app renders it with `allowFullScreen`).
//   * everything else: denied.
// ============================================================================

export interface PermissionRequestFacts {
    permission: string;
    /** details.requestingUrl — the URL of the frame that asked. */
    requestingUrl?: string;
    /** details.isMainFrame. */
    isMainFrame?: boolean;
    /** details.securityOrigin (media requests). */
    securityOrigin?: string;
    /** webContents.getURL() — the window's top-level page. */
    topLevelUrl?: string;
}

/** Third-party frames allowed to go fullscreen (embedded video players only). */
export const FULLSCREEN_EMBED_ORIGINS: readonly string[] = ['https://www.youtube-nocookie.com'];

export function originOf(url: string | undefined): string | null {
    if (!url) return null;
    try {
        const o = new URL(url).origin;
        return o === 'null' ? null : o;
    } catch {
        return null;
    }
}

/**
 * The origins the renderer is served from: the Vite dev server in an unpackaged
 * dev run, otherwise the loopback HTTP server main.ts binds for dist/.
 */
export function appOriginsFor(devServerUrl: string | undefined, prodPort: number): string[] {
    if (devServerUrl) {
        const dev = originOf(devServerUrl);
        return dev ? [dev] : [];
    }
    return [`http://127.0.0.1:${prodPort}`];
}

export function decidePermissionRequest(facts: PermissionRequestFacts, appOrigins: readonly string[]): boolean {
    const isApp = (o: string | null) => o !== null && appOrigins.includes(o);

    if (!isApp(originOf(facts.topLevelUrl))) return false;
    const requester = originOf(facts.requestingUrl);

    switch (facts.permission) {
        case 'media': {
            if (facts.isMainFrame === false || !isApp(requester)) return false;
            // securityOrigin is the origin Chromium attributes the capture to;
            // when present it must agree.
            if (facts.securityOrigin !== undefined && facts.securityOrigin !== ''
                && !isApp(originOf(facts.securityOrigin))) return false;
            return true;
        }
        case 'speaker-selection':
            return facts.isMainFrame !== false && isApp(requester);
        case 'fullscreen':
            if (isApp(requester)) return true;
            return facts.isMainFrame === false
                && requester !== null
                && FULLSCREEN_EMBED_ORIGINS.includes(requester);
        default:
            return false;
    }
}

/**
 * Permission CHECKS from a third-party frame that are allowed. Everything else
 * a cross-origin frame (Stripe, Cloudflare Turnstile, the YouTube player, the
 * website) asks about is answered "no".
 *   - fullscreen:  the YouTube embed only (mirrors FULLSCREEN_EMBED_ORIGINS).
 *   - clipboard-sanitized-write: write-only; payment/challenge widgets use it
 *     for "copy" buttons. Reading the clipboard is never allowed to a frame.
 *   - storage-access / top-level-storage-access: Stripe Link and Turnstile may
 *     ask for their own first-party storage inside our page; denying it can
 *     break checkout without protecting anything of ours.
 */
const THIRD_PARTY_CHECKS_ALLOWED: ReadonlySet<string> = new Set([
    'clipboard-sanitized-write',
    'storage-access',
    'top-level-storage-access',
]);

export interface PermissionCheckFacts {
    permission: string;
    /** The origin Electron passes as `requestingOrigin`. */
    requestingOrigin?: string;
    /** details.embeddingOrigin — the top-level origin a subframe is embedded in. */
    embeddingOrigin?: string;
    /** details.isMainFrame. */
    isMainFrame?: boolean;
    /** webContents.getURL(), or undefined when Electron passes no webContents. */
    topLevelUrl?: string;
}

/**
 * setPermissionCheckHandler policy. Without a handler Electron answers every
 * synchronous permission check "yes" for every frame, including third-party
 * iframes (navigator.permissions.query, device-label access, clipboard).
 *
 * The app's own origin keeps that behaviour (it is what the app was built
 * against; its prompts are governed by decidePermissionRequest). A
 * third-party frame inside the app gets only THIRD_PARTY_CHECKS_ALLOWED (plus
 * fullscreen for the YouTube embed). Anything outside an app page gets nothing.
 */
export function decidePermissionCheck(facts: PermissionCheckFacts, appOrigins: readonly string[]): boolean {
    const isApp = (o: string | null) => o !== null && appOrigins.includes(o);
    const requester = originOf(facts.requestingOrigin);
    // With no webContents, fall back to the embedding origin; neither known → deny.
    const top = originOf(facts.topLevelUrl) ?? originOf(facts.embeddingOrigin);
    if (!isApp(top)) return false;
    if (isApp(requester)) return true;
    if (requester === null) return false;
    if (facts.permission === 'fullscreen') return FULLSCREEN_EMBED_ORIGINS.includes(requester);
    return THIRD_PARTY_CHECKS_ALLOWED.has(facts.permission);
}
