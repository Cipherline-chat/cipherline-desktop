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
