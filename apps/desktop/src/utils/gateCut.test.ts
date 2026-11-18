/**
 * "Your voice gate may be cutting you off" (owner 2026-11-17): the detector on the REAL gate worklet (its embedded
 * GateCutMeter), the decision and suggestion (gateCut.ts) and the prompt rules / memory (gateCutPrompt.ts).
 *
 * Signals: the gate-data-tune speech model (voiceGateHarness.synth: harmonic syllable nuclei, unvoiced and voiced
 * consonants, phrase declination, breaths and key clicks in the pauses) and the audit harness's rooms. The same cases
 * on the owner's real speech through the whole chain are in the audit worklog (2026-11-17-audio-audit.md).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../workers/rnnoise.worker?worker', () => ({ default: class {} }));

const mem = vi.hoisted(() => new Map<string, string>());
vi.mock('./secureLocalStore', () => ({
    default: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } },
}));

import { synth, loadGate, SR, Q } from './voiceGateHarness';
import { background, keyClicks, breath, loadModuleWorklet, waitFor } from '../audio/audit/chainHarness';
import {
    GateCutWatcher, decideGateCut, suggestThreshold, gateCutSecondFrom, GC_BLOCK_SEC,
    GC_WINDOW_VOICED_SEC, GC_GATED_SHARE, type GateCutSecond,
} from './gateCut';
import {
    mayPromptForGateCut, loadGateCutPromptStore, saveGateCutPromptStore, afterDismiss, afterNever, offerDontAskAgain,
    GATE_CUT_PROMPT_STORAGE_KEY, GC_MIN_CALL_SEC,
} from './gateCutPrompt';

/** Feed `x` through the real gate worklet at `thr`; replay its once-a-second reports as a call would. */
async function detect(x: Float32Array, thr: number) {
    const { GATE_WORKLET_SOURCE } = await import('./voiceProcessor');
    const g = loadGate(GATE_WORKLET_SOURCE, [{ type: 'gate', enabled: true }, { type: 'threshold', value: thr }, { type: 'hold', ms: 150 }]);
    g.run(x);
    const secs = g.posted.filter(m => m.type === 'gateStats').map(m => gateCutSecondFrom(m)).filter((s): s is GateCutSecond => !!s);
    const w = new GateCutWatcher();
    let first: ReturnType<typeof decideGateCut> = null, firstSec = -1;
    secs.forEach((s, i) => {
        if (s.voiced > 0) w.push(s);
        if (i + 1 < GC_MIN_CALL_SEC || first) return;
        const d = w.decide(thr);
        if (d) { first = d; firstSec = i + 1; }
    });
    const voiced = secs.reduce((a, s) => a + s.voiced, 0), gated = secs.reduce((a, s) => a + s.gated, 0);
    return { detection: first as ReturnType<typeof decideGateCut>, firstSec, voicedSec: voiced * GC_BLOCK_SEC, gatedShare: voiced ? gated / voiced : 0 };
}

const talker = (speechDb: number, floorDb: number, seed = 3) =>
    synth({ speechDb, duty: 0.35, floorDb, seconds: 120, seed, events: 'both', sigmaDb: 3.5, phraseSigmaDb: 2 }).x;

describe('gate-cut detector on the real gate worklet', () => {
    it('TRIGGERS: a quiet talker (-45 dBFS nuclei) behind the -45 default, with a lower threshold to offer', async () => {
        const r = await detect(talker(-45, -70), -45);
        expect(r.detection).not.toBeNull();
        expect(r.detection!.gatedShare).toBeGreaterThanOrEqual(GC_GATED_SHARE);
        expect(r.detection!.suggestDb).not.toBeNull();
        expect(r.detection!.suggestDb!).toBeLessThanOrEqual(-50);
        expect(r.detection!.suggestDb!).toBeGreaterThanOrEqual(-60);
        expect(r.firstSec).toBeLessThan(120);
    }, 60_000);

    it('TRIGGERS in a noisy room too (-47 dBFS talker, fan at -62)', async () => {
        const x = talker(-47, -90, 5); const fan = background('fan', x.length, -62, 4);
        for (let i = 0; i < x.length; i++) x[i] += fan[i];
        const r = await detect(x, -45);
        expect(r.detection).not.toBeNull();
    }, 60_000);

    for (const [name, db, thr] of [['normal talker (-30) behind -45', -30, -45], ['loud talker (-16) behind -45', -16, -45], ['quiet talker (-45) behind a well-set -60', -45, -60]] as const) {
        it(`does NOT trigger: ${name}`, async () => {
            const r = await detect(talker(db, -70), thr);
            expect(r.voicedSec).toBeGreaterThan(GC_WINDOW_VOICED_SEC); // it had the evidence and judged
            expect(r.detection).toBeNull();
        }, 60_000);
    }

    it('CONTROL: counting every close between words (not only those the voice comes back under) would nag a normal talker', async () => {
        const { GATE_WORKLET_SOURCE } = await import('./voiceProcessor');
        const loose = GATE_WORKLET_SOURCE.replace('if (this.pendingClose > 0) { if (!passed) this.closes++; this.pendingClose = 0; }', 'if (this.pendingClose > 0) { this.closes++; this.pendingClose = 0; }');
        expect(loose).not.toBe(GATE_WORKLET_SOURCE);
        const g = loadGate(loose, [{ type: 'gate', enabled: true }, { type: 'threshold', value: -45 }, { type: 'hold', ms: 150 }]);
        g.run(talker(-30, -70));
        const secs = g.posted.filter(m => m.type === 'gateStats').map(m => gateCutSecondFrom(m)).filter((x): x is GateCutSecond => !!x);
        const w = new GateCutWatcher();
        let hit = false;
        secs.forEach((x, i) => { if (x.voiced > 0) w.push(x); if (i + 1 >= GC_MIN_CALL_SEC && w.decide(-45)) hit = true; });
        expect(hit).toBe(true);
    }, 60_000);

    const room = (kind: 'fan' | 'hum' | 'hiss', db: number) => {
        const x = background(kind, 120 * SR, db, 9);
        // keyboard bursts and breaths every few seconds
        for (let t = 2; t < 118; t += 3.7) {
            const ev = Math.round(t) % 2 ? keyClicks(9, db + 14, Math.round(t * 10)) : breath(0.4, db + 10, Math.round(t * 10));
            const at = Math.round(t * SR);
            for (let i = 0; i < ev.length && at + i < x.length; i++) x[at + i] += ev[i];
        }
        return x;
    };
    for (const kind of ['fan', 'hum', 'hiss'] as const) {
        it(`nobody talking (${kind} at -50 with keyboard and breaths) never triggers, at -45 or -60`, async () => {
            for (const thr of [-45, -60]) {
                const r = await detect(room(kind, -50), thr);
                expect(r.detection).toBeNull();
                expect(r.voicedSec).toBeLessThan(GC_WINDOW_VOICED_SEC);
            }
        }, 60_000);
    }

    it("nobody talking, Light's residual of a -52 dBFS fan (the pitch rule's fish tank) never triggers", async () => {
        const { SPEEX_LIGHT_WORKLET_SOURCE } = await import('./speexLightWorkletSource');
        const { speexWasmBytes } = await import('./speexWasm');
        const p = await loadModuleWorklet(SPEEX_LIGHT_WORKLET_SOURCE, 'speex-light-worklet');
        p.port.onmessage!({ data: { type: 'init', wasm: speexWasmBytes() } });
        await waitFor(() => !!p.ready);
        p.port.onmessage!({ data: { type: 'toggle', enabled: true } });
        const x = background('fan', 120 * SR, -52, 5), y = new Float32Array(x.length), o = new Float32Array(Q);
        for (let b = 0; (b + 1) * Q <= x.length; b++) { p.process([[x.subarray(b * Q, (b + 1) * Q)]], [[o]]); y.set(o, b * Q); }
        for (const thr of [-45, -60]) expect((await detect(y, thr)).detection).toBeNull();
    }, 60_000);

    it('CONTROL: one voiced frame on its own would count Light\'s fan residual as voice (why 2 in a row)', async () => {
        const { SPEEX_LIGHT_WORKLET_SOURCE } = await import('./speexLightWorkletSource');
        const { speexWasmBytes } = await import('./speexWasm');
        const { GATE_WORKLET_SOURCE } = await import('./voiceProcessor');
        const p = await loadModuleWorklet(SPEEX_LIGHT_WORKLET_SOURCE, 'speex-light-worklet');
        p.port.onmessage!({ data: { type: 'init', wasm: speexWasmBytes() } });
        await waitFor(() => !!p.ready);
        p.port.onmessage!({ data: { type: 'toggle', enabled: true } });
        const x = background('fan', 60 * SR, -52, 5), y = new Float32Array(x.length), o = new Float32Array(Q);
        for (let b = 0; (b + 1) * Q <= x.length; b++) { p.process([[x.subarray(b * Q, (b + 1) * Q)]], [[o]]); y.set(o, b * Q); }
        const voicedWith = (minRun: number) => {
            const src = GATE_WORKLET_SOURCE.replace(/const GC_MIN_RUN = \d+;/, `const GC_MIN_RUN = ${minRun};`);
            if (minRun !== 2) expect(src).not.toBe(GATE_WORKLET_SOURCE);
            const g = loadGate(src, [{ type: 'gate', enabled: true }, { type: 'threshold', value: -60 }]);
            g.run(y);
            return g.posted.filter(m => m.type === 'gateStats').reduce((a, m) => a + ((m.cut as { voiced: number }).voiced), 0) * GC_BLOCK_SEC;
        };
        expect(voicedWith(2)).toBeLessThan(1);
        expect(voicedWith(1)).toBeGreaterThan(voicedWith(2) * 3 + 1);
    }, 60_000);

    it('reports nothing while the gate is off (no pitch analysis then)', async () => {
        const { GATE_WORKLET_SOURCE } = await import('./voiceProcessor');
        const g = loadGate(GATE_WORKLET_SOURCE, [{ type: 'gate', enabled: false }]);
        g.run(talker(-45, -70).subarray(0, 20 * SR));
        const cut = g.posted.filter(m => m.type === 'gateStats').map(m => m.cut as { voiced: number });
        expect(cut.length).toBeGreaterThan(10);
        expect(cut.every(c => c.voiced === 0)).toBe(true);
    }, 60_000);
});

// Owner report 5ffa77e6 (2026-11-18): "background noise turned way up, also when typing". The same meter now also counts
// what ELSE the gate passes (noise = audible non-voice blocks it let through; bursts = threshold crossings no voice
// followed), for the mic_noise diagnostics and the background-noise prompt.
describe('what else the gate lets through (noise, bursts)', () => {
    const totals = async (x: Float32Array, thr = -45, patch?: (src: string) => string, enabled = true) => {
        const { GATE_WORKLET_SOURCE } = await import('./voiceProcessor');
        const src = patch ? patch(GATE_WORKLET_SOURCE) : GATE_WORKLET_SOURCE;
        if (patch) expect(src).not.toBe(GATE_WORKLET_SOURCE);
        const g = loadGate(src, [{ type: 'gate', enabled }, { type: 'threshold', value: thr }, { type: 'hold', ms: 150 }]);
        g.run(x);
        return g.posted.filter(m => m.type === 'gateStats').map(m => m.cut as Record<string, number>)
            .reduce((a, b) => { for (const k of Object.keys(b)) a[k] = (a[k] ?? 0) + b[k]; return a; }, {} as Record<string, number>);
    };
    const typing = (secs: number, clickDb: number) => {
        const room = background('fan', secs * SR, -62, 4), k = keyClicks(Math.floor(secs * 9) - 1, clickDb, 9);
        const x = new Float32Array(room.length);
        for (let i = 0; i < x.length; i++) x[i] = room[i] + (k[i] ?? 0);
        return x;
    };
    const quietTalker = (speechDb: number, floorDb: number) =>
        synth({ speechDb, duty: 0.35, floorDb, seconds: 60, seed: 3, events: 'none', sigmaDb: 3.5, phraseSigmaDb: 2 }).x;

    it('typing over a quiet room (clicks over the -45 gate, nobody talking): bursts and passed noise', async () => {
        const t = await totals(typing(20, -40));
        expect(t.voiced).toBe(0);
        expect(t.bursts).toBeGreaterThan(60);                 // ~9 keys/s for 20 s, crossings 120 ms apart merge
        expect(t.noise * GC_BLOCK_SEC).toBeGreaterThan(5);     // the 150 ms hold passes the room between keys too
    }, 60_000);

    it('clicks under the threshold open nothing and count nothing', async () => {
        const t = await totals(typing(20, -60));
        expect(t.bursts).toBe(0);
        expect(t.noise * GC_BLOCK_SEC).toBeLessThan(0.06); // only the gate's first 50 ms (it starts open, then releases)
    }, 60_000);

    for (const [db, floor] of [[-30, -70], [-45, -70], [-16, -60], [-40, -62]] as const) {
        it(`a talker alone (${db} dBFS over ${floor}) makes no bursts: every phrase start is followed by voice`, async () => {
            const t = await totals(quietTalker(db, floor));
            expect(t.starts).toBeGreaterThan(5);
            expect(t.bursts).toBe(0);
            expect(t.noise * GC_BLOCK_SEC).toBeLessThan(1.5);   // phrase starts before their first voiced analysis
        }, 60_000);
    }

    it('CONTROL: without waiting for voice after a crossing, every phrase start would count as a burst', async () => {
        const t = await totals(quietTalker(-30, -70), -45, s => s.replace(/const GC_BURST_CONFIRM_SEC = [\d.]+;/, 'const GC_BURST_CONFIRM_SEC = 1e-9;'));
        expect(t.bursts).toBeGreaterThanOrEqual(t.starts);
    }, 60_000);

    it('nothing is counted while the gate is off', async () => {
        const t = await totals(typing(10, -40), -45, undefined, false);
        expect(t.bursts ?? 0).toBe(0);
        expect(t.noise ?? 0).toBe(0);
        expect(t.blocks ?? 0).toBe(0);
    }, 60_000);
});

describe('decision and suggestion (pure)', () => {
    const sec = (o: Partial<GateCutSecond>): GateCutSecond => ({ voiced: 150, gated: 0, vms: 150 * 10 ** (-4.5), starts: 1, clipped: 0, closes: 0, minDb: -70, ...o });
    it('needs GC_WINDOW_VOICED_SEC of voice before it says anything', () => {
        const few = Array.from({ length: 10 }, () => sec({ gated: 150 }));
        expect(decideGateCut(few, -45)).toBeNull(); // 10 x 150 blocks = 4 s of voice
        const enough = Array.from({ length: 60 }, () => sec({ gated: 150 }));
        expect(decideGateCut(enough, -45)).not.toBeNull();
    });
    it('mid-phrase cuts: 5 in the window trigger, 4 do not', () => {
        const at = (n: number) => Array.from({ length: 60 }, (_, i) => sec({ closes: i >= 60 - n ? 1 : 0 })); // the newest seconds
        expect(decideGateCut(at(5), -45)).not.toBeNull();
        expect(decideGateCut(at(4), -45)).toBeNull();
    });
    it('gated share under the trigger and few clipped starts: no; clipped starts alone can trigger', () => {
        const ok = Array.from({ length: 60 }, () => sec({ gated: Math.floor(150 * GC_GATED_SHARE * 0.5) }));
        expect(decideGateCut(ok, -45)).toBeNull();
        const starts = Array.from({ length: 60 }, () => sec({ starts: 1, clipped: 1 }));
        expect(decideGateCut(starts, -45)).not.toBeNull();
    });
    it('suggestion: 15 dB under the voice, never within 6 dB of the room, never under -60, and only if it lowers by 3+ dB', () => {
        expect(suggestThreshold(-45, -80, -45)).toBe(-60);
        expect(suggestThreshold(-40, -80, -45)).toBe(-55);
        expect(suggestThreshold(-40, -58, -45)).toBe(-52);  // the room decides
        expect(suggestThreshold(-40, -50, -45)).toBeNull(); // the voice is too close to the room: only "turn off" helps
        expect(suggestThreshold(-34, -80, -45)).toBe(-49);
        expect(suggestThreshold(-32, -80, -45)).toBeNull(); // -47 would barely move it
    });
    it('parses a gateStats message defensively', () => {
        expect(gateCutSecondFrom({})).toBeNull();
        expect(gateCutSecondFrom({ cut: { voiced: 5, gated: 'x', vms: -1, starts: 2, clipped: 1 }, minDb: -63 }))
            .toEqual({ voiced: 5, gated: 0, vms: 0, starts: 2, clipped: 1, closes: 0, minDb: -63 });
    });
});

describe('when the prompt may show, and what is remembered', () => {
    beforeEach(() => mem.clear());
    const base = { gateOn: true, micOpen: true, deafened: false, callSec: 60, shownThisCall: false, store: { dismissals: 0, never: false } };
    it('shows only with the gate on, the mic open, not deafened, after the first seconds, once per call, unless "never"', () => {
        expect(mayPromptForGateCut(base)).toBe(true);
        expect(mayPromptForGateCut({ ...base, gateOn: false })).toBe(false);
        expect(mayPromptForGateCut({ ...base, micOpen: false })).toBe(false); // muted, or push-to-talk with the key up
        expect(mayPromptForGateCut({ ...base, deafened: true })).toBe(false);
        expect(mayPromptForGateCut({ ...base, callSec: GC_MIN_CALL_SEC - 1 })).toBe(false);
        expect(mayPromptForGateCut({ ...base, shownThisCall: true })).toBe(false);
        expect(mayPromptForGateCut({ ...base, store: { dismissals: 5, never: true } })).toBe(false);
    });
    it('dismissals are remembered in the encrypted store; "Don\'t ask again" is offered after two', () => {
        let s = loadGateCutPromptStore();
        expect(offerDontAskAgain(s)).toBe(false);
        s = afterDismiss(s); saveGateCutPromptStore(s);
        s = afterDismiss(loadGateCutPromptStore()); saveGateCutPromptStore(s);
        expect(loadGateCutPromptStore()).toEqual({ dismissals: 2, never: false });
        expect(offerDontAskAgain(loadGateCutPromptStore())).toBe(true);
        saveGateCutPromptStore(afterNever(loadGateCutPromptStore()));
        expect(JSON.parse(mem.get(GATE_CUT_PROMPT_STORAGE_KEY)!)).toEqual({ dismissals: 2, never: true });
    });
});
