/**
 * TriStateControl — the explicit Deny / Inherit / Allow picker for one
 * permission override (or a whole group of them).
 *
 * Replaces the old click-to-cycle row (Neutral → Allow → Deny → …), where
 * getting from Allow to Neutral took two clicks and the current state was
 * only readable after you had already clicked. Here every state is its own
 * target, one click away.
 *
 * Keyboard: it is a radio group with a roving tab stop — Tab lands on the
 * selected segment, ←/→ (or ↑/↓) move AND select, Home/End jump to the ends.
 * Letter shortcuts while focused: A = allow, D = deny, I or / = inherit.
 *
 * `value === null` renders the MIXED state for a group control (no segment
 * selected); choosing a segment then applies it to every bit in the group.
 */

import React, { useRef } from 'react';
import { Check, Slash, X } from 'lucide-react';
import type { Tri } from './overrideDraft';

const ORDER: Tri[] = ['deny', 'inherit', 'allow'];

const META: Record<Tri, { word: string; icon: React.ReactNode; iconSm: React.ReactNode; on: string }> = {
    deny: {
        word: 'Deny',
        icon: <X size={13} strokeWidth={2.6} />,
        iconSm: <X size={11} strokeWidth={2.6} />,
        on: 'bg-cl-flash/20 text-cl-flash shadow-[inset_0_0_0_1px_rgba(255,107,94,0.55)]',
    },
    inherit: {
        word: 'Inherit',
        icon: <Slash size={12} strokeWidth={2.4} />,
        iconSm: <Slash size={10} strokeWidth={2.4} />,
        on: 'bg-cl-raise text-cl-muted shadow-[inset_0_0_0_1px_rgba(167,179,212,0.35)]',
    },
    allow: {
        word: 'Allow',
        icon: <Check size={13} strokeWidth={2.6} />,
        iconSm: <Check size={11} strokeWidth={2.6} />,
        on: 'bg-cl-lume/20 text-cl-lume shadow-[inset_0_0_0_1px_rgba(37,224,200,0.55)]',
    },
};

export interface TriStateControlProps {
    value: Tri | null;
    onChange: (next: Tri) => void;
    /** What this control sets, e.g. "Send Messages for @Moderator". */
    label: string;
    /** Per-segment disable reasons (shown as the tooltip), or `true` for all. */
    disabled?: true | Partial<Record<Tri, string>>;
    size?: 'md' | 'sm';
    className?: string;
}

export const TriStateControl: React.FC<TriStateControlProps> = ({
    value, onChange, label, disabled, size = 'md', className,
}) => {
    const refs = useRef<Record<Tri, HTMLButtonElement | null>>({ deny: null, inherit: null, allow: null });
    const isDisabled = (t: Tri): string | null => {
        if (disabled === true) return 'Locked';
        return disabled?.[t] ?? null;
    };
    const enabled = ORDER.filter(t => !isDisabled(t));
    // Roving tab stop: the selected segment, else the first usable one.
    const tabStop: Tri | undefined = value && !isDisabled(value) ? value : enabled[0];

    const pick = (t: Tri) => {
        if (isDisabled(t)) return;
        if (t !== value) onChange(t);
        refs.current[t]?.focus();
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (enabled.length === 0) return;
        const cur = (e.target as HTMLElement).dataset.tri as Tri | undefined;
        const i = cur ? enabled.indexOf(cur) : -1;
        let next: Tri | undefined;
        switch (e.key) {
            case 'ArrowRight': case 'ArrowDown': next = enabled[(i + 1) % enabled.length]; break;
            case 'ArrowLeft': case 'ArrowUp': next = enabled[(i - 1 + enabled.length) % enabled.length]; break;
            case 'Home': next = enabled[0]; break;
            case 'End': next = enabled[enabled.length - 1]; break;
            case 'a': case 'A': next = 'allow'; break;
            case 'd': case 'D': next = 'deny'; break;
            case 'i': case 'I': case '/': next = 'inherit'; break;
            default: return;
        }
        if (!next || isDisabled(next)) return;
        e.preventDefault();
        e.stopPropagation();
        pick(next);
    };

    const dims = size === 'sm' ? 'w-[24px] h-[20px]' : 'w-[30px] h-[24px]';

    return (
        <div
            role="radiogroup"
            aria-label={label}
            onKeyDown={onKeyDown}
            className={`inline-flex items-center gap-[2px] p-[2px] rounded-[9px] bg-cl-sink/70 border border-cl-border/60 shrink-0 ${className ?? ''}`}
        >
            {ORDER.map(t => {
                const m = META[t];
                const why = isDisabled(t);
                const checked = value === t;
                return (
                    <button
                        key={t}
                        ref={el => { refs.current[t] = el; }}
                        type="button"
                        role="radio"
                        data-tri={t}
                        aria-checked={checked}
                        aria-label={m.word}
                        aria-disabled={why ? true : undefined}
                        title={why ? `${m.word} — ${why}` : m.word}
                        tabIndex={t === tabStop ? 0 : -1}
                        onClick={() => pick(t)}
                        className={[
                            dims,
                            'flex items-center justify-center rounded-[7px] outline-none',
                            'motion-safe:transition-colors motion-safe:duration-100',
                            'focus-visible:ring-2 focus-visible:ring-cl-lume/70 focus-visible:ring-offset-0',
                            checked ? m.on : 'text-cl-faint',
                            why ? 'opacity-30 cursor-not-allowed' : (checked ? 'cursor-default' : 'cursor-pointer hover:bg-white/[0.06] hover:text-cl-muted'),
                        ].join(' ')}
                    >
                        {size === 'sm' ? m.iconSm : m.icon}
                    </button>
                );
            })}
        </div>
    );
};

export default TriStateControl;
