import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OwnDevice } from '../utils/staleDevices';

vi.mock('axios', () => ({ default: { post: vi.fn(), get: vi.fn() } }));
vi.mock('../constants', () => ({ API_BASE: 'http://api.test/v1' }));

// The suite's window has no matchMedia; clPhysics reads it at import time.
const w = globalThis as unknown as { window?: { matchMedia?: unknown } };
if (w.window && typeof w.window.matchMedia !== 'function') {
    w.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
}
const { StaleDeviceRows } = await import('./StaleDevicesDialog');
const { staleDialogCopy } = await import('../utils/staleDevices');

// .ts (not .tsx): vitest here only collects *.test.ts, so no JSX.
const h = React.createElement;

const dev = (id: string, over: Partial<OwnDevice> = {}): OwnDevice => ({
    device_id: id, device_name: `PC-${id}`, platform: 'windows', last_active_on: '2026-08-03',
    stale_tier: '30d', stale_prompt_due: true, ...over,
});

describe('StaleDeviceRows', () => {
    it('one row per device with name, platform label, last active and tier badge', () => {
        const out = renderToStaticMarkup(h(StaleDeviceRows, {
            devices: [dev('a', { device_name: 'GAMING-RIG' }), dev('b', { platform: 'android', stale_tier: '180d' })],
            onRemove: vi.fn(), onKeep: vi.fn(),
        }));
        expect(out).toContain('GAMING-RIG');
        expect(out).toContain('Windows');
        expect(out).toContain('Android');
        expect(out).toMatch(/last active (Aug|3)/);
        // The tier rides as the row's tooltip and tints the date; 6 months reads warmer.
        expect(out).toContain('title="Not used in 30+ days"');
        expect(out).toContain('title="Not used in 6+ months"');
        expect(out).toContain('stale-when--old');
        expect(out.match(/>Keep</g)).toHaveLength(2);
        expect(out.match(/>Remove</g)).toHaveLength(2);
    });

    it('escapes a hostile device name (it is user-controlled)', () => {
        const out = renderToStaticMarkup(h(StaleDeviceRows, {
            devices: [dev('a', { device_name: '<img src=x onerror=alert(1)>' })], onRemove: vi.fn(), onKeep: vi.fn(),
        }));
        expect(out).not.toContain('<img src=x');
    });

    it('busy and error states', () => {
        const out = renderToStaticMarkup(h(StaleDeviceRows, {
            devices: [dev('a'), dev('b')],
            state: { a: { busy: 'removing' }, b: { error: 'Nope' } },
            onRemove: vi.fn(), onKeep: vi.fn(),
        }));
        expect(out).toContain('Removing…');
        expect(out).toContain('role="alert"');
        expect(out).toContain('Nope');
    });
});

describe('staleDialogCopy', () => {
    it('singular vs plural, 30-day vs 6-month wording', () => {
        expect(staleDialogCopy([dev('a')])).toMatchObject({
            title: 'Still using this device?', subtitle: 'It hasn’t been used in over a month.',
        });
        expect(staleDialogCopy([dev('a'), dev('b', { stale_tier: '180d' })])).toMatchObject({
            title: 'Still using these devices?', subtitle: 'Some haven’t been used in over 6 months.',
        });
    });

    it('mentions automatic removal only when the server says it is on', () => {
        expect(staleDialogCopy([dev('a')]).autoRemove).toBeNull();
        expect(staleDialogCopy([dev('a', { auto_remove_on: '2027-08-03' })]).autoRemove).toMatch(/removed automatically \(this one on .*2027\)/);
    });
});

describe('wiring', () => {
    it('Dashboard mounts the host once', () => {
        const src = readFileSync(join(__dirname, 'Dashboard.tsx'), 'utf8');
        expect(src.match(/<StaleDevicesHost\b/g)).toHaveLength(1);
    });

    it('the host confirms removal with the house destructive dialog, not window.confirm', () => {
        const src = readFileSync(join(__dirname, 'StaleDevicesHost.tsx'), 'utf8');
        expect(src).toContain('<ConfirmDialog');
        expect(src).not.toContain('window.confirm');
        // Checked once per sign-in on this device, not per reconnect/timer.
        expect(src).not.toContain('wsConnectCount');
        expect(src).not.toContain('setInterval');
    });

    it('Settings → Devices shows the badge (never on this device)', () => {
        const src = readFileSync(join(__dirname, 'settings', 'panes', 'DevicesPane.tsx'), 'utf8');
        expect(src).toContain('{!isCurrent && staleBadge && (');
    });
});
