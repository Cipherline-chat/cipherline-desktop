import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChannelRefPill, type ChannelRefPillProps } from './ChannelRefPill';
import { UNAVAILABLE_CHANNEL_LABEL, type LinkableChannel } from '../utils/channelRefs';

// .ts (not .tsx): vitest here only collects *.test.ts, so no JSX.
const h = React.createElement;
const html = (p: ChannelRefPillProps) => renderToStaticMarkup(h(ChannelRefPill, p));
/** Text a reader sees / a selection copies (tags stripped). */
const text = (p: ChannelRefPillProps) => html(p).replace(/<[^>]+>/g, '');

const base = { server_id: 's', topic: null, icon_emoji: null, icon_name: null, position: 0, parent_category_id: null };
const memes: LinkableChannel = { ...base, channel_id: 'c-memes', kind: 'text', name: 'memes', topic: 'dank only' };
const lounge: LinkableChannel = { ...base, channel_id: 'c-lounge', kind: 'huddle', name: 'lounge' };
const visible = [memes, lounge];

/** The pill's root element, with its props, so handlers can be invoked directly
 *  (the component is hook-free, so calling it is rendering it). */
type PillHandler = ((e: ReturnType<typeof fakeEvent>) => void) | undefined;
const root = (p: ChannelRefPillProps) => ChannelRefPill(p) as React.ReactElement<{ onClick: PillHandler; onKeyDown: PillHandler }>;
const fakeEvent = (key?: string) => ({ key, stopPropagation: vi.fn(), preventDefault: vi.fn() });

describe('ChannelRefPill rendering states', () => {
    it('visible: "#memes", a focusable link named "Channel memes", topic on hover', () => {
        const out = html({ channelRef: { id: 'c-memes', name: 'memes' }, visibleChannels: visible, onNavigate: () => {} });
        expect(out).toContain('role="link"');
        expect(out).toContain('tabindex="0"');
        expect(out).toContain('aria-label="Channel memes"');
        expect(out).toContain('title="dank only"');
        expect(text({ channelRef: { id: 'c-memes', name: 'memes' }, visibleChannels: visible })).toBe('#memes');
    });

    it('renamed: shows the current name from the id, not the stored one', () => {
        const renamed = [{ ...memes, name: 'dank-memes' }];
        const p = { channelRef: { id: 'c-memes', name: 'memes' }, visibleChannels: renamed, onNavigate: () => {} };
        expect(text(p)).toBe('#dank-memes');
        expect(html(p)).toContain('aria-label="Channel dank-memes"');
    });

    it('hidden and deleted render byte-for-byte the same, inert, without the stored name', () => {
        const hidden = html({ channelRef: { id: 'c-secret', name: 'secret-plans' }, visibleChannels: visible, onNavigate: () => {} });
        const deleted = html({ channelRef: { id: 'c-gone', name: 'old-stuff' }, visibleChannels: visible, onNavigate: () => {} });
        expect(hidden).toBe(deleted);
        expect(hidden).not.toContain('secret');
        expect(hidden).not.toContain('role="link"');
        expect(hidden).not.toContain('tabindex');
        expect(hidden.replace(/<[^>]+>/g, '')).toBe(`#${UNAVAILABLE_CHANNEL_LABEL}`);
    });

    it('call channel: speaker icon, copy text still "#lounge"', () => {
        const p = { channelRef: { id: 'c-lounge', name: 'lounge' }, visibleChannels: visible, onNavigate: () => {} };
        expect(html(p)).toContain('<svg');
        expect(text(p)).toBe('#lounge');
    });

    it('list not loaded yet: stored name, inert', () => {
        const p = { channelRef: { id: 'c-memes', name: 'memes' }, visibleChannels: null, onNavigate: () => {} };
        expect(text(p)).toBe('#memes');
        expect(html(p)).not.toContain('role="link"');
    });

    it('no navigate handler (e.g. a surface without one): not a link', () => {
        expect(html({ channelRef: { id: 'c-memes', name: 'memes' }, visibleChannels: visible })).not.toContain('role="link"');
    });
});

describe('ChannelRefPill navigation', () => {
    it('click navigates to the channel id and stops the row click', () => {
        const onNavigate = vi.fn();
        const el = root({ channelRef: { id: 'c-memes', name: 'memes' }, visibleChannels: visible, onNavigate });
        const e = fakeEvent();
        el.props.onClick!(e);
        expect(onNavigate).toHaveBeenCalledWith('c-memes');
        expect(e.stopPropagation).toHaveBeenCalled();
    });

    it('Enter and Space activate; other keys do not', () => {
        const onNavigate = vi.fn();
        const el = root({ channelRef: { id: 'c-memes', name: 'memes' }, visibleChannels: visible, onNavigate });
        el.props.onKeyDown!(fakeEvent('Enter'));
        el.props.onKeyDown!(fakeEvent(' '));
        el.props.onKeyDown!(fakeEvent('a'));
        expect(onNavigate).toHaveBeenCalledTimes(2);
    });

    it('negative control: an unavailable ref has no click handler at all', () => {
        const onNavigate = vi.fn();
        const el = root({ channelRef: { id: 'c-secret', name: 'secret-plans' }, visibleChannels: visible, onNavigate });
        expect(el.props.onClick).toBeUndefined();
        expect(el.props.onKeyDown).toBeUndefined();
        expect(onNavigate).not.toHaveBeenCalled();
    });
});
