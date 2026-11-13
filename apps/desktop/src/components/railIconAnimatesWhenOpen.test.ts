import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Rail icons: a still unless it is the server you are in, or hovered (ServerIcon's own hover). */
const dash = readFileSync(join(__dirname, 'Dashboard.tsx'), 'utf8');
const icon = readFileSync(join(__dirname, 'server/ServerIcon.tsx'), 'utf8');

describe('animated server icons in the rail', () => {
    it('the rail tile plays only for the server you are in', () => {
        expect(dash).toMatch(/<ServerIcon\s+serverId=\{srv\.server_id\}[\s\S]{0,900}?animate=\{isActive\}/);
    });

    it('so does an icon in an open rail folder', () => {
        expect(dash).toContain('animate={s.server_id === activeRailServerId}');
    });

    it('no other server icon in Dashboard is told to always play', () => {
        const always = [...dash.matchAll(/<ServerIcon\b[^>]*?\sanimate(\s|\/|>)/g)];
        expect(always).toEqual([]);
    });

    it('every other icon still plays on hover, and only while the app is in front when told to', () => {
        expect(icon).toContain('animate || hovered || playing');
    });
});
