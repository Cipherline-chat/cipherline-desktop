import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { statusDotFill, statusShape, STATUS_BACKING, STATUS_CONFIG, type UserStatus } from './userStatusModel';
import { StatusDot, StatusIcon } from '../components/StatusIcon';
import { HomeStatusDot } from '../components/HomeStatusDot';

const h = React.createElement;
const html = (el: React.ReactElement) => renderToStaticMarkup(el);
const STATUSES: UserStatus[] = ['online', 'away', 'dnd', 'offline'];

describe('status shapes (plan D12): status never relies on colour alone', () => {
    it('each status has its own shape: dot / crescent / minus / ring', () => {
        expect(STATUSES.map(statusShape)).toEqual(['dot', 'crescent', 'minus', 'ring']);
        expect(new Set(STATUSES.map(statusShape)).size).toBe(4);
    });
    it('the four fills are pairwise different even in ONE colour (greyscale test)', () => {
        const fills = STATUSES.map(s => statusDotFill(s, '#888888'));
        expect(new Set(fills).size).toBe(4);
    });
    it('online is the plain colour (a filled dot)', () => {
        expect(statusDotFill('online', '#4ADE80')).toBe('#4ADE80');
    });
    it('idle punches a disc out of the dot; offline is hollow; DND carries a minus bar in the theme dot-hole colour (black on Dark, white on Light)', () => {
        expect(statusDotFill('away', '#FFC94D')).toMatch(/radial-gradient\(ellipse[^)]*at 72% 28%, transparent/);
        expect(statusDotFill('offline', '#5E6B8F')).toMatch(/radial-gradient\(circle closest-side, transparent 0 46%/);
        expect(statusDotFill('dnd', '#FF6B5E')).toMatch(/^linear-gradient\(var\(--cl-dot-hole\), var\(--cl-dot-hole\)\) 50% 50% \/ 64% 24% no-repeat, #FF6B5E$/);
    });
    it('every shape still carries its status colour', () => {
        for (const s of STATUSES) expect(statusDotFill(s, STATUS_CONFIG[s].color)).toContain(STATUS_CONFIG[s].color);
    });
    it('an unknown or missing status is the plain dot', () => {
        expect(statusShape(undefined)).toBe('dot');
        expect(statusShape('mystery')).toBe('dot');
        expect(statusDotFill(undefined, '#123456')).toBe('#123456');
    });
});

describe('the shared dot components draw the shape', () => {
    it.each(STATUSES)('StatusDot %s carries data-status-shape and the shaped background', (s) => {
        const out = html(h(StatusDot, { status: s }));
        expect(out).toContain(`data-status-shape="${statusShape(s)}"`);
        expect(out).toContain('border-radius:50%');
    });
    it('StatusIcon (member list, DMs, friends, picker) goes through StatusDot', () => {
        for (const s of STATUSES) {
            expect(html(h(StatusIcon, { status: s }))).toContain(`data-status-shape="${statusShape(s)}"`);
        }
    });
    it('the Home deck dot is shaped too (it kept its own plain colour before)', () => {
        expect(html(h(HomeStatusDot, { status: 'away' }))).toContain('transparent');
        expect(html(h(HomeStatusDot, { status: 'offline' }))).toContain('transparent');
        expect(html(h(HomeStatusDot, { status: 'dnd' }))).toContain('linear-gradient');
    });
    it('the phone glyph keeps its own shape', () => {
        expect(html(h(StatusDot, { status: 'online', onMobile: true }))).toContain('status-mobile-glyph');
    });
});

describe('status shapes sit on a solid backing disc (never the avatar)', () => {
    const LAST_LAYER = (fill: string) => fill.slice(fill.lastIndexOf('), ') + 3);
    it('the backing is the --status-backing token, --cl-deep when a context sets nothing', () => {
        expect(STATUS_BACKING).toBe('var(--status-backing, var(--cl-deep))');
    });
    it('the crescent bite and the offline ring hole are painted over the backing, as the LAST (solid) layer', () => {
        for (const s of ['away', 'offline'] as const) {
            const fill = statusDotFill(s, '#888888');
            expect(LAST_LAYER(fill)).toBe(STATUS_BACKING);
            // the cut-out is still transparent WITHIN its own gradient: the layer under it is what shows
            expect(fill).toContain('transparent');
        }
    });
    it('online and DND are fully opaque and need no backing layer', () => {
        expect(statusDotFill('online', '#4ADE80')).not.toContain('--status-backing');
        expect(statusDotFill('dnd', '#FF6B5E')).not.toContain('--status-backing');
    });
    it('positive control: without the backing layer a bite WOULD be see-through (the pre-fix fill)', () => {
        const prefix = statusDotFill('away', '#888888').replace(`, ${STATUS_BACKING}`, '');
        expect(prefix).not.toContain('--status-backing');
        expect(statusDotFill('away', '#888888')).not.toBe(prefix);
    });
    it.each(['away', 'offline'] as const)('the rendered %s dot carries the backing in its inline background', (s) => {
        expect(html(h(StatusDot, { status: s }))).toContain('var(--status-backing, var(--cl-deep))');
        expect(html(h(HomeStatusDot, { status: s }))).toContain('var(--status-backing, var(--cl-deep))');
    });
});

describe('each context sets --status-backing to ITS surface (and the ring reads the same var)', () => {
    const css = (f: string) => readFileSync(join(__dirname, '..', 'styles', f), 'utf8');
    const tsx = (f: string) => readFileSync(join(__dirname, '..', 'components', f), 'utf8');
    it('friends list, people picker, profile card and Home deck set it from their own surface', () => {
        expect(css('friends-pane.css')).toMatch(/\.fp-presence \{[^}]*--status-backing: var\(--fp-ring\)/);
        expect(css('people-picker.css')).toMatch(/\.pp-presence\{[^}]*--status-backing:var\(--pp-row-bg\)/);
        expect(css('profile-card.css')).toMatch(/\.pcd-dot \{[^}]*--status-backing: var\(--pcd-ring\)[^}]*0 0 0 4px var\(--status-backing\)/);
        expect(css('home-deck.css')).toMatch(/\.hd-av \{[^}]*--status-backing: var\(--hd-backing, var\(--cl-sink\)\)/);
        expect(css('home-deck.css')).toMatch(/\.hd-row:hover \{[^}]*--hd-backing:/);
    });
    it('hovered / selected rows update the backing (DM list, member list, group members)', () => {
        const dash = tsx('Dashboard.tsx');
        expect(dash).toContain("'bg-cl-surface cl-row-active [--status-backing:var(--cl-surface)]' : 'hover:bg-cl-surface hover:[--status-backing:var(--cl-surface)]'");
        expect(dash).toContain('hover:bg-white/5 hover:[--status-backing:color-mix(');
        const scp = tsx('server/ServerContextPanel.tsx');
        expect(scp).toContain('hover:bg-white/[0.04] [--status-backing:var(--cl-abyss)] hover:[--status-backing:color-mix(');
        expect(scp).toContain("const dotRing = 'border-[color:var(--status-backing,var(--cl-abyss))]'");
    });
    it('high contrast keeps the ring in the backing colour', () => {
        expect(css('theme-contrast.css')).toContain('[data-status-shape] { box-shadow: 0 0 0 2px var(--status-backing, var(--cl-deep)); }');
    });
});
