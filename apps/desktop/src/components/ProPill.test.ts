import { describe, it, expect } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProPill } from './ProPill';

// .ts (not .tsx): vitest here only collects *.test.ts, so no JSX.
const h = React.createElement;
const html = (props: React.ComponentProps<typeof ProPill>) => renderToStaticMarkup(h(ProPill, props));

/** "YYYY-MM" for `n` calendar months before now (UTC, as the server cuts it). */
function monthsAgo(n: number): string {
    const d = new Date();
    const total = d.getUTCFullYear() * 12 + d.getUTCMonth() - n;
    return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

describe('ProPill', () => {
    it('with pro_since: a focusable, named badge carrying the "member since" text', () => {
        const out = html({ proSince: monthsAgo(7) });
        expect(out).toContain('data-testid="pro-pill"');
        expect(out).toContain('tabindex="0"');
        expect(out).toContain('role="img"');
        expect(out).toMatch(/aria-label="Pro member since [A-Z][a-z]+ \d{4} [^"]*7 months"/);
        expect(out).toContain('Pro</span>'); // the visible label is unchanged
    });

    it('a brand-new member reads "less than a month"', () => {
        expect(html({ proSince: monthsAgo(0) })).toContain('less than a month');
    });

    it('a 13-month member reads "1 year, 1 month"', () => {
        expect(html({ proSince: monthsAgo(13) })).toContain('1 year, 1 month');
    });

    it("CONTROL - without pro_since (older server / null / malformed): today's pill, no tab stop, no tooltip wiring", () => {
        for (const proSince of [undefined, null, '', 'nonsense', '2026-03-17']) {
            const out = html({ proSince });
            expect(out).not.toContain('data-testid="pro-pill"');
            expect(out).not.toContain('tabindex');
            expect(out).not.toContain('aria-label');
            expect(out).toContain('rolet gold');
            expect(out).toContain('Pro');
        }
    });

    it('the pill itself is the same gold role chip in both modes', () => {
        expect(html({ proSince: monthsAgo(3) })).toContain('rolet gold');
    });
});

describe('every place the Pro badge renders goes through ProPill', () => {
    const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

    it('ProfileCardNameRow (profile card for others, and your own card) passes proSince through', () => {
        const src = read('./ProfileCardParts.tsx');
        expect(src).toMatch(/<ProPill proSince=\{proSince\} \/>/);
        expect(src).not.toMatch(/variant="gold"/); // no second, tip-less Pro pill left behind
    });

    it('ProfileModal feeds the API field to the card, whose Pro medallion carries the same "member since" tip', () => {
        expect(read('./ProfileModal.tsx')).toMatch(/proSince: profile\.pro_since/);
        expect(read('./profile/ProfilePopoutCard.tsx')).toMatch(/proSince=\{data\.proSince\}/);
        expect(read('./profile/ProfileFullView.tsx')).toMatch(/proSince=\{data\.proSince\}/);
        const badges = read('./ProfileBadgeRow.tsx');
        expect(badges).toMatch(/formatProSinceTooltip\(proSince\)/);
        expect(badges).toContain('testId="pro-badge"');
    });

    it('the Settings > Profile identity card (yourself) uses ProPill with the fetched value', () => {
        const src = read('./settings/panes/ProfilePane.tsx');
        expect(src).toMatch(/<ProPill proSince=\{isPro \? proSince : null\}/);
        expect(src).not.toMatch(/variant="gold"/);
    });

    it('the public-profile type carries the optional field', () => {
        expect(read('../utils/profileCache.ts')).toMatch(/pro_since\?: string \| null/);
    });
});
