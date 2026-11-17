import { describe, it, expect } from 'vitest';
import { decideCreateNavigation, PENDING_CHANNEL_PREFIX } from './createChannelNavigation';

const text = { channel_id: 'c-real', kind: 'text' };
const calls = { channel_id: 'h-real', kind: 'huddle' };

describe('decideCreateNavigation', () => {
    it('opens a new text channel when Create another is off', () => {
        expect(decideCreateNavigation({ ok: true, channel: text, keepOpen: false })).toEqual({ action: 'open', channelId: 'c-real' });
    });

    it('only reveals a new Calls channel (never an open/join action)', () => {
        const nav = decideCreateNavigation({ ok: true, channel: calls, keepOpen: false });
        expect(nav).toEqual({ action: 'reveal', channelId: 'h-real' });
        expect(nav.action).not.toBe('open');
    });

    it('stays put when Create another is checked', () => {
        expect(decideCreateNavigation({ ok: true, channel: text, keepOpen: true })).toEqual({ action: 'none' });
        expect(decideCreateNavigation({ ok: true, channel: calls, keepOpen: true })).toEqual({ action: 'none' });
    });

    it('never navigates on failure', () => {
        expect(decideCreateNavigation({ ok: false, channel: undefined, keepOpen: false })).toEqual({ action: 'none' });
        expect(decideCreateNavigation({ ok: false, channel: text, keepOpen: false })).toEqual({ action: 'none' });
    });

    it('refuses the optimistic temp id and uses only the real one', () => {
        const temp = { channel_id: `${PENDING_CHANNEL_PREFIX}1234`, kind: 'text' };
        expect(decideCreateNavigation({ ok: true, channel: temp, keepOpen: false })).toEqual({ action: 'none' });
        expect(decideCreateNavigation({ ok: true, channel: { ...temp, channel_id: 'real-9' }, keepOpen: false }))
            .toEqual({ action: 'open', channelId: 'real-9' });
    });

    it('refuses a missing or empty id', () => {
        expect(decideCreateNavigation({ ok: true, channel: null, keepOpen: false })).toEqual({ action: 'none' });
        expect(decideCreateNavigation({ ok: true, channel: { channel_id: '', kind: 'text' }, keepOpen: false })).toEqual({ action: 'none' });
    });
});
