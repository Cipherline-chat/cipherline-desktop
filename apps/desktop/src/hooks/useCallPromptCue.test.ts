// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const h = vi.hoisted(() => ({ played: [] as unknown[][], prefs: { sounds_enabled: true } as unknown }));
vi.mock('../utils/notificationSounds', () => ({ playSound: (...a: unknown[]) => h.played.push(a) }));
vi.mock('../contexts/NotificationContext', () => ({ useNotificationPrefsSafe: () => ({ prefs: h.prefs }) }));

import { useCallPromptCue } from './useCallPromptCue';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const Probe: React.FC<{ open: boolean; tick?: number }> = ({ open }) => { useCallPromptCue(open); return null; };

describe('useCallPromptCue', () => {
    beforeEach(() => { h.played.length = 0; });

    it('plays once when a card opens, through the prefs, and again only on the next opening', async () => {
        const root = createRoot(document.createElement('div'));
        await act(async () => { root.render(React.createElement(Probe, { open: false })); });
        expect(h.played).toEqual([]);
        await act(async () => { root.render(React.createElement(Probe, { open: true })); });
        expect(h.played).toEqual([['call_prompt', h.prefs]]);
        // A re-render with the card still up is not a new prompt.
        await act(async () => { root.render(React.createElement(Probe, { open: true, tick: 1 })); });
        expect(h.played).toHaveLength(1);
        await act(async () => { root.render(React.createElement(Probe, { open: false })); });
        expect(h.played).toHaveLength(1);
        await act(async () => { root.render(React.createElement(Probe, { open: true })); });
        expect(h.played).toHaveLength(2);
        await act(async () => { root.unmount(); });
    });

    it('every card that asks for a decision uses it, and the card that asks nothing does not', () => {
        const read = (f: string) => readFileSync(resolve(__dirname, '../components/call', f), 'utf8');
        expect(read('ShareOverloadOffer.tsx')).toContain('useCallPromptCue(cue && !anchor.held)');
        expect(read('CallPerformanceGuard.tsx')).toContain('useCallPromptCue(offerOpen && !anchor.held)');
        expect(read('GamingVideoGuard.tsx')).toContain('useCallPromptCue(offerOpen && !mode.enabled && !anchor.held)');
        expect(read('CallMilestones.tsx')).not.toContain('useCallPromptCue');
    });
});
