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
