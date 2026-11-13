import { describe, it, expect } from 'vitest';
import { isPortalSourceId, portalCaptureVideo, PORTAL_SOURCE_NAME } from './portal-source';
import { isPortalSourceId as rendererIsPortalSourceId, newPortalSourceId } from '../src/utils/portalSource';
import { isCaptureSourceId } from './capture-consent';

describe('the portal placeholder source', () => {
    it('main and the renderer agree on what a placeholder is', () => {
        const samples = [
            newPortalSourceId(), newPortalSourceId(), newPortalSourceId('abc'),
            'screen:portal-abc:0', 'screen:portal-0:0', 'screen:portal-ABC:0', 'screen:portal-:0', 'screen:portal-abc',
            'window:portal-abc:0', 'screen:0:0', 'window:1:0', 'screen:portal-abc:0:s', 'screen:portal-a_b:0',
            'screen:portal-12345678901234567:0', 'screen:portal-1234567890123456:0', '', null, undefined, 42, {},
            'screen:portal-abc:1', ' screen:portal-abc:0', 'screen:portal-abc:0\n',
        ];
        for (const s of samples) expect(isPortalSourceId(s), String(s)).toBe(rendererIsPortalSourceId(s));
    });

    it('accepts only the shape the renderer makes; nothing a real listing could have returned', () => {
        expect(isPortalSourceId(newPortalSourceId())).toBe(true);
        for (const real of ['screen:0:0', 'screen:3:0:s', 'window:1:0:s', 'window:132456:0']) expect(isPortalSourceId(real)).toBe(false);
        expect(isPortalSourceId('window:portal-abc:0')).toBe(false); // the kind says nothing about what is shared: one shape
    });

    it('every placeholder is a well-formed capture source id (consent and the IPC check it too)', () => {
        for (let i = 0; i < 50; i++) expect(isCaptureSourceId(newPortalSourceId())).toBe(true);
    });

    it('a new placeholder each time: the difference IS "another capture"', () => {
        const ids = new Set(Array.from({ length: 200 }, () => newPortalSourceId()));
        expect(ids.size).toBe(200);
    });

    it('Chromium is handed an id it can parse (numeric middle part) and a name that is the truth', () => {
        const v = portalCaptureVideo(1);
        expect(v.id).toMatch(/^screen:\d+:\d+$/);
        expect(v.name).toBe(PORTAL_SOURCE_NAME);
        expect(PORTAL_SOURCE_NAME).toBe('Screen or window');
        expect(isCaptureSourceId(v.id)).toBe(true);
    });

    it('every capture gets a NEW id: the same id twice would attach the second capture to the running one (no chooser, a silent no-op)', () => {
        const ids = Array.from({ length: 500 }, (_, i) => portalCaptureVideo(i + 1).id);
        expect(new Set(ids).size).toBe(500);
        expect(portalCaptureVideo(1).id).not.toBe(portalCaptureVideo(2).id);
        // junk never produces a malformed id
        for (const bad of [NaN, -5, 1.9, Infinity]) expect(portalCaptureVideo(bad as number).id).toMatch(/^screen:\d+:0$/);
    });
});
