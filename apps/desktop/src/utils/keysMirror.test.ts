import { describe, it, expect } from 'vitest';
import {
    NEUTRAL_INPUTS, GEAR, PILE_AT, poseFor, sceneFor, sameScene, pileTier, gestureFor, Cooldown,
    homePress, newlyOnline, waveForArrivals, isCoffeeHour,
    DIZZY_PRESSES, DIZZY_WINDOW_MS, DIZZY_COOLDOWN_MS, PLANE_COOLDOWN_MS, WAVE_MAX_BATCH, WAVE_SETTLE_MS,
    type MirrorInputs, type Scene, type Gesture, type Pose,
} from './keysMirror';

const S = (over: Partial<MirrorInputs> = {}, prevPile: 0 | 1 | 2 | 3 = 0) => sceneFor({ ...NEUTRAL_INPUTS, ...over }, prevPile);
const has = (s: Scene, ...g: string[]) => g.every(x => (s.gear as readonly string[]).includes(x));
const lacks = (s: Scene, ...g: string[]) => g.every(x => !(s.gear as readonly string[]).includes(x));

describe('sources → scene', () => {
    it('neutral: an awake Keys with nothing on', () => {
        const s = S();
        expect(s.pose).toBe('awake');
        expect(s.gear).toEqual([]);
        expect(s.face).toBeNull();
        expect(s.doing).toBe('');
    });
    it('away → asleep, eyes closed, Zzz', () => {
        const s = S({ status: 'away' });
        expect(s.pose).toBe('asleep');
        expect(s.face).toBe('closed');
        expect(has(s, 'zzz')).toBe(true);
        expect(s.doing).toBe('napping');
    });
    it('DND → focus: headphones, eye mask, the sign', () => {
        const s = S({ status: 'dnd' });
        expect(s.pose).toBe('focus');
        expect(has(s, 'headphones', 'mask', 'sign')).toBe(true);
    });
    it('gaming → TV + its glow on him + controller, focused brows', () => {
        const s = S({ gaming: true });
        expect(s.pose).toBe('gaming');
        expect(has(s, 'tv', 'tvglow', 'controller')).toBe(true);
        expect(s.face).toBe('focus');
    });
    it('in a call → headset + call bubble; camera → ring light; sharing → frame', () => {
        expect(has(S({ inCall: true }), 'headset', 'callBubble')).toBe(true);
        expect(has(S({ inCall: true, video: true }), 'ringlight')).toBe(true);
        expect(has(S({ inCall: true, sharing: true }), 'frame')).toBe(true);
        expect(S({ inCall: true, sharing: true }).doing).toBe('on a call, sharing a screen');
    });
    it('sharing / camera flags mean nothing outside a call', () => {
        expect(lacks(S({ sharing: true, video: true }), 'frame', 'ringlight', 'live')).toBe(true);
    });
    it('invisible → camouflage with floating eyes', () => {
        const s = S({ status: 'offline' });
        expect(s.camo).toBe(true);
        expect(has(s, 'camoEyes')).toBe(true);
        expect(s.pose).toBe('awake');
    });
    it('no connection → no-signal bubble, worried, everything server-vouched hidden', () => {
        const s = S({ connected: false, inCall: true, gaming: true, status: 'dnd' });
        expect(s.pose).toBe('offline');
        expect(s.face).toBe('worried');
        expect(s.gear).toEqual(['noSignal']);
        expect(s.camo).toBe(false);
    });
    it('…but keeps what is local and still true: pile, lantern, crown', () => {
        const s = S({ connected: false, unread: 60, night: true, pro: true });
        expect(s.pile).toBe(2);
        expect(has(s, 'noSignal', 'lantern', 'crown')).toBe(true);
    });
    it('transfer → box; backup → papers + safe; morning → mug', () => {
        expect(has(S({ transfer: true }), 'box')).toBe(true);
        expect(has(S({ backup: true }), 'papers', 'safe')).toBe(true);
        expect(has(S({ coffee: true }), 'mug')).toBe(true);
    });
    it('night → lantern, burning low while he naps', () => {
        expect(has(S({ night: true }), 'lantern')).toBe(true);
        expect(S({ night: true }).lanternDim).toBe(false);
        expect(S({ night: true, status: 'away' }).lanternDim).toBe(true);
    });
    it('Pro → crown, but never over a calendar hat or a headset/headphones', () => {
        expect(has(S({ pro: true }), 'crown')).toBe(true);
        expect(lacks(S({ pro: true, costume: true }), 'crown')).toBe(true);
        expect(lacks(S({ pro: true, inCall: true }), 'crown')).toBe(true);
        expect(lacks(S({ pro: true, status: 'dnd' }), 'crown')).toBe(true);
    });
    it('gear is always in GEAR order (stable, comparable)', () => {
        const s = S({ gaming: true, inCall: true, sharing: true, video: true, status: 'dnd', night: true, backup: true });
        const order = s.gear.map(g => GEAR.indexOf(g));
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });
});

describe('precedence', () => {
    const cases: [Partial<MirrorInputs>, Pose][] = [
        [{ connected: false, inCall: true }, 'offline'],
        [{ inCall: true, gaming: true }, 'call'],
        [{ inCall: true, status: 'away' }, 'call'],
        [{ gaming: true, status: 'dnd' }, 'gaming'],
        [{ gaming: true, status: 'away' }, 'gaming'],
        [{ status: 'dnd' }, 'focus'],
        [{ status: 'away' }, 'asleep'],
        [{ status: 'offline' }, 'awake'],
    ];
    it.each(cases)('%j → %s', (over, pose) => {
        expect(poseFor({ ...NEUTRAL_INPUTS, ...over })).toBe(pose);
    });
    it('DND + gaming: at the TV in DND headphones, sign planted, NO eye mask', () => {
        const s = S({ status: 'dnd', gaming: true });
        expect(has(s, 'tv', 'controller', 'headphones', 'sign')).toBe(true);
        expect(lacks(s, 'mask')).toBe(true);
    });
    it('DND + call: the call headset wins the head, the sign stays', () => {
        const s = S({ status: 'dnd', inCall: true });
        expect(has(s, 'headset', 'sign')).toBe(true);
        expect(lacks(s, 'headphones', 'mask')).toBe(true);
    });
    it('gaming + sharing in a call = streaming: TV with a LIVE light, controller, no frame', () => {
        const s = S({ gaming: true, inCall: true, sharing: true });
        expect(has(s, 'tv', 'live', 'controller', 'headset')).toBe(true);
        expect(lacks(s, 'frame')).toBe(true);
    });
    it('hands: frame > controller > box > papers > mug, one at a time', () => {
        const hands = (o: Partial<MirrorInputs>) => S(o).gear.filter(g => ['frame', 'controller', 'box', 'papers', 'mug'].includes(g));
        expect(hands({ inCall: true, sharing: true, transfer: true, backup: true, coffee: true })).toEqual(['frame']);
        expect(hands({ gaming: true, transfer: true, backup: true, coffee: true })).toEqual(['controller']);
        expect(hands({ transfer: true, backup: true, coffee: true })).toEqual(['box']);
        expect(hands({ backup: true, coffee: true })).toEqual(['papers']);
        expect(hands({ coffee: true })).toEqual(['mug']);
    });
    it('right side: ring light outranks the safe', () => {
        const s = S({ inCall: true, video: true, backup: true });
        expect(has(s, 'ringlight')).toBe(true);
        expect(lacks(s, 'safe')).toBe(true);
    });
    it('asleep: hands are empty (he put it down), the safe stays', () => {
        const s = S({ status: 'away', transfer: true, backup: true, coffee: true });
        expect(lacks(s, 'box', 'papers', 'mug')).toBe(true);
        expect(has(s, 'safe', 'zzz')).toBe(true);
    });
    it('the pile shows under any state, camouflage combines with anything', () => {
        expect(S({ unread: 120, gaming: true }).pile).toBe(3);
        const s = S({ status: 'offline', gaming: true, inCall: true });
        expect(s.camo).toBe(true);
        expect(has(s, 'tv', 'headset', 'camoEyes')).toBe(true);
    });
});

describe('the unread pile', () => {
    it('tiers at 10 / 50 / 100 going up', () => {
        expect([0, 9, 10, 49, 50, 99, 100, 5000].map(n => pileTier(n))).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
        expect(PILE_AT).toEqual([10, 50, 100]);
    });
    it('hysteresis going down: a count hovering at a threshold does not flap', () => {
        expect(pileTier(49, 2)).toBe(2);
        expect(pileTier(40, 2)).toBe(2);
        expect(pileTier(39, 2)).toBe(1);
        expect(pileTier(9, 1)).toBe(1);
        expect(pileTier(7, 1)).toBe(0);
        expect(pileTier(0, 3)).toBe(0);
        expect(pileTier(85, 3)).toBe(3);
        expect(pileTier(79, 3)).toBe(2);
    });
    it('garbage counts are zero', () => {
        expect(pileTier(NaN)).toBe(0);
        expect(pileTier(-5)).toBe(0);
        expect(pileTier(Infinity)).toBe(0);
    });
    it('a heap worries him (when nothing else owns his face)', () => {
        expect(S({ unread: 12 }).face).toBeNull();
        expect(S({ unread: 60 }).face).toBe('worried');
        expect(S({ unread: 160, gaming: true }).face).toBe('focus');
        expect(S({ unread: 160, status: 'away' }).face).toBe('closed');
    });
    it('streaming a game in a call keeps the gaming face', () => {
        expect(S({ gaming: true, inCall: true }).face).toBe('focus');
        expect(S({ inCall: true }).face).toBeNull();
    });
    it('doing says so at the top two tiers', () => {
        expect(S({ unread: 60 }).doing).toBe('swamped with messages');
        expect(S({ unread: 200, status: 'away' }).doing).toBe('napping, buried in messages');
    });
});

describe('transitions: one gesture per change, every direction', () => {
    const g = (a: Partial<MirrorInputs>, b: Partial<MirrorInputs>): Gesture | null => gestureFor(S(a), S(b));
    it('the first scene just is', () => { expect(gestureFor(null, S({ status: 'away' }))).toBeNull(); });
    it('idle in / out', () => {
        expect(g({}, { status: 'away' })).toBe('doze');
        expect(g({ status: 'away' }, {})).toBe('wake');
    });
    it('DND in / out', () => {
        expect(g({}, { status: 'dnd' })).toBe('shh');
        expect(g({ status: 'dnd' }, {})).toBe('unshh');
        expect(g({ status: 'dnd' }, { status: 'away' })).toBe('doze');
        expect(g({ status: 'away' }, { status: 'dnd' })).toBe('wake');
    });
    it('gaming in / out', () => {
        expect(g({}, { gaming: true })).toBe('hype');
        expect(g({ gaming: true }, {})).toBe('stretch');
        expect(g({ status: 'away' }, { status: 'away', gaming: true })).toBe('wake');
    });
    it('call in / out', () => {
        expect(g({}, { inCall: true })).toBe('listen');
        expect(g({ inCall: true }, {})).toBe('stretch');
        expect(g({ gaming: true }, { gaming: true, inCall: true })).toBe('listen');
    });
    it('connection lost / back', () => {
        expect(g({ gaming: true }, { gaming: true, connected: false })).toBe('droop');
        expect(g({ connected: false }, {})).toBe('perk');
    });
    it('pile up / down', () => {
        expect(g({ unread: 5 }, { unread: 15 })).toBe('swamped');
        expect(g({ unread: 150 }, { unread: 0 })).toBe('digOut');
        expect(g({ unread: 15 }, { unread: 16 })).toBeNull();
    });
    it('camouflage, lantern, hands, crown', () => {
        expect(g({}, { status: 'offline' })).toBe('shimmer');
        expect(g({ status: 'offline' }, {})).toBe('shimmer');
        expect(g({}, { night: true })).toBe('yawn');
        expect(g({ night: true }, {})).toBe('stretch');
        expect(g({}, { transfer: true })).toBe('pickup');
        expect(g({}, { pro: true })).toBe('proud');
        expect(g({ transfer: true }, {})).toBeNull();
    });
    it('every pose pair has a gesture (no silent snaps between poses)', () => {
        const poses: Partial<MirrorInputs>[] = [{}, { status: 'away' }, { status: 'dnd' }, { gaming: true }, { inCall: true }, { connected: false }];
        for (const a of poses) for (const b of poses) {
            if (a === b) continue;
            expect(g(a, b), `${JSON.stringify(a)} → ${JSON.stringify(b)}`).not.toBeNull();
        }
    });
    it('interruption: a change back mid-way just plays the reverse gesture (state is never half-applied)', () => {
        // online → away (doze starts) → back online before he has curled up:
        const online = S(), away = S({ status: 'away' });
        expect(gestureFor(online, away)).toBe('doze');
        expect(gestureFor(away, online)).toBe('wake');
        // and the scene he lands in is exactly the one he would have reached
        // without the detour (scenes are pure functions of the inputs).
        expect(sameScene(S(), online)).toBe(true);
    });
});

describe('rate limits', () => {
    it('Cooldown: fires, refuses inside the window, fires after; a clock going back fails quiet', () => {
        const c = new Cooldown(PLANE_COOLDOWN_MS);
        expect(c.tryFire(1000)).toBe(true);
        expect(c.tryFire(1000 + PLANE_COOLDOWN_MS - 1)).toBe(false);
        expect(c.tryFire(1000 + PLANE_COOLDOWN_MS)).toBe(true);
        expect(c.tryFire(500)).toBe(true); // clock moved back: not stuck forever
    });
    it('a burst of messages is ONE plane', () => {
        const c = new Cooldown(PLANE_COOLDOWN_MS);
        const fired = [0, 200, 400, 900, 3000, 9999].filter(t => c.tryFire(t));
        expect(fired).toEqual([0]);
    });
    it('Home mashed 4× inside 2.5 s → dizzy; then a cooldown; slow presses never', () => {
        let times: number[] = [];
        let last = -Infinity;
        const press = (t: number) => { const r = homePress(times, t, last); times = r.times; if (r.dizzy) last = t; return r.dizzy; };
        expect([0, 300, 600].map(press)).toEqual([false, false, false]);
        expect(press(900)).toBe(true);
        expect([1000, 1200, 1400, 1600].map(press)).toEqual([false, false, false, false]); // cooling down
        expect(press(900 + DIZZY_COOLDOWN_MS + 1)).toBe(false); // history kept trimming
        times = []; last = -Infinity;
        expect([0, 1000, 2000, 3000, 4000].map(t => press(t * (DIZZY_WINDOW_MS / 1000)))).toEqual([false, false, false, false, false]);
        expect(DIZZY_PRESSES).toBe(4);
    });
    it('friend arrivals: one to three is a wave, a snapshot is not, nothing while settling', () => {
        const a = new Set(['x']), b = new Set(['x', 'y']);
        expect(newlyOnline(a, b)).toEqual(['y']);
        expect(newlyOnline(b, a)).toEqual([]);
        expect(waveForArrivals(1, WAVE_SETTLE_MS)).toBe(true);
        expect(waveForArrivals(WAVE_MAX_BATCH + 1, WAVE_SETTLE_MS)).toBe(false);
        expect(waveForArrivals(1, WAVE_SETTLE_MS - 1)).toBe(false);
        expect(waveForArrivals(0, WAVE_SETTLE_MS)).toBe(false);
    });
    it('coffee hours are 05:00–09:59 local', () => {
        expect(isCoffeeHour(new Date(2026, 9, 20, 4, 59))).toBe(false);
        expect(isCoffeeHour(new Date(2026, 9, 20, 5, 0))).toBe(true);
        expect(isCoffeeHour(new Date(2026, 9, 20, 9, 59))).toBe(true);
        expect(isCoffeeHour(new Date(2026, 9, 20, 10, 0))).toBe(false);
    });
});

describe('privacy shape', () => {
    it('the inputs are counts and flags: no string field could carry content', () => {
        for (const [k, v] of Object.entries(NEUTRAL_INPUTS)) {
            if (k === 'status') continue; // an enum of four presence values
            expect(['boolean', 'number']).toContain(typeof v);
        }
    });
});
