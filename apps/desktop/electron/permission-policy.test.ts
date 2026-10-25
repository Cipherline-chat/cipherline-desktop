import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appOriginsFor, decidePermissionRequest, type PermissionRequestFacts } from './permission-policy';

const PROD = appOriginsFor(undefined, 42917);
const DEV = appOriginsFor('https://cipherline.chat:5174/', 42917);
const APP = 'http://127.0.0.1:42917/';
const YT = 'https://www.youtube-nocookie.com/embed/abc?origin=x';
const STRIPE = 'https://js.stripe.com/v3/elements-inner.html';

describe('appOriginsFor', () => {
    it('prod is the loopback dist server origin; dev is the Vite origin', () => {
        expect(PROD).toEqual(['http://127.0.0.1:42917']);
        expect(appOriginsFor(undefined, 42918)).toEqual(['http://127.0.0.1:42918']); // smoke-test port
        expect(DEV).toEqual(['https://cipherline.chat:5174']);
        expect(appOriginsFor('not a url', 1)).toEqual([]);
    });
});

describe('decidePermissionRequest', () => {
    type Row = [string, PermissionRequestFacts, boolean];
    const rows: Row[] = [
        // Positive controls — what the real app needs.
        ['app main frame: mic/camera', { permission: 'media', requestingUrl: APP, isMainFrame: true, securityOrigin: APP, topLevelUrl: APP }, true],
        ['app main frame: media without securityOrigin', { permission: 'media', requestingUrl: APP, isMainFrame: true, topLevelUrl: APP }, true],
        ['app main frame: speaker selection', { permission: 'speaker-selection', requestingUrl: APP, isMainFrame: true, topLevelUrl: APP }, true],
        ['app main frame: fullscreen (<video controls>)', { permission: 'fullscreen', requestingUrl: APP, isMainFrame: true, topLevelUrl: APP }, true],
        ['app deep route still the app origin', { permission: 'media', requestingUrl: APP + '#/dash', isMainFrame: true, topLevelUrl: APP + '#/dash' }, true],
        ['YouTube embed fullscreen inside the app', { permission: 'fullscreen', requestingUrl: YT, isMainFrame: false, topLevelUrl: APP }, true],

        // Negative — third-party frames inside the app.
        ['YouTube embed asking for mic', { permission: 'media', requestingUrl: YT, isMainFrame: false, securityOrigin: YT, topLevelUrl: APP }, false],
        ['Stripe frame asking for mic', { permission: 'media', requestingUrl: STRIPE, isMainFrame: false, topLevelUrl: APP }, false],
        ['Stripe frame asking for speaker selection', { permission: 'speaker-selection', requestingUrl: STRIPE, isMainFrame: false, topLevelUrl: APP }, false],
        ['Stripe frame asking for fullscreen', { permission: 'fullscreen', requestingUrl: STRIPE, isMainFrame: false, topLevelUrl: APP }, false],
        ['app-origin subframe asking for mic', { permission: 'media', requestingUrl: APP, isMainFrame: false, topLevelUrl: APP }, false],
        ['media whose securityOrigin disagrees', { permission: 'media', requestingUrl: APP, isMainFrame: true, securityOrigin: YT, topLevelUrl: APP }, false],

        // Negative — wrong top-level page.
        ['top-level page is not the app', { permission: 'media', requestingUrl: 'https://evil.example/', isMainFrame: true, topLevelUrl: 'https://evil.example/' }, false],
        ['other loopback port', { permission: 'media', requestingUrl: 'http://127.0.0.1:8080/', isMainFrame: true, topLevelUrl: 'http://127.0.0.1:8080/' }, false],
        ['YouTube fullscreen when top-level is not the app', { permission: 'fullscreen', requestingUrl: YT, isMainFrame: false, topLevelUrl: 'https://evil.example/' }, false],
        ['YouTube as top-level page', { permission: 'fullscreen', requestingUrl: YT, isMainFrame: true, topLevelUrl: YT }, false],
        ['file:// splash', { permission: 'fullscreen', requestingUrl: 'file:///tmp/splash.html', isMainFrame: true, topLevelUrl: 'file:///tmp/splash.html' }, false],
        ['missing URLs fail closed', { permission: 'media' }, false],

        // Negative — permissions the app never asks for.
        ['geolocation from the app', { permission: 'geolocation', requestingUrl: APP, isMainFrame: true, topLevelUrl: APP }, false],
        ['notifications from the app', { permission: 'notifications', requestingUrl: APP, isMainFrame: true, topLevelUrl: APP }, false],
        ['clipboard-read from the app', { permission: 'clipboard-read', requestingUrl: APP, isMainFrame: true, topLevelUrl: APP }, false],
    ];
    it.each(rows)('%s', (_name, facts, expected) => {
        expect(decidePermissionRequest(facts, PROD)).toBe(expected);
    });

    it('dev: the Vite origin is the app; the prod loopback origin is not', () => {
        const dev = 'https://cipherline.chat:5174/';
        expect(decidePermissionRequest({ permission: 'media', requestingUrl: dev, isMainFrame: true, topLevelUrl: dev }, DEV)).toBe(true);
        expect(decidePermissionRequest({ permission: 'media', requestingUrl: APP, isMainFrame: true, topLevelUrl: APP }, DEV)).toBe(false);
    });
});

describe('wiring', () => {
    const main = readFileSync(join(__dirname, 'main.ts'), 'utf8');
    it('main.ts gates the permission request handler on decidePermissionRequest before any grant', () => {
        const start = main.indexOf('setPermissionRequestHandler(');
        expect(start).toBeGreaterThan(-1);
        const body = main.slice(start, start + 4000);
        const gate = body.indexOf('decidePermissionRequest(');
        const firstGrant = body.indexOf('callback(true)');
        expect(gate).toBeGreaterThan(-1);
        expect(gate).toBeLessThan(firstGrant);
        expect(main).toMatch(/appOriginsFor\(DEV_SERVER_URL, CIPHERLINE_PROD_PORT\)/);
    });
});
