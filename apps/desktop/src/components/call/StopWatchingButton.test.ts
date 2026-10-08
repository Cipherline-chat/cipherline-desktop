/**
 * Stop-watching control on remote screen-share tiles.
 *
 * There is no DOM render harness in the node-env suite, so this combines:
 *   - direct behavioural tests of the pure helpers and of the button component
 *     (the component is a plain function returning a <button> element, so its
 *     props/handlers can be read and invoked without a DOM), and
 *   - source-wiring pins (same approach as ChatPane.sendRelease.test.ts) for
 *     the places only a full render would exercise.
 * Every wiring assertion has a positive control proving the matcher can fail.
 */
import { describe, it, expect, vi } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Track } from 'livekit-client';
import { StopWatchingButton } from './StopWatchingButton';
import {
    canStopWatching,
    stopWatchingAriaLabel,
    withoutIdentity,
    focusAfterStopWatching,
    unsubscribeShareTracks,
} from '../../utils/stopWatchingScreenshare';
import { parseWatchedShares, writeWatchedShares, WATCHING_META_KEY } from '../../utils/screenShareViewers';

type Ev = { stopPropagation: () => void };
interface BtnProps {
    type: string;
    'aria-label': string;
    title: string;
    tabIndex?: number;
    className: string;
    onClick: (e: Ev) => void;
    onDoubleClick: (e: Ev) => void;
    onPointerDown: (e: Ev) => void;
    onMouseDown: (e: Ev) => void;
}
type BtnEl = React.ReactElement<BtnProps>;

const src = (rel: string) => readFileSync(resolve(__dirname, rel), 'utf8');

describe('canStopWatching — only remote, watched screen-share tiles', () => {
    const handler = () => {};
    it('positive control: remote screen share with a handler shows the button', () => {
        expect(canStopWatching({ source: Track.Source.ScreenShare, isLocal: false, onStopWatching: handler })).toBe(true);
    });
    it('not on cameras', () => {
        expect(canStopWatching({ source: Track.Source.Camera, isLocal: false, onStopWatching: handler })).toBe(false);
    });
    it('not on your own share', () => {
        expect(canStopWatching({ source: Track.Source.ScreenShare, isLocal: true, onStopWatching: handler })).toBe(false);
    });
    it('not when no handler is wired (e.g. an unwatched/gated surface)', () => {
        expect(canStopWatching({ source: Track.Source.ScreenShare, isLocal: false })).toBe(false);
    });
});

describe('StopWatchingButton', () => {
    const el = StopWatchingButton({ name: 'Alex', onStop: () => {} }) as BtnEl;

    it('is a real, keyboard-reachable <button type=button> with the required aria-label and tooltip', () => {
        expect(el.type).toBe('button');
        expect(el.props.type).toBe('button');
        expect(el.props['aria-label']).toBe("Stop watching Alex's screen");
        expect(el.props.title).toBe('Stop watching');
        expect(el.props.tabIndex).not.toBe(-1);
        // positive control: the label really is derived from the name
        expect(stopWatchingAriaLabel('Bo')).not.toBe(el.props['aria-label']);
    });

    it('has a visible focus ring and uses the danger (cl-flash) token with the lucide X', () => {
        expect(el.props.className).toMatch(/focus-visible:ring-2/);
        expect(el.props.className).toMatch(/text-cl-flash/);
        expect(el.props.className).toMatch(/pointer-events-auto/); // pill wrapper is pointer-events-none
        const html = renderToStaticMarkup(el);
        expect(html).toContain('aria-label="Stop watching Alex&#x27;s screen"');
        expect(html).toContain('lucide-x');
    });

    it('click calls onStop exactly once and stops propagation (no focus/fullscreen toggle)', () => {
        const onStop = vi.fn();
        const b = StopWatchingButton({ name: 'Alex', onStop }) as BtnEl;
        const ev = { stopPropagation: vi.fn() };
        b.props.onClick(ev);
        expect(onStop).toHaveBeenCalledTimes(1);
        expect(ev.stopPropagation).toHaveBeenCalledTimes(1);
    });

    it('double-click, pointerdown and mousedown are also contained', () => {
        for (const h of ['onDoubleClick', 'onPointerDown', 'onMouseDown']) {
            const ev = { stopPropagation: vi.fn() };
            el.props[h as 'onDoubleClick'](ev);
            expect(ev.stopPropagation, h).toHaveBeenCalledTimes(1);
        }
    });

    it('negative control: a handler that forgot stopPropagation would be caught by the same check', () => {
        const bad = (e: { stopPropagation: () => void }) => { void e; };
        const ev = { stopPropagation: vi.fn() };
        bad(ev);
        expect(ev.stopPropagation).not.toHaveBeenCalled();
    });
});

describe('unwatch mechanics', () => {
    it('withoutIdentity removes only that identity; same set returned when absent', () => {
        const s = new Set(['a', 'b']);
        const n = withoutIdentity(s, 'a');
        expect([...n]).toEqual(['b']);
        expect(s.has('a')).toBe(true); // not mutated
        expect(withoutIdentity(s, 'zzz')).toBe(s);
    });

    it('focusAfterStopWatching closes focus only for that identity\'s screen share', () => {
        const share = { identity: 'a', source: Track.Source.ScreenShare };
        expect(focusAfterStopWatching(share, 'a')).toBeNull();
        // positive control: unrelated focus is preserved
        const other = { identity: 'b', source: Track.Source.ScreenShare };
        expect(focusAfterStopWatching(other, 'a')).toBe(other);
        const cam = { identity: 'a', source: Track.Source.Camera };
        expect(focusAfterStopWatching(cam, 'a')).toBe(cam);
        expect(focusAfterStopWatching(null, 'a')).toBeNull();
    });

    it('unsubscribeShareTracks unsubscribes BOTH the video and the share-audio track', async () => {
        const video = { setSubscribed: vi.fn() };
        const audio = { setSubscribed: vi.fn() };
        const pubs = new Map<Track.Source, { setSubscribed: ReturnType<typeof vi.fn> }>([
            [Track.Source.ScreenShare, video],
            [Track.Source.ScreenShareAudio, audio],
            [Track.Source.Camera, { setSubscribed: vi.fn() }],
        ]);
        await unsubscribeShareTracks({ getTrackPublication: s => pubs.get(s) });
        expect(video.setSubscribed).toHaveBeenCalledWith(false);
        expect(audio.setSubscribed).toHaveBeenCalledWith(false);
        expect(pubs.get(Track.Source.Camera)!.setSubscribed).not.toHaveBeenCalled();
    });

    it('unsubscribeShareTracks tolerates a missing audio track and a throwing video unsubscribe', async () => {
        const audio = { setSubscribed: vi.fn() };
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await unsubscribeShareTracks({
            getTrackPublication: s =>
                s === Track.Source.ScreenShare ? { setSubscribed: () => { throw new Error('gone'); } }
                : s === Track.Source.ScreenShareAudio ? audio : undefined,
        });
        expect(audio.setSubscribed).toHaveBeenCalledWith(false);
        await unsubscribeShareTracks({ getTrackPublication: () => undefined });
        warn.mockRestore();
    });

    it('leaving the subscribed set removes this client from the sharer\'s viewer list (metadata fold)', () => {
        // SidebarConference publishes writeWatchedShares(meta, [...subscribedScreenshares]).
        // positive control: watching a and b is published...
        const watching = writeWatchedShares('{"deafened":false}', ['sharerA', 'sharerB'])!;
        expect(parseWatchedShares(watching).sort()).toEqual(['sharerA', 'sharerB']);
        // ...and after stop-watching A (set minus A) A is gone, B and other keys remain.
        const afterStop = writeWatchedShares(watching, [...withoutIdentity(new Set(['sharerA', 'sharerB']), 'sharerA')])!;
        expect(parseWatchedShares(afterStop)).toEqual(['sharerB']);
        expect(JSON.parse(afterStop).deafened).toBe(false);
        // last share: the key is deleted entirely
        const none = writeWatchedShares(afterStop, [])!;
        expect(JSON.parse(none)[WATCHING_META_KEY]).toBeUndefined();
    });

    it('re-watching after stop works: adding the id back republishes it', () => {
        const stopped = writeWatchedShares('{"watching_shares":["a"]}', [])!;
        expect(parseWatchedShares(stopped)).toEqual([]);
        const again = writeWatchedShares(stopped, ['a'])!;
        expect(parseWatchedShares(again)).toEqual(['a']);
    });
});

describe('wiring (source pins)', () => {
    const tile = src('./VideoTile.tsx');
    const sidebar = src('../SidebarConference.tsx');
    const banner = src('./FocusedStreamBanner.tsx');
    const overlay = src('./FullscreenOverlay.tsx');

    it('VideoTile renders the button inside the name pill, gated by canStopWatching', () => {
        const pill = tile.slice(tile.indexOf('<TileNamePill insets={chrome}'), tile.indexOf('</TileNamePill>'));
        expect(pill).toMatch(/canStopWatching\(\{ source, isLocal, onStopWatching \}\)/);
        expect(pill).toMatch(/<StopWatchingButton name=\{displayName\} onStop=\{onStopWatching!\}/);
        // positive control: the matcher fails on a pill without it
        expect('<TileNamePill>{displayName}</TileNamePill>').not.toMatch(/StopWatchingButton/);
    });

    it('SidebarConference handler is the inverse of the watch path', () => {
        const start = sidebar.indexOf('const handleStopWatchingScreenshare');
        const body = sidebar.slice(start, sidebar.indexOf('\n    };', start));
        expect(body).toMatch(/setSubscribedScreenshares\(prev => withoutIdentity\(prev, identity\)\)/);
        expect(body).toMatch(/unsubscribeShareTracks\(sharer\)/);
        expect(body).toMatch(/callCtx\.setFocusedStream\(null\)/);
        // positive control: the existing watch path (the thing we invert) is a different, adding setter
        expect(sidebar).toMatch(/const handleSubscribeScreenshare[\s\S]{0,120}new Set\(\[\.\.\.prev, identity\]\)/);
    });

    it('the viewer-list publisher still derives from subscribedScreenshares (so unwatching leaves it)', () => {
        expect(sidebar).toMatch(/writeWatchedShares\(localParticipant\.metadata, \[\.\.\.subscribedScreenshares\]\)/);
    });

    it('exactly the two remote sidebar screen-share VideoTiles + banner + overlay are wired — not cameras/local', () => {
        const wired = sidebar.match(/onStopWatching=\{\(\) => handleStopWatchingScreenshare\(p\.identity\)\}/g) ?? [];
        expect(wired).toHaveLength(2);
        // each wired occurrence sits in a `ss-` (remote screen share) motion block
        const blocks = sidebar.match(/key=\{`ss-\$\{p\.identity\}`\}[\s\S]*?<\/motion\.div>/g) ?? [];
        expect(blocks).toHaveLength(2);
        for (const b of blocks) {
            expect(b).toMatch(/source=\{Track\.Source\.ScreenShare\}/);
            expect(b).toMatch(/onStopWatching=/);
        }
        // every other VideoTile (cameras, local share) carries no handler
        expect((sidebar.match(/onStopWatching=/g) ?? []).length).toBe(2);
        expect(sidebar).toMatch(/<FocusedStreamBanner[\s\S]*?onStopWatchingScreenshare=\{handleStopWatchingScreenshare\}/);
        expect(sidebar).toMatch(/<FullscreenOverlay[\s\S]*?onStopWatchingScreenshare=\{handleStopWatchingScreenshare\}/);
        expect(banner).toMatch(/onStopWatching=\{onStopWatchingScreenshare \?/);
        expect(overlay).toMatch(/onStopWatching: onStopWatchingScreenshare \?/);
    });
});

describe('Hide screen share = stop watching (viewer list)', () => {
    const sidebar = src('../SidebarConference.tsx');
    const hideBody = (() => {
        const i = sidebar.indexOf('const toggleHideScreenShare = async');
        return sidebar.slice(i, sidebar.indexOf('toggleHideScreenShareRef.current = toggleHideScreenShare', i));
    })();

    // Model of the SidebarConference state this feature rides on: the
    // subscribed set is published as `watching_shares`, and the sharer's count
    // is a fold over the roster. `hide` is toggleHideScreenShare's hide branch
    // (it delegates to the stop-watching helper); `watch`/`unhide` add the id
    // back exactly like handleSubscribeScreenshare / the unhide branch.
    const viewersOf = (meta: string | null, sharer: string) => (parseWatchedShares(meta).includes(sharer) ? 1 : 0);
    const publish = (meta: string | null, set: Set<string>) => writeWatchedShares(meta, [...set]) ?? meta;

    it('hide -> no longer a viewer (positive control: was a viewer before)', () => {
        let set = new Set(['sharer']);
        let meta = publish(null, set);
        expect(viewersOf(meta, 'sharer')).toBe(1);          // control: watching counts
        set = withoutIdentity(set, 'sharer');               // what hide now does
        meta = publish(meta, set);
        expect(viewersOf(meta, 'sharer')).toBe(0);
    });

    it('negative control: the OLD hide (flag only, set untouched) would still count as a viewer', () => {
        const set = new Set(['sharer']);
        const hidden = new Set<string>(); hidden.add('sharer'); // old behaviour: only the hidden flag changes
        const meta = publish(null, set);
        expect(hidden.has('sharer')).toBe(true);
        expect(viewersOf(meta, 'sharer')).toBe(1);
    });

    it('hiding something you were not watching changes nothing (idempotent)', () => {
        const set = new Set<string>();
        expect(withoutIdentity(set, 'sharer')).toBe(set);
        expect(writeWatchedShares(null, [...set])).toBeNull();
    });

    it('stays out of the list until a watch happens, then is a viewer again', () => {
        let set = new Set(['sharer']);
        let meta = publish(null, set);
        set = withoutIdentity(set, 'sharer'); meta = publish(meta, set);
        expect(viewersOf(meta, 'sharer')).toBe(0);
        // re-render with nothing changed -> still not a viewer
        expect(publish(meta, set)).toBe(meta);
        expect(viewersOf(meta, 'sharer')).toBe(0);
        set = new Set([...set, 'sharer']);                  // handleSubscribeScreenshare
        meta = publish(meta, set);
        expect(viewersOf(meta, 'sharer')).toBe(1);
    });

    it('hide shares ONE code path with the red X: toggleHideScreenShare calls handleStopWatchingScreenshare only on hide', () => {
        expect(hideBody).toMatch(/if \(hide\) handleStopWatchingScreenshare\(id\);/);
        // single definition of the unsubscribe logic
        expect(sidebar.match(/unsubscribeShareTracks\(/g)).toHaveLength(1);
        expect(sidebar.match(/const handleStopWatchingScreenshare/g)).toHaveLength(1);
        // positive control: the matcher rejects a body without the call
        expect('const toggleHideScreenShare = async (id, hide) => { set(hide) }').not.toMatch(/handleStopWatchingScreenshare/);
    });

    it('existing UN-hide UX is kept: un-hiding is an explicit "show this share" and re-watches via the subscribed set', () => {
        const unhide = hideBody.slice(hideBody.indexOf('if (!hide) {'));
        expect(unhide).toMatch(/setSubscribed\(true\)/);
        expect(unhide).toMatch(/next\.add\(id\)/);
        expect(unhide).not.toMatch(/handleStopWatchingScreenshare/);
    });
});
