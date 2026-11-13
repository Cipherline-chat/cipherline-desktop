// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('../../utils/openExternalLink', () => ({ openExternalLink: () => ({ ok: true }) }));

import { ProfileActivityRow } from './ProfileActivityRow';
import type { ProfileActivity } from './integrationTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GAME = { kind: 'playing', source: 'game', title: 'BeamNG.drive' } as ProfileActivity;
const MUSIC = { kind: 'listening', source: 'spotify', title: 'Hold My Breath', detail: 'Arlo' } as ProfileActivity;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const render = (activities: ProfileActivity[], variant: 'compact' | 'full') =>
    act(() => root.render(React.createElement(ProfileActivityRow, { activities, variant })));

describe('the profile card shows a game and music together', () => {
    it('compact: both get a row, game first, music right below, and no "+1 more"', () => {
        render([GAME, MUSIC], 'compact');
        const rows = [...host.querySelectorAll('.pfa-row')];
        expect(rows.length).toBe(2);
        expect(rows[0].textContent).toContain('BeamNG.drive');
        expect(rows[1].textContent).toContain('Hold My Breath');
        expect(rows[1].textContent).toContain('Listening to');
        expect(host.textContent).not.toMatch(/more/);
    });

    it('compact: the music row is the same row it is with no game running', () => {
        render([MUSIC], 'compact');
        const alone = host.querySelector('.pfa-row')!.innerHTML;
        render([GAME, MUSIC], 'compact');
        expect(host.querySelectorAll('.pfa-row')[1].innerHTML).toBe(alone);
    });

    it('nothing going on renders nothing', () => {
        render([], 'compact');
        expect(host.querySelector('[data-testid="profile-activity"]')).toBeNull();
    });
});
