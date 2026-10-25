/**
 * CustomStatusInline — set, edit or clear the custom status right inside the
 * status picker popover (it replaced the separate CustomStatusDialog).
 *
 * One emoji (unicode, or one of the user's My Emojis as a `cl:p_…` reference,
 * see utils/customStatus.ts), up to 100 characters of text, and "Clear after".
 * Enter (or Save) commits, × clears an existing status at once, Escape is
 * handled by the host popover's escape layer: it closes the popover, and the
 * unsaved draft is dropped when `open` turns false. The server validates and
 * enforces the expiry independently; this mirrors the rules for UX only.
 *
 * Presentational: the host owns the network call via `onSave`.
 */
import React, { useMemo, useRef, useState } from 'react';
import { Smile, X } from 'lucide-react';
import { ClButton, ClInput, ClSelect } from './cl';
import EmojiPickerPopover from './emojiPickerLazy';
import { StatusEmoji } from './StatusLine';
import { personalStatusEmoji } from './personalStatusEmoji';
import { personalEmojis } from '../utils/personalEmoji/service';
import { statusEmojiFromSelection } from '../utils/personalEmoji/statusEmoji';
import {
    CLEAR_AFTER_OPTIONS, CUSTOM_STATUS_TEXT_MAX, describeExpiry, draftIsEmpty, draftIssue, draftPayload, initialDraft,
    type ClearAfterChoice, type CurrentCustomStatus, type CustomStatusDraft, type CustomStatusPayload,
} from '../utils/customStatus';

interface Props {
    /** The active (unexpired) status, or null. */
    current: CurrentCustomStatus | null;
    /** Whether the host popover is open: the draft re-syncs on every open/close. */
    open: boolean;
    onSave: (payload: CustomStatusPayload) => void;
    /** After Enter/Save, so the host can close its popover. */
    onSaved?: () => void;
}

const sameDraft = (a: CustomStatusDraft, b: CustomStatusDraft) =>
    a.text === b.text && a.emoji === b.emoji && a.clearAfter === b.clearAfter;

export const CustomStatusInline: React.FC<Props> = ({ current, open, onSave, onSaved }) => {
    const [draft, setDraft] = useState(() => initialDraft(current));
    const [emojiIssue, setEmojiIssue] = useState<string | null>(null);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [emojiBtn, setEmojiBtn] = useState<HTMLButtonElement | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    const baseline = useMemo(
        () => initialDraft(current),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the fields, not the object identity
        [current?.text, current?.emoji, current?.expiresAt],
    );
    // Start from the stored status every time the popover opens or closes (so a
    // discarded edit never reappears) and when the stored status changes.
    // (State adjusted during render, React's documented alternative to an effect.)
    const [synced, setSynced] = useState({ open, baseline });
    if (synced.open !== open || synced.baseline !== baseline) {
        setSynced({ open, baseline });
        setDraft(baseline);
        setEmojiIssue(null);
        setPickerOpen(false);
    }

    const hadStatus = !!current && (current.text !== '' || current.emoji !== '');
    const issue = draftIssue(draft);
    const dirty = !sameDraft(draft, baseline);
    const canSave = issue === null && dirty && (!draftIsEmpty(draft) || hadStatus);

    const options = useMemo(() => {
        const base: { value: ClearAfterChoice; label: string }[] = CLEAR_AFTER_OPTIONS.map(o => ({ value: o.id, label: o.label }));
        if (draft.clearAfter === 'keep') {
            const when = describeExpiry(current?.expiresAt);
            base.unshift({ value: 'keep', label: when ? `Keep (${when.toLowerCase()})` : 'Keep current' });
        }
        return base;
    }, [draft.clearAfter, current?.expiresAt]);

    const save = () => {
        if (!canSave) return;
        onSave(draftPayload(draft, current?.expiresAt ?? null));
        onSaved?.();
    };

    const clear = () => {
        if (hadStatus) onSave(draftPayload({ text: '', emoji: '', clearAfter: 'never' }, null));
        setDraft({ text: '', emoji: '', clearAfter: 'never' });
        setEmojiIssue(null);
        inputRef.current?.focus();
    };

    const message = issue ?? emojiIssue;

    return (
        <div className="px-3 py-3" data-testid="custom-status-inline">
            <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] font-bold text-cl-faint uppercase tracking-widest m-0">Custom status</p>
                {draft.text.length >= CUSTOM_STATUS_TEXT_MAX - 20 && (
                    <span className="text-[10.5px] text-cl-faint">{draft.text.length}/{CUSTOM_STATUS_TEXT_MAX}</span>
                )}
            </div>
            <div className="flex items-center gap-1.5">
                <button
                    ref={setEmojiBtn}
                    type="button"
                    onClick={() => setPickerOpen(v => !v)}
                    aria-label={draft.emoji ? 'Change status emoji' : 'Add a status emoji'}
                    title={draft.emoji ? 'Change emoji' : 'Add an emoji'}
                    className="w-10 h-10 shrink-0 rounded-xl bg-cl-sink border border-white/[0.08] flex items-center justify-center text-lg p-0 cursor-pointer hover:border-white/20 transition-colors"
                >
                    {draft.emoji
                        ? <StatusEmoji value={draft.emoji} renderCustom={personalStatusEmoji(null, true)} />
                        : <Smile size={17} className="text-cl-faint" />}
                </button>
                <ClInput
                    ref={inputRef}
                    value={draft.text}
                    maxLength={CUSTOM_STATUS_TEXT_MAX}
                    placeholder="What's happening?"
                    aria-label="Status text"
                    aria-invalid={issue !== null}
                    error={issue !== null}
                    className="!py-2 !px-3 !text-[13px] min-w-0"
                    onChange={e => setDraft(d => ({ ...d, text: e.target.value }))}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); save(); } }}
                    style={{ flex: 1, minWidth: 0 }}
                />
                {(draft.text || draft.emoji || hadStatus) && (
                    <button
                        type="button"
                        onClick={clear}
                        title="Clear status"
                        aria-label="Clear status"
                        data-testid="clear-custom-status"
                        className="w-8 h-8 shrink-0 rounded-full border-none bg-transparent p-0 flex items-center justify-center text-cl-faint hover:text-cl-text hover:bg-white/[0.08] cursor-pointer transition-colors"
                    >
                        <X size={15} />
                    </button>
                )}
            </div>
            {message && <div role="alert" className="text-[12px] text-cl-danger mt-2">{message}</div>}

            <div className="flex items-center gap-2 mt-2.5">
                <span className="text-[11.5px] text-cl-faint shrink-0">Clear after</span>
                <ClSelect<ClearAfterChoice>
                    options={options}
                    value={draft.clearAfter}
                    onChange={v => setDraft(d => ({ ...d, clearAfter: v }))}
                    ariaLabel="Clear after"
                    className="flex-1 min-w-0 [&_.selt]:!py-1.5 [&_.selt]:!px-2.5 [&_.selt]:!text-[12px] [&_.selt]:!rounded-[10px]"
                    style={{ minWidth: 0 }}
                />
                {dirty && (
                    <ClButton size="sm" onClick={save} disabled={!canSave}>Save</ClButton>
                )}
            </div>

            {pickerOpen && (
                <EmojiPickerPopover
                    anchorEl={emojiBtn}
                    onClose={() => setPickerOpen(false)}
                    onEmojiSelect={sel => {
                        // A unicode pick, or one of the user's My Emojis (`cl:p_…`).
                        const choice = statusEmojiFromSelection(sel, id => personalEmojis().store.meta(id));
                        if (choice && 'emoji' in choice) { setEmojiIssue(null); setDraft(d => ({ ...d, emoji: choice.emoji })); }
                        else setEmojiIssue(choice ? choice.issue : null);
                        setPickerOpen(false);
                        inputRef.current?.focus();
                    }}
                />
            )}
        </div>
    );
};

export default CustomStatusInline;
