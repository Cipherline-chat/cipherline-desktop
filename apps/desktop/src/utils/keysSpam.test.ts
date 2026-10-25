import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = vi.hoisted(() => new Map<string, string>());
vi.mock('./secureLocalStore', () => {
    const api = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => { store.set(k, v); },
    };
    return { default: api, secureLocalStore: api };
});

import {
    SHOWS, PERSONALITIES, REST, EMPTY_BAG, ready, upNext, deal, parseBag,
    type Move, type Personality, type SpamBag,
} from './keysSpam';
import { readSpamBag, writeSpamBag, spamBagKey, __resetSpamBagMemory } from './keysSpamStore';
import { classifyKvKey } from '../services/backupRegistry';

/** Every number in a move's transforms and opacities: a crude "how big". */
const magnitude = (moves: Move[]) => moves.reduce((sum, m) => sum + m.frames.reduce((s, f0) => {
    // the charge's filling ring is a meter: its scale climbing toward 1 IS
    // the growth, so only its opacity counts here
    const f = m.target === 'fill' ? { opacity: f0.opacity } : f0;
    let t = 0;
    for (const [k, v] of Object.entries(f)) {
        if (k === 'offset' || k === 'easing') continue;
        if (k === 'opacity' && typeof v === 'number') t += v;
        if (typeof v === 'string') for (const n of v.matchAll(/(-?\d+(?:\.\d+)?)(px|deg)/g)) t += Math.abs(Number(n[1]));
        if (typeof v === 'string') for (const n of v.matchAll(/scale\(([\d.]+)(?:,\s*([\d.]+))?\)/g)) t += Math.abs(Number(n[1]) - 1) * 100 + Math.abs(Number(n[2] ?? n[1]) - 1) * 100;
    }
    return s + t;
}, 0), 0);

/** A held target's final keyframe at the end of a list of moves. */
const endState = (moves: Move[]) => {
    const out = new Map<string, Keyframe>();
    for (const m of moves) if (m.hold) out.set(m.target, m.frames[m.frames.length - 1]);
    return out;
};

describe('keysSpam: five shows', () => {
    it('there are five, each with five different lines, a finale and a recovery line', () => {
        expect(PERSONALITIES).toHaveLength(5);
        for (const id of PERSONALITIES) {
            const s = SHOWS[id];
            expect(s.id).toBe(id);
            expect(new Set(s.lines).size, id).toBe(5);
            expect(s.finaleLine.length, id).toBeGreaterThan(0);
            expect(s.recoveredLine.length, id).toBeGreaterThan(0);
        }
    });

    it('they are genuinely different: no two share a line, and each has its own signature', () => {
        const all = PERSONALITIES.flatMap(id => [...SHOWS[id].lines, SHOWS[id].finaleLine, SHOWS[id].recoveredLine]);
        expect(new Set(all).size).toBe(all.length);
        const signature = (id: Personality) => {
            const ts = new Set(SHOWS[id].click(0.5, 3).map(m => m.target));
            return `${[...ts].sort().join(',')}|${SHOWS[id].eyes}|${SHOWS[id].avoid ? 'avoid' : ''}|${SHOWS[id].face ?? ''}`;
        };
        expect(new Set(PERSONALITIES.map(signature)).size).toBe(5);
    });

    it('none of them reuses the website mascot’s gags (inflate/pop, doze-and-wake, dizzy spirals, blush, spin, peek-from-edge)', () => {
        const text = PERSONALITIES.map(id => JSON.stringify(SHOWS[id]) + [...SHOWS[id].lines, SHOWS[id].finaleLine, SHOWS[id].recoveredLine].join(' ')).join(' ').toLowerCase();
        for (const word of ['pop', 'inflat', 'zz', 'asleep', 'sleep', 'spiral', 'blush', 'dizzy', 'rotatey']) expect(text, word).not.toContain(word);
    });

    it.each(PERSONALITIES)('%s ramps: its level never drops, and a late click is a bigger reaction than an early one', (id) => {
        const s = SHOWS[id];
        let prev = -1;
        for (let i = 0; i <= 100; i++) {
            const l = s.level(i / 100);
            expect(l).toBeGreaterThanOrEqual(prev);
            prev = l;
        }
        expect(s.level(1)).toBeGreaterThan(s.level(0));
        for (const n of [1, 2, 3, 4]) {
            expect(magnitude(s.click(0.9, n)), `click ${n}`).toBeGreaterThan(magnitude(s.click(0.1, n)));
        }
    });

    it.each(PERSONALITIES)('%s only ever animates transform and opacity', (id) => {
        const s = SHOWS[id];
        const moves = [...s.click(0.3, 1), ...s.click(0.8, 2), ...s.finale().moves, ...s.recover(0.6).moves];
        for (const m of moves) for (const f of m.frames) {
            for (const k of Object.keys(f)) expect(['transform', 'opacity', 'offset', 'easing'], `${id} ${m.target} ${k}`).toContain(k);
        }
    });

    it.each(PERSONALITIES)('%s recovers: every target its show held ends back at rest', (id) => {
        const s = SHOWS[id];
        const heldBy = new Set([...s.click(0.7, 1), ...s.click(0.7, 2), ...s.click(0.7, 3)].filter(m => m.hold).map(m => m.target));
        const rc = s.recover(0.7);
        expect(rc.ms).toBeGreaterThan(0);
        expect(rc.ms).toBeLessThanOrEqual(2000);
        const end = endState(rc.moves);
        for (const t of heldBy) {
            expect(end.has(t), `${id} recovers ${t}`).toBe(true);
            const last = end.get(t)!;
            for (const [k, v] of Object.entries(last)) {
                if (k === 'offset' || k === 'easing') continue;
                expect(v, `${id} ${t}.${k}`).toEqual(REST[t][k]);
            }
        }
    });

    it.each(PERSONALITIES)('%s stays upright: no click tilts him more than 20 degrees', (id) => {
        for (let i = 0; i <= 20; i++) {
            for (const m of SHOWS[id].click(i / 20, i + 1)) for (const f of m.frames) {
                const r = /rotate\((-?[\d.]+)deg\)/.exec(String(f.transform ?? ''));
                if (r) expect(Math.abs(Number(r[1])), id).toBeLessThanOrEqual(20);
                expect(String(f.transform ?? '')).not.toMatch(/rotateX|rotateY|scale\(-|scaleY\(-/); // never flipped
            }
        }
    });
});

describe('keysSpam: the rotation', () => {
    /** A seeded rand, so the shuffles are reproducible. */
    const seeded = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

    it('deals all five before any repeats, every round, and never the same one twice in a row', () => {
        const rand = seeded(7);
        let st: SpamBag = EMPTY_BAG;
        const dealt: Personality[] = [];
        for (let i = 0; i < 50; i++) {
            st = ready(st, rand);
            dealt.push(upNext(st));
            st = deal(st);
        }
        for (let r = 0; r < 10; r++) expect(new Set(dealt.slice(r * 5, r * 5 + 5)).size, `round ${r}`).toBe(5);
        for (let i = 1; i < dealt.length; i++) expect(dealt[i], `at ${i}`).not.toBe(dealt[i - 1]);
    });

    it('ready() does not reshuffle a bag that still has shows in it', () => {
        const st: SpamBag = { bag: ['camo', 'dance'], last: 'glitch' };
        expect(ready(st, () => 0.99)).toBe(st);
        expect(upNext(st)).toBe('camo');
    });

    it('parseBag: junk, unknown names and duplicates come back as an empty bag', () => {
        expect(parseBag(null)).toEqual(EMPTY_BAG);
        expect(parseBag('{nope')).toEqual(EMPTY_BAG);
        expect(parseBag(JSON.stringify({ bag: ['camo', 'camo'], last: null }))).toEqual(EMPTY_BAG);
        expect(parseBag(JSON.stringify({ bag: ['camo', 'balloon', 'dance'], last: 'x' }))).toEqual({ bag: ['camo', 'dance'], last: null });
    });
});

describe('keysSpam: the rotation is kept per account', () => {
    beforeEach(() => { store.clear(); __resetSpamBagMemory(); });

    it('round-trips under the account’s own key, and another account starts fresh', () => {
        const bag: SpamBag = { bag: ['dodge', 'charge'], last: 'glitch' };
        writeSpamBag('acct-a', bag);
        expect(store.has(spamBagKey('acct-a'))).toBe(true);
        expect(readSpamBag('acct-a')).toEqual(bag);
        expect(readSpamBag('acct-b')).toEqual(EMPTY_BAG);
    });

    it('its key is classified in the backup registry (excluded)', () => {
        expect(classifyKvKey(spamBagKey('acct-a'), 'acct-a')).toBe('exclude');
    });
});

describe('keysSpam: each show ends on an action-matched payoff (no call refusal)', () => {
    /** What each payoff is made of: the props that make it that show's own. */
    const SIGNATURE: Record<Personality, string[]> = {
        dance: ['ball', 'discoA', 'discoB', 'note0', 'spark0'],      // a disco
        glitch: ['scan', 'ghostA', 'ghostB'],                         // a reboot
        dodge: ['streak0', 'streak1', 'dust'],                        // a victory lap
        charge: ['ring0', 'ring1', 'fill', 'spark0'],                 // a power-up
        camo: ['sheen', 'stripes', 'eyesLight'],                      // a reveal
    };

    it('every show has a payoff line of its own, none of them about the call', () => {
        const others = PERSONALITIES.flatMap(id => [...SHOWS[id].lines, SHOWS[id].finaleLine, SHOWS[id].recoveredLine]);
        const lines = PERSONALITIES.map(id => SHOWS[id].payoffLine);
        expect(new Set(lines).size).toBe(5);
        for (const l of lines) {
            expect(l.length).toBeGreaterThan(0);
            expect(others).not.toContain(l);
            expect(l).not.toMatch(/call|after|later|busy/i);
        }
        for (const id of PERSONALITIES) expect(JSON.stringify(SHOWS[id])).not.toMatch(/after your call/i);
    });

    it.each(PERSONALITIES)('%s: the payoff is built from its own props (the mapping)', (id) => {
        const targets = new Set(SHOWS[id].payoff().moves.map(m => m.target));
        for (const t of SIGNATURE[id]) expect(targets.has(t as never), `${id} payoff animates ${t}`).toBe(true);
        // and no two shows share a signature prop (a disco is not a reboot)
        for (const other of PERSONALITIES) {
            if (other === id) continue;
            const mine = SIGNATURE[id].filter(t => !['spark0', 'ghostA', 'ghostB', 'stripes'].includes(t));
            for (const t of mine) expect(SIGNATURE[other].includes(t), `${id} vs ${other}: ${t}`).toBe(false);
        }
    });

    it.each(PERSONALITIES)('%s: 3-5 s, finite, animates only transform and opacity, one animation per target', (id) => {
        const po = SHOWS[id].payoff();
        expect(po.ms).toBeGreaterThanOrEqual(3000);
        expect(po.ms).toBeLessThanOrEqual(5000);
        const seen = new Set<string>();
        for (const m of po.moves) {
            expect(seen.has(m.target), `${id} animates ${m.target} twice`).toBe(false);
            seen.add(m.target);
            expect(m.ms, `${id} ${m.target}`).toBeLessThanOrEqual(po.ms);
            for (const f of m.frames) for (const k of Object.keys(f)) {
                expect(['transform', 'opacity', 'offset', 'easing'], `${id} ${m.target} ${k}`).toContain(k);
            }
        }
        expect(Math.max(...po.moves.map(m => m.ms))).toBe(po.ms);
    });

    it.each(PERSONALITIES)('%s: no skew in the payoff (measured: skewX on his body drops the animation off the compositor)', (id) => {
        expect(JSON.stringify(SHOWS[id].payoff().moves)).not.toMatch(/skew/i);
    });

    it.each(PERSONALITIES)('%s: every target ends back at rest, so nothing is left on screen', (id) => {
        for (const m of SHOWS[id].payoff().moves) {
            const last = m.frames[m.frames.length - 1];
            for (const [k, v] of Object.entries(last)) {
                if (k === 'offset' || k === 'easing') continue;
                expect(v, `${id} ${m.target}.${k}`).toEqual(REST[m.target][k]);
            }
            expect(last.offset, `${id} ${m.target} ends at 1`).toBe(1);
        }
    });

    it.each(PERSONALITIES)('%s: keyframe offsets are in order, and stay inside the slot (< 40 px of travel, scale < 1.6)', (id) => {
        for (const m of SHOWS[id].payoff().moves) {
            let prev = 0;
            for (const f of m.frames) {
                if (typeof f.offset === 'number') {
                    expect(f.offset).toBeGreaterThanOrEqual(prev);
                    expect(f.offset).toBeLessThanOrEqual(1);
                    prev = f.offset;
                }
                const t = String(f.transform ?? '');
                for (const n of t.matchAll(/translate\(([-\d.]+)px/g)) expect(Math.abs(Number(n[1])), `${id} ${m.target}`).toBeLessThan(40);
                for (const n of t.matchAll(/translateY\(([-\d.]+)px\)/g)) expect(Math.abs(Number(n[1])), `${id} ${m.target}`).toBeLessThan(40);
                if (m.target !== 'body') continue;
                for (const n of t.matchAll(/scale\(([\d.]+)/g)) expect(Number(n[1])).toBeLessThan(1.6);
            }
        }
    });

    /** Large-area light changes (the washes, rays, the scan, the stripes): how
     *  many distinct brightening peaks fall in any one second. */
    const peaksPerSecond = (id: Personality, targets: string[]) => {
        const times: number[] = [];
        for (const m of SHOWS[id].payoff().moves.filter(x => targets.includes(x.target))) {
            const pts = m.frames.filter(f => typeof f.offset === 'number').map(f => ({ t: (f.offset as number) * m.ms, o: Number(f.opacity ?? 0) }));
            for (let i = 1; i < pts.length - 1; i++) if (pts[i].o >= 0.3 && pts[i].o >= pts[i - 1].o && pts[i].o > pts[i + 1].o) times.push(pts[i].t);
        }
        times.sort((a, b) => a - b);
        // layers that peak together (the two RGB ghosts) are ONE flash to the eye
        const flashes = times.filter((t, i) => i === 0 || t - times[i - 1] > 150);
        let worst = 0;
        for (const t of flashes) worst = Math.max(worst, flashes.filter(x => x >= t && x < t + 1000).length);
        return { worst, count: flashes.length };
    };

    it('no strobe: the disco washes and rays peak less than 3 times in any second (and they do flash)', () => {
        const r = peaksPerSecond('dance', ['discoA', 'discoB']);
        expect(r.count).toBeGreaterThanOrEqual(4);     // positive control: the detector sees the flashes
        expect(r.worst).toBeLessThan(3);
    });
    it.each(PERSONALITIES)('%s: every large-area light layer peaks under 3 times a second', (id) => {
        expect(peaksPerSecond(id, ['discoA', 'discoB', 'scan', 'stripes', 'ghostA', 'ghostB', 'sheen']).worst).toBeLessThan(3);
    });
    it('the detector counts a strobe: control with a 5 Hz flasher', () => {
        const fake: Move = { target: 'discoA', ms: 1000, frames: Array.from({ length: 11 }, (_, i) => ({ opacity: i % 2 ? 0.8 : 0, offset: i / 10 })) };
        const times = fake.frames.filter((f, i) => i > 0 && i < 10 && Number(f.opacity) >= 0.3).length;
        expect(times).toBe(5);
    });

    it('the disco peaks the washes with the bob: eight beats at 120 bpm then a bow', () => {
        const body = SHOWS.dance.payoff().moves.find(m => m.target === 'body')!;
        const ups = body.frames.filter(f => /translateY\(-(5|8|15)/.test(String(f.transform)));
        expect(ups).toHaveLength(8);                    // a hop on every beat
        expect(SHOWS.dance.payoff().ms).toBeGreaterThanOrEqual(4500); // the owner's "5 second disco"
    });
});
