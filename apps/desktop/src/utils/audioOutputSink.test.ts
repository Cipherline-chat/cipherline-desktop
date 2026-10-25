import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// secureLocalStore is hydrated at app boot; unhydrated (as here) every read
// returns null. Swap in a plain map so these cases exercise the routing.
vi.mock('./secureLocalStore', () => {
    const mem = new Map<string, string>();
    return {
        default: {
            getItem: (k: string) => mem.get(k) ?? null,
            setItem: (k: string, v: string) => { mem.set(k, v); },
            removeItem: (k: string) => { mem.delete(k); },
        },
    };
});

import {
    applyOutputDevice,
    applyOutputDeviceChecked,
    registerOutputAudioContext,
    unregisterOutputAudioContext,
    outputSinkRef,
    onOutputDeviceChange,
    refreshOutputDevices,
    probeContextSink,
    setOutputDeviceFailureHandler,
    sinkErrorName,
    __resetOutputRoutingForTests,
} from './audioOutput';
import { clearCallEvents, getCallEvents, validateCallEvent } from './callEventLog';
import { describeSpeakerTest } from './speakerTestSummary';

const SELECTED = 'selected-sink-id-1234';

class SinkEl {
    sinkId = '';
    isConnected = true;
    setSinkId = vi.fn(async (id: string) => { this.sinkId = id; });
}
class SinkCtx {
    sinkId: string | object = '';
    setSinkId = vi.fn(async (id: string) => { this.sinkId = id; });
    close = vi.fn(async () => {});
}
const asEl = (e: object) => e as unknown as HTMLMediaElement;
const asCtx = (c: object) => c as unknown as AudioContext;
const sinkEvents = () => getCallEvents().filter(e => e.kind === 'audio_output_sink');
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

beforeEach(() => {
    __resetOutputRoutingForTests();
    setOutputDeviceFailureHandler(null);
    onOutputDeviceChange('');
    clearCallEvents();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('audio_output_sink call events', () => {
    it('records one contract-valid event per element and per context attempt, with no ids or labels', async () => {
        const el = new SinkEl();
        const ctx = new SinkCtx();
        applyOutputDevice(asEl(el));
        registerOutputAudioContext(asCtx(ctx));
        onOutputDeviceChange(SELECTED, { label: 'Secret Headphones', groupId: 'g1' });
        await flush();

        const evs = sinkEvents();
        expect(evs.length).toBeGreaterThanOrEqual(2);
        for (const e of evs) expect(validateCallEvent(e)).toEqual([]);
        const targets = new Set(evs.map(e => e.detail?.target));
        expect(targets).toEqual(new Set(['element', 'context']));
        expect(evs.every(e => e.detail?.ok === true && e.detail?.landed === true && e.detail?.error === 'none')).toBe(true);
        const blob = JSON.stringify(getCallEvents());
        expect(blob).not.toContain(SELECTED);
        expect(blob).not.toContain('Secret Headphones');
    });

    it('a rejected setSinkId is recorded with its DOMException name only (not the message, which can echo an id)', async () => {
        const el = new SinkEl();
        el.setSinkId = vi.fn(async () => { throw new DOMException(`no such device ${SELECTED}`, 'NotFoundError'); });
        applyOutputDevice(asEl(el));
        onOutputDeviceChange(SELECTED);
        await flush();

        const failed = sinkEvents().filter(e => e.detail?.ok === false);
        expect(failed.length).toBeGreaterThan(0);
        expect(failed[0].detail).toMatchObject({ target: 'element', ok: false, landed: false, error: 'NotFoundError', to_default: false });
        expect(JSON.stringify(getCallEvents())).not.toContain(SELECTED);
    });

    it('an unknown error type is reduced to "other"', () => {
        expect(sinkErrorName(new DOMException('x', 'NotAllowedError'))).toBe('NotAllowedError');
        expect(sinkErrorName(new Error('device 9f3a-secret'))).toBe('other');
        expect(sinkErrorName(undefined)).toBe('other');
        expect(sinkErrorName({ name: 'Mallory\u0000' })).toBe('other');
    });

    it('a resolved promise whose read-back is NOT the requested sink is logged as landed:false and reported', async () => {
        const notice = vi.fn();
        setOutputDeviceFailureHandler(notice);
        const el = new SinkEl();
        el.setSinkId = vi.fn(async () => { /* resolves, sink unchanged */ });
        applyOutputDevice(asEl(el));
        onOutputDeviceChange(SELECTED);
        await flush();

        const e = sinkEvents().find(x => x.detail?.landed === false);
        expect(e?.detail).toMatchObject({ ok: true, landed: false, error: 'not_applied' });
        expect(notice).toHaveBeenCalledTimes(1);
    });

    it('a target without setSinkId is recorded as unsupported and does not toast', async () => {
        const notice = vi.fn();
        setOutputDeviceFailureHandler(notice);
        registerOutputAudioContext(asCtx({}));
        onOutputDeviceChange(SELECTED);
        await flush();
        expect(sinkEvents().some(e => e.detail?.error === 'unsupported')).toBe(true);
        expect(notice).not.toHaveBeenCalled();
    });
});

describe('audio_output_pick: is the stored pick a real, current device?', () => {
    const row = (deviceId: string, label: string, groupId = `g-${deviceId}`) =>
        ({ deviceId, label, kind: 'audiooutput', groupId } as MediaDeviceInfo);
    const DEF = row('default', 'Default - Speakers', 'g-spk');
    const HEADSET = row('headset-9', 'Private Headset Name', 'g-headset');
    const picks = () => getCallEvents().filter(e => e.kind === 'audio_output_pick').map(e => e.detail);

    it('exact / re-enumerated / unplugged / synthetic / default are told apart, with no id or label', () => {
        onOutputDeviceChange('headset-9', { label: 'Private Headset Name', groupId: 'g-headset' });
        refreshOutputDevices([DEF, HEADSET]);
        expect(picks().at(-1)).toMatchObject({ result: 'exact', count: 2 });

        onOutputDeviceChange('headset-OLD', { label: 'Private Headset Name', groupId: 'g-headset' });
        refreshOutputDevices([DEF, HEADSET]);
        expect(picks().at(-1)).toMatchObject({ result: 'group_label', count: 2 });

        onOutputDeviceChange('headset-gone', { label: 'Something Else', groupId: 'g-x' });
        refreshOutputDevices([DEF, HEADSET]);
        expect(picks().at(-1)).toMatchObject({ result: 'none' });

        // The literal alias row stored as the pick: a bug upstream, flagged.
        onOutputDeviceChange('default');
        refreshOutputDevices([DEF, HEADSET]);
        expect(picks().at(-1)).toMatchObject({ result: 'synthetic' });

        onOutputDeviceChange('');
        refreshOutputDevices([DEF, HEADSET]);
        expect(picks().at(-1)).toMatchObject({ result: 'default' });

        const blob = JSON.stringify(getCallEvents());
        expect(blob).not.toContain('Private Headset Name');
        expect(blob).not.toContain('headset-9');
        for (const e of getCallEvents()) expect(validateCallEvent(e)).toEqual([]);
    });

    it('a devicechange storm that changes nothing logs once', () => {
        onOutputDeviceChange('headset-9', { label: 'Private Headset Name', groupId: 'g-headset' });
        for (let i = 0; i < 5; i++) refreshOutputDevices([DEF, HEADSET]);
        expect(picks()).toHaveLength(1);
    });

    it('the pre-permission placeholder list logs nothing (it says nothing about the pick)', () => {
        onOutputDeviceChange('headset-9');
        refreshOutputDevices([row('', '')]);
        expect(picks()).toHaveLength(0);
    });
});

describe('a rejected setSinkId shows the toast once', () => {
    const rejecting = () => {
        const el = new SinkEl();
        el.setSinkId = vi.fn(async () => { throw new DOMException('denied', 'NotAllowedError'); });
        return el;
    };

    it('once for many failing targets, again only after the user picks again', async () => {
        const notice = vi.fn();
        setOutputDeviceFailureHandler(notice);
        const a = rejecting(); const b = rejecting();
        const c = new SinkCtx();
        c.setSinkId = vi.fn(async () => { throw new DOMException('denied', 'NotAllowedError'); });
        applyOutputDevice(asEl(a)); applyOutputDevice(asEl(b)); registerOutputAudioContext(asCtx(c));

        onOutputDeviceChange(SELECTED);
        await flush();
        expect(notice).toHaveBeenCalledTimes(1); // 3 failures, 1 toast

        // The user picking again is a new episode: the toast may fire once more...
        onOutputDeviceChange(SELECTED);
        await flush();
        expect(notice).toHaveBeenCalledTimes(2);
        // ...but a reapply pass (a livekit reroute, a devicechange) is not:
        const { reapplyOutputDevice } = await import('./audioOutput');
        reapplyOutputDevice();
        await flush();
        expect(notice).toHaveBeenCalledTimes(2);
    });

    it('negative control: with no handler registered nothing throws and the latch is not consumed', async () => {
        const a = rejecting();
        applyOutputDevice(asEl(a));
        expect(() => onOutputDeviceChange(SELECTED)).not.toThrow();
        await flush();
        const notice = vi.fn();
        setOutputDeviceFailureHandler(notice);
        onOutputDeviceChange(SELECTED);
        await flush();
        expect(notice).toHaveBeenCalledTimes(1);
    });
});

describe('late-created elements and contexts, and ordering', () => {
    it('an element created after the pick is routed at birth with the selected id', async () => {
        onOutputDeviceChange(SELECTED);
        const late = new SinkEl();
        applyOutputDevice(asEl(late));
        expect(late.setSinkId).toHaveBeenCalledWith(SELECTED); // synchronously on an idle element
        await flush();
        expect(late.sinkId).toBe(SELECTED);
    });

    it('a context created after the pick is routed at birth with the selected id', async () => {
        onOutputDeviceChange(SELECTED);
        const ctx = new SinkCtx();
        registerOutputAudioContext(asCtx(ctx));
        expect(ctx.setSinkId).toHaveBeenCalledWith(SELECTED);
        unregisterOutputAudioContext(asCtx(ctx));
    });

    it('overlapping changes on one element are queued: the LAST request wins', async () => {
        const el = new SinkEl();
        let release: (() => void) | null = null;
        el.setSinkId = vi.fn((id: string) => new Promise<void>(res => {
            const done = () => { el.sinkId = id; res(); };
            if (!release) release = done; else done();
        }));
        applyOutputDevice(asEl(el));
        onOutputDeviceChange('first-sink');
        onOutputDeviceChange('second-sink');
        // The second call must not start until the first has settled.
        expect(el.setSinkId).toHaveBeenCalledTimes(1);
        release!();
        await flush();
        expect(el.setSinkId).toHaveBeenCalledTimes(2);
        expect(el.sinkId).toBe('second-sink');
    });

    it('an element already on the requested sink is not asked again', async () => {
        const el = new SinkEl();
        el.sinkId = SELECTED;
        onOutputDeviceChange(SELECTED);
        applyOutputDevice(asEl(el));
        await flush();
        expect(el.setSinkId).not.toHaveBeenCalled();
    });

    it('outputSinkRef routes an attachment player, and an unmounted one is pruned on the next change', async () => {
        onOutputDeviceChange(SELECTED);
        const mounted = new SinkEl();
        const gone = new SinkEl();
        outputSinkRef(asEl(mounted));
        outputSinkRef(asEl(gone));
        await flush();
        expect(mounted.setSinkId).toHaveBeenCalledWith(SELECTED);
        expect(gone.setSinkId).toHaveBeenCalledWith(SELECTED);

        gone.isConnected = false;
        mounted.setSinkId.mockClear(); gone.setSinkId.mockClear();
        onOutputDeviceChange('other-sink');
        await flush();
        expect(mounted.setSinkId).toHaveBeenCalledWith('other-sink');
        expect(gone.setSinkId).not.toHaveBeenCalled();
        expect(() => outputSinkRef(null)).not.toThrow();
    });

    it('applyOutputDeviceChecked reports the verdict (and routes only when a device is picked)', async () => {
        const el = new SinkEl();
        await expect(applyOutputDeviceChecked(asEl(el))).resolves.toEqual({ ok: true, landed: true });
        expect(el.setSinkId).not.toHaveBeenCalled(); // system default: nothing to route

        onOutputDeviceChange(SELECTED);
        const el2 = new SinkEl();
        await expect(applyOutputDeviceChecked(asEl(el2))).resolves.toEqual({ ok: true, landed: true });
        expect(el2.setSinkId).toHaveBeenCalledWith(SELECTED);

        const el3 = new SinkEl();
        el3.setSinkId = vi.fn(async () => { throw new DOMException('x', 'NotAllowedError'); });
        const bad = await applyOutputDeviceChecked(asEl(el3));
        expect(bad).toMatchObject({ ok: false, landed: false, error: 'NotAllowedError' });
    });
});

describe('probeContextSink (the silent AudioContext half of "Test speakers")', () => {
    afterEach(() => { delete (globalThis as { AudioContext?: unknown }).AudioContext; });

    it('sets the picked sink on a throwaway context, reports it, and closes the context', async () => {
        const made: SinkCtx[] = [];
        (globalThis as { AudioContext?: unknown }).AudioContext = class extends SinkCtx { constructor() { super(); made.push(this); } };
        onOutputDeviceChange(SELECTED);
        const out = await probeContextSink();
        expect(out).toEqual({ ok: true, landed: true });
        expect(made).toHaveLength(1);
        expect(made[0].setSinkId).toHaveBeenCalledWith(SELECTED);
        expect(made[0].close).toHaveBeenCalled();
    });

    it('reports a rejection and still closes the context', async () => {
        const made: SinkCtx[] = [];
        (globalThis as { AudioContext?: unknown }).AudioContext = class extends SinkCtx {
            constructor() { super(); this.setSinkId = vi.fn(async () => { throw new DOMException('x', 'NotFoundError'); }); made.push(this); }
        };
        onOutputDeviceChange(SELECTED);
        const out = await probeContextSink();
        expect(out).toMatchObject({ ok: false, error: 'NotFoundError' });
        expect(made[0].close).toHaveBeenCalled();
    });

    it('does nothing on the system default', async () => {
        const ctor = vi.fn();
        (globalThis as { AudioContext?: unknown }).AudioContext = ctor;
        await expect(probeContextSink()).resolves.toEqual({ ok: true, landed: true });
        expect(ctor).not.toHaveBeenCalled();
    });
});

describe('describeSpeakerTest wording', () => {
    const good = { ok: true, landed: true };
    it('both paths landed', () => {
        expect(describeSpeakerTest({ element: good, context: good, played: true }, false))
            .toEqual({ ok: true, text: 'Played on your selected speakers.' });
    });
    it('system default is described as such, without claiming a routed device', () => {
        expect(describeSpeakerTest({ element: good, context: good, played: true }, true).text).toMatch(/system default/);
    });
    it('a rejected element path says so, with the error enum', () => {
        const r = describeSpeakerTest({ element: { ok: false, landed: false, error: 'NotAllowedError' }, context: good, played: true }, false);
        expect(r.ok).toBe(false);
        expect(r.text).toMatch(/NotAllowedError/);
        expect(r.text).toMatch(/system default/);
    });
    it('a resolved-but-not-landed context path is a failure too (negative control for "ok" alone)', () => {
        const r = describeSpeakerTest({ element: good, context: { ok: true, landed: false, error: 'not_applied' }, played: true }, false);
        expect(r.ok).toBe(false);
        expect(r.text).toMatch(/not_applied/);
    });
    it('a sound that did not start is its own message', () => {
        expect(describeSpeakerTest({ element: good, context: good, played: false }, false).ok).toBe(false);
    });
});

/**
 * Coverage guard: every place the renderer can make sound must be routed to the
 * selected output, or be listed here as deliberately not a playback path. A new
 * `new Audio()` / `new AudioContext()` / `<audio>` / `<video controls>` that is
 * in neither list fails this test, which is how an un-sinked path would be
 * noticed before an owner hears it come out of the wrong speakers.
 */
describe('playback-path coverage scan', () => {
    const root = join(__dirname, '..');
    const walk = (dir: string, out: string[] = []): string[] => {
        for (const f of readdirSync(dir)) {
            const p = join(dir, f);
            if (statSync(p).isDirectory()) walk(p, out);
            else if (/\.(ts|tsx)$/.test(f) && !/\.(test|d)\.tsx?$/.test(f) && !/\.test\./.test(f)) out.push(p);
        }
        return out;
    };
    const files = walk(root);
    const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    // file -> what makes sound there, and the call that routes it
    const ROUTED: Record<string, RegExp> = {
        'utils/notificationSounds.ts': /applyOutputDevice\(/,
        'hooks/useParticipantAudio.ts': /applyOutputDevice\(el\)[\s\S]*registerOutputAudioContext\(sharedAudioCtx\)|registerOutputAudioContext\(sharedAudioCtx\)[\s\S]*applyOutputDevice\(el\)/,
        'components/VoiceVideoSettings.tsx': /registerOutputAudioContext\(ctx\)/,
        'components/FileViewer.tsx': /ref=\{outputSinkRef\}/,
        'components/PinnedMessagesPanel.tsx': /ref=\{outputSinkRef\}/,
        'components/SharedContentModal.tsx': /ref=\{outputSinkRef\}/,
    };
    // Not playback: never connected to an audible destination, or muted by design.
    const EXEMPT: Record<string, string> = {
        'utils/speakingAnalyser.ts': 'analysis only: AudioContext({ sinkId: none })',
        'utils/voiceProcessor.ts': 'local mic processing; output is published, never played',
        'utils/voiceProcessorManager.ts': 'guard context for the local mic processor; never reaches a destination',
        'components/SidebarConference.tsx': 'PCM-ring context feeds a published MediaStreamDestination',
        'components/call/VideoTile.tsx': 'video tracks only; the audio is useParticipantAudio',
        'components/ChatPane.tsx': 'muted poster-frame <video>, no controls',
        'components/SharedContentModal.tsx#muted': 'offscreen/muted poster capture',
        'utils/gpuRecoveryRoom.ts': 're-attaches remote VIDEO tracks',
        'utils/audioHealth.ts': 'probe, never connected to destination',
        'utils/customEntranceSound/browser.ts': 'encode fallback: the clip is routed into a MediaStreamDestination for MediaRecorder, never to ctx.destination (playback is notificationSounds)',
    };
    const MAKES_SOUND = /new Audio\(|new AudioContext\(|new \(?window as any\)?\.AudioContext|new AudioCtx\(|<audio\b|<video\b[^>]*\bcontrols\b/;

    it('finds the source files (positive control)', () => {
        expect(files.length).toBeGreaterThan(300);
    });

    it('every sound-making file is either routed (and says how) or explicitly exempt', () => {
        const unaccounted: string[] = [];
        for (const f of files) {
            const rel = relative(root, f).split('\\').join('/');
            const text = code(readFileSync(f, 'utf8'));
            if (!MAKES_SOUND.test(text)) continue;
            if (rel in EXEMPT) continue;
            const routed = ROUTED[rel];
            if (!routed) { unaccounted.push(`${rel}: makes sound but is neither routed nor exempt`); continue; }
            if (!routed.test(text)) unaccounted.push(`${rel}: listed as routed but the routing call is gone`);
        }
        expect(unaccounted).toEqual([]);
    });

    it('every audible attachment player carries the sink ref (counted, so dropping one of two is caught)', () => {
        const expected: Record<string, number> = {
            'components/FileViewer.tsx': 2,            // <video controls> + <audio controls>
            'components/PinnedMessagesPanel.tsx': 1,   // <video controls>
            'components/SharedContentModal.tsx': 1,    // the lightbox <video controls autoPlay>
        };
        for (const [rel, n] of Object.entries(expected)) {
            const text = code(readFileSync(join(root, rel), 'utf8'));
            expect([rel, (text.match(/ref=\{outputSinkRef\}/g) ?? []).length]).toEqual([rel, n]);
        }
    });

    it('the scan itself flags a new un-routed player (negative control)', () => {
        const sample = code('const el = new Audio(); el.play();');
        expect(MAKES_SOUND.test(sample)).toBe(true);
        expect('components/SomeNewThing.tsx' in ROUTED || 'components/SomeNewThing.tsx' in EXEMPT).toBe(false);
        expect(MAKES_SOUND.test(code('<video src={x} controls />'))).toBe(true);
        expect(MAKES_SOUND.test(code('// new Audio() in a comment only'))).toBe(false);
    });
});

describe('wiring pins', () => {
    const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');

    it('the rejected-switch toast is registered session-long from Dashboard, not only while a call is mounted', () => {
        expect(read('../components/Dashboard.tsx')).toMatch(/useOutputDeviceNotices\(\);/);
        expect(read('../hooks/useOutputDeviceNotices.ts')).toMatch(/setOutputDeviceFailureHandler\(/);
        expect(read('../components/SidebarConference.tsx')).not.toMatch(/setOutputDeviceFailureHandler/);
    });

    it('Settings has a "Test speakers" button wired to notificationSounds.testSpeakers', () => {
        const src = read('../components/VoiceVideoSettings.tsx');
        expect(src).toMatch(/Test speakers/);
        expect(src).toMatch(/testSpeakers\(DEFAULT_SOUNDS\.message/);
    });

    it('the main process still grants speaker-selection to the request handler (and no check handler is needed - see commit)', () => {
        const main = read('../../electron/main.ts');
        expect(main).toMatch(/permission === 'speaker-selection'/);
    });
});
