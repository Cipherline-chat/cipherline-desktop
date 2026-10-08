/**
 * Message contract between the desktop app and the website-hosted Turnstile
 * page (apps/website/public/turnstile-embed.js). See components/TurnstileFrame.tsx
 * for why the widget is hosted rather than rendered in the app.
 */

/** Where the hosted widget page lives — the only origin the app listens to. */
export const TURNSTILE_EMBED_ORIGIN = 'https://cipherline.chat';

export type TurnstileMessage =
    | { type: 'ready' }
    | { type: 'token'; token: string }
    | { type: 'expire' }
    | { type: 'error'; code: string };

/** Site keys are public, but only ever interpolate a well-formed one into a URL. */
const SITE_KEY_RE = /^0x[A-Za-z0-9_-]{8,64}$/;

export function buildTurnstileEmbedUrl(siteKey: string, parentOrigin: string, theme: 'dark' | 'light'): string {
    const q = new URLSearchParams({
        k: SITE_KEY_RE.test(siteKey) ? siteKey : '',
        o: parentOrigin,
        t: theme,
    });
    return `${TURNSTILE_EMBED_ORIGIN}/turnstile-embed.html?${q.toString()}`;
}

/** Strictly validate a message payload; anything unexpected is null (ignored). */
export function parseTurnstileMessage(data: unknown): TurnstileMessage | null {
    if (!data || typeof data !== 'object') return null;
    const d = data as Record<string, unknown>;
    if (d.source !== 'cl-turnstile') return null;
    switch (d.type) {
        case 'ready':
        case 'expire':
            return { type: d.type };
        case 'token':
            // Turnstile tokens are long opaque strings; bound it so a hostile
            // payload can't push a megabyte string into the register request.
            return typeof d.token === 'string' && d.token.length > 0 && d.token.length <= 4096
                ? { type: 'token', token: d.token }
                : null;
        case 'error':
            return { type: 'error', code: typeof d.code === 'string' ? d.code.slice(0, 32) : '' };
        default:
            return null;
    }
}
