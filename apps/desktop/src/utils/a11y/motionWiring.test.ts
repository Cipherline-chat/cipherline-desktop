/**
 * Celebrations and effects: every celebration / mascot-idle / ambient host must
 * read the one switch, and calls / screen share / video must not.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

const GATED: [string, RegExp][] = [
    ['components/ProWelcome.tsx', /celebrationReducedNow/],
    ['components/billing/gifts/GiftBox.tsx', /useCelebrationReduced/],
    ['components/billing/gifts/GiftCardEmbed.tsx', /useCelebrationReduced/],
    ['components/HighFiveOverlay.tsx', /celebrationReducedNow/],
    ['components/Dashboard.tsx', /celebrationReducedNow\(\)\) return;\s*setFirstFriendCelebration/],
    ['components/EggLayer.tsx', /celebrationReducedNow/],
    ['components/levelUp/LevelUpHost.tsx', /celebrationReducedNow/],
    ['components/moments/MomentHost.tsx', /celebrationReducedNow/],
    ['components/mascot/Keys.tsx', /celebrationReducedNow/],
    ['components/mascot/HomeKeys.tsx', /celebrationReducedNow/],
    ['components/billing/BillingTab.tsx', /celebrationReducedNow/],
    ['components/AuthScreen.tsx', /celebrationReducedNow/],
    ['components/OnboardingChecklist.tsx', /useEffectsEnabled/],
    ['components/SeasonalLayer.tsx', /useEffectsEnabled/],
    ['components/HomeAmbient.tsx', /useEffectsEnabled/],
    ['components/settings/SeaBackdrop.tsx', /useAmbientActive/],
    ['components/server/DockBackdrop.tsx', /useAmbientActive/],
    ['hooks/useAmbientMotion.ts', /m\.effects && !m\.reduced/],
    ['components/HomePanel.tsx', /ambientPref && effectsOn/],
];

describe('celebration gating is wired', () => {
    it.each(GATED)('%s reads the effects switch', (file, re) => {
        expect(read(file)).toMatch(re);
    });

    it('the ping pill float is dropped under data-effects="off" (and the pill itself stays)', () => {
        const css = read('styles/rail-ping-arrows.css');
        expect(css).toMatch(/:root\[data-effects="off"\] \.cl-rail-ping \{ animation: none; \}/);
    });

    it('calls, screen share and video never read the switch (positive control: the scan can fail)', () => {
        const dir = path.resolve(__dirname, '..', '..', 'components', 'call');
        const offenders = fs.readdirSync(dir)
            .filter(f => f.endsWith('.tsx') || f.endsWith('.ts'))
            .filter(f => /celebrationReducedNow|useCelebrationReduced|useEffectsEnabled|effectsEnabledNow/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
        expect(offenders).toEqual([]);
        expect(/celebrationReducedNow/.test('const x = celebrationReducedNow()')).toBe(true);
    });

    it('the Firewall game stays playable (it does not read the switch)', () => {
        expect(read('components/FirewallOverlay.tsx')).not.toMatch(/celebrationReducedNow|useEffectsEnabled/);
    });
});
