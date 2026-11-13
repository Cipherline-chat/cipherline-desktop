// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const opened = vi.hoisted(() => [] as string[]);
vi.mock('../../utils/openExternalLink', () => ({ openExternalLink: (u: string) => { opened.push(u); return { ok: true }; } }));

import { ProfileActivityRow } from './ProfileActivityRow';
import type { ProfileActivity } from './integrationTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SONG = { kind: 'listening', source: 'spotify', title: 'Human Race', detail: 'Forty Sixth', url: 'https://open.spotify.com/track/x', linkLabel: 'Open Human Race on Spotify' } as ProfileActivity;
const GAME = { kind: 'playing', source: 'game', title: 'BeamNG.drive' } as ProfileActivity;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => { opened.length = 0; host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });
const render = (activities: ProfileActivity[], onOpen = vi.fn(), parentClick = vi.fn()) => {
    act(() => root.render(React.createElement('div', { onClick: parentClick },
        React.createElement(ProfileActivityRow, { activities, variant: 'compact', open: { onOpen, label: "Open Mara's full profile" } }))));
    return { onOpen, parentClick };
};
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

describe('a row on the preview card', () => {
    it('clicking the row opens the full profile and does not go to the song', () => {
        const { onOpen, parentClick } = render([SONG]);
        click(host.querySelector('.pfa-open')!);
        expect(onOpen).toHaveBeenCalledTimes(1);
        expect(opened).toEqual([]);
        expect(parentClick).not.toHaveBeenCalled();
    });

    it('clicking the title goes to the song and does not open the profile', () => {
        const { onOpen, parentClick } = render([SONG]);
        const link = host.querySelector('.pfa-link')!;
        expect(link.textContent).toBe('Human Race');
        click(link);
        expect(opened).toEqual([SONG.url]);
        expect(onOpen).not.toHaveBeenCalled();
        expect(parentClick).not.toHaveBeenCalled();
    });

    it('Enter follows the link from the keyboard; the artist is not part of it', () => {
        const { onOpen } = render([SONG]);
        const link = host.querySelector('.pfa-link') as HTMLElement;
        expect(link.getAttribute('role')).toBe('link');
        expect(link.tabIndex).toBe(0);
        act(() => { link.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
        expect(opened).toEqual([SONG.url]);
        expect(onOpen).not.toHaveBeenCalled();
        expect(link.textContent).not.toContain('Forty Sixth');
    });

    it('a row with nothing to link to still opens the profile, with no link or icon', () => {
        const { onOpen } = render([GAME]);
        expect(host.querySelector('.pfa-link')).toBeNull();
        expect(host.querySelector('[data-testid="profile-activity-ext"]')).toBeNull();
        click(host.querySelector('.pfa-open')!);
        expect(onOpen).toHaveBeenCalledTimes(1);
    });

    it('never puts the URL in the DOM for the browser to act on by itself', () => {
        render([SONG]);
        expect(host.innerHTML).not.toContain(SONG.url);
        expect(host.querySelector('a')).toBeNull();
    });
});
