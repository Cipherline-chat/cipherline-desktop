/**
 * Bridges from existing diagnostics into beta events, plus a source-scan that
 * every contract event kind has a real emitter wired into the app (a module
 * tested in isolation but never called is the failure mode this guards).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deliveryEntryToBeta, callEventToBeta, freezePhase, installBetaBridges, APP_FREEZE_MS } from './bridges';
import { betaReporter } from './reporter';
import { BETA_EVENT_KINDS } from './types';
import { recordLongTask, WAKE_SETTLE_MS } from '../freezeLog';
import { record as recordDelivery } from '../deliveryDiagnostics';
import { logCallEvent } from '../callEventLog';

const on = () => { betaReporter.setServerEnabled(true); betaReporter.setLocalEnabled(true); betaReporter.setSignedIn(true); };
afterEach(() => { betaReporter.setSignedIn(false); betaReporter.setServerEnabled(false); });

describe('bridge mappings', () => {
    it('delivery diagnostics → key / message kinds', () => {
        expect(deliveryEntryToBeta({ kind: 'message_decrypt', code: 'BAD_MAC', ctx: {} })).toEqual({ kind: 'key_decrypt_failed', detail: { scope: 'dm', code: 'BAD_MAC' } });
        expect(deliveryEntryToBeta({ kind: 'channel_key_decrypt', code: 'HTTP_500', ctx: { status: 500 } })).toEqual({ kind: 'key_decrypt_failed', detail: { scope: 'channel_key', code: 'HTTP_500', status: 500 } });
        expect(deliveryEntryToBeta({ kind: 'message_ack', code: 'UNKNOWN', ctx: {} })?.kind).toBe('msg_fetch_gap');
        expect(deliveryEntryToBeta({ kind: 'message_encrypt', code: 'X', ctx: {} })?.kind).toBe('msg_send_failed');
        expect(deliveryEntryToBeta({ kind: 'channel_key_distribute', code: 'X', ctx: {} })).toBeNull();
    });
    it('call event log → call kinds', () => {
        expect(callEventToBeta('reconnecting', undefined)).toEqual({ kind: 'call_reconnect' });
        expect(callEventToBeta('e2ee_decrypt_error', { reason: 'missing_key' })?.kind).toBe('call_e2ee_error');
        expect(callEventToBeta('share_start', { verdict: 'ok' })).toBeNull();
        expect(callEventToBeta('share_start', { verdict: 'failed', why: 'NotAllowedError' })).toMatchObject({ kind: 'share_failed', detail: { stage: 'start', why: 'NotAllowedError' } });
        expect(callEventToBeta('share_start_check', { verdict: 'stalled', codec: 'h264' })?.kind).toBe('share_failed');
        expect(callEventToBeta('camera_encoder_stall', { codec: 'vp8' })?.kind).toBe('camera_failed');
        expect(callEventToBeta('mic_device_switch', { verdict: 'ok' })).toBeNull();
        expect(callEventToBeta('mic_device_switch', { verdict: 'failed' })?.kind).toBe('mic_failed');
        expect(callEventToBeta('gpu_process_restarted', { reason: 'crashed' })?.kind).toBe('gpu_fallback');
        expect(callEventToBeta('freeze_start', {})).toBeNull();
    });
    it('freeze phase is the first static label', () => {
        expect(freezePhase('dm:pull, js:index.js:fn:c1:300ms')).toBe('dm:pull');
        expect(freezePhase('idle')).toBeUndefined();
    });
});

describe('installed bridges', () => {
    it('route live reports into the reporter only while active', () => {
        vi.useFakeTimers();
        const off = installBetaBridges();
        try {
            recordLongTask(0, APP_FREEZE_MS + 200);
            recordDelivery('message_decrypt', new Error('[E2EE:BAD_MAC] x'));
            vi.advanceTimersByTime(WAKE_SETTLE_MS);
            expect(betaReporter.peekQueue()).toHaveLength(0);
            on();
            recordLongTask(0, APP_FREEZE_MS - 1);  // perf-log stall, not an app_freeze
            recordLongTask(0, APP_FREEZE_MS + 200);
            recordDelivery('message_decrypt', new Error('[E2EE:BAD_MAC] x'));
            logCallEvent('reconnecting');
            // app_freeze waits out the sleep / hidden-window guard (freezeLog WAKE_SETTLE_MS).
            vi.advanceTimersByTime(WAKE_SETTLE_MS);
            expect(betaReporter.peekQueue().map(e => e.kind)).toEqual(['key_decrypt_failed', 'call_reconnect', 'app_freeze']);
        } finally {
            vi.useRealTimers();
            off();
        }
    });
});

describe('wiring: every contract kind has an emitter in the app', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = join(here, '..', '..');
    const files: string[] = [];
    const walk = (d: string) => {
        for (const n of readdirSync(d)) {
            const p = join(d, n);
            if (statSync(p).isDirectory()) walk(p);
            else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) files.push(p);
        }
    };
    walk(src);
    const text = files.map(f => readFileSync(f, 'utf8')).join('\n');
    it.each(BETA_EVENT_KINDS.map(k => [k]))('%s', (kind) => {
        const direct = new RegExp(`reportBeta\\(\\s*'${kind}'`).test(text);
        const bridged = new RegExp(`kind: '${kind}'`).test(readFileSync(join(here, 'bridges.ts'), 'utf8'));
        const detector = new RegExp(`'${kind}'`).test(readFileSync(join(here, 'detectors.ts'), 'utf8'));
        expect(direct || bridged || detector, `${kind} has no emitter`).toBe(true);
    });
    it('the host, the call monitor and the gate are mounted', () => {
        const read = (p: string) => readFileSync(join(src, p), 'utf8');
        expect(read('App.tsx')).toMatch(/<BetaDiagnosticsHost \/>/);
        expect(read('components/CallPane.tsx')).toMatch(/<BetaCallMonitor \/>/);
        expect(read('components/CallPane.tsx')).toMatch(/beginBetaCall\(/);
        expect(read('components/ClientControlGate.tsx')).toMatch(/betaReporter\.setServerEnabled\(s\.betaDiagnostics\)/);
        expect(read('components/diagnostics/ReportProblemCard.tsx')).toMatch(/<BetaDiagnosticsSetting /);
        expect(read('components/Dashboard.tsx')).toMatch(/noteBetaKeyAsked\(/);
        expect(read('components/Dashboard.tsx')).toMatch(/noteBetaCallKeyGate\(/);
        expect(read('components/ChatPane.tsx')).toMatch(/watchPendingSend\(/);
        expect(read('utils/channelKeyWait.ts')).toMatch(/noteBetaKeyReceived\(/);
    });
});
