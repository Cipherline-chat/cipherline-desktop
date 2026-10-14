import React from 'react';
import { Volume2 } from 'lucide-react';
import { channelPillView, resolveChannelRef, type ChannelRef, type LinkableChannel } from '../utils/channelRefs';

export interface ChannelRefPillProps {
    channelRef: ChannelRef;
    /** Channels the reader can view in the server being read (linkableChannels),
     *  or null while that list has not loaded. */
    visibleChannels: readonly LinkableChannel[] | null;
    /** Called with the channel id when a VISIBLE link is activated. */
    onNavigate?: (channelId: string) => void;
}

/**
 * One `#channel` link inside a message (utils/channelRefs.ts). Hook-free on
 * purpose, so it renders in the plain node test environment.
 *
 * Visible: the channel's current name, keyboard-focusable `role="link"` with
 * the accessible name "Channel <name>", topic on hover, Enter/Space/click
 * navigate. Anything else: one neutral, inert style whatever the reason, so a
 * private channel cannot be told apart from a deleted one.
 *
 * Text stays selectable (unlike mention pills) so selecting and copying a
 * message yields `#name`.
 */
export function ChannelRefPill({ channelRef, visibleChannels, onNavigate }: ChannelRefPillProps): React.ReactElement {
    const resolution = resolveChannelRef(channelRef, visibleChannels);
    const view = channelPillView(channelRef, resolution);
    const clickable = view.clickable && !!onNavigate && resolution.state === 'visible';
    const activate = (e: React.MouseEvent | React.KeyboardEvent) => {
        e.stopPropagation();
        if (resolution.state === 'visible') onNavigate?.(resolution.channel.channel_id);
    };
    const cls = clickable
        ? 'bg-white/[0.07] text-cl-text hover:bg-white/[0.12] hover:underline cursor-pointer'
        : 'bg-white/[0.04] text-cl-faint cursor-default';
    return (
        <span
            className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[0.9em] font-semibold align-baseline transition-colors ${cls}`}
            data-channel-ref={clickable ? 'link' : 'inert'}
            title={view.title}
            {...(clickable ? {
                role: 'link' as const,
                tabIndex: 0,
                'aria-label': view.ariaLabel,
                onClick: activate,
                onKeyDown: (e: React.KeyboardEvent) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        activate(e);
                    }
                },
            } : {
                'aria-label': view.ariaLabel,
            })}
        >
            {view.kind === 'call' ? (
                <>
                    <Volume2 aria-hidden="true" className="shrink-0" style={{ width: '0.95em', height: '0.95em' }} />
                    {/* Zero-size but real text: a selection copy still reads "#name". */}
                    <span aria-hidden="true" style={{ fontSize: 0 }}>#</span>
                </>
            ) : (
                <span aria-hidden="true">#</span>
            )}
            {view.label}
        </span>
    );
}
