import React from 'react';
import { Bell, BellOff } from 'lucide-react';
import type { ContextMenuItem } from '../primitives/ContextMenu';
import type { ChannelMuteApi } from '../../contexts/ChannelMuteContext';
import { MUTE_DURATIONS, mutedHint } from '../../utils/channelMute';
import { formatClock, formatDateTime } from '../../utils/a11y/timeFormat';

/**
 * The right-click "Mute <noun>" submenu (or, when already muted, the
 * "Unmute <noun>" row plus a "Muted until 3:40 PM" hint). One builder for text
 * channels, Calls channels, categories and the server rail so they cannot
 * drift. Times go through the shared a11y formatter, so the user's 12/24 h
 * setting applies.
 */
export function buildMuteItems(api: ChannelMuteApi, id: string, noun: string): ContextMenuItem[] {
    const rec = api.mutes[id];
    const hint = mutedHint(
        rec, Date.now(), ms => formatClock(ms),
        ms => formatDateTime(ms, undefined, { weekday: 'short' }),
    );
    if (hint) {
        return [
            { icon: <Bell />, label: `Unmute ${noun}`, onSelect: () => api.unmute(id) },
            { icon: <BellOff />, label: hint, disabled: true, onSelect: () => {} },
        ];
    }
    return [{
        icon: <BellOff />,
        label: `Mute ${noun}`,
        onSelect: () => {},
        submenu: MUTE_DURATIONS.map(d => ({ label: d.label, onSelect: () => api.mute(id, d.id) })),
    }];
}

/** Small "muted" glyph for a dimmed row. Colour comes from the row (tokens). */
export const MutedGlyph: React.FC<{ size?: number }> = ({ size = 12 }) => (
    <span role="img" aria-label="muted" title="Muted" className="shrink-0 text-cl-faint inline-flex">
        <BellOff size={size} aria-hidden="true" />
    </span>
);
