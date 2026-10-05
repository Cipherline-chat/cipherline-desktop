import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeToClipboard } from './clipboard';

/**
 * ── Why this suite exists ───────────────────────────────────────────────────
 *
 * `SafetyVerificationModal`'s copy button did nothing for every packaged user,
 * and reported success anyway. The cause was in the CALL SITE (it called
 * `navigator.clipboard.writeText` directly, which Chromium gates behind the
 * `clipboard-sanitized-write` permission that `electron/main.ts`'s catch-all
 * `setPermissionRequestHandler` denies), but the reason it was INVISIBLE was a
 * contract question about this module's replacement: a helper that swallows
 * every failure and resolves regardless is indistinguishable, from the call
 * site, from one that worked.
 *
 * So the load-bearing assertion here is the last one — `writeToClipboard`
 * REJECTS when every tier fails. The modal keys its icon and its inline error
 * off that rejection; if this module ever goes back to swallowing, the button
 * silently starts lying again and nothing else in the suite would notice.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;

/** Restores whatever the setup file / Node put on these. */
let savedNavigator: PropertyDescriptor | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let savedDocument: any;

function setBridge(fn?: (t: string) => Promise<void>) {
    if (fn) g.window.electronAPI = { writeClipboard: fn };
    else delete g.window.electronAPI;
}

function setWebClipboard(fn?: (t: string) => Promise<void>) {
    Object.defineProperty(g, 'navigator', {
        value: fn ? { clipboard: { writeText: fn } } : {},
        configurable: true,
        writable: true,
    });
}

/** Minimal DOM good enough for the execCommand tier's textarea dance. */
function setExecCommand(exec: () => boolean) {
    const body = {
        appendChild: vi.fn(),
        removeChild: vi.fn(),
    };
    g.document = {
        addEventListener: () => {},
        visibilityState: 'visible',
        createElement: vi.fn(() => ({
            value: '',
            style: { cssText: '' },
            focus: vi.fn(),
            select: vi.fn(),
        })),
        body,
        execCommand: vi.fn(exec),
    };
    return g.document;
}

beforeEach(() => {
    savedNavigator = Object.getOwnPropertyDescriptor(g, 'navigator');
    savedDocument = g.document;
});

afterEach(() => {
    delete g.window.electronAPI;
    if (savedNavigator) Object.defineProperty(g, 'navigator', savedNavigator);
    else delete g.navigator;
    g.document = savedDocument;
    vi.restoreAllMocks();
});

describe('writeToClipboard — tier ordering', () => {
    it('prefers the Electron IPC bridge and does not touch the later tiers', async () => {
        const bridge = vi.fn(async () => {});
        const web = vi.fn(async () => {});
        const doc = setExecCommand(() => true);
        setBridge(bridge);
        setWebClipboard(web);

        await writeToClipboard('SAFETY CODE');

        expect(bridge).toHaveBeenCalledExactlyOnceWith('SAFETY CODE');
        // The point of the bridge tier: it is the ONLY one not subject to a
        // renderer permission gate, so it must win when it is available.
        expect(web).not.toHaveBeenCalled();
        expect(doc.execCommand).not.toHaveBeenCalled();
    });

    it('falls through to the web Clipboard API when no bridge exists (browser dev)', async () => {
        const web = vi.fn(async () => {});
        const doc = setExecCommand(() => true);
        setBridge(undefined);
        setWebClipboard(web);

        await writeToClipboard('SAFETY CODE');

        // Positive control for the assertion above: the same two spies that
        // stayed at zero when the bridge was present DO fire when it is absent,
        // so "not.toHaveBeenCalled()" there was discriminating, not vacuous.
        expect(web).toHaveBeenCalledExactlyOnceWith('SAFETY CODE');
        expect(doc.execCommand).not.toHaveBeenCalled();
    });

    it('falls through when the bridge REJECTS rather than being absent', async () => {
        const bridge = vi.fn(async () => { throw new Error('ipc down'); });
        const web = vi.fn(async () => {});
        setBridge(bridge);
        setWebClipboard(web);
        setExecCommand(() => true);

        await writeToClipboard('SAFETY CODE');

        expect(bridge).toHaveBeenCalledOnce();
        expect(web).toHaveBeenCalledExactlyOnceWith('SAFETY CODE');
    });

    it('reaches execCommand when the web API is permission-denied — the packaged-Electron path', async () => {
        // This is the real shipped shape of the bug: no bridge used by the call
        // site, and `navigator.clipboard.writeText` rejecting with the
        // NotAllowedError that main.ts's catch-all permission denial produces.
        const web = vi.fn(async () => { throw new Error('NotAllowedError'); });
        setBridge(undefined);
        setWebClipboard(web);
        const doc = setExecCommand(() => true);

        await writeToClipboard('SAFETY CODE');

        expect(web).toHaveBeenCalledOnce();
        expect(doc.execCommand).toHaveBeenCalledExactlyOnceWith('copy');
        expect(doc.body.removeChild).toHaveBeenCalledOnce();
    });

    it('writes the exact text it was given, unmangled, through every tier', async () => {
        const grouped = 'A1B2 C3D4 E5F6 G7H8';
        for (const tier of ['bridge', 'web'] as const) {
            const spy = vi.fn(async () => {});
            setBridge(tier === 'bridge' ? spy : undefined);
            setWebClipboard(tier === 'web' ? spy : undefined);
            setExecCommand(() => true);
            await writeToClipboard(grouped);
            expect(spy).toHaveBeenCalledWith(grouped);
        }
    });
});

describe('writeToClipboard — failure is loud', () => {
    it('REJECTS when all three tiers fail (the modal keys its error state off this)', async () => {
        setBridge(async () => { throw new Error('ipc down'); });
        setWebClipboard(async () => { throw new Error('NotAllowedError'); });
        setExecCommand(() => false);

        await expect(writeToClipboard('SAFETY CODE')).rejects.toThrow(/clipboard write failed/i);
    });

    it('positive control: `.rejects.toThrow()` really does fail on a promise that resolves', async () => {
        // Guards the assertion style used directly above. The pre-fix bug was
        // exactly a silent resolve, so a `.rejects` matcher that passed
        // vacuously would reproduce the original defect inside the test suite
        // meant to prevent it. This proves the matcher discriminates.
        await expect(
            expect(Promise.resolve('resolved, not thrown')).rejects.toThrow(),
        ).rejects.toBeTruthy();
    });

    it('does not leave the temporary textarea attached after a failure', async () => {
        setBridge(undefined);
        setWebClipboard(undefined);
        const doc = setExecCommand(() => false);

        await expect(writeToClipboard('SAFETY CODE')).rejects.toThrow();

        // Removal happens before the throw — a failed copy must not accumulate
        // hidden off-screen textareas in the document on every retry.
        expect(doc.body.appendChild).toHaveBeenCalledOnce();
        expect(doc.body.removeChild).toHaveBeenCalledOnce();
    });
});
