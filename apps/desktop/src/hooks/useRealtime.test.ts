import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import {
    isRetiredHistorySyncFrame, RETIRED_HISTORY_SYNC_EVENTS, isOwnAnswerEcho, isSelfReadEvent, isSocketStale, readDisplayName,
    parseDeviceLinkedEvent, formatDeviceLinkedToast,
} from './useRealtime';

const ME = 'my-device-id';
const OTHER = 'some-other-device-id';

/**
 * The server-relayed history sync was removed from this client (2026-11-24); the API keeps emitting its events while older clients
 * exist. An old device's request, its approver's key delivery and its decline must all be dropped before dispatch: no prompt, no
 * import, no crash.
 */
describe('isRetiredHistorySyncFrame: the old history-sync events are ignored', () => {
    it('drops an old device\'s history request, targeted or broadcast', () => {
        expect(isRetiredHistorySyncFrame({ event: 'device:history_request', data: { device_id: OTHER, device_name: 'Old PC', target_device_id: ME } })).toBe(true);
        expect(isRetiredHistorySyncFrame({ event: 'device:history_request', data: {} })).toBe(true);
        expect(isRetiredHistorySyncFrame({ event: 'device:history_request' })).toBe(true);
    });
    it('drops a decline and a key delivery, wrapped or legacy plaintext, for this device or another', () => {
        expect(isRetiredHistorySyncFrame({ event: 'device:history_declined', data: { device_id: ME, reason: null } })).toBe(true);
        expect(isRetiredHistorySyncFrame({ event: 'device:approved', data: { device_id: ME, wrapped_transfer_key_b64: 'AAAA' } })).toBe(true);
        expect(isRetiredHistorySyncFrame({ event: 'device:approved', data: { device_id: OTHER, transfer_key_b64: 'AAAA' } })).toBe(true);
        expect(isRetiredHistorySyncFrame({ event: 'device:approved', data: { device_id: ME, transfer_meta: {} } })).toBe(true);
    });
    it('leaves every other frame alone, including a device:approved that carries no history key', () => {
        expect(isRetiredHistorySyncFrame({ event: 'device:approved', data: { device_id: ME } })).toBe(false);
        expect(isRetiredHistorySyncFrame({ event: 'message:new', data: {} })).toBe(false);
        expect(isRetiredHistorySyncFrame({ event: 'device:linked', data: {} })).toBe(false);
    });
    it('never throws on junk', () => {
        for (const junk of [null, undefined, 0, 'device:history_request', [], { event: 42 }, { event: 'device:approved', data: 'x' }]) {
            expect(() => isRetiredHistorySyncFrame(junk)).not.toThrow();
            expect(isRetiredHistorySyncFrame(junk)).toBe(false);
        }
    });
    it('the dispatch drops them first, and nothing in it handles the old events any more', () => {
        const src = readFileSync(fileURLToPath(new URL('./useRealtime.ts', import.meta.url)), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
        const parse = src.indexOf('const msg = JSON.parse(event.data);');
        const guard = src.indexOf('if (isRetiredHistorySyncFrame(msg)) return;');
        expect(parse).toBeGreaterThan(0);
        expect(guard).toBeGreaterThan(parse);
        expect(src.slice(parse, guard)).not.toMatch(/msg\.event ===/);
        for (const ev of RETIRED_HISTORY_SYNC_EVENTS) expect(src).not.toContain(`msg.event === '${ev}'`);
        expect(src).not.toMatch(/setHistory(Request|Delivered|Declined)|msg\.data\??\.(wrapped_)?transfer_key_b64/);
    });
});

/**
 * isSocketStale — the sleep-detection liveness check (long-standing "app is
 * stale after sleep, needs a manual refresh" bug). A WebSocket left OPEN
 * across a sleep is a zombie: the OS drops the TCP connection silently, but
 * readyState never changes and send() on the dead buffer never throws — so
 * nothing else in the app would notice without this timestamp comparison.
 * Kept pure (no timers, no socket) so the actual staleness DECISION is
 * tested directly, independent of setInterval/setTimeout plumbing.
 */
describe('isSocketStale', () => {
    const THRESHOLD = 40_000;

    it('is not stale when the last inbound message is recent', () => {
        const now = 1_000_000;
        expect(isSocketStale(now - 5_000, now, THRESHOLD)).toBe(false);
    });

    it('is not stale exactly AT the threshold — only past it', () => {
        const now = 1_000_000;
        expect(isSocketStale(now - THRESHOLD, now, THRESHOLD)).toBe(false);
    });

    it('is stale just past the threshold', () => {
        const now = 1_000_000;
        expect(isSocketStale(now - THRESHOLD - 1, now, THRESHOLD)).toBe(true);
    });

    it('is stale after a long sleep (hours of silence)', () => {
        const now = 1_000_000;
        const twoHoursMs = 2 * 60 * 60 * 1000;
        expect(isSocketStale(now - twoHoursMs, now, THRESHOLD)).toBe(true);
    });

    it('uses the default threshold when none is passed', () => {
        const now = 1_000_000;
        // Default is 40s (LIVENESS_TIMEOUT_MS) — well past it must read stale
        // without the caller having to know the constant.
        expect(isSocketStale(now - 60_000, now)).toBe(true);
        expect(isSocketStale(now - 1_000, now)).toBe(false);
    });
});

/**
 * readDisplayName — the wire half of the "Someone" fix.
 *
 * `voiceUserNames` used to be fed ONLY by the batched
 * `GET /v1/voice-participants` seed, so anyone who joined a call after your
 * last seed arrived as a bare user id and rendered as "Someone" until the next
 * one. Both live events now carry `display_name`. The field is optional
 * because the API and the desktop app roll separately — an older API sends
 * none, and that must degrade to the seed-only behaviour rather than putting
 * `undefined` (or a coerced number/object) into the name map.
 */
describe('readDisplayName — optional display_name on live call events', () => {
    it('accepts a real name', () => {
        expect(readDisplayName('Ali')).toBe('Ali');
    });

    it('yields undefined when an OLDER API sends no display_name at all', () => {
        expect(readDisplayName(undefined)).toBeUndefined();
    });

    it('yields undefined for null', () => {
        expect(readDisplayName(null)).toBeUndefined();
    });

    it('rejects an empty string — an empty label is worse than the neutral fallback', () => {
        expect(readDisplayName('')).toBeUndefined();
    });

    it('never coerces a non-string into the name map', () => {
        expect(readDisplayName(42)).toBeUndefined();
        expect(readDisplayName({ name: 'Ali' })).toBeUndefined();
        expect(readDisplayName(['Ali'])).toBeUndefined();
        expect(readDisplayName(true)).toBeUndefined();
    });
});

/**
 * REGRESSION — "this call was already answered on another device" shown on the
 * device the user just answered on.
 *
 * call:answered_elsewhere is broadcast to the whole account, and the server
 * emits it BEFORE the winning device's own join response is serialized
 * (measured on the dev stack: the frame landed 1-16ms ahead of the 201, 5 runs
 * out of 5). So on the winner the event arrives while the accept flow is still
 * awaiting axios and globalIncomingCall is still set — and it toasted about
 * itself. This predicate drops the winner's own echo.
 *
 * Note the polarity is the OPPOSITE of isSelfReadEvent's fail-closed rule: this
 * one only suppresses a toast and must ALLOW on a missing id, or an older server (which sends no device_id)
 * would have the event swallowed on every device, restoring the 15s
 * silent-ring-then-looks-missed behaviour the event exists to prevent.
 */
describe('isOwnAnswerEcho — call:answered_elsewhere self-filtering', () => {
    it('suppresses the event when it names THIS device (the winner)', () => {
        expect(isOwnAnswerEcho(ME, ME)).toBe(true);
    });

    it('does not suppress when it names a different device (a genuine loss)', () => {
        expect(isOwnAnswerEcho(OTHER, ME)).toBe(false);
    });

    it('does not suppress when the server sent no device_id (older server)', () => {
        expect(isOwnAnswerEcho(undefined, ME)).toBe(false);
        expect(isOwnAnswerEcho(null, ME)).toBe(false);
        expect(isOwnAnswerEcho('', ME)).toBe(false);
    });

    it('does not suppress when this client has no device id of its own', () => {
        expect(isOwnAnswerEcho(OTHER, undefined)).toBe(false);
        expect(isOwnAnswerEcho(OTHER, null)).toBe(false);
        expect(isOwnAnswerEcho(ME, '')).toBe(false);
    });
});

/**
 * Continuity — cross-device read sync. `message:read` now reaches the
 * reader's own OTHER devices too (the server broadcasts to
 * `[...notifyIds, client.userId]`), specifically so a message read on the
 * phone clears the desktop's badge and vice versa. `isSelfReadEvent` is the
 * one thing standing between "someone else read this" (a read receipt to
 * render) and "I read this, somewhere else" (a badge to clear) — getting the
 * polarity wrong either direction is a real bug: too permissive clears a
 * genuinely-unread badge (the user misses a message), too strict never
 * clears anything (stale badges forever). Fails closed: a missing id on
 * either side is never a match.
 */
const MY_ID = 'my-user-id';
const OTHER_USER = 'someone-elses-user-id';

describe('isSelfReadEvent — message:read self-device badge clearing', () => {
    it('matches when the reader is this account (read on another device)', () => {
        expect(isSelfReadEvent(MY_ID, MY_ID)).toBe(true);
    });

    it('does not match when the reader is someone else (a real read receipt)', () => {
        expect(isSelfReadEvent(OTHER_USER, MY_ID)).toBe(false);
    });

    it('fails closed when reader_user_id is missing — never clear a badge on a guess', () => {
        expect(isSelfReadEvent(undefined, MY_ID)).toBe(false);
        expect(isSelfReadEvent(null, MY_ID)).toBe(false);
        expect(isSelfReadEvent('', MY_ID)).toBe(false);
    });

    it('fails closed when this client does not yet know its own user id', () => {
        expect(isSelfReadEvent(OTHER_USER, undefined)).toBe(false);
        expect(isSelfReadEvent(OTHER_USER, null)).toBe(false);
        expect(isSelfReadEvent(MY_ID, undefined)).toBe(false);
    });

    it('two absences must never accidentally match', () => {
        expect(isSelfReadEvent(undefined, undefined)).toBe(false);
        expect(isSelfReadEvent(null, null)).toBe(false);
        expect(isSelfReadEvent('', '')).toBe(false);
    });
});

/**
 * QR-2 (adversarial review) — `device:linked` was emitted by the gateway
 * (gateway.gateway.ts's notifyDeviceLinked) and subscribed to by NOTHING:
 * `git grep device:linked` found only the emit and a doc sentence. The design
 * leans on this event twice as the "you would notice" mitigation for two
 * residual risks (docs/QR-LINKING.md §2.9.1, §2.9.5), so an uncollected event
 * meant neither mitigation existed. These two blocks are the regression
 * coverage: the first proves the payload reaches user-visible state (there is
 * no DOM/@testing-library in this suite to render a toast and assert on it —
 * see this file's own header for why every suite here tests logic directly);
 * the second is a source-scan proving useRealtime.ts's dispatch actually
 * calls it, since a test of the pure function alone cannot prove it is wired
 * into the `onmessage` switch at all.
 */
describe('parseDeviceLinkedEvent + formatDeviceLinkedToast — device:linked reaches user-visible state', () => {
    const WELL_FORMED = {
        approved_by_device_id: 'DEV_APPROVER',
        approved_by_device_name: "Dawson's Pixel",
        device_label: 'Not a hacker\'s PC',
        linked_at: '2026-09-23T00:00:00.000Z',
    };

    it('parses a well-formed device:linked payload', () => {
        expect(parseDeviceLinkedEvent(WELL_FORMED)).toEqual(WELL_FORMED);
    });

    it('rejects malformed payloads rather than partially applying them', () => {
        expect(parseDeviceLinkedEvent(null)).toBeNull();
        expect(parseDeviceLinkedEvent(undefined)).toBeNull();
        expect(parseDeviceLinkedEvent('not an object')).toBeNull();
        expect(parseDeviceLinkedEvent({})).toBeNull();
        expect(parseDeviceLinkedEvent({ ...WELL_FORMED, approved_by_device_id: 42 })).toBeNull();
        expect(parseDeviceLinkedEvent({ ...WELL_FORMED, device_label: undefined })).toBeNull();
    });

    it('turns a parsed event into non-empty, user-visible toast copy naming both devices', () => {
        const parsed = parseDeviceLinkedEvent(WELL_FORMED)!;
        const { title, message } = formatDeviceLinkedToast(parsed);

        expect(title.length).toBeGreaterThan(0);
        expect(message).toContain(WELL_FORMED.approved_by_device_name);
        // device_label is attacker-controllable (self-asserted by the newly
        // linked device) — it must be visibly marked as reported, not
        // presented as a verified fact, same treatment this field gets
        // everywhere else it's shown.
        expect(message.toLowerCase()).toContain('reported as');
        expect(message).toContain(WELL_FORMED.device_label);
    });
});

describe('device:linked is wired into the WS dispatch switch (QR-2 regression guard)', () => {
    it('useRealtime.ts\'s onmessage handler actually subscribes to device:linked', () => {
        const src = readFileSync(fileURLToPath(new URL('./useRealtime.ts', import.meta.url)), 'utf8');
        expect(src).toContain("msg.event === 'device:linked'");
        // And it must actually route the payload somewhere, not just check
        // for the event name and drop it.
        expect(src).toContain('parseDeviceLinkedEvent(msg.data)');
        expect(src).toContain('setDeviceLinkedEvent(parsed)');
    });
});
