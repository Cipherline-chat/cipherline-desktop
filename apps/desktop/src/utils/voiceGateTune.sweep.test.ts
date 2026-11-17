import { describe, it, vi } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { runWindow, backgroundVoicePass, type WindowSpec, type EventKind } from './voiceGateHarness';

vi.mock('../workers/rnnoise.worker?worker', () => ({ default: class {} }));

/**
 * Heavy offline sweep behind GATE_SWEEP=<mode> (skipped in normal runs). Prints the tables that go in
 * docs/worklog/entries/2026-11-16-gate-data-tune.md. Inputs: GATE_CSV = the exported mic_level rows.
 */
const MODE = process.env.GATE_SWEEP;
const AUTO = [{ type: 'gate', enabled: true }, { type: 'threshold', value: -45 }, { type: 'auto', value: true }];

function v010Source(): string {
    const src = execSync('git show v0.1.0:apps/desktop/src/utils/voiceProcessor.ts', { encoding: 'utf8', maxBuffer: 1 << 26 });
    const a = src.indexOf('export const GATE_WORKLET_SOURCE = `') + 'export const GATE_WORKLET_SOURCE = `'.length;
    const b = src.indexOf('\n`;', a);
    return src.slice(a, b);
}

interface Row { rid: string; uid: string; ver: string; thr: number; gate: string; speech: number; talk: number; gatePct: number }
function rows(): Row[] {
    const lines = readFileSync(process.env.GATE_CSV!, 'utf8').split('\n').filter(l => l.split(',').length === 20 && !l.startsWith('rid'));
    return lines.map(l => { const f = l.split(','); return { rid: f[0], uid: f[1], ver: f[2], thr: +f[5], gate: f[6], speech: +f[11], talk: +f[16], gatePct: +f[15] }; }).filter(r => Number.isFinite(r.speech));
}

describe.skipIf(!MODE)('gate sweep', () => {
    it('runs', async () => {
        const { GATE_WORKLET_SOURCE } = await import('./voiceProcessor');
        const cur = GATE_WORKLET_SOURCE;
        const old = v010Source();
        const cfg = JSON.parse(process.env.GATE_CFG ?? '{}') as Record<string, { src: 'cur' | 'old'; ov: Record<string, number> }>;
        const spec = JSON.parse(process.env.GATE_SPEC ?? '{}') as { floors: number[]; events: EventKind; seconds: number; seeds: number; rowFilter?: string; maxRows?: number; speechOverride?: number[]; duty?: number; maxGapSec?: number; manualThr?: number; sigma?: number; phraseSigma?: number; eventBoost?: number };
        let rs = rows();
        if (spec.rowFilter) rs = rs.filter(r => r.rid.startsWith(spec.rowFilter!));
        if (spec.maxRows) rs = rs.filter((_, i) => i % Math.ceil(rs.length / spec.maxRows!) === 0);
        const out: unknown[] = [];
        if (MODE === 'bg') {
            for (const [name, c] of Object.entries(cfg)) {
                for (const sp of [-40, -30]) for (const off of [12, 18, 24, 30, 36]) for (const fl of [-80, -70]) {
                    out.push({ cfg: name, speech: sp, offset: off, floor: fl, pass: backgroundVoicePass(c.src === 'old' ? old : cur, c.ov, sp, off, fl) });
                }
            }
            writeFileSync(process.env.GATE_OUT!, JSON.stringify(out));
            return;
        }
        for (const [name, c] of Object.entries(cfg)) {
            const source = c.src === 'old' ? old : cur;
            for (const floor of spec.floors) {
                for (const r of rs) {
                    for (let sd = 1; sd <= spec.seeds; sd++) {
                        const w: WindowSpec = { speechDb: r.speech, duty: spec.duty ?? r.talk / 100, floorDb: floor, seconds: spec.seconds, seed: sd, events: spec.events, maxGapSec: spec.maxGapSec, sigmaDb: spec.sigma, phraseSigmaDb: spec.phraseSigma, eventBoostDb: spec.eventBoost };
                        const msgs = spec.manualThr !== undefined ? [{ type: 'gate', enabled: true }, { type: 'threshold', value: spec.manualThr }, { type: 'auto', value: false }] : AUTO;
                        const res = runWindow(source, msgs, c.ov, w);
                        out.push({ cfg: name, floor, rid: r.rid, speech: r.speech, talk: r.talk, gatePct: r.gatePct, ...res });
                    }
                }
            }
        }
        writeFileSync(process.env.GATE_OUT!, JSON.stringify(out));
    }, 3_600_000);
});
