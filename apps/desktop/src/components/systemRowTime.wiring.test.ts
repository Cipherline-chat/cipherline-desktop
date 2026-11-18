import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Owner, 2026-11-18: hovering a system row (member joined/left/kicked/banned, plain system lines, call bars) shows
// when it happened. Pinned at the source: each of the three pills renders the hover label and a full-date title.
const pane = readFileSync(resolve(__dirname, 'ChatPane.tsx'), 'utf8');

describe('system rows show their time on hover', () => {
    it('builds the label from systemRowTime, inside the pill, only on hover or focus', () => {
        expect(pane).toMatch(/const sysTime = systemRowTime\(msgMs\);/);
        expect(pane).toMatch(/data-system-row-time[\s\S]{0,120}className="hidden group-hover:inline group-focus-within:inline/);
    });
    it('the member-event, plain system and call pills each carry it, plus the full date as a title', () => {
        expect(pane.match(/\{SysTimeLabel\}/g)?.length).toBe(3);
        expect(pane).not.toMatch(/flex-wrap justify-center min-w-0 max-w-full/);
        expect(pane.match(/title=\{sysTime\?\.full\}/g)?.length).toBe(3);
    });
    it('every row that carries it is a hover group', () => {
        expect(pane).toMatch(/data-system-row="member-event"\s+className="group /);
        expect(pane).toMatch(/className="group flex items-center gap-3 my-2 px-4 select-none" data-system-row="call"/);
        expect(pane).toMatch(/<div className="group flex items-center gap-3 my-2 px-4 select-none">\s*<div className="flex-1 h-px/);
    });
});
