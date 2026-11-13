import { describe, it, expect, beforeEach } from 'vitest';
import {
    applyRemoteAttention, isMobileAttentive, resetRemoteAttention, REMOTE_ATTENTION_FRESH_MS,
} from './remoteAttention';
import { gateOnOtherDeviceAttention, type NotifDecision } from './notificationDecision';

const loud: NotifDecision = { isMention: false, countsMention: false, countsUnread: true, playsSound: true, showsToast: true };

beforeEach(() => resetRemoteAttention());

describe('remoteAttention store', () => {
    it('starts unknown = not attentive', () => {
        expect(isMobileAttentive()).toBe(false);
    });

    it('true only for a boolean true, only while fresh', () => {
        const t = 1_000_000;
        applyRemoteAttention({ mobile_attentive: true }, t);
        expect(isMobileAttentive(t)).toBe(true);
        expect(isMobileAttentive(t + REMOTE_ATTENTION_FRESH_MS)).toBe(true);
        expect(isMobileAttentive(t + REMOTE_ATTENTION_FRESH_MS + 1)).toBe(false);
    });

    it('a clock that went backwards never reads as attentive', () => {
        applyRemoteAttention({ mobile_attentive: true }, 5_000);
        expect(isMobileAttentive(4_000)).toBe(false);
    });

    it('the latest answer wins, both ways', () => {
        const t = 10;
        applyRemoteAttention({ mobile_attentive: true }, t);
        applyRemoteAttention({ mobile_attentive: false }, t + 1);
        expect(isMobileAttentive(t + 2)).toBe(false);
        applyRemoteAttention({ mobile_attentive: true }, t + 3);
        expect(isMobileAttentive(t + 4)).toBe(true);
    });

    it.each([[undefined], [null], [{}], [{ mobile_attentive: 1 }], [{ mobile_attentive: 'true' }], ['x'], [42]])(
        'malformed payload %j reads as unknown (false), never carrying a previous true',
        (data) => {
            applyRemoteAttention({ mobile_attentive: true }, 1);
            applyRemoteAttention(data, 2);
            expect(isMobileAttentive(3)).toBe(false);
        },
    );

    it('reset forgets', () => {
        applyRemoteAttention({ mobile_attentive: true });
        resetRemoteAttention();
        expect(isMobileAttentive()).toBe(false);
    });
});

describe('gateOnOtherDeviceAttention', () => {
    it('phone attentive → sound and toast off, counters untouched', () => {
        const out = gateOnOtherDeviceAttention(loud, { category: 'message', mobileAttentive: true });
        expect(out.playsSound).toBe(false);
        expect(out.showsToast).toBe(false);
        expect(out.countsUnread).toBe(true);
        expect(out.countsMention).toBe(loud.countsMention);
        expect(out.isMention).toBe(loud.isMention);
    });

    it('does not mutate its input', () => {
        const input = { ...loud };
        gateOnOtherDeviceAttention(input, { category: 'message', mobileAttentive: true });
        expect(input).toEqual(loud);
    });

    it('phone not attentive → the decision is returned as is', () => {
        expect(gateOnOtherDeviceAttention(loud, { category: 'message', mobileAttentive: false })).toBe(loud);
    });

    it('a call is never gated', () => {
        expect(gateOnOtherDeviceAttention(loud, { category: 'call', mobileAttentive: true })).toBe(loud);
    });
});

/**
 * useRealtime cannot load under vitest's node environment, so its WIRING is
 * pinned by source: both frames feed the store, and every path that loses the
 * socket forgets the answer (unknown must read as "notify").
 */
describe('useRealtime wiring', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '..', 'hooks', 'useRealtime.ts'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

    it('feeds presence:ack and presence:attention into the store', () => {
        expect(src).toMatch(/msg\.event === 'presence:ack' \|\| msg\.event === 'presence:attention'\)\s*\{\s*applyRemoteAttention\(msg\.data\);/);
    });

    it('resets on socket close, on forced reconnect and on teardown', () => {
        expect(src.match(/resetRemoteAttention\(\)/g)?.length).toBeGreaterThanOrEqual(3);
    });
});

describe('the notification dispatcher is the single gated path', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(__dirname, '..', 'hooks', 'useNotificationDispatch.ts'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

    it('sound, toast and taskbar flash all read the gated decision', () => {
        expect(src).toContain('gateOnOtherDeviceAttention(resolved,');
        expect(src).toContain('isMobileAttentive()');
        // the flash sits inside the toast branch, which reads `decision.showsToast`
        const toastBranch = src.indexOf('if (decision.showsToast');
        const flash = src.indexOf('notifFlashTaskbar');
        expect(toastBranch).toBeGreaterThan(-1);
        expect(flash).toBeGreaterThan(toastBranch);
        expect(src).toContain('decision.playsSound');
    });
});
