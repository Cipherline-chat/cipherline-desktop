/**
 * Every egg moment dims the app behind it with ONE shared backdrop (the egg scrim,
 * components/EggScrim.tsx), so its art and words never sit straight on a busy chat
 * (owner 2026-10-28 for text, 2026-11-12 for every moment: "make sure the easter eggs
 * dim stuff around them so they don't look bad"). MomentHost puts it under every
 * moment (MomentHost.test checks each id at runtime); this file pins the static side.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..');
const read = (rel: string) => readFileSync(join(src, rel), 'utf8');
const views = readdirSync(join(here, 'views')).filter((f) => f.endsWith('Moment.tsx'));

describe('the egg scrim', () => {
    it('no moment view draws a backdrop of its own (the host owns the one scrim)', () => {
        const own = views.filter((f) => /mo-dim|egg-scrim|EggScrim/.test(read(`components/moments/views/${f}`)));
        expect(own).toEqual([]);
        expect(read('styles/moments.css')).not.toMatch(/\.mo-dim\b/);
    });

    it('the host renders it once, before the art', () => {
        const host = read('components/moments/MomentHost.tsx');
        expect(host.match(/<EggScrim \/>/g)?.length).toBe(1);
        expect(host.indexOf('<EggScrim />')).toBeLessThan(host.indexOf('<MomentStill'));
    });

    it('the moment scrim fades in over the notice beat and out with the scene, off the host numbers', () => {
        const css = read('styles/moments.css');
        expect(css).toMatch(/\.mo-root > \.egg-scrim \{[^}]*--egg-scrim-in: var\(--mo-main[^}]*--egg-scrim-out-at: var\(--mo-exit[^}]*--egg-scrim-out: var\(--mo-exit-dur/);
    });

    it('is one token colour, a plain scrim (no backdrop-filter), and never takes a click', () => {
        const css = read('styles/egg-scrim.css').replace(/\/\*[\s\S]*?\*\//g, '');
        expect(css).toMatch(/var\(--cl-scrim-egg,/);
        expect(css).toMatch(/var\(--cl-scrim-egg-core,/);
        expect(css).toMatch(/pointer-events: none/);
        expect(css).not.toMatch(/backdrop-filter|filter:/);
        expect(read('index.css')).toMatch(/--cl-scrim-egg:/);
        expect(read('index.css')).toMatch(/--cl-scrim-egg-core:/);
    });

    it('the other over-the-app egg moments use the same scrim: the Konami party and the first-friend celebration', () => {
        for (const f of ['components/KeysParty.tsx', 'components/FirstFriendCelebration.tsx']) {
            expect(read(f)).toMatch(/<EggScrim\b/);
            expect(read(f)).toMatch(/useEggSkip\(onDone\)/);
        }
    });

    it('those layers share the moments z (50000), under the toast stack (60000)', () => {
        for (const f of ['styles/egg-party.css', 'styles/first-friend.css']) expect(read(f)).toMatch(/z-index: 50000;/);
        expect(read('styles/moments.css')).toMatch(/z-index: 50000;/);
        expect(read('contexts/ToastContext.tsx')).toMatch(/z-\[60000\]/);
    });
});
