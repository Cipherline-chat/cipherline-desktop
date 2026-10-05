import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-level guards for the broken-avatar path.
 *
 * Same idiom and the same reason as avatarWarmingWiring.test.ts: the vitest
 * environment here is 'node' with no DOM and no render harness, so there is no
 * way to actually mount an <img> and fire its error event. What CAN be pinned
 * is the two-line contract that made a broken avatar user-visible and
 * self-perpetuating, both of which are one careless edit away from returning.
 */

const source = readFileSync(join(__dirname, 'EncryptedAvatar.tsx'), 'utf8');

describe('a broken avatar never renders literal text', () => {
    it('gives the <img> an EMPTY alt', () => {
        // A browser paints alt text as body copy when the image fails to
        // decode. With alt="Avatar" that surfaced in the running app as a bare,
        // uninterpretable "Avatar" line sitting where a face should be — and at
        // FULL opacity in exactly the common case, because a synchronous
        // memory-cache hit sets `instant` and skips the opacity-0 guard that
        // hides the async path's alt text.
        expect(source).toContain('alt=""');
        expect(source).not.toContain('alt="Avatar"');
    });

    it('has no other non-empty alt on the component', () => {
        const alts = [...source.matchAll(/\balt=(?:"([^"]*)"|\{([^}]*)\})/g)];
        expect(alts.length).toBeGreaterThan(0);
        for (const m of alts) {
            expect(m[1] ?? m[2]).toBe('');
        }
    });
});

describe('a broken avatar does not re-enter the <img> forever', () => {
    // evictAvatar() revokes the object URL and deletes the IndexedDB blob, so
    // the very next resolve mints a BRAND-NEW blob URL for the same attachment.
    // A guard remembering the failed URL therefore never matches again: the
    // <img> re-renders, fails, evicts and re-downloads, spending two API
    // requests per turn and keeping the broken image on screen throughout. The
    // attachment id is the stable identity across those remints.
    it('remembers the failed ATTACHMENT ID, not the blob URL', () => {
        expect(source).toContain('broken !== attachmentId');
        expect(source).not.toContain('broken !== avatarUrl');
    });

    it('stores the attachment id in the error handler, not the URL', () => {
        const onError = source.slice(source.indexOf('onError={'));
        const body = onError.slice(0, onError.indexOf('}}') + 2);
        expect(body).toContain('setBroken(attachmentId');
        expect(body).not.toContain('setBroken(avatarUrl)');
        // Evicting is what forces the next load back to the network; without it
        // the same bad bytes are re-served from cache forever.
        expect(body).toContain('evictAvatar(attachmentId)');
    });
});
