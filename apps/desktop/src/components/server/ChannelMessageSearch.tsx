/**
 * ChannelMessageSearch — purely client-side search across the *decrypted*
 * messages of the currently open text channel. The server never sees the
 * query — E2EE intact (cipherline does not index plaintext server-side).
 *
 * Visually and behaviourally identical to the DM/group "Search in chat" bar
 * in pane 4. Filtering is a case-insensitive substring match; up to 8 hits
 * are surfaced in a dropdown beneath the bar. Click → `onJumpToMessage`.
 * Esc clears. Empty query hides the results but keeps the bar visible.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { ClButton, ClSearch } from '../cl';
import { searchExcerpt } from '../../utils/messagePreviewText';

export interface SearchableMessage {
    id: string;
    sender_user_id: string;
    sender_display_name?: string;
    /** Decrypted plaintext; missing/empty messages skipped. */
    text: string;
    created_at: string;
}

interface Props {
    /** Active text channel id — used as a query reset trigger. Null = hide. */
    channelId: string | null;
    /** Decrypted messages from the active channel. */
    messages: SearchableMessage[];
    onJumpToMessage: (messageId: string) => void;
}

const MAX_HITS = 8;

export const ChannelMessageSearch: React.FC<Props> = ({ channelId, messages, onJumpToMessage }) => {
    const [query, setQuery] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    // Reset query whenever the user switches channels.
    useEffect(() => { setQuery(''); }, [channelId]);

    if (!channelId) return null;

    const trimmed = query.trim();
    const hits: Array<SearchableMessage & { __excerpt: React.ReactNode }> = [];
    if (trimmed.length > 0) {
        for (const m of messages) {
            // Matched and excerpted on the DISPLAY text, so a mention shows as
            // "@dawson", never its wire token (see utils/messagePreviewText.ts).
            const ex = searchExcerpt(m.text, trimmed);
            if (!ex) continue;
            const { before, match, after } = ex;
            hits.push({
                ...m,
                __excerpt: (
                    <>
                        <span className="text-cl-muted">{before}</span>
                        <span className="text-cl-lume font-semibold">{match}</span>
                        <span className="text-cl-muted">{after}</span>
                    </>
                ),
            });
            if (hits.length >= MAX_HITS) break;
        }
    }

    return (
        /* No own horizontal padding — parent (ServerContextPanel px-2) provides it */
        <div className="shrink-0">
            <div className="relative">
                {/* Kit search field — the `.srch` wrapper owns the icon slot and
                    input padding, same recipe as the DM-list search. (A Tailwind
                    pl-9 on a raw ClInput loses to the kit's own `.inp` padding.) */}
                {/*
                  * DELIBERATE ESCAPE EXCEPTION — see escapeOwnership.test.ts's
                  * allowlist. This field is a persistent, always-mounted inline
                  * search (not a layer that opens/closes), so its Escape-to-clear
                  * is scoped by DOM FOCUS via ordinary bubble-phase onKeyDown,
                  * not by the modal LIFO stack. That composes correctly with
                  * escapeStack as-is: whenever a real layer (dialog, menu,
                  * picker) is open, the stack's capture-phase listener consumes
                  * the press before it can bubble here, so the open layer always
                  * wins even if this input happens to still have focus. When no
                  * layer is open, the press reaches this handler exactly as
                  * before. Moving this onto the stack would require tracking
                  * DOM focus explicitly for no behavioural gain.
                  */}
                <ClSearch
                    ref={inputRef}
                    icon={<Search size={15} />}
                    type="text"
                    placeholder="Search in channel"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Escape') { setQuery(''); inputRef.current?.blur(); }
                    }}
                    className="text-[13px]"
                    style={{ paddingTop: 8, paddingBottom: 8, borderRadius: 11, paddingRight: 32 }}
                />
                {query.length > 0 && (
                    <button
                        title="Clear"
                        onClick={() => { setQuery(''); inputRef.current?.focus(); }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 w-[22px] h-[22px] flex items-center justify-center rounded-md text-cl-faint hover:text-cl-text hover:bg-white/[0.06] transition-colors"
                    >
                        <X size={12} />
                    </button>
                )}
            </div>

            {/* Results dropdown — only shown when there's a non-empty query */}
            {trimmed.length > 0 && (
                <div className="mt-1.5 max-h-[220px] overflow-y-auto custom-scrollbar rounded-xl bg-cl-deep border border-cl-border/50 shadow-xl fade-drop-enter">
                    {hits.length === 0 ? (
                        <div className="px-3 py-3 text-xs text-cl-faint text-center">
                            No matches in this channel.
                        </div>
                    ) : (
                        <ul className="py-1">
                            {hits.map(h => (
                                <li key={h.id}>
                                    <ClButton
                                        variant="ghost"
                                        fullWidth
                                        row
                                        onClick={() => { onJumpToMessage(h.id); setQuery(''); }}
                                    >
                                        <div className="w-full">
                                            <div className="text-[10px] uppercase tracking-wider text-cl-faint font-semibold mb-0.5">
                                                {h.sender_display_name ?? 'Unknown User'}
                                            </div>
                                            <div className="text-xs leading-snug truncate">
                                                {h.__excerpt}
                                            </div>
                                        </div>
                                    </ClButton>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
};

export default ChannelMessageSearch;
