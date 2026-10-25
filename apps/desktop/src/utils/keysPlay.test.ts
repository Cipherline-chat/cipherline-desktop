import { describe, it, expect } from 'vitest';
import {
    PLAY_STATES, PLAYS, CLAIMING, GARNISH, playStateFor, FinaleGate, VariationBag, finaleEggId, FINALE_EGG_IDS, fxFor,
    FINALE_CLICKS, FINALE_WINDOW_MS, FINALE_COOLDOWN_MS, NUDGE, RARE_BEATS, isGearTarget,
    type PlayCtx, type Beat, type PlayState,
} from './keysPlay';
import { sceneFor, NEUTRAL_INPUTS, type MirrorInputs } from './keysMirror';

const CTXS: PlayCtx[] = [
    { video: false, sharing: false }, { video: true, sharing: false }, { video: false, sharing: true }, { video: true, sharing: true },
];
const stateOf = (i: Partial<MirrorInputs>) => playStateFor(sceneFor({ ...NEUTRAL_INPUTS, ...i }));

function seeded(seed: number) {
    let s = seed;
    return () => { s = (s * 48271) % 2147483647; return s / 2147483647; };
}

describe('keysPlay: which state answers a click', () => {
    it.each<[string, Partial<MirrorInputs>, PlayState]>([
        ['plain', {}, 'neutral'],
        ['no connection beats everything', { connected: false, inCall: true, gaming: true, status: 'dnd' }, 'offline'],
        ['call beats gaming', { inCall: true, gaming: true }, 'call'],
        ['gaming beats DND', { gaming: true, status: 'dnd' }, 'gaming'],
        ['DND', { status: 'dnd', unread: 200 }, 'dnd'],
        ['away = asleep', { status: 'away', transfer: true }, 'asleep'],
        ['invisible = camo', { status: 'offline', transfer: true }, 'camo'],
        ['upload box beats the safe and the pile', { transfer: true, backup: true, unread: 120 }, 'box'],
        ['backup safe beats the pile', { backup: true, unread: 60 }, 'safe'],
        ['the pile beats the garnish', { unread: 12, coffee: true, night: true, pro: true }, 'pile'],
        ['coffee', { coffee: true, night: true, pro: true }, 'coffee'],
        ['lantern', { night: true, pro: true }, 'lantern'],
        ['crown', { pro: true }, 'crown'],
        ['a calendar hat hides the crown: neutral', { pro: true, costume: true }, 'neutral'],
    ])('%s', (_n, inputs, want) => {
        expect(stateOf(inputs)).toBe(want);
    });

    it('claiming and garnish split every state, and the neutral egg is never claimed', () => {
        for (const s of PLAY_STATES) expect(CLAIMING.has(s) !== GARNISH.has(s)).toBe(true);
        expect(CLAIMING.has('neutral')).toBe(false);
        expect(GARNISH.has('neutral')).toBe(false);
        // Pro and the unread pile are everyday: they must not take the Firewall egg away
        expect(GARNISH.has('crown')).toBe(true);
        expect(GARNISH.has('pile')).toBe(true);
    });
});

describe('keysPlay: every state has three click reactions and a finale', () => {
    it.each(PLAY_STATES)('%s: exactly three distinct beats in every call context, and a finale', (s) => {
        for (const c of CTXS) {
            const beats = PLAYS[s].beats(c);
            expect(beats).toHaveLength(3);
            expect(new Set(beats.map(b => b.id)).size).toBe(3);
            const f = PLAYS[s].finale(c);
            expect(beats.map(b => b.id)).not.toContain(f.id);
        }
    });

    it('the call\'s third beat fits the call: a wave at the camera on video, the screen when sharing', () => {
        expect(PLAYS.call.beats({ video: true, sharing: false })[2]).toMatchObject({ id: 'camwave', wave: true });
        expect(PLAYS.call.beats({ video: false, sharing: true })[2].id).toBe('present');
        expect(PLAYS.call.beats({ video: false, sharing: false })[2].id).toBe('tap');
    });

    it('finale egg ids are keys-finale-<state>, one per state', () => {
        expect(FINALE_EGG_IDS).toHaveLength(PLAY_STATES.length);
        expect(new Set(FINALE_EGG_IDS).size).toBe(PLAY_STATES.length);
        for (const s of PLAY_STATES) expect(finaleEggId(s)).toBe(`keys-finale-${s}`);
        // the egg registry's id shape (eggProgress EGG_ID_RE: lowercase, digits, dashes)
        for (const id of FINALE_EGG_IDS) expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
    });

    const everyBeat = (): [string, Beat][] => {
        const out: [string, Beat][] = [];
        for (const s of PLAY_STATES) {
            for (const c of CTXS) {
                PLAYS[s].beats(c).forEach(b => out.push([`${s}/${b.id}`, b]));
                const f = PLAYS[s].finale(c);
                out.push([`${s}/${f.id}`, f]);
                if (f.hold) out.push([`${s}/${f.hold.release.id}`, f.hold.release]);
            }
        }
        out.push(['rare/juggle', RARE_BEATS.juggle], ['rare/newspaper', RARE_BEATS.newspaper]);
        return out;
    };

    it('every keyframe list is well formed: offsets rise within 0..1, transform / opacity only', () => {
        const bad: string[] = [];
        const OK = new Set(['offset', 'easing', 'transform', 'opacity', 'composite']);
        const check = (where: string, frames: Keyframe[]) => {
            let last = -1;
            frames.forEach((k, i) => {
                const off = k.offset ?? (i === 0 ? 0 : i === frames.length - 1 ? 1 : null);
                if (off !== null && off !== undefined) {
                    if (!((off as number) >= last && (off as number) <= 1)) bad.push(`${where}: offset ${off} after ${last}`);
                    last = off as number;
                }
                for (const p of Object.keys(k)) if (!OK.has(p)) bad.push(`${where}: animates ${p}`);
            });
        };
        for (const [where, b] of everyBeat()) {
            if (b.body) check(`${where} body`, b.body.frames);
            for (const m of b.moves) check(`${where} ${m.t}`, m.frames);
        }
        check('nudge', NUDGE.frames);
        expect(bad).toEqual([]);
    });

    it('every body gesture ends at rest, and every effect ends invisible', () => {
        for (const [where, b] of everyBeat()) {
            if (b.body) expect(b.body.frames[b.body.frames.length - 1].transform, where).toBe('none');
            for (const m of b.moves) {
                if (isGearTarget(m.t) || m.hold) continue;
                const last = m.frames[m.frames.length - 1];
                expect(last.opacity, `${where} ${m.t}`).toBe(0);
            }
        }
        expect(NUDGE.frames[NUDGE.frames.length - 1].transform).toBe('none');
    });

    it('nothing outlasts its beat (so a beat really is over when it says so)', () => {
        for (const [where, b] of everyBeat()) {
            for (const m of b.moves) {
                if (m.hold) continue;
                expect((m.delay ?? 0) + m.ms, `${where} ${m.t}`).toBeLessThanOrEqual(b.ms + 200);
            }
            if (b.body) expect(b.body.ms, where).toBeLessThanOrEqual(b.ms + 200);
        }
    });

    it('lines are short and dry: no sea puns', () => {
        const SEA = /\b(sea|ocean|fish|reef|tide|kraken|whale|squid|krill|shell|deep|abyss|current|kelp|coral|tentacle|ink)\b/i;
        for (const [where, b] of everyBeat()) {
            if (!b.line) continue;
            expect(b.line.length, where).toBeLessThanOrEqual(32);
            expect(b.line, where).not.toMatch(SEA);
        }
    });

    it('every effect a state uses is one KeysPlayFx can draw', () => {
        const KNOWN = /^(gameover|hiscore|conf[0-5]|shard[0-7]|vol|busy|wall|finger|mute|tap|squig[0-2]|env[0-2]|aval[0-9]|doc[0-4]|dial|door|vaultKey|stripes|antenna|drop[0-2]|gust|beam|moth|csp[01]|dust|ball[0-2]|paper|shine[01])$/;
        for (const s of PLAY_STATES) for (const c of CTXS) for (const t of fxFor(s, c)) expect(t).toMatch(KNOWN);
        expect(fxFor('neutral')).toEqual([]);
    });
});

describe('VariationBag: no immediate repeats', () => {
    it('never the same reaction twice in a row, for any RNG (seeded, stuck low, stuck high)', () => {
        for (const rng of [seeded(1), seeded(42), () => 0, () => 0.999999, () => NaN]) {
            const bag = new VariationBag(3);
            let prev = -1;
            const bad: string[] = [];
            for (let i = 0; i < 3000; i++) {
                const v = bag.next(rng);
                if (!(v >= 0 && v < 3) || v === prev) bad.push(`${i}: ${prev} -> ${v}`);
                prev = v;
            }
            expect(bad).toEqual([]);
        }
    });

    it('each round of three plays all three', () => {
        const bag = new VariationBag(3);
        const rng = seeded(7);
        for (let r = 0; r < 200; r++) {
            const round = [bag.next(rng), bag.next(rng), bag.next(rng)];
            expect([...round].sort()).toEqual([0, 1, 2]);
        }
    });

    it('it does randomise (not one fixed order)', () => {
        const bag = new VariationBag(3);
        const rng = seeded(3);
        const orders = new Set<string>();
        for (let r = 0; r < 100; r++) orders.add([bag.next(rng), bag.next(rng), bag.next(rng)].join(''));
        expect(orders.size).toBeGreaterThan(2);
    });
});

describe('FinaleGate: the spam threshold and its cooldown', () => {
    const burst = (g: FinaleGate, start: number, n: number, gap: number) => {
        const fired: number[] = [];
        for (let i = 0; i < n; i++) if (g.click(start + i * gap)) fired.push(i + 1);
        return fired;
    };

    it(`fires on the ${FINALE_CLICKS}th click inside ${FINALE_WINDOW_MS} ms, not before`, () => {
        const g = new FinaleGate();
        expect(burst(g, 0, FINALE_CLICKS - 1, 200)).toEqual([]);
        expect(g.click((FINALE_CLICKS - 1) * 200)).toBe(true);
    });

    it('six clicks spread wider than the window never fire', () => {
        const g = new FinaleGate();
        const gap = FINALE_WINDOW_MS / (FINALE_CLICKS - 1) + 1; // the 1st and 6th are > window apart
        expect(burst(g, 0, 40, gap)).toEqual([]);
    });

    it('exactly at the window edge: the oldest click no longer counts', () => {
        const g = new FinaleGate();
        // clicks at 0, 500, ..., 2500: the 6th is exactly FINALE_WINDOW_MS after the 1st
        expect(burst(g, 0, 6, FINALE_WINDOW_MS / 5)).toEqual([]);
        const h = new FinaleGate();
        expect(burst(h, 0, 6, FINALE_WINDOW_MS / 5 - 1)).toEqual([6]);
    });

    it('cools down after firing, then can fire again', () => {
        const g = new FinaleGate();
        expect(burst(g, 0, 6, 100)).toEqual([6]);
        expect(g.cooling(1000)).toBe(true);
        // keep spamming inside the cooldown: nothing
        expect(burst(g, 600, 60, 100)).toEqual([]);
        // after the cooldown (counted from the firing click at 500)
        const after = 500 + FINALE_COOLDOWN_MS;
        expect(g.cooling(after)).toBe(false);
        expect(burst(g, after, 6, 100)).toEqual([6]);
    });

    it('clear() forgets the clicks so far (a state change), not the cooldown', () => {
        const g = new FinaleGate();
        burst(g, 0, 5, 100);
        g.clear();
        expect(g.click(500)).toBe(false);
        const h = new FinaleGate();
        burst(h, 0, 6, 100);
        h.clear();
        expect(burst(h, 1000, 6, 100)).toEqual([]);
    });

    it('a clock that went backwards fails quiet', () => {
        const g = new FinaleGate();
        expect(burst(g, 10_000, 6, 100)).toEqual([6]);
        expect(burst(g, 0, 6, 100)).toEqual([]);
    });
});
