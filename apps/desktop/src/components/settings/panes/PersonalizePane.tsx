import React, { useEffect, useRef, useState } from 'react';
import { SmilePlus, Pencil, Trash2, ChevronLeft, ChevronRight } from 'lucide-react';
import { ClButton, ClConfirm, ClInput } from '../../cl';
import { PersonalEmojiImage } from '../../PersonalEmoji';
import { AddEmojiDialog } from './AddEmojiDialog';
import { MostPlayedSetting } from './MostPlayedSetting';
import { CallPersonalizeCard } from './CallPersonalizeCard';
import { SettingsDisclosure } from '../SettingsDisclosure';
import '../../../styles/settings-ui.css';
import { usePersonalEmojiLibrary } from '../../../hooks/usePersonalEmojis';
import { useEscape } from '../../../hooks/useEscape';
import { personalEmojis } from '../../../utils/personalEmoji/service';
import { PERSONAL_EMOJI_LIBRARY_MAX, isPersonalEmojiName } from '../../../utils/personalEmoji/token';
import { EMOJI_INPUT_MAX_BYTES } from '../../../utils/personalEmoji/process/protocol';
import type { LibraryError } from '../../../utils/personalEmoji/library';

/**
 * Surface · Personalize - things that are yours alone. Home of My Emojis now
 * and of future personalization features.
 *
 * Calm layout: three accordion sections (only the one you are editing is open).
 * My Emojis shows its first two rows and folds the rest under "Show all".
 *
 * My Emojis: up to 100, free for everyone, usable in every chat and as
 * reactions. Add from any picture (shrunk on this computer), rename, reorder
 * (drag, or the arrow buttons / Alt+Left and Alt+Right), delete.
 */

const ERROR_TEXT: Record<LibraryError, string> = {
    full: `You can have ${PERSONAL_EMOJI_LIBRARY_MAX} emojis. Remove one first.`,
    duplicate_name: 'You already have an emoji with that name.',
    invalid_name: 'Names are 2 to 32 characters: lowercase letters, numbers and underscores.',
    not_found: 'That emoji is gone.',
};

const MyEmojisCard: React.FC = () => {
    const { entries } = usePersonalEmojiLibrary();
    const lib = personalEmojis();
    const fileRef = useRef<HTMLInputElement>(null);
    const gridRef = useRef<HTMLDivElement>(null);

    const [pending, setPending] = useState<File | null>(null);
    const [pickError, setPickError] = useState('');
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [activeId, setActiveId] = useState<string | null>(null);
    const [renaming, setRenaming] = useState<string | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const [actionError, setActionError] = useState('');
    const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
    const [dragId, setDragId] = useState<string | null>(null);
    const [dropIdx, setDropIdx] = useState<number | null>(null);
    const [dropActive, setDropActive] = useState(false);
    const [announce, setAnnounce] = useState('');
    const [expanded, setExpanded] = useState(false);
    const [cols, setCols] = useState(8);

    // Escape cancels an open rename before it can close the whole Settings screen.
    useEscape(() => { setRenaming(null); setActionError(''); }, renaming !== null);

    const full = entries.length >= PERSONAL_EMOJI_LIBRARY_MAX;
    const selected = entries.find(e => e.id === selectedId) ?? null;

    // Two rows by default: the column count follows the grid's width (76px tiles, 8px gaps).
    const hasEntries = entries.length > 0;
    useEffect(() => {
        const el = gridRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(() => setCols(Math.max(1, Math.floor((el.clientWidth + 8) / (76 + 8)))));
        ro.observe(el);
        return () => ro.disconnect();
    }, [hasEntries]);
    const limit = cols * 2;
    const visible = expanded ? entries : entries.slice(0, limit);
    const tabbableId = (visible.find(e => e.id === activeId) ?? visible[0])?.id;

    const chooseFile = (f: File | null | undefined) => {
        setPickError('');
        if (!f) return;
        if (!f.type.startsWith('image/') || f.type === 'image/svg+xml') { setPickError('Pick a picture: PNG, JPG, GIF, WebP or similar.'); return; }
        if (f.size > EMOJI_INPUT_MAX_BYTES) { setPickError('That file is bigger than 25 MB.'); return; }
        setPending(f);
    };

    const startRename = (id: string) => {
        const e = entries.find(x => x.id === id);
        if (!e) return;
        setRenaming(id); setRenameValue(e.name); setActionError('');
    };
    const commitRename = () => {
        if (!renaming) return;
        const res = lib.rename(renaming, renameValue);
        if (res.ok) { setRenaming(null); setActionError(''); setAnnounce(`Renamed to ${renameValue}`); }
        else setActionError(ERROR_TEXT[res.error]);
    };

    const move = (id: string, delta: number) => {
        const idx = entries.findIndex(e => e.id === id);
        if (idx < 0) return;
        const to = idx + delta;
        if (to < 0 || to >= entries.length) return;
        lib.move(id, to);
        setAnnounce(`Moved to position ${to + 1} of ${entries.length}`);
        requestAnimationFrame(() => gridRef.current?.querySelector<HTMLElement>(`[data-emoji-id="${id}"]`)?.focus());
    };

    const doDelete = (id: string) => {
        const idx = entries.findIndex(e => e.id === id);
        const name = entries[idx]?.name;
        lib.remove(id);
        setConfirmDelete(null); setSelectedId(null);
        const next = entries[idx + 1] ?? entries[idx - 1];
        setActiveId(next?.id ?? null);
        setAnnounce(`Removed ${name ?? 'emoji'}`);
        requestAnimationFrame(() => (next ? gridRef.current?.querySelector<HTMLElement>(`[data-emoji-id="${next.id}"]`) : fileRef.current)?.focus());
    };

    /** Columns currently laid out, for Up/Down arrow movement. */
    const columns = () => {
        const tiles = gridRef.current?.querySelectorAll<HTMLElement>('[data-emoji-id]');
        if (!tiles || tiles.length < 2) return 1;
        const top = tiles[0].offsetTop;
        let n = 0;
        for (const t of tiles) { if (t.offsetTop !== top) break; n++; }
        return Math.max(1, n);
    };

    const onTileKeyDown = (e: React.KeyboardEvent, id: string, idx: number) => {
        const focusIdx = (i: number) => {
            const at = Math.max(0, Math.min(entries.length - 1, i));
            const target = entries[at];
            if (!target) return;
            setActiveId(target.id);
            const focusIt = () => gridRef.current?.querySelector<HTMLElement>(`[data-emoji-id="${target.id}"]`)?.focus();
            // Arrowing past the visible rows opens the rest, so keyboard users never hit a wall.
            if (at >= visible.length) { setExpanded(true); requestAnimationFrame(focusIt); } else focusIt();
        };
        if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); move(id, e.key === 'ArrowLeft' ? -1 : 1); return; }
        switch (e.key) {
            case 'ArrowRight': e.preventDefault(); focusIdx(idx + 1); break;
            case 'ArrowLeft': e.preventDefault(); focusIdx(idx - 1); break;
            case 'ArrowDown': e.preventDefault(); focusIdx(idx + columns()); break;
            case 'ArrowUp': e.preventDefault(); focusIdx(idx - columns()); break;
            case 'Home': e.preventDefault(); focusIdx(0); break;
            case 'End': e.preventDefault(); focusIdx(entries.length - 1); break;
            case 'F2': e.preventDefault(); setSelectedId(id); startRename(id); break;
            case 'Delete': case 'Backspace': e.preventDefault(); setConfirmDelete(id); break;
            default: break;
        }
    };

    return (
        <SettingsDisclosure
            id="personalize.emojis" variant="card" defaultOpen title="My Emojis"
            summary={entries.length === 0 ? 'Your own emojis, free for everyone' : `${entries.length} of ${PERSONAL_EMOJI_LIBRARY_MAX}`}
            labels={['My Emojis', 'Add emoji']}
            action={(
                <ClButton size="sm" disabled={full} onClick={() => fileRef.current?.click()} tooltip={full ? 'Full. Remove an emoji to add another.' : undefined}>
                    <SmilePlus size={14} className="mr-1.5" aria-hidden="true" /> Add emoji
                </ClButton>
            )}
        >
        <div
            className={`rounded-xl ${dropActive ? 'outline outline-1 outline-dashed outline-cl-lume' : ''}`}
            onDragOver={e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropActive(true); } }}
            onDragLeave={() => setDropActive(false)}
            onDrop={e => { e.preventDefault(); setDropActive(false); if (e.dataTransfer.files[0]) chooseFile(e.dataTransfer.files[0]); }}
        >
            <p className="su-hint" style={{ margin: '0 0 8px' }}>
                Use them in any chat and as reactions. Shrunk to 128 px here, sent inside end-to-end encrypted messages. GIFs and WebPs animate.
                {' '}{full ? 'Full: remove one to add another.' : 'Drop a picture anywhere in this section.'}
            </p>
            <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp"
                className="hidden"
                onChange={e => { chooseFile(e.target.files?.[0]); e.target.value = ''; }}
            />
            {pickError && <div className="text-xs text-cl-flash mt-2" role="alert">{pickError}</div>}

            {entries.length === 0 ? (
                <div className="mt-4 text-center text-[13px] text-cl-faint py-6">
                    No emojis yet. Add a picture and it is ready to use everywhere.
                </div>
            ) : (
                <>
                    <div
                        ref={gridRef}
                        role="listbox"
                        aria-label="My Emojis"
                        aria-orientation="horizontal"
                        className="grid gap-2"
                        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(76px, 1fr))' }}
                    >
                        {visible.map((e, i) => {
                            const isSel = e.id === selectedId;
                            return (
                                <div
                                    key={e.id}
                                    className="relative"
                                    onDragOver={ev => { if (dragId) { ev.preventDefault(); setDropIdx(i); } }}
                                    onDrop={ev => { ev.preventDefault(); if (dragId && dragId !== e.id) lib.move(dragId, i); setDragId(null); setDropIdx(null); }}
                                >
                                    {dropIdx === i && dragId && dragId !== e.id && (
                                        <span className="absolute -left-1 top-1 bottom-1 w-0.5 rounded bg-cl-lume" aria-hidden="true" />
                                    )}
                                    <button
                                        type="button"
                                        role="option"
                                        aria-selected={isSel}
                                        aria-label={`:${e.name}:${e.animated ? ', animated' : ''}, position ${i + 1} of ${entries.length}`}
                                        data-emoji-id={e.id}
                                        tabIndex={e.id === tabbableId ? 0 : -1}
                                        draggable
                                        onDragStart={ev => { setDragId(e.id); ev.dataTransfer.effectAllowed = 'move'; }}
                                        onDragEnd={() => { setDragId(null); setDropIdx(null); }}
                                        onFocus={() => setActiveId(e.id)}
                                        onClick={() => { setSelectedId(isSel ? null : e.id); setRenaming(null); setActionError(''); }}
                                        onKeyDown={ev => onTileKeyDown(ev, e.id, i)}
                                        className={`w-full flex flex-col items-center gap-1 rounded-xl px-1 py-2 border transition-colors ${isSel ? 'border-cl-lume bg-cl-lume/10' : 'border-transparent hover:bg-white/5'} ${dragId === e.id ? 'opacity-40' : ''}`}
                                    >
                                        <PersonalEmojiImage id={e.id} name={e.name} saveable={false} style={{ width: 44, height: 44 }} />
                                        <span className="text-[11px] text-cl-faint truncate w-full text-center">:{e.name}:</span>
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                    {entries.length > limit && (
                        <div className="su-more">
                            <ClButton variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded(x => !x)}>
                                {expanded ? 'Show fewer' : `Show all ${entries.length}`}
                            </ClButton>
                        </div>
                    )}
                    <div className="text-[11px] text-cl-faint mt-2">
                        Select one to rename, move or remove it. Drag to reorder, or use Alt + the arrow keys.
                    </div>
                </>
            )}

            {selected && (
                <div className="mt-3 rounded-xl bg-cl-raise/40 px-3 py-2.5 flex flex-wrap items-center gap-2" role="group" aria-label={`Actions for ${selected.name}`}>
                    {renaming === selected.id ? (
                        <>
                            <span className="text-cl-faint">:</span>
                            <ClInput
                                autoFocus
                                value={renameValue}
                                maxLength={32}
                                spellCheck={false}
                                style={{ width: 200 }}
                                error={!isPersonalEmojiName(renameValue)}
                                aria-label="Emoji name"
                                onChange={ev => { setRenameValue(ev.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_')); setActionError(''); }}
                                onKeyDown={ev => {
                                    if (ev.key === 'Enter') { ev.preventDefault(); commitRename(); }
                                }}
                            />
                            <span className="text-cl-faint">:</span>
                            <ClButton size="sm" onClick={commitRename} disabled={!isPersonalEmojiName(renameValue)}>Save</ClButton>
                            <ClButton size="sm" variant="ghost" onClick={() => { setRenaming(null); setActionError(''); }}>Cancel</ClButton>
                        </>
                    ) : (
                        <>
                            <span className="text-[13px] mr-auto truncate">:{selected.name}:{selected.animated ? ' (animated)' : ''}</span>
                            <ClButton size="sm" variant="ghost" onClick={() => startRename(selected.id)}><Pencil size={14} className="mr-1.5" aria-hidden="true" />Rename</ClButton>
                            <ClButton size="sm" variant="ghost" disabled={entries[0]?.id === selected.id} onClick={() => move(selected.id, -1)}><ChevronLeft size={14} className="mr-1" aria-hidden="true" />Earlier</ClButton>
                            <ClButton size="sm" variant="ghost" disabled={entries[entries.length - 1]?.id === selected.id} onClick={() => move(selected.id, 1)}>Later<ChevronRight size={14} className="ml-1" aria-hidden="true" /></ClButton>
                            <ClButton size="sm" variant="danger" onClick={() => setConfirmDelete(selected.id)}><Trash2 size={14} className="mr-1.5" aria-hidden="true" />Remove</ClButton>
                        </>
                    )}
                </div>
            )}
            {actionError && <div className="text-xs text-cl-flash mt-2" role="alert">{actionError}</div>}

            <div className="sr-only" role="status" aria-live="polite">{announce}</div>

            {pending && <AddEmojiDialog file={pending} onClose={() => setPending(null)} onAdded={e => { setSelectedId(e.id); setActiveId(e.id); setAnnounce(`Added ${e.name}`); }} />}

            <ClConfirm
                open={!!confirmDelete}
                onClose={() => setConfirmDelete(null)}
                onConfirm={() => confirmDelete && doDelete(confirmDelete)}
                danger
                title="Remove this emoji?"
                message="It disappears from your picker and your other devices. Messages that already used it keep showing it for the people who got them."
                confirmLabel="Remove"
            />
        </div>
        </SettingsDisclosure>
    );
};

export const PersonalizePane: React.FC = () => (
    <div className="pz-main">
        <MyEmojisCard />
        <CallPersonalizeCard />
        <MostPlayedSetting />
    </div>
);
