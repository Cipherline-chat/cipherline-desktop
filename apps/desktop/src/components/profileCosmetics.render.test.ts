// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { AvatarDecoration, ProfileEffect } from './ProfileCosmetics';
import { ProfileCardVerified, ProfileCardWidgets } from './ProfileCardParts';
import { AVATAR_DECORATIONS, PROFILE_EFFECTS } from '../utils/profileCosmetics';

const h = React.createElement as (...a: any[]) => React.ReactElement;
const html = (n: React.ReactElement) => renderToStaticMarkup(n);
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf8');

describe('decoration + effect art', () => {
    it('every catalog id has art (and nothing else does)', () => {
        for (const d of AVATAR_DECORATIONS) expect(html(h(AvatarDecoration, { decoration: d.id }, 'x'))).toContain(`data-decoration="${d.id}"`);
        for (const e of PROFILE_EFFECTS) expect(html(h(ProfileEffect, { effect: e.id }))).toContain(`data-effect="${e.id}"`);
        expect(html(h(AvatarDecoration, { decoration: '__proto__' }, 'x'))).not.toContain('data-decoration');
        expect(html(h(ProfileEffect, { effect: 'constructor' }))).toBe('');
    });
    it('a decoration wraps the avatar; an unknown or absent one renders it untouched', () => {
        const child = h('i', { id: 'av' });
        expect(html(h(AvatarDecoration, { decoration: 'lume-ring' }, child))).toMatch(/data-decoration="lume-ring"[\s\S]*<svg/);
        for (const d of [null, undefined, 'unknown-future-id']) {
            const out = html(h(AvatarDecoration, { decoration: d }, child));
            expect(out).toContain('id="av"');
            expect(out).not.toContain('<svg');
        }
    });
    it('Keys decorations draw the mascot behind the avatar; rings draw in front', () => {
        expect(html(h(AvatarDecoration, { decoration: 'keys-peek' }, 'x'))).toContain('pc-deco-back');
        expect(html(h(AvatarDecoration, { decoration: 'lume-ring' }, 'x'))).toContain('pc-deco-front');
        const crown = html(h(AvatarDecoration, { decoration: 'keys-crown' }, 'x'));
        expect(crown).toMatch(/pc-deco-back[\s\S]*pc-deco-front/);
    });
    it('decorations are decorative: hidden from assistive tech, never take the pointer', () => {
        const out = html(h(AvatarDecoration, { decoration: 'keys-crown' }, 'x'));
        expect(out).toContain('aria-hidden="true"');
        expect(read('../styles/profile-cosmetics.css')).toMatch(/\.pc-deco-art\s*\{[^}]*pointer-events:\s*none/);
    });
    it('an effect is an inert overlay; unknown renders nothing', () => {
        const out = html(h(ProfileEffect, { effect: 'bubbles' }));
        expect(out).toContain('data-effect="bubbles"');
        expect(out).toContain('aria-hidden="true"');
        expect(html(h(ProfileEffect, { effect: 'nope' }))).toBe('');
        expect(html(h(ProfileEffect, { effect: null }))).toBe('');
    });
    it('effects are deterministic (same markup twice)', () => {
        expect(html(h(ProfileEffect, { effect: 'confetti' }))).toBe(html(h(ProfileEffect, { effect: 'confetti' })));
    });
});

describe('motion rules (CSS contract)', () => {
    const css = read('../styles/profile-cosmetics.css');
    // Every class that carries an animation (`.pc-x { ... animation: ... }`).
    const animated = [...css.matchAll(/^\.(pc-[\w-]+)\s*\{[^}]*\banimation:/gm)].map((m) => `.${m[1]}`);
    /** `@keyframes name { ... }` with its (one-level nested) body. */
    const keyframes = [...css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g)];
    it('found the animated classes and keyframes (guards the parsers)', () => {
        expect(animated.length).toBeGreaterThanOrEqual(12);
        expect(keyframes.length).toBeGreaterThanOrEqual(12);
    });
    it('prefers-reduced-motion switches every animation off', () => {
        const block = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
        expect(block).toMatch(/animation:\s*none/);
        for (const c of animated) expect([c, block.includes(c)]).toEqual([c, true]);
    });
    it("a window that is not in front (data-cl-window=inactive) pauses every loop; input idleness does not", () => {
        const block = /:root\[data-cl-window="inactive"\]([\s\S]*?)\{\s*animation-play-state:\s*paused/.exec(css)?.[1] ?? "";
        expect(css).not.toMatch(/:root\[data-cl-motion="idle"\][^{]*\{\s*animation-play-state:\s*paused/);
        for (const c of animated) expect([c, block.includes(c)]).toEqual([c, true]);
    });
    it('only cheap properties are animated (transform, opacity, stroke-dashoffset)', () => {
        for (const [, name, body] of keyframes) {
            const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
            for (const p of props) expect([name, p]).toEqual([name, expect.stringMatching(/^(transform|opacity|stroke-dashoffset)$/)]);
        }
    });
    it('effects are card-only: the lists never import the effect layer', () => {
        for (const rel of ['./FriendsPane.tsx', './StatusPicker.tsx', './EncryptedAvatar.tsx']) {
            expect(read(rel)).not.toMatch(/ProfileEffect/);
        }
    });
});

describe('card parts', () => {
    it('the egg showcase is retired: the card parts no longer name eggs', () => {
        expect(read('./ProfileCardParts.tsx')).not.toMatch(/ProfileCardEggShowcase|title="Eggs found"/);
    });
    it('widgets: games render as chips, text is escaped, empty renders nothing', () => {
        const out = html(h(ProfileCardWidgets, { widgets: { games: ['Hades', '<b>x</b>'] } }));
        expect(out).toContain('Hades');
        expect(out).toContain('&lt;b&gt;x&lt;/b&gt;');
        expect(out).not.toContain('<b>x</b>');
        expect(html(h(ProfileCardWidgets, { widgets: { games: [] } }))).toBe('');
        expect(html(h(ProfileCardWidgets, { widgets: null }))).toBe('');
    });
    it('widgets show the friends-only lock when asked', () => {
        expect(html(h(ProfileCardWidgets, { widgets: { games: ['Hades'] }, friendsOnly: true }))).toContain('data-friends-only');
    });
    it('verified mark says exactly what the owner asked for', () => {
        expect(html(h(ProfileCardVerified))).toContain('You verified their safety number');
    });
});

describe('verified mark is local-only', () => {
    const modal = read('./ProfileModal.tsx');
    it('is derived from the on-device pin store, not from the profile response', () => {
        expect(modal).toMatch(/getVerificationState\(currentUserId, userId\) === 'verified'/);
        expect(modal).toMatch(/!isOwnProfile/);
    });
    it('never leaves the device: the key-verification module makes no network calls', () => {
        const kv = read('../utils/keyVerification.ts');
        expect(kv).not.toMatch(/axios|fetch\(|XMLHttpRequest|API_BASE/);
    });
});
