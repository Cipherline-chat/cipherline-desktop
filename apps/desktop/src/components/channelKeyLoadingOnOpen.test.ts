// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChannelKeyWait, ChannelKeyWaitBanner, KEY_WAIT_RETRY_REST_MS } from './ChannelKeyWait';
import { useChannelKeyWait, KEY_WAIT_EXIT_MS, KEY_WAIT_PENDING_MAX_MS } from '../hooks/useChannelKeyWait';
import {
    KEY_WAIT_COPY, KEY_WAIT_STALL_MS, KEY_WAIT_STALLED_DWELL_MS, beginChannelOpen, beginChannelPageDecrypt,
    keyMissingRuns, noteChannelKeyReceived, noteKeyRequestAcked, resetKeyWaitSignals, getKeyWaitSignals,
    isGiveUpRemembered,
} from '../utils/channelKeyWait';
import { channelPlaceholderContent } from '../utils/channelDecryptFailure';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Owner report 2026-10-20: "people join a server and it never plays the
 * animation for getting the keys … make it every time you open it up the keys
 * load, not the message panel with a bunch of 'waiting on channel keys'
 * messages".
 *
 * The pane lifecycle on OPEN, through the real hook + component, with
 * ChatPane's render rules in miniature (layer only while shown/exiting, the
 * list held back while pending/shown, consecutive key pills collapsed into
 * one row, the banner). Every test samples EVERY committed frame for a layer
 * or a painted pill, so "no flash" is checked, not assumed.
 */

const CH = 'chan-open';
let n = 0;
const pill = () => ({ id: `p${++n}`, content: channelPlaceholderContent('key_missing', 4), sender_device_id: 'd' });
const text = () => ({ id: `t${++n}`, content: { type: 'text', text: 'hello' }, sender_device_id: 'd' });
const joinLine = () => ({ id: `sys${++n}`, content: { type: 'system', kind: 'member_event', event: 'member_joined' }, sender_device_id: '' });
const many = <T,>(k: number, f: () => T) => Array.from({ length: k }, f);
type Row = { id: string; content?: unknown; sender_device_id?: string };

let root: Root | null = null;
let host: HTMLDivElement;
const ctl: { setRows: (r: Row[]) => void; setLoading: (b: boolean) => void } = { setRows: () => {}, setLoading: () => {} };
/** Every committed frame: was the layer up, how many pill rows were painted. */
let frames: Array<{ layer: boolean; pills: number; rows: number; banner: boolean }> = [];

const Pane: React.FC<{ initial: Row[]; loading?: boolean; coolingOff?: boolean; onRetry?: () => void }> = ({ initial, loading: l0 = false, coolingOff = false, onRetry }) => {
    const [rows, setRows] = React.useState<Row[]>(initial);
    const [loading, setLoading] = React.useState(l0);
    React.useEffect(() => { ctl.setRows = setRows; ctl.setLoading = setLoading; }, []);
    const kw = useChannelKeyWait({ enabled: true, channelId: CH, messages: rows, loading, coolingOff });
    const runs = keyMissingRuns(rows);
    React.useLayoutEffect(() => {
        frames.push({
            layer: !!host.querySelector('.ckw-root'),
            pills: host.querySelectorAll('.row.pill').length,
            rows: host.querySelectorAll('.row').length,
            banner: !!host.querySelector('.ckw-banner'),
        });
    });
    return React.createElement('div', { className: 'feed' },
        kw.holdList ? null : React.createElement('div', { className: kw.handoff ? 'list ckw-list-in' : 'list' },
            rows.map(r => {
                const run = runs.get(r.id);
                if (run === 0) return null;
                const isPill = (r.content as { kind?: string })?.kind === 'encrypted';
                return React.createElement('div', { key: r.id, className: isPill ? 'row pill' : 'row', 'data-run': run ?? 1 });
            })),
        kw.phase === 'shown' || kw.phase === 'exiting'
            ? React.createElement(ChannelKeyWait, { phase: kw.phase, stage: kw.stage, reduced: false }) : null,
        kw.banner ? React.createElement(ChannelKeyWaitBanner, { waitingCount: kw.waitingCount, onRetry }) : null,
    );
};

function open(initial: Row[], props: { loading?: boolean; coolingOff?: boolean; onRetry?: () => void } = {}) {
    act(() => { root!.render(React.createElement(Pane, { key: `open-${++n}`, initial, ...props })); });
}
const layer = () => host.querySelector('.ckw-root');
const title = () => host.querySelector('.ckw-copy-in .ckw-title')?.textContent ?? null;
const banner = () => host.querySelector('.ckw-banner');
const painted = () => [...host.querySelectorAll('.row')];

async function advance(ms: number, step = 250) {
    for (let t = 0; t < ms; t += step) {
        await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(step, ms - t)); });
    }
}

beforeEach(() => {
    vi.useFakeTimers();
    resetKeyWaitSignals();
    frames = [];
    Object.defineProperty(window, 'matchMedia', {
        configurable: true, writable: true,
        value: (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }),
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => { root?.unmount(); });
    root = null;
    host.remove();
    vi.useRealTimers();
});

describe('fresh join (the report)', () => {
    it('the joiner\'s own "joined" line lands first, then the page of pills: the animation plays, and no pill ever paints', () => {
        const endOpen = beginChannelOpen(CH);
        // Dashboard: first fetch of this channel in flight; the live join line is already in the thread.
        open([joinLine()], { loading: true });
        expect(layer()).toBeNull();
        // the page lands as pills (folded in before the open settles)
        act(() => { ctl.setRows([joinLine(), ...many(100, pill)]); });
        expect(painted()).toHaveLength(0);
        act(() => { endOpen(); ctl.setLoading(false); });
        expect(layer()).not.toBeNull();
        expect(title()).toBe(KEY_WAIT_COPY.asking.title);
        expect(frames.every(f => f.pills === 0)).toBe(true);
    });
    it('same, without the loading flag (a later open of the landing channel): the join line alone does not latch the layer off', () => {
        open([joinLine()]);
        act(() => { ctl.setRows([joinLine(), ...many(100, pill)]); });
        expect(layer()).not.toBeNull();
        expect(frames.every(f => f.pills === 0)).toBe(true);
    });
    it('keys arrive mid-animation → received → building → the decrypted feed fades in under the exiting layer', async () => {
        open(many(100, pill));
        act(() => { noteKeyRequestAcked(CH); });
        act(() => { noteChannelKeyReceived(CH); });
        expect(title()).toBe(KEY_WAIT_COPY.received.title);
        let end = () => {};
        act(() => { end = beginChannelPageDecrypt(CH); });
        expect(title()).toBe(KEY_WAIT_COPY.building.title);
        act(() => { ctl.setRows(many(100, text)); end(); });
        expect(layer()!.classList.contains('is-exiting')).toBe(true);
        expect(host.querySelector('.list.ckw-list-in')).not.toBeNull();
        await advance(KEY_WAIT_EXIT_MS + 50);
        expect(layer()).toBeNull();
        expect(painted()).toHaveLength(100);
        expect(frames.every(f => f.pills === 0)).toBe(true);
        expect(banner()).toBeNull();
    });
});

describe('every later open', () => {
    it('keys already installed (login prefetch): cached pills heal during the open → NO animation and no pill, ever', () => {
        const endOpen = beginChannelOpen(CH);
        open(many(100, pill));
        expect(layer()).toBeNull();
        expect(painted()).toHaveLength(0); // held back, not painted
        // the open's re-read decrypts the cached placeholders with the installed key
        const endDecrypt = beginChannelPageDecrypt(CH);
        act(() => { ctl.setRows(many(100, text)); endDecrypt(); endOpen(); });
        expect(painted()).toHaveLength(100);
        expect(frames.some(f => f.layer)).toBe(false);
        expect(frames.every(f => f.pills === 0)).toBe(true);
    });
    it('keys NOT installed: the open settles with the page still waiting → the animation', () => {
        const endOpen = beginChannelOpen(CH);
        open(many(100, pill));
        expect(layer()).toBeNull();
        act(() => { endOpen(); });
        expect(layer()).not.toBeNull();
        expect(frames.every(f => f.pills === 0)).toBe(true);
    });
    it('a slow open does not hold a blank feed for long: the animation takes over after the pending cap', async () => {
        beginChannelOpen(CH); // never settles
        open(many(100, pill));
        expect(layer()).toBeNull();
        await advance(KEY_WAIT_PENDING_MAX_MS + 50, 50);
        expect(layer()).not.toBeNull();
    });
    it('newest epoch missing on a readable channel (a rotation while away): the animation, not a pill at the bottom', () => {
        open([...many(80, text), ...many(20, pill)]);
        expect(layer()).not.toBeNull();
        expect(frames.every(f => f.pills === 0)).toBe(true);
    });
    it('control: everything readable → no animation, no banner', () => {
        open(many(100, text));
        expect(frames.some(f => f.layer || f.banner)).toBe(false);
        expect(painted()).toHaveLength(100);
    });
});

describe('history-only gap', () => {
    // 2026-10-20 (owner): the banner "showed up for someone who had access to
    // the channel they were viewing". Older locked rows under a channel whose
    // newest messages read fine are a history gap - the compact row says so;
    // the "waiting for someone with the keys" banner does not, ever.
    it('older rows waiting, the screen reads: feed shown, the 70 pills are ONE compact row, and NO banner even when nobody answers', async () => {
        open([...many(70, pill), ...many(30, text)]);
        act(() => { noteKeyRequestAcked(CH); });
        expect(layer()).toBeNull();
        const pills = host.querySelectorAll('.row.pill');
        expect(pills).toHaveLength(1);
        expect(pills[0].getAttribute('data-run')).toBe('70');
        expect(banner()).toBeNull();
        await advance(KEY_WAIT_STALL_MS * 3);
        expect(banner()).toBeNull();
        expect(frames.some(f => f.layer)).toBe(false);
        act(() => { noteChannelKeyReceived(CH); ctl.setRows(many(100, text)); });
        expect(banner()).toBeNull();
    });
});

describe('no holder online → fallback (never trapped)', () => {
    it('nobody answers: the stalled copy, then the feed with ONE banner and the pills collapsed into one row', async () => {
        open(many(100, pill));
        act(() => { noteKeyRequestAcked(CH); });
        await advance(KEY_WAIT_STALL_MS + 300);
        expect(title()).toBe(KEY_WAIT_COPY.stalled.title);
        expect(banner()).toBeNull();
        await advance(KEY_WAIT_STALLED_DWELL_MS + KEY_WAIT_EXIT_MS + 300);
        expect(layer()).toBeNull();
        expect(banner()).not.toBeNull();
        expect(host.querySelectorAll('.ckw-banner')).toHaveLength(1);
        const rows = painted();
        expect(rows).toHaveLength(1);
        expect(rows[0].getAttribute('data-run')).toBe('100');
        expect(isGiveUpRemembered(getKeyWaitSignals(CH), Date.now())).toBe(true);
    });
    it('re-opening that channel goes straight to the feed + banner (no second unanswered wait) — until a key arrives', async () => {
        open(many(100, pill));
        act(() => { noteKeyRequestAcked(CH); });
        await advance(KEY_WAIT_STALL_MS + KEY_WAIT_STALLED_DWELL_MS + KEY_WAIT_EXIT_MS + 600);
        expect(banner()).not.toBeNull();

        frames = [];
        open(many(100, pill)); // re-open (ChatPane remounts per channel)
        expect(frames.some(f => f.layer)).toBe(false);
        expect(banner()).not.toBeNull();

        // a key for this channel lands (another epoch): the next open may wait again
        act(() => { noteChannelKeyReceived(CH); });
        open(many(100, pill));
        expect(layer()).not.toBeNull();
    });
    it('a key install that keeps failing (cool-off): straight to the feed + banner', () => {
        open(many(100, pill), { coolingOff: true });
        expect(frames.some(f => f.layer)).toBe(false);
        expect(banner()).not.toBeNull();
    });
    it('a key that arrives while waiting pushes the give-up back (progress is not a reason to leave)', async () => {
        open(many(100, pill));
        act(() => { noteKeyRequestAcked(CH); });
        await advance(KEY_WAIT_STALL_MS);
        act(() => { noteChannelKeyReceived(CH); }); // another epoch: page still waiting
        await advance(KEY_WAIT_STALLED_DWELL_MS + 2_000);
        expect(layer()).not.toBeNull();
    });
});

describe('the banner\'s "Ask again"', () => {
    it('asks once, rests, then can ask again', async () => {
        const onRetry = vi.fn();
        act(() => { root!.render(React.createElement(ChannelKeyWaitBanner, { waitingCount: 3, onRetry })); });
        const btn = () => host.querySelector('.ckw-banner-retry') as HTMLButtonElement;
        act(() => { btn().click(); });
        act(() => { btn().click(); });
        expect(onRetry).toHaveBeenCalledTimes(1);
        expect(btn().disabled).toBe(true);
        await advance(KEY_WAIT_RETRY_REST_MS + 50, 500);
        expect(btn().disabled).toBe(false);
        act(() => { btn().click(); });
        expect(onRetry).toHaveBeenCalledTimes(2);
    });
    it('accessible: a polite status region with a real button', () => {
        act(() => { root!.render(React.createElement(ChannelKeyWaitBanner, { waitingCount: 3, onRetry: () => {} })); });
        expect(banner()!.getAttribute('role')).toBe('status');
        expect(host.querySelector('button.ckw-banner-retry')?.getAttribute('type')).toBe('button');
    });
});

// Owner report 2026-10-20: "the channel keys timed-out message at the top ...
// randomly comes up, and it kept appearing over and over until it stopped".
// Under the re-send storm every duplicate key copy noted "key received" and
// every envelopes-ready push re-read the open channel's page; each one took
// the banner down (stage received / building) and the stall clock put it back.
describe('the fallback banner does not flap', () => {
    it('newest message locked, nobody answers: banner up once, and key signals / page re-reads never take it down', async () => {
        // Opened readable (the layer is done for this pane), then the channel
        // moved to an epoch this device does not have: new messages lock.
        open(many(60, text));
        act(() => { ctl.setRows([...many(60, text), ...many(8, pill)]); noteKeyRequestAcked(CH); });
        await advance(KEY_WAIT_STALL_MS + 1_000);
        expect(layer()).toBeNull();
        expect(banner()).not.toBeNull();
        frames = [];
        // 2 minutes of storm: a key signal and a page re-read every ~4 s.
        for (let i = 0; i < 30; i++) {
            const end = beginChannelPageDecrypt(CH);
            act(() => { noteChannelKeyReceived(CH); });
            await advance(1_000);
            act(() => { end(); ctl.setRows(many(100, pill)); });
            await advance(3_000);
        }
        expect(frames.length).toBeGreaterThan(10);
        expect(frames.every(f => f.banner)).toBe(true);
    });

    it('a channel whose newest message reads never gets the banner, however long older rows wait', async () => {
        open([...many(40, pill), ...many(10, text)]);
        act(() => { noteKeyRequestAcked(CH); });
        await advance(5 * 60_000, 1_000);
        expect(frames.some(f => f.banner)).toBe(false);
    });

    it('within budget (newest locked < stall time) → no banner; the newest message healing takes it down for good', async () => {
        open([...many(30, text), ...many(3, pill)]);
        act(() => { noteKeyRequestAcked(CH); });
        await advance(KEY_WAIT_STALL_MS - 2_000);
        expect(banner()).toBeNull();
        // (the newest is locked, so the layer is up and says it; the banner
        // takes over only once the layer has given up)
        await advance(2_000 + KEY_WAIT_STALLED_DWELL_MS + KEY_WAIT_EXIT_MS + 600);
        expect(layer()).toBeNull();
        expect(banner()).not.toBeNull();
        act(() => { ctl.setRows([...many(30, text), ...many(3, text)]); });
        expect(banner()).toBeNull();
        await advance(60_000, 1_000);
        expect(banner()).toBeNull();
    });
});
