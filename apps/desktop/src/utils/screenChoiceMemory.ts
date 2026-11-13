import secureLocalStore from './secureLocalStore';
import type { OverlayRect, OverlayShowHint } from './annotationOverlayTypes';
import type { PortalStreamInfo } from './nativeSharePipeline';

/**
 * Remembering the sharer's answer to "Which screen are you sharing?" (Wayland, identical monitors).
 *
 * A stroke on the WRONG monitor is worse than none, so an answer is reused only while it is still provably the answer to the
 * same question:
 *   - the display layout is exactly the one it was given for (main re-checks this against the live displays), and
 *   - the capture is the same one: within one share (an internal restart: quality change, keep-alive, hardware -> normal
 *     fallback, re-publish) or - across shares - only when the portal re-opened our restore token with no chooser at all, so
 *     it can only be the source the person picked last time.
 * When the chooser WAS shown the answer is only preselected; the person still confirms.
 *
 * Device-local (secureLocalStore, per-account encrypted), excluded from backups (services/backupRegistry.ts): a layout and a
 * grant binding describe THIS desktop session.
 */
export const SCREEN_CHOICE_KEY = 'cipherline_annot_screen_choice';

export interface RememberedScreen {
    /** Every display rectangle the sharer was shown. */
    layout: OverlayRect[];
    /** The rectangle they picked. */
    chosen: OverlayRect;
    /** Fingerprint of the portal grant this answer belongs to (native path only); null = no cross-share reuse. */
    grant: string | null;
}

/** Non-cryptographic fingerprint (cyrb53): it only binds an answer to a token without keeping the token's text around. */
export function grantFingerprint(token: string | null | undefined): string | null {
    if (!token) return null;
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < token.length; i++) {
        const c = token.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const int = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
export function cleanRect(raw: unknown): OverlayRect | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    return int(r.x, -100000, 100000) && int(r.y, -100000, 100000) && int(r.width, 1, 65536) && int(r.height, 1, 65536)
        ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
}
export const sameRect = (a: OverlayRect, b: OverlayRect): boolean =>
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/** Same set of rectangles in any order. */
export function sameLayout(a: readonly OverlayRect[], b: readonly OverlayRect[]): boolean {
    if (a.length !== b.length) return false;
    const left = [...b];
    for (const r of a) {
        const i = left.findIndex(o => sameRect(r, o));
        if (i < 0) return false;
        left.splice(i, 1);
    }
    return true;
}

export function loadRememberedScreen(): RememberedScreen | null {
    let raw: string | null = null;
    try { raw = secureLocalStore.getItem(SCREEN_CHOICE_KEY); } catch { return null; }
    if (!raw) return null;
    try {
        const v = JSON.parse(raw) as Record<string, unknown>;
        const chosen = cleanRect(v.chosen);
        const layout = Array.isArray(v.layout) && v.layout.length >= 1 && v.layout.length <= 16 ? v.layout.map(cleanRect) : null;
        if (!chosen || !layout || layout.some(l => l === null)) return null;
        const grant = typeof v.grant === 'string' && /^[0-9a-z]{1,16}$/.test(v.grant) ? v.grant : null;
        return { layout: layout as OverlayRect[], chosen, grant };
    } catch { return null; }
}

export function saveRememberedScreen(r: RememberedScreen): void {
    try { secureLocalStore.setItem(SCREEN_CHOICE_KEY, JSON.stringify(r)); } catch { /* locked store: this share's in-memory answer still works */ }
}
export function forgetRememberedScreen(): void {
    try { secureLocalStore.removeItem(SCREEN_CHOICE_KEY); } catch { /* locked store */ }
}

/** What a native share's portal said, in the shape the overlay controller wants. */
export interface OverlayShareFacts {
    stream: OverlayRect | null;
    /** Set only when the portal re-opened our restore token with no chooser: the fingerprint of that token. */
    silentGrant: string | null;
    /** Fingerprint of the token the NEXT share will offer. */
    nextGrant: string | null;
}
export function overlayFactsFromPortal(ps: PortalStreamInfo | null | undefined): OverlayShareFacts | null {
    if (!ps) return null;
    return {
        stream: ps.rect,
        silentGrant: ps.restoredSilently ? grantFingerprint(ps.offeredToken) : null,
        nextGrant: grantFingerprint(ps.restoreToken),
    };
}

/**
 * The hint to send main for this show, or undefined when there is nothing to say. `carried` is an answer from earlier in this
 * same share (an internal restart); `stored` is the device's last answer, usable only for a silently restored grant.
 */
export function buildShowHint(
    facts: OverlayShareFacts | null,
    carried: { layout: OverlayRect[]; chosen: OverlayRect } | null,
    stored: RememberedScreen | null,
): OverlayShowHint | undefined {
    const hint: OverlayShowHint = {};
    if (facts?.stream) hint.stream = facts.stream;
    const remembered = carried
        ?? (stored && facts?.silentGrant && stored.grant === facts.silentGrant ? { layout: stored.layout, chosen: stored.chosen } : null);
    if (remembered) hint.remembered = remembered;
    return hint.stream || hint.remembered ? hint : undefined;
}

/** For a chooser that IS shown: the display to highlight (never to auto-pick), if the last answer still fits this layout. */
export function preselectFromMemory(
    stored: RememberedScreen | null,
    choice: { displays: Array<OverlayRect & { id: number }>; candidates: number[] },
): number | null {
    if (!stored || !sameLayout(stored.layout, choice.displays)) return null;
    const hits = choice.displays.filter(d => sameRect(d, stored.chosen) && choice.candidates.includes(d.id));
    return hits.length === 1 ? hits[0].id : null;
}
