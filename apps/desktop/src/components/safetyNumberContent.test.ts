import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * A friend could crash desktop remotely (2026-09-24, found by the mobile
 * safety-number port). Nothing validated `ClientContent{type:'safety_number'}`
 * before `SafetyNumberEmbed` ran `formatCode((code || '').toUpperCase())`,
 * which throws for a numeric or object `code`; only the root error boundary
 * caught it, so the whole app dropped to the error screen every time that chat
 * rendered. The payload is attacker-shaped: any contact can send one.
 *
 * Rendered with react-dom/server — this app's vitest has no DOM — which runs
 * render and useMemo (where the throw was) but not effects.
 */
vi.mock('../utils/keyVerification', () => ({ getKnownDevices: () => ({}), markVerified: () => {} }));
// Import-time browser probes in the embed's dependency tree: axios reads
// window.location, the cl physics module asks matchMedia for reduced motion.
if (!(window as { location?: unknown }).location) {
    Object.assign(window, { location: { href: 'http://localhost/', origin: 'http://localhost' } });
}
if (typeof (window as { matchMedia?: unknown }).matchMedia !== 'function') {
    Object.assign(window, { matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) });
}

const { SafetyNumberEmbed } = await import('./SafetyNumberEmbed');
const { contentProblem, safetyNumberProblem, parseSafetyNumberContent, SAFETY_NUMBER_CODE_MAX_LENGTH } =
    await import('../utils/contentValidation');

const render = (code: unknown, extra: Record<string, unknown> = {}) => renderToStaticMarkup(
    React.createElement(SafetyNumberEmbed, {
        code: code as string,
        claimedUserId: 'bob',
        senderUserId: 'bob',
        myUserId: 'me',
        senderName: 'Bob',
        token: null,
        ...extra,
    }),
);

const GOOD = { type: 'safety_number', user_id: 'bob', code: 'ABCDEFGHJKMNPQRSTVWXYZ0123456789ABCDEFGH', device_count: 2 };

describe('SafetyNumberEmbed survives a hostile stored row', () => {
    it.each([
        ['a number', 42],
        ['an object', { toUpperCase: 'nope' }],
        ['an array', ['A', 'B']],
        ['null', null],
    ])('renders (does not throw) when code is %s', (_label, code) => {
        expect(() => render(code)).not.toThrow();
        expect(render(code)).toContain('couldn’t be shown');
    });

    it('still renders a real code in groups', () => {
        const html = render(GOOD.code);
        expect(html).toContain('>ABCD<');
        expect(html).not.toContain('couldn’t be shown');
    });
});

describe('contentProblem — the content boundary', () => {
    it('accepts a well-formed safety_number (device_count optional)', () => {
        expect(contentProblem(GOOD)).toBeNull();
        const noCount: Record<string, unknown> = { ...GOOD };
        delete noCount.device_count;
        expect(contentProblem(noCount)).toBeNull();
    });

    it.each([
        ['numeric code', { ...GOOD, code: 42 }],
        ['object code', { ...GOOD, code: { a: 1 } }],
        ['empty code', { ...GOOD, code: '' }],
        ['over-long code', { ...GOOD, code: 'A'.repeat(SAFETY_NUMBER_CODE_MAX_LENGTH + 1) }],
        ['missing user_id', { ...GOOD, user_id: undefined }],
        ['numeric user_id', { ...GOOD, user_id: 7 }],
        ['string device_count', { ...GOOD, device_count: '2' }],
    ])('rejects a safety_number with %s', (_label, c) => {
        expect(safetyNumberProblem(c as Record<string, unknown>)).not.toBeNull();
        expect(contentProblem(c)).not.toBeNull();
        expect(parseSafetyNumberContent(c)).toBeNull();
    });

    it.each([
        ['a number', 42], ['null', null], ['an array', []], ['no type', { text: 'hi' }], ['a numeric type', { type: 5 }],
    ])('rejects content that is %s', (_label, c) => {
        expect(contentProblem(c)).not.toBeNull();
    });

    it('leaves other variants alone (it is not a general schema)', () => {
        expect(contentProblem({ type: 'text', text: 'hi' })).toBeNull();
        expect(contentProblem({ type: 'some_future_type' })).toBeNull();
    });

    it('parseSafetyNumberContent returns only what the card needs — never an outcome field', () => {
        expect(parseSafetyNumberContent({ ...GOOD, verified: true })).toEqual({
            claimedUserId: 'bob', code: GOOD.code, deviceCount: 2,
        });
    });
});

describe('every decode path checks the content before storing or rendering it', () => {
    const code = (file: string) => readFileSync(join(__dirname, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    const dash = code('Dashboard.tsx');
    const chat = code('ChatPane.tsx');

    it('the DM pull loop stores a placeholder for malformed content', () => {
        const loop = dash.slice(dash.indexOf('const pullMessagesOnce = React.useCallback'), dash.indexOf('const pullMessages = React.useCallback'));
        expect(loop).toContain('contentProblem(content)');
        expect(loop).toContain("keepPlaceholder(env, 'malformed')");
    });

    it('both channel decode paths (live and history) check it too', () => {
        expect(dash.match(/contentProblem\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    });

    it('ChatPane renders the embed only from a re-validated row', () => {
        expect(chat).toContain('parseSafetyNumberContent(msg.content)');
    });
});
