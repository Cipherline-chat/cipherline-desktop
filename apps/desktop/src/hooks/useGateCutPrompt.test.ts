// @vitest-environment jsdom
/**
 * The "Your voice gate may be cutting you off" prompt in a call: when it shows and never shows, what its buttons write
 * (the same setters as the Settings slider / toggle), and the `gate_cut` diagnostics event.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const mem = vi.hoisted(() => new Map<string, string>());
vi.mock('../utils/secureLocalStore', () => ({
    default: { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } },
}));
const events = vi.hoisted(() => [] as Array<{ kind: string; detail?: Record<string, unknown> }>);
vi.mock('../utils/callEventLog', () => ({ logCallEvent: (kind: string, detail?: Record<string, unknown>) => { events.push({ kind, detail }); } }));

import { useGateCutPrompt, type GateCutPrompt } from './useGateCutPrompt';
import { publishGateCutSecond, type GateCutSecond } from '../utils/gateCut';
import { GC_MIN_CALL_SEC, GATE_CUT_PROMPT_STORAGE_KEY } from '../utils/gateCutPrompt';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A second of a quiet talker the -45 gate keeps cutting: 150 voice blocks (0.4 s), a third of them gated, voice ~-44. */
const cutSecond = (): GateCutSecond => ({ voiced: 150, gated: 50, vms: 150 * 10 ** (-4.4), starts: 1, clipped: 1, closes: 1, minDb: -75 });
/** A second of a talker the gate never touches. */
const fineSecond = (): GateCutSecond => ({ voiced: 150, gated: 0, vms: 150 * 10 ** (-3), starts: 1, clipped: 0, closes: 0, minDb: -75 });

let root: Root;
let host: HTMLDivElement;
let clock = 0;
let seen: ReturnType<typeof useGateCutPrompt>;
const setThreshold = vi.fn();
const setGate = vi.fn();
interface Props { room: object; gateOn?: boolean; micOpen?: boolean; deafened?: boolean; thresholdDb?: number }
const Probe: React.FC<Props> = ({ room, gateOn = true, micOpen = true, deafened = false, thresholdDb = -45 }) => {
    seen = useGateCutPrompt({ room: room as never, gateOn, thresholdDb, micOpen, deafened, setThreshold, setGate, now: () => clock });
    return null;
};
const render = (p: Props) => act(() => root.render(React.createElement(Probe, p)));
/** `n` seconds of reports, one per (fake) second. */
const feed = (n: number, mk: () => GateCutSecond = cutSecond) => {
    for (let i = 0; i < n; i++) { clock += 1000; act(() => publishGateCutSecond(mk())); }
};
const prompt = (): GateCutPrompt | null => seen.prompt;

beforeEach(() => {
    mem.clear(); events.length = 0; setThreshold.mockReset(); setGate.mockReset(); clock = 1_000_000;
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('useGateCutPrompt', () => {
    it('shows once a quiet talker has been cut for long enough, logs gate_cut, and "Lower" writes the suggested threshold', () => {
        render({ room: {} });
        feed(GC_MIN_CALL_SEC + 40);
        expect(prompt()).not.toBeNull();
        const d = prompt()!.detection;
        expect(d.suggestDb).toBe(-59); // 15 dB under the -44 voice
        const ev = events.find(e => e.kind === 'gate_cut')!;
        expect(ev.detail).toMatchObject({ thr_db: -45, suggest_db: -59, gated_pct: 33 });
        expect(Object.values(ev.detail!).every(v => typeof v === 'number')).toBe(true); // numbers only
        expect(events.some(e => e.kind === 'gate_cut_prompt' && e.detail?.action === 'shown')).toBe(true);
        act(() => seen.lower());
        expect(setThreshold).toHaveBeenCalledWith(-59);
        expect(prompt()).toBeNull();
    });

    it('"Turn off voice gate" switches the gate off through its setter', () => {
        render({ room: {} });
        feed(GC_MIN_CALL_SEC + 40);
        act(() => seen.turnOff());
        expect(setGate).toHaveBeenCalledWith(false);
        expect(setThreshold).not.toHaveBeenCalled();
    });

    it('CONTROL: a talker the gate does not cut never gets it', () => {
        render({ room: {} });
        feed(GC_MIN_CALL_SEC + 120, fineSecond);
        expect(prompt()).toBeNull();
    });

    for (const [name, props] of [['muted / push-to-talk key up', { micOpen: false }], ['deafened', { deafened: true }], ['gate off', { gateOn: false }]] as const) {
        it(`never while ${name}: those seconds are not even evidence`, () => {
            const room = {};
            render({ room, ...props });
            feed(GC_MIN_CALL_SEC + 60);
            expect(prompt()).toBeNull();
            // back to normal: the evidence starts from scratch, so not straight away
            render({ room });
            feed(2);
            expect(prompt()).toBeNull();
        });
    }

    it('not in the first seconds of a call even with evidence; it can show once the call is old enough', () => {
        render({ room: {} });
        const d = (n: number) => feed(n);
        d(GC_MIN_CALL_SEC - 2);
        expect(prompt()).toBeNull();
        d(60);
        expect(prompt()).not.toBeNull();
    });

    it('at most once per call: after Dismiss, more cutting in the same call shows nothing; a new call can show it', () => {
        const room = {};
        render({ room });
        feed(GC_MIN_CALL_SEC + 40);
        act(() => seen.dismiss());
        feed(120);
        expect(prompt()).toBeNull();
        render({ room: {} });
        feed(GC_MIN_CALL_SEC + 40);
        expect(prompt()).not.toBeNull();
    });

    it('a changed threshold restarts the evidence (the user moved the slider)', () => {
        const room = {};
        render({ room });
        feed(GC_MIN_CALL_SEC + 10); // evidence almost enough
        render({ room, thresholdDb: -50 });
        feed(3);
        expect(prompt()).toBeNull();
    });

    it('"Don\'t ask again" is offered after two dismissals and then silences it for good', () => {
        for (let i = 0; i < 2; i++) {
            render({ room: {} });
            feed(GC_MIN_CALL_SEC + 40);
            expect(prompt()!.offerNever).toBe(false);
            act(() => seen.dismiss());
            act(() => root.unmount()); root = createRoot(host);
        }
        render({ room: {} });
        feed(GC_MIN_CALL_SEC + 40);
        expect(prompt()!.offerNever).toBe(true);
        act(() => seen.neverAskAgain());
        expect(JSON.parse(mem.get(GATE_CUT_PROMPT_STORAGE_KEY)!)).toEqual({ dismissals: 3, never: true });
        act(() => root.unmount()); root = createRoot(host);
        render({ room: {} });
        feed(GC_MIN_CALL_SEC + 60);
        expect(prompt()).toBeNull();
    });

    it('the in-call pill is no longer mounted: the automatic voice gate it talks about is gone (the new audio engine is the only engine)', () => {
        const dir = dirname(fileURLToPath(import.meta.url));
        const src = readFileSync(join(dir, '..', 'components', 'SidebarConference.tsx'), 'utf8');
        expect(src).not.toMatch(/useGateCutPrompt/);
        expect(src).not.toMatch(/data-testid="gate-cut-prompt"/);
    });
});
