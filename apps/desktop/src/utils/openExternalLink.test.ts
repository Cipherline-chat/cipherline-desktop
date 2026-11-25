import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openExternalLink } from './openExternalLink';
import {
    cancelLeave, confirmLeave, getLeaveSnapshot, registerLeaveHost,
} from './externalLinks/leaveGate';
import { hasUserGesture, setUserGestureProbeForTests } from './externalLinks/shellOpen';

/** Whether the call happens inside a real click / key press (see shellOpen.hasUserGesture). */
function setGesture(active: boolean | null) {
    setUserGestureProbeForTests(active === null ? null : () => active);
}

describe('openExternalLink', () => {
    const originalElectronAPI = window.electronAPI;
    const originalOpen = window.open;
    let openExternal: ReturnType<typeof vi.fn>;
    let unregister: () => void;

    beforeEach(() => {
        window.open = vi.fn();
        openExternal = vi.fn().mockResolvedValue(undefined);
        window.electronAPI = { ...(window.electronAPI ?? {}), openExternal } as typeof window.electronAPI;
        setGesture(true);
        unregister = registerLeaveHost();
    });

    afterEach(() => {
        const pending = getLeaveSnapshot();
        if (pending) cancelLeave(pending.id);
        unregister();
        window.electronAPI = originalElectronAPI;
        window.open = originalOpen;
        setUserGestureProbeForTests(null);
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    describe('scheme validation (unchanged: main allows https: and mailto: only)', () => {
        it('rejects http:// — the electron/main.ts handler deliberately blocks it (MITM downgrade)', () => {
            expect(openExternalLink('http://example.com')).toEqual({ ok: false, reason: 'disallowed-scheme' });
            expect(openExternal).not.toHaveBeenCalled();
            expect(getLeaveSnapshot()).toBeNull();
        });

        it.each([
            'javascript:alert(1)',
            'file:///etc/passwd',
            'data:text/html,<script>alert(1)</script>',
            'ms-msdt:/id PCWDiagnostic',
        ])('rejects dangerous scheme %s without reaching any sink or the dialog — even as source app', (url) => {
            expect(openExternalLink(url).ok).toBe(false);
            expect(openExternalLink(url, { source: 'app' }).ok).toBe(false);
            expect(openExternal).not.toHaveBeenCalled();
            expect(window.open).not.toHaveBeenCalled();
            expect(getLeaveSnapshot()).toBeNull();
        });

        it('rejects an unparseable string', () => {
            expect(openExternalLink('not a url at all')).toEqual({ ok: false, reason: 'unparseable' });
        });

        it('a javascript: scheme hidden behind tabs/newlines never reaches a sink', () => {
            for (const u of ['\tjavascript:alert(1)', 'java\nscript:alert(1)', 'java\tscript:alert(1)', ' \u0001javascript:alert(1)']) {
                expect(openExternalLink(u).ok).toBe(false);
            }
            expect(openExternal).not.toHaveBeenCalled();
            expect(window.open).not.toHaveBeenCalled();
        });
    });

    describe('the leaving-Cipherline gate', () => {
        it('an untrusted link raises the dialog and opens NOTHING until Visit', () => {
            expect(openExternalLink('https://example.com/path')).toEqual({ ok: true, opened: 'after-confirm' });
            expect(openExternal).not.toHaveBeenCalled();
            const req = getLeaveSnapshot()!;
            expect(req.model.href).toBe('https://example.com/path');
            expect(req.model.kind).toBe('https');

            expect(confirmLeave(req.id)).toEqual({ ok: true, trusted: false });
            expect(openExternal).toHaveBeenCalledTimes(1);
            expect(openExternal).toHaveBeenCalledWith('https://example.com/path');
            expect(getLeaveSnapshot()).toBeNull();
        });

        it('Cancel opens nothing', () => {
            openExternalLink('https://example.com/');
            cancelLeave(getLeaveSnapshot()!.id);
            expect(getLeaveSnapshot()).toBeNull();
            expect(openExternal).not.toHaveBeenCalled();
        });

        it('mailto: asks too', () => {
            expect(openExternalLink('mailto:someone@example.com')).toEqual({ ok: true, opened: 'after-confirm' });
            expect(openExternal).not.toHaveBeenCalled();
            expect(getLeaveSnapshot()!.model.kind).toBe('mailto');
            confirmLeave(getLeaveSnapshot()!.id);
            expect(openExternal).toHaveBeenCalledWith('mailto:someone@example.com');
        });

        it.each([
            'https://cipherline.chat/privacy',
            'https://www.cipherline.chat/download',
            'mailto:support@cipherline.chat',
        ])('built-in trusted %s opens directly (with a gesture), no dialog', (url) => {
            expect(openExternalLink(url)).toEqual({ ok: true, opened: 'now' });
            expect(openExternal).toHaveBeenCalledWith(new URL(url).href);
            expect(getLeaveSnapshot()).toBeNull();
        });

        it.each([
            'https://cipherline.chat.evil.io/',
            'https://cipherline.chat@evil.com/',
            'https://evilcipherline.chat/',
        ])('look-alikes of the trusted host still ask: %s', (url) => {
            expect(openExternalLink(url)).toEqual({ ok: true, opened: 'after-confirm' });
            expect(openExternal).not.toHaveBeenCalled();
        });

        it('a masked link whose text names another site asks even for a TRUSTED destination', () => {
            expect(openExternalLink('https://cipherline.chat/x', { label: 'paypal.com' })).toEqual({ ok: true, opened: 'after-confirm' });
            expect(getLeaveSnapshot()!.model.mismatch).toEqual({ says: 'paypal.com', goesTo: 'cipherline.chat' });
            expect(openExternal).not.toHaveBeenCalled();
        });

        it('the newest click replaces a pending request; confirming the old id is refused', () => {
            openExternalLink('https://one.example/');
            const first = getLeaveSnapshot()!;
            openExternalLink('https://two.example/');
            expect(confirmLeave(first.id)).toEqual({ ok: false, reason: 'stale' });
            expect(openExternal).not.toHaveBeenCalled();
            confirmLeave(getLeaveSnapshot()!.id);
            expect(openExternal).toHaveBeenCalledWith('https://two.example/');
        });

        it('with no dialog host mounted, an untrusted link is refused rather than opened', () => {
            unregister();
            expect(openExternalLink('https://example.com/')).toEqual({ ok: false, reason: 'no-confirm-host' });
            expect(openExternal).not.toHaveBeenCalled();
            unregister = registerLeaveHost();
        });

        it('confirms only the validated href the gate recorded (canonical form)', () => {
            openExternalLink('  HTTPS://Example.COM/Path?q=1  ');
            confirmLeave(getLeaveSnapshot()!.id);
            expect(openExternal).toHaveBeenCalledWith('https://example.com/Path?q=1');
        });
    });

    describe('never auto-open: a crafted call without a user gesture is refused', () => {
        // Positive control first: the identical calls WITH a gesture do act, so
        // the refusals below are the gate, not a broken fixture.
        it('control: with a gesture, the same calls open / ask', () => {
            expect(openExternalLink('https://cipherline.chat/')).toEqual({ ok: true, opened: 'now' });
            expect(openExternalLink('https://example.com/')).toEqual({ ok: true, opened: 'after-confirm' });
            expect(openExternal).toHaveBeenCalledTimes(1);
        });

        it.each([false, null])('gesture %s (null = the real check, no browser event): no open and no dialog, trusted or not', (g) => {
            setGesture(g);
            expect(openExternalLink('https://cipherline.chat/')).toEqual({ ok: false, reason: 'no-user-gesture' });
            expect(openExternalLink('https://example.com/')).toEqual({ ok: false, reason: 'no-user-gesture' });
            expect(openExternalLink('https://x.example/', { label: 'paypal.com' })).toEqual({ ok: false, reason: 'no-user-gesture' });
            expect(openExternal).not.toHaveBeenCalled();
            expect(window.open).not.toHaveBeenCalled();
            expect(getLeaveSnapshot()).toBeNull();
        });

        it('a pending dialog cannot be confirmed without a gesture (e.g. a timer or message handler)', () => {
            openExternalLink('https://example.com/');
            const req = getLeaveSnapshot()!;
            setGesture(false);
            expect(confirmLeave(req.id)).toEqual({ ok: false, reason: 'no-user-gesture' });
            expect(openExternal).not.toHaveBeenCalled();
            expect(getLeaveSnapshot()).toBe(req); // still showing, still the user's call
        });
    });

    describe("source: 'app' (destinations written by Cipherline's own code)", () => {
        it('opens directly, without the dialog, and without needing a live gesture (async OAuth start)', () => {
            setGesture(false);
            expect(openExternalLink('https://discord.com/oauth2/authorize?x=1', { source: 'app' })).toEqual({ ok: true, opened: 'now' });
            expect(openExternal).toHaveBeenCalledWith('https://discord.com/oauth2/authorize?x=1');
            expect(getLeaveSnapshot()).toBeNull();
        });
    });

    describe('window.open fallback (no Electron bridge) gets the same validation', () => {
        it('uses the canonical href, and still refuses bad schemes', () => {
            window.electronAPI = undefined as unknown as typeof window.electronAPI;
            expect(openExternalLink('https://cipherline.chat')).toEqual({ ok: true, opened: 'now' });
            expect(window.open).toHaveBeenCalledWith('https://cipherline.chat/', '_blank', 'noopener,noreferrer');
            vi.mocked(window.open).mockClear();
            expect(openExternalLink('javascript:alert(1)')).toEqual({ ok: false, reason: 'disallowed-scheme' });
            expect(window.open).not.toHaveBeenCalled();
        });
    });

    describe('hasUserGesture — the real check', () => {
        const g = globalThis as unknown as { window: { event?: unknown } };
        const withEvent = (ev: unknown, isActive: boolean | undefined) => {
            setUserGestureProbeForTests(null);
            g.window.event = ev;
            vi.stubGlobal('navigator', isActive === undefined ? {} : { userActivation: { isActive } });
            try { return hasUserGesture(); } finally { delete g.window.event; }
        };
        it('true only inside a TRUSTED click/key event with an active user activation', () => {
            expect(withEvent({ isTrusted: true, type: 'click' }, true)).toBe(true);
            expect(withEvent({ isTrusted: true, type: 'keydown' }, true)).toBe(true);
        });
        it.each([
            ['script-dispatched click (el.click(), dispatchEvent)', { isTrusted: false, type: 'click' }, true],
            ['a WebSocket / postMessage handler', { isTrusted: true, type: 'message' }, true],
            ['a timer or promise callback (no event)', undefined, true],
            ['activation not active', { isTrusted: true, type: 'click' }, false],
            ['userActivation API missing', { isTrusted: true, type: 'click' }, undefined],
            ['a load / focus event', { isTrusted: true, type: 'load' }, true],
        ])('false for %s', (_name, ev, active) => {
            expect(withEvent(ev, active as boolean | undefined)).toBe(false);
        });
    });
});
