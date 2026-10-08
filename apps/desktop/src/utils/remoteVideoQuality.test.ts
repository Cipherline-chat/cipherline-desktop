import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VideoQuality } from 'livekit-client';
import {
    displayedPixels, pickTileLayer, capForCount, normaliseLayers,
    claimRemoteQuality, prewarmRemoteQuality, appliedQuality, msSinceUpgrade,
    DOWNGRADE_DELAY_MS, PREWARM_HOLD_MS, type LayerDims, type TileRole,
    chooseDecodedSet, parseIncomingVideoMode, DECODE_CAP, pickShareLayer,
} from './remoteVideoQuality';
import { cameraLadder } from './cameraQuality';

const { LOW, MEDIUM, HIGH } = VideoQuality;

/** The layers a publisher of this capture size advertises (cameraLadder). */
function layersFor(w: number, h: number): LayerDims[] {
    const l = cameraLadder(w, h);
    const all = [...l.lower, l.top];
    // livekit-client videoQualityForRid: rids q / h / f → LOW / MEDIUM / HIGH,
    // so a two-layer publisher is LOW + MEDIUM (not LOW + HIGH).
    const q = all.length === 3 ? [LOW, MEDIUM, HIGH] : all.length === 2 ? [LOW, MEDIUM] : [HIGH];
    return all.map((x, i) => ({ quality: q[i], width: x.width, height: x.height }));
}
const CAM720 = layersFor(1280, 720);   // 180 / 360 / 720
const CAM1080 = layersFor(1920, 1080); // 270 / 540 / 1080
const CAM1440 = layersFor(2560, 1440); // 360 / 720 / 1440

describe('displayedPixels', () => {
    it('contain: the short side the video actually occupies, × DPR', () => {
        expect(displayedPixels(1280, 720, 1)).toBe(720);
        expect(displayedPixels(1280, 1000, 1)).toBe(720);   // letterboxed: width-limited
        expect(displayedPixels(800, 300, 2)).toBe(600);     // height-limited, Retina-ish
        expect(displayedPixels(1280, 720, 1.5)).toBe(1080);
    });
    it('cover (sidebar thumbnails): the video is drawn larger than the box', () => {
        expect(displayedPixels(320, 320, 1, 16 / 9, 'cover')).toBe(320);
        expect(displayedPixels(320, 180, 1, 16 / 9, 'cover')).toBe(180);
    });
    it('DPR below 1 never shrinks the ask; unmeasured box → 0', () => {
        expect(displayedPixels(640, 360, 0.5)).toBe(360);
        expect(displayedPixels(0, 0, 2)).toBe(0);
        expect(displayedPixels(640, 360, 1, NaN)).toBe(360);
    });
    it('portrait video: short side is the width', () => {
        expect(displayedPixels(1000, 1000, 1, 9 / 16)).toBe(563);
    });
});

describe('capForCount', () => {
    it.each([
        ['grid', 1, false, 1080], ['grid', 4, false, 1080], ['grid', 5, false, 540], ['grid', 9, false, 540],
        ['grid', 10, false, 270], ['grid', 30, false, 270],
        ['grid', 6, true, 1080], ['grid', 12, true, 540],   // the active speaker gets one tier more
        ['tile', 3, false, 1080], ['focus', 50, false, Infinity],
    ] as const)('%s × %d (speaking=%s) → %d', (role, n, speaking, cap) => {
        expect(capForCount(role as TileRole, n, speaking)).toBe(cap);
    });
});

describe('pickTileLayer — by rendered size × DPR, capped by count', () => {
    const pick = (layers: LayerDims[], role: TileRole, need: number, count = 1, current?: VideoQuality, speaking = false) =>
        pickTileLayer({ layers, role, need, count, current, speaking });

    it('small tiles get the low layer', () => {
        expect(pick(CAM720, 'tile', 150)).toBe(LOW);    // sidebar thumbnail at DPR 1
        expect(pick(CAM1080, 'tile', 200)).toBe(LOW);
        expect(pick(CAM1440, 'tile', 200)).toBe(LOW);   // its low IS 360p
    });
    it('allows ~15% upscale before stepping up', () => {
        expect(pick(CAM720, 'grid', 207)).toBe(LOW);    // 180 × 1.15 = 207
        expect(pick(CAM720, 'grid', 208)).toBe(MEDIUM);
    });
    it('FOCUS: 720p / 1080p cameras are always their top layer, even in a small banner', () => {
        expect(pick(CAM720, 'focus', 200)).toBe(HIGH);
        expect(pick(CAM1080, 'focus', 300)).toBe(HIGH);
    });
    it('FOCUS: a 1440p camera gives ≥ 720p, and its 1440p layer only to a focus view ≥ ~830 device px', () => {
        expect(pick(CAM1440, 'focus', 400)).toBe(MEDIUM);
        expect(pick(CAM1440, 'focus', 828)).toBe(MEDIUM);
        expect(pick(CAM1440, 'focus', 829)).toBe(HIGH);
        expect(pick(CAM1440, 'focus', 1440)).toBe(HIGH);
    });
    it('GRID ≤ 4 on a 1440p monitor: full quality up to 1080p, 1440p stays focus-only', () => {
        // 2×2 grid on 2560×1440: cells ≈ 1270×700 → need ≈ 700
        expect(pick(CAM720, 'grid', 700, 4)).toBe(HIGH);
        expect(pick(CAM1080, 'grid', 700, 4)).toBe(HIGH);
        expect(pick(CAM1440, 'grid', 700, 4)).toBe(MEDIUM);
        expect(pick(CAM1440, 'grid', 1080, 2)).toBe(MEDIUM);
    });
    it('GRID 5–9: the mid layer at most; 10+: the low layer', () => {
        expect(pick(CAM720, 'grid', 470, 6)).toBe(MEDIUM);
        expect(pick(CAM1080, 'grid', 470, 6)).toBe(MEDIUM);
        expect(pick(CAM1440, 'grid', 470, 6)).toBe(LOW);  // 360p is its only layer ≤ 540
        expect(pick(CAM720, 'grid', 380, 12)).toBe(LOW);
        expect(pick(CAM1080, 'grid', 380, 12)).toBe(LOW);
    });
    it('the active speaker in a crowded grid gets one tier more', () => {
        expect(pick(CAM720, 'grid', 470, 6, undefined, true)).toBe(HIGH);
        expect(pick(CAM720, 'grid', 380, 12, undefined, true)).toBe(MEDIUM);
    });
    it('a cap below every layer still gives the lowest', () => {
        expect(pick(CAM1440, 'grid', 300, 15)).toBe(LOW);
    });
    it('no layer info yet: focus asks HIGH, everything else LOW', () => {
        expect(pick([], 'focus', 0)).toBe(HIGH);
        expect(pick([], 'grid', 900)).toBe(LOW);
    });
    it('a two-layer publisher (854×480 camera, rids q/h) maps cleanly', () => {
        const l = layersFor(854, 480);
        expect(l.map(x => x.quality)).toEqual([LOW, MEDIUM]);
        expect(pick(l, 'tile', 150)).toBe(LOW);
        expect(pick(l, 'focus', 150)).toBe(MEDIUM); // its top layer
    });

    describe('hysteresis — no flapping at a boundary', () => {
        it('holds the higher layer until the need drops clearly below the switch point', () => {
            // up at > 414 (360 × 1.15); down only at ≤ 352 (× 0.85)
            expect(pick(CAM720, 'grid', 415, 1, MEDIUM)).toBe(HIGH);
            expect(pick(CAM720, 'grid', 400, 1, HIGH)).toBe(HIGH);
            expect(pick(CAM720, 'grid', 353, 1, HIGH)).toBe(HIGH);
            expect(pick(CAM720, 'grid', 352, 1, HIGH)).toBe(MEDIUM);
        });
        it('a resize jitter across the boundary never toggles', () => {
            let cur: VideoQuality | undefined;
            const seen: VideoQuality[] = [];
            for (const need of [420, 410, 418, 405, 416, 400, 412]) {
                cur = pick(CAM720, 'grid', need, 1, cur);
                seen.push(cur);
            }
            expect(new Set(seen)).toEqual(new Set([HIGH]));
        });
        it('a cap change (more people joined) applies even inside the band', () => {
            expect(pick(CAM720, 'grid', 400, 6, HIGH)).toBe(MEDIUM);
        });
    });
});

describe('normaliseLayers', () => {
    it('drops invalid entries, de-duplicates by quality, sorts low → high', () => {
        const raw = [
            { quality: 2, width: 1280, height: 720 }, { quality: 0, width: 320, height: 180 },
            { quality: 1, width: 0, height: 0 }, { quality: 7, width: 1, height: 1 }, {},
            { quality: 1, width: 640, height: 360 },
        ];
        expect(normaliseLayers(raw).map(l => l.quality)).toEqual([LOW, MEDIUM, HIGH]);
        expect(normaliseLayers(undefined)).toEqual([]);
    });
});

describe('arbiter — max of all tiles, upgrade now, downgrade later', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    const pub = () => {
        const calls: VideoQuality[] = [];
        return { calls, setVideoQuality: (q: VideoQuality) => { calls.push(q); } };
    };

    it('the sidebar copy of a focused stream can no longer pull it down', () => {
        const p = pub();
        const sidebar = claimRemoteQuality(p);
        sidebar.set(LOW);
        const focus = claimRemoteQuality(p);
        focus.set(HIGH);
        sidebar.set(LOW); // the sidebar tile re-renders: no effect
        vi.advanceTimersByTime(DOWNGRADE_DELAY_MS * 4);
        expect(p.calls).toEqual([LOW, HIGH]);
        expect(appliedQuality(p)).toBe(HIGH);
    });

    it('an upgrade is applied synchronously — no debounce', () => {
        const p = pub();
        const c = claimRemoteQuality(p);
        c.set(LOW);
        c.set(HIGH);
        expect(p.calls).toEqual([LOW, HIGH]);
    });

    it('a downgrade waits DOWNGRADE_DELAY_MS, then applies the max at that moment', () => {
        const p = pub();
        const sidebar = claimRemoteQuality(p);
        sidebar.set(LOW);
        const focus = claimRemoteQuality(p);
        focus.set(HIGH);
        focus.release(); // unfocus
        vi.advanceTimersByTime(DOWNGRADE_DELAY_MS - 1);
        expect(p.calls).toEqual([LOW, HIGH]);
        vi.advanceTimersByTime(1);
        expect(p.calls).toEqual([LOW, HIGH, LOW]);
    });

    it('unfocus → refocus inside the delay never dips', () => {
        const p = pub();
        const sidebar = claimRemoteQuality(p);
        sidebar.set(LOW);
        const f1 = claimRemoteQuality(p);
        f1.set(HIGH);
        f1.release();
        vi.advanceTimersByTime(1000);
        const f2 = claimRemoteQuality(p);
        f2.set(HIGH);
        vi.advanceTimersByTime(DOWNGRADE_DELAY_MS * 2);
        expect(p.calls).toEqual([LOW, HIGH]);
    });

    it('step-down to an intermediate layer when the high claim leaves but a medium one stays', () => {
        const p = pub();
        const a = claimRemoteQuality(p); a.set(MEDIUM);
        const b = claimRemoteQuality(p); b.set(HIGH);
        b.release();
        vi.advanceTimersByTime(DOWNGRADE_DELAY_MS);
        expect(p.calls).toEqual([MEDIUM, HIGH, MEDIUM]);
    });

    it('when the last tile goes, nothing is requested (remoteVideoDemand pauses the stream)', () => {
        const p = pub();
        const a = claimRemoteQuality(p); a.set(HIGH);
        a.release();
        vi.advanceTimersByTime(DOWNGRADE_DELAY_MS * 3);
        expect(p.calls).toEqual([HIGH]);
    });

    it('release is idempotent and a released claim ignores set()', () => {
        const p = pub();
        const keep = claimRemoteQuality(p); keep.set(LOW);
        const a = claimRemoteQuality(p); a.set(HIGH);
        a.release(); a.release(); a.set(HIGH);
        vi.advanceTimersByTime(DOWNGRADE_DELAY_MS);
        expect(p.calls).toEqual([LOW, HIGH, LOW]);
    });

    it('prewarm: HIGH at once (press/hover/focus change), held PREWARM_HOLD_MS, then the normal delayed downgrade', () => {
        const p = pub();
        const sidebar = claimRemoteQuality(p); sidebar.set(LOW);
        prewarmRemoteQuality(p);
        expect(p.calls).toEqual([LOW, HIGH]);
        vi.advanceTimersByTime(PREWARM_HOLD_MS + DOWNGRADE_DELAY_MS - 1);
        expect(p.calls).toEqual([LOW, HIGH]);
        vi.advanceTimersByTime(1);
        expect(p.calls).toEqual([LOW, HIGH, LOW]);
    });

    it('prewarm that turns into a focus: the focus claim takes over seamlessly', () => {
        const p = pub();
        const sidebar = claimRemoteQuality(p); sidebar.set(LOW);
        prewarmRemoteQuality(p);           // pointerdown
        vi.advanceTimersByTime(160);       // crossfade
        const focus = claimRemoteQuality(p); focus.set(HIGH);
        vi.advanceTimersByTime(PREWARM_HOLD_MS + DOWNGRADE_DELAY_MS * 2);
        expect(p.calls).toEqual([LOW, HIGH]);
    });

    it('msSinceUpgrade times upgrades only (the focus-switch log), and forgets after the window', () => {
        const p = pub();
        expect(msSinceUpgrade(p)).toBeNull();
        const a = claimRemoteQuality(p);
        a.set(HIGH);
        vi.advanceTimersByTime(420);
        expect(msSinceUpgrade(p)).toBe(420);
        a.set(LOW);
        vi.advanceTimersByTime(DOWNGRADE_DELAY_MS); // downgrade applied: not an upgrade
        expect(msSinceUpgrade(p)).toBe(420 + DOWNGRADE_DELAY_MS);
        vi.advanceTimersByTime(10_000);
        expect(msSinceUpgrade(p)).toBeNull();
    });

    it('a setVideoQuality that throws (unsubscribed meanwhile) does not break the arbiter', () => {
        const p = { setVideoQuality: () => { throw new Error('gone'); } };
        const c = claimRemoteQuality(p);
        expect(() => c.set(HIGH)).not.toThrow();
        expect(appliedQuality(p)).toBe(HIGH);
    });
});

/**
 * Simulation: the layers every tile asks for across a scripted session, and
 * the resulting worst-case downlink (sum of the requested layers' bitrates),
 * with real ladders. This is the stand-in for a multi-party call we cannot
 * run here.
 */
describe('simulation — a session on a 2560×1440 monitor (DPR 1)', () => {
    const ladders = { 720: layersFor(1280, 720), 1080: layersFor(1920, 1080), 1440: layersFor(2560, 1440) };
    const bitrate = (cam: 720 | 1080 | 1440, q: VideoQuality) => {
        const [w, h] = ({ 720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440] } as const)[cam];
        const l = cameraLadder(w, h);
        return [...l.lower, l.top][[LOW, MEDIUM, HIGH].indexOf(q)].maxBitrate;
    };
    // Grid cell need for n tiles on 2544×1360 usable (FullscreenOverlay bestGrid-ish).
    const gridNeed = (n: number) => {
        const cols = Math.ceil(Math.sqrt(n));
        const rows = Math.ceil(n / cols);
        return displayedPixels(2544 / cols - 8, 1360 / rows - 8, 1);
    };
    const mix: (720 | 1080 | 1440)[] = [720, 1080, 1440];

    it.each([2, 4, 6, 9, 12, 16])('full-screen grid of %d cameras stays inside a sane downlink', n => {
        const need = gridNeed(n);
        let total = 0;
        const picks: string[] = [];
        for (let i = 0; i < n; i++) {
            const cam = mix[i % 3];
            const q = pickTileLayer({ layers: ladders[cam], role: 'grid', need, count: n });
            picks.push(`${cam}:${q}`);
            total += bitrate(cam, q);
            // 1440p is never sent to a grid tile.
            expect(cam === 1440 && q === HIGH).toBe(false);
        }
        const budget = n <= 4 ? 16_000_000 : n <= 9 ? 12_000_000 : 8_000_000;
        expect(total).toBeLessThanOrEqual(budget);
        // ≤4: a 720p/1080p camera is shown at its top layer.
        if (n <= 4) expect(picks.filter(p => p.startsWith('720') || p.startsWith('1080')).every(p => p.endsWith(`:${HIGH}`))).toBe(true);
    });

    it('focusing a 1440p camera in fullscreen gets 1440p; the sidebar thumbnails stay low', () => {
        const stage = displayedPixels(2544, 1300, 1);
        expect(pickTileLayer({ layers: ladders[1440], role: 'focus', need: stage, count: 1 })).toBe(HIGH);
        const thumb = displayedPixels(280, 158, 1, 16 / 9, 'cover');
        for (const cam of mix) expect(pickTileLayer({ layers: ladders[cam], role: 'tile', need: thumb, count: 5 })).toBe(LOW);
        // The same thumbnail on a 125% display needs 198 px: still the low layer.
        expect(pickTileLayer({ layers: ladders[720], role: 'tile', need: displayedPixels(280, 158, 1.25, 16 / 9, 'cover'), count: 5 })).toBe(LOW);
        // A wider panel (300 css px at 125% → 211 px) is past 180p's tolerance: the mid layer.
        expect(pickTileLayer({ layers: ladders[720], role: 'tile', need: displayedPixels(300, 169, 1.25, 16 / 9, 'cover'), count: 5 })).toBe(MEDIUM);
    });
});

describe('incoming video modes — layer caps', () => {
    const pick = (layers: LayerDims[], role: TileRole, need: number, mode: 'auto' | 'reduced' | 'datasaver', speaking = false, count = 3) =>
        pickTileLayer({ layers, role, need, count, speaking, mode });

    it('Reduced: every non-focused camera LOW, the active speaker at most MEDIUM, a focused camera unchanged', () => {
        for (const cam of [CAM720, CAM1080, CAM1440]) {
            expect(pick(cam, 'grid', 1000, 'reduced')).toBe(LOW);
            expect(pick(cam, 'tile', 1000, 'reduced')).toBe(LOW);
            expect(pick(cam, 'grid', 1000, 'reduced', true)).toBe(MEDIUM);
            expect(pick(cam, 'focus', 1440, 'reduced')).toBe(pick(cam, 'focus', 1440, 'auto'));
        }
    });
    it('Reduced never RAISES a small tile (cap, not floor)', () => {
        expect(pick(CAM720, 'grid', 150, 'reduced', true)).toBe(LOW);
    });
    it('Data saver: everyone LOW (speaker too), a focused camera at most MEDIUM', () => {
        for (const cam of [CAM720, CAM1080, CAM1440]) {
            expect(pick(cam, 'grid', 1000, 'datasaver', true)).toBe(LOW);
            expect(pick(cam, 'focus', 1440, 'datasaver')).toBe(MEDIUM);
        }
    });
    it('a two-layer publisher: the speaker\'s "medium" in Reduced is its top layer', () => {
        const l = layersFor(854, 480);
        expect(pick(l, 'grid', 600, 'reduced', true)).toBe(MEDIUM);
        expect(pick(l, 'grid', 600, 'reduced')).toBe(LOW);
    });
    it('parseIncomingVideoMode', () => {
        expect(['auto', 'reduced', 'datasaver', 'low', '', null].map(v => parseIncomingVideoMode(v))).toEqual(['auto', 'reduced', 'datasaver', 'auto', 'auto', 'auto']);
    });
});

describe('chooseDecodedSet — at most DECODE_CAP remote cameras decoded', () => {
    const roster = Array.from({ length: 14 }, (_, i) => `p${i}`);
    it('no cap in effect when everyone fits', () => {
        expect(chooseDecodedSet({ order: roster.slice(0, 9), cap: DECODE_CAP })).toBeNull();
    });
    it('roster order fills the budget by default', () => {
        expect([...chooseDecodedSet({ order: roster, cap: 9 })!]).toEqual(roster.slice(0, 9));
    });
    it('the focused camera and recent speakers always get in, most recent first', () => {
        const s = chooseDecodedSet({ order: roster, focused: 'p13', recentSpeakers: ['p12', 'p11'], cap: 9 })!;
        expect(s.has('p13') && s.has('p12') && s.has('p11')).toBe(true);
        expect(s.size).toBe(9);
        expect(s.has('p6')).toBe(false); // the last roster slots made room
    });
    it('stable: a new speaker displaces only one previously decoded person, and stays after going quiet', () => {
        const prev = chooseDecodedSet({ order: roster, cap: 9 })!;
        const next = chooseDecodedSet({ order: roster, recentSpeakers: ['p12'], prev, cap: 9 })!;
        expect([...prev].filter(id => !next.has(id))).toEqual(['p8']);
        const after = chooseDecodedSet({ order: roster, recentSpeakers: [], prev: next, cap: 9 })!;
        expect(after).toEqual(next);
    });
    it('ignores ids no longer in the roster (left the call / camera off)', () => {
        const s = chooseDecodedSet({ order: roster.slice(0, 10), focused: 'gone', recentSpeakers: ['gone2'], prev: new Set(['gone3']), cap: 9 })!;
        expect([...s].every(id => roster.includes(id))).toBe(true);
        expect(s.size).toBe(9);
    });
});

describe('pickShareLayer — the screen share\'s lighter copy', () => {
    // A two-layer share: rids q (≤720p copy) / h (full) → LOW / MEDIUM.
    const SHARE = [{ quality: LOW, width: 1280, height: 720 }, { quality: MEDIUM, width: 2560, height: 1440 }];
    const ONE = [{ quality: HIGH, width: 2560, height: 1440 }];
    it('single-layer share (feature off, VP9, older clients): always that layer', () => {
        for (const role of ['focus', 'grid', 'tile'] as const) expect(pickShareLayer({ layers: ONE, role, need: 100 })).toBe(HIGH);
        expect(pickShareLayer({ layers: [], role: 'tile', need: 0 })).toBe(HIGH);
    });
    it('focused / stage → the FULL layer (Reduced too)', () => {
        expect(pickShareLayer({ layers: SHARE, role: 'focus', need: 300 })).toBe(MEDIUM);
        expect(pickShareLayer({ layers: SHARE, role: 'focus', need: 300, mode: 'reduced' })).toBe(MEDIUM);
    });
    it('small / not focused → the copy; a big grid cell (> 828 device px) → full, with hysteresis', () => {
        expect(pickShareLayer({ layers: SHARE, role: 'tile', need: 200 })).toBe(LOW);
        expect(pickShareLayer({ layers: SHARE, role: 'grid', need: 700 })).toBe(LOW);
        expect(pickShareLayer({ layers: SHARE, role: 'grid', need: 900 })).toBe(MEDIUM);
        expect(pickShareLayer({ layers: SHARE, role: 'grid', need: 800, current: MEDIUM })).toBe(MEDIUM);
        expect(pickShareLayer({ layers: SHARE, role: 'grid', need: 700, current: MEDIUM })).toBe(LOW);
    });
    it('Reduced → copy unless focused; Data saver → copy always', () => {
        expect(pickShareLayer({ layers: SHARE, role: 'grid', need: 1400, mode: 'reduced' })).toBe(LOW);
        expect(pickShareLayer({ layers: SHARE, role: 'focus', need: 1400, mode: 'datasaver' })).toBe(LOW);
    });
});
