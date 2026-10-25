import { describe, it, expect } from 'vitest';
import { MOTIONS, GestureRunner, framesFrom, PLANE_FRAMES, PUFFS, type Motion } from './keysGestures';

/** A fake element whose animations record their frames and cancel order. */
function fakeEl() {
    const log: string[] = [];
    const made: { frames: Keyframe[]; opts: KeyframeAnimationOptions; cancelled: boolean; anim: Animation }[] = [];
    const el = {
        animate(frames: Keyframe[], opts: KeyframeAnimationOptions) {
            const rec = { frames, opts, cancelled: false, anim: null as unknown as Animation };
            const anim = {
                cancel: () => { rec.cancelled = true; log.push(`cancel#${made.indexOf(rec)}`); },
                pause: () => log.push(`pause#${made.indexOf(rec)}`),
                play: () => log.push(`play#${made.indexOf(rec)}`),
                addEventListener: () => {},
            } as unknown as Animation;
            rec.anim = anim;
            made.push(rec);
            log.push(`animate#${made.length - 1}`);
            return anim;
        },
    };
    return { el, log, made };
}

describe('the gesture vocabulary', () => {
    const all = Object.keys(MOTIONS) as Motion[];
    it.each(all)('%s: transform only, offsets ascending, ends at rest', (m) => {
        const { frames, ms } = MOTIONS[m];
        expect(ms).toBeGreaterThan(300);
        expect(ms).toBeLessThanOrEqual(1800);
        let last = 0;
        for (const f of frames) {
            const props = Object.keys(f).filter(k => k !== 'offset' && k !== 'easing');
            expect(props).toEqual(['transform']);
            expect(f.offset as number).toBeGreaterThan(last);
            last = f.offset as number;
        }
        expect(last).toBe(1);
        // rest = none, or a full turn (dizzy), which is the same matrix
        expect(['none', 'rotate(360deg)']).toContain(frames[frames.length - 1].transform);
    });
    it('the plane and the puffs are transform / opacity only', () => {
        for (const f of [...PLANE_FRAMES, ...Object.values(PUFFS).flatMap(p => p.frames)]) {
            expect(Object.keys(f).filter(k => k !== 'offset' && k !== 'easing').every(k => k === 'transform' || k === 'opacity')).toBe(true);
        }
        expect(PLANE_FRAMES[0].opacity).toBe(0);
        expect(PLANE_FRAMES[PLANE_FRAMES.length - 1].opacity).toBe(0);
    });
    it('framesFrom starts at the current transform', () => {
        expect(framesFrom('matrix(1, 0, 0, 1, 0, -4)', MOTIONS.wake)[0]).toEqual({ offset: 0, transform: 'matrix(1, 0, 0, 1, 0, -4)' });
        expect(framesFrom('', MOTIONS.wake)[0].transform).toBe('none');
    });
});

describe('GestureRunner: interruption hands over without a snap', () => {
    it('a new gesture starts FROM where the old one is, and only then cancels it', () => {
        const { el, log, made } = fakeEl();
        let current = 'none';
        const r = new GestureRunner(el, () => current);
        r.play('doze');
        expect(r.current).toBe('doze');
        current = 'matrix(0.95, 0, 0, 1.1, 0, -3)'; // mid-yawn
        r.play('wake');
        expect(made[1].frames[0].transform).toBe('matrix(0.95, 0, 0, 1.1, 0, -3)');
        expect(log).toEqual(['animate#0', 'animate#1', 'cancel#0']);
        expect(r.current).toBe('wake');
    });
    it('settle eases a cut-off gesture home; cancel stops it; pause/resume pass through', () => {
        const { el, log, made } = fakeEl();
        const r = new GestureRunner(el, () => 'matrix(1, 0, 0, 1, 0, -8)');
        r.play('startle');
        r.pause();
        r.resume();
        r.settle();
        expect(made[1].frames).toEqual([{ transform: 'matrix(1, 0, 0, 1, 0, -8)' }, { transform: 'none' }]);
        expect(made[1].opts.duration).toBe(220);
        r.cancel();
        expect(r.current).toBeNull();
        expect(log).toEqual(['animate#0', 'pause#0', 'play#0', 'animate#1', 'cancel#0', 'cancel#1']);
    });
    it('nothing running: settle is a no-op', () => {
        const { el, made } = fakeEl();
        new GestureRunner(el, () => 'none').settle();
        expect(made).toHaveLength(0);
    });
    it('an element that throws on animate never throws through', () => {
        const r = new GestureRunner({ animate: () => { throw new Error('no WAAPI'); } }, () => 'none');
        expect(r.play('hype')).toBeNull();
    });
    it('animations never fill: the pose wrapper owns the resting state', () => {
        const { el, made } = fakeEl();
        new GestureRunner(el, () => 'none').play('dizzy');
        expect(made[0].opts.fill).toBe('none');
    });
});
