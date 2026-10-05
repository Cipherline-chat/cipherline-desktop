import { describe, it, expect } from 'vitest';
import {
    isTrustedSenderUrl,
    channelRequiresSenderCheck,
    UNGUARDED_IPC_CHANNELS,
} from './ipc-guard';

const PROD_PORT = 42917;
const SMOKE_PORT = 42918;

describe('isTrustedSenderUrl — packaged build (no dev server)', () => {
    it('accepts the app origin on the fixed loopback port', () => {
        expect(isTrustedSenderUrl(`http://127.0.0.1:${PROD_PORT}/`, undefined, PROD_PORT)).toBe(true);
        expect(isTrustedSenderUrl(`http://127.0.0.1:${PROD_PORT}/index.html`, undefined, PROD_PORT)).toBe(true);
    });

    it('accepts the smoke-test port when that is the configured port', () => {
        expect(isTrustedSenderUrl(`http://127.0.0.1:${SMOKE_PORT}/`, undefined, SMOKE_PORT)).toBe(true);
    });

    it('rejects a different loopback port', () => {
        // Another program listening on loopback is not our renderer.
        expect(isTrustedSenderUrl(`http://127.0.0.1:${SMOKE_PORT}/`, undefined, PROD_PORT)).toBe(false);
        expect(isTrustedSenderUrl('http://127.0.0.1:3005/', undefined, PROD_PORT)).toBe(false);
    });

    it('rejects a userinfo-prefixed URL that only LOOKS like loopback', () => {
        // The regression this replaced: `senderUrl.startsWith('http://127.0.0.1:')`
        // matches every one of these, and every one of them has a host that is
        // not 127.0.0.1.
        expect(isTrustedSenderUrl(`http://127.0.0.1:${PROD_PORT}@evil.example/`, undefined, PROD_PORT)).toBe(false);
        expect(isTrustedSenderUrl(`http://127.0.0.1:pw@evil.example/`, undefined, PROD_PORT)).toBe(false);
        expect(isTrustedSenderUrl(`http://127.0.0.1:${PROD_PORT}.evil.example/`, undefined, PROD_PORT)).toBe(false);
    });

    it('rejects https, other hosts, and non-http schemes on the right port', () => {
        expect(isTrustedSenderUrl(`https://127.0.0.1:${PROD_PORT}/`, undefined, PROD_PORT)).toBe(false);
        expect(isTrustedSenderUrl(`http://localhost:${PROD_PORT}/`, undefined, PROD_PORT)).toBe(false);
        expect(isTrustedSenderUrl(`file:///C:/app/index.html`, undefined, PROD_PORT)).toBe(false);
    });

    it('rejects empty, missing and unparseable sender URLs', () => {
        expect(isTrustedSenderUrl('', undefined, PROD_PORT)).toBe(false);
        expect(isTrustedSenderUrl(undefined, undefined, PROD_PORT)).toBe(false);
        expect(isTrustedSenderUrl(null, undefined, PROD_PORT)).toBe(false);
        expect(isTrustedSenderUrl('not a url', undefined, PROD_PORT)).toBe(false);
    });
});

describe('isTrustedSenderUrl — dev build (dev server configured)', () => {
    const DEV = 'http://cipherline.chat:5174';

    it('accepts the dev server origin', () => {
        expect(isTrustedSenderUrl(`${DEV}/`, DEV, PROD_PORT)).toBe(true);
        expect(isTrustedSenderUrl(`${DEV}/src/main.tsx`, DEV, PROD_PORT)).toBe(true);
    });

    it('accepts a localhost dev server, which is what `npm run dev` uses', () => {
        expect(isTrustedSenderUrl('http://localhost:5174/', 'http://localhost:5174', PROD_PORT)).toBe(true);
    });

    it('rejects a different port on the same dev host', () => {
        expect(isTrustedSenderUrl('http://cipherline.chat:5175/', DEV, PROD_PORT)).toBe(false);
    });

    it('rejects a different host on the dev port', () => {
        expect(isTrustedSenderUrl('http://evil.example:5174/', DEV, PROD_PORT)).toBe(false);
    });

    it('does NOT fall back to the loopback rule while a dev server is set', () => {
        // Dev and prod are alternatives, not a union — otherwise anything that
        // could bind loopback would be trusted on a dev machine too.
        expect(isTrustedSenderUrl(`http://127.0.0.1:${PROD_PORT}/`, DEV, PROD_PORT)).toBe(false);
    });
});

describe('UNGUARDED_IPC_CHANNELS', () => {
    it('is empty — every IPC channel in this app is origin-checked', () => {
        // If this fails, someone exempted a channel. That is allowed, but it is
        // a deliberate act: read the criteria in ipc-guard.ts and make sure the
        // entry says which window legitimately sends on it.
        expect([...UNGUARDED_IPC_CHANNELS]).toEqual([]);
    });

    it('requires the sender check for the channels that have actually been abused or nearly abused', () => {
        for (const ch of ['updater:set-channel', 'fs:read-file', 'fs:unlink', 'dialog:save', 'secure:get-many']) {
            expect(channelRequiresSenderCheck(ch)).toBe(true);
        }
    });

    it('requires the sender check for an arbitrary brand-new channel', () => {
        // The point of the wrapper: a channel nobody has thought about yet is
        // guarded, not unguarded, by default.
        expect(channelRequiresSenderCheck('some:channel-added-next-year')).toBe(true);
    });
});
