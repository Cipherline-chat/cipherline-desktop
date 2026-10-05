/**
 * CallNamingSection — the "Call names" block of a Calls channel's settings
 * (create + edit). Controlled: the dialog owns the draft, this renders it.
 *
 * Rows, top to bottom:
 *   • Never change call names (master switch) — when on, the two automatic /
 *     rename rows below are disabled with a note, because the server ignores
 *     them (a locked channel shows no game and accepts no rename).
 *   • Name new calls — how a call is named when it starts. Still applies
 *     when locked: it is the name the call then keeps.
 *   • While a game is being played — replace / after / don't show.
 *   • Call starters can rename their call.
 * A live example line under them mirrors exactly what the shared policy
 * functions will produce.
 */
import React, { useRef } from 'react';
import { Lock, Tag, Gamepad2, Pencil } from 'lucide-react';
import { ClInput, ClSelect, ClToggle } from '../cl';
import type { CallNameStyle, CallNamingSettings } from '@cipherline/shared';
import { CALL_NAME_MAX_LENGTH } from '@cipherline/shared';
import { callNamingFormError, previewCallNames } from '../../utils/callNaming';

interface Props {
    value: CallNamingSettings;
    onChange: (next: CallNamingSettings) => void;
    /** The channel's name as currently typed (for {channel} and the fixed fallback). */
    channelName: string;
    /** Name used for {host} in the example line. */
    exampleHost?: string;
    disabled?: boolean;
}

const EXAMPLE_GAME = 'Elden Ring';
const TOKENS = ['{host}', '{channel}', '{n}'] as const;

const Row: React.FC<{ icon: React.ReactNode; label: string; sublabel: React.ReactNode; control: React.ReactNode; dim?: boolean; children?: React.ReactNode }> = ({
    icon, label, sublabel, control, dim, children,
}) => (
    <div className={`px-3 py-2.5 ${dim ? 'opacity-55' : ''}`}>
        <div className="flex items-center gap-3">
            <div className="w-6 h-6 rounded-md bg-cl-lume/10 text-cl-lume/80 flex items-center justify-center shrink-0">{icon}</div>
            <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-semibold text-cl-text leading-tight">{label}</div>
                <div className="text-[10.5px] text-cl-faint leading-snug">{sublabel}</div>
            </div>
            <div className="shrink-0">{control}</div>
        </div>
        {children}
    </div>
);

export const CallNamingSection: React.FC<Props> = ({ value, onChange, channelName, exampleHost = 'Alex', disabled }) => {
    const set = (patch: Partial<CallNamingSettings>) => onChange({ ...value, ...patch });
    const templateRef = useRef<HTMLInputElement>(null);
    const channel = channelName.trim() || 'General';
    const error = callNamingFormError(value);
    const preview = previewCallNames(value, { host: exampleHost, channel, game: EXAMPLE_GAME });
    const autoNote = value.locked ? 'Off while “Never change call names” is on.' : null;

    const insertToken = (tok: string) => {
        const el = templateRef.current;
        const cur = value.template ?? '';
        const at = el?.selectionStart ?? cur.length;
        const end = el?.selectionEnd ?? at;
        const next = (cur.slice(0, at) + tok + cur.slice(end)).slice(0, CALL_NAME_MAX_LENGTH);
        set({ template: next });
        requestAnimationFrame(() => {
            el?.focus();
            const pos = Math.min(at + tok.length, next.length);
            el?.setSelectionRange(pos, pos);
        });
    };

    const styleOptions: { value: CallNameStyle; label: string }[] = [
        { value: 'host', label: `Starter’s name — “${exampleHost}’s Call”` },
        { value: 'numbered', label: `Channel name + number — “${channel} 2”` },
        { value: 'fixed', label: 'Always the same name' },
        { value: 'template', label: 'Custom pattern' },
    ];

    return (
        <div className="rounded-xl border border-solid border-cl-border/50 bg-cl-surface/40 divide-y divide-white/[0.05]" data-testid="call-naming">
            <Row
                icon={<Lock size={13} />}
                label="Never change call names"
                sublabel="Calls keep the name they start with — no game names, no renaming."
                control={<ClToggle checked={value.locked} onChange={v => set({ locked: v })} disabled={disabled} aria-label="Never change call names" />}
            />
            <Row
                icon={<Tag size={13} />}
                label="Name new calls"
                sublabel="What a call is called when someone starts it."
                control={
                    <ClSelect<CallNameStyle>
                        options={styleOptions}
                        value={value.style}
                        onChange={v => set({ style: v })}
                        ariaLabel="Name new calls"
                        disabled={disabled}
                        style={{ width: 250 }}
                    />
                }
            >
                {value.style === 'fixed' && (
                    <div className="mt-2 pl-9">
                        <ClInput
                            value={value.fixed_name ?? ''}
                            onChange={e => set({ fixed_name: e.target.value.slice(0, CALL_NAME_MAX_LENGTH) })}
                            placeholder={`${channel} (leave empty to use the channel name)`}
                            maxLength={CALL_NAME_MAX_LENGTH}
                            aria-label="Call name"
                            disabled={disabled}
                            className="w-full"
                        />
                    </div>
                )}
                {value.style === 'template' && (
                    <div className="mt-2 pl-9 space-y-1.5">
                        <ClInput
                            ref={templateRef}
                            value={value.template ?? ''}
                            onChange={e => set({ template: e.target.value.slice(0, CALL_NAME_MAX_LENGTH) })}
                            placeholder="{channel} {n}"
                            maxLength={CALL_NAME_MAX_LENGTH}
                            aria-label="Call name pattern"
                            disabled={disabled}
                            className="w-full"
                        />
                        <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] text-cl-faint">
                            <span>Insert:</span>
                            {TOKENS.map(t => (
                                <button
                                    key={t}
                                    type="button"
                                    disabled={disabled}
                                    onClick={() => insertToken(t)}
                                    className="px-1.5 h-[20px] rounded-md border border-solid border-cl-border/50 text-cl-muted hover:border-cl-lume/40 hover:text-cl-lume font-mono"
                                >
                                    {t}
                                </button>
                            ))}
                            <span className="ml-1">starter · channel · lowest free number</span>
                        </div>
                    </div>
                )}
            </Row>
            <Row
                icon={<Gamepad2 size={13} />}
                label="Show the game being played"
                sublabel={autoNote ?? 'The call is titled with the game while at least half of it plays the same one.'}
                dim={value.locked}
                control={
                    <ClToggle
                        checked={value.game === 'replace'}
                        onChange={v => set({ game: v ? 'replace' : 'off' })}
                        disabled={disabled || value.locked}
                        aria-label="Show the game being played"
                    />
                }
            />
            <Row
                icon={<Pencil size={13} />}
                label="Call starters can rename their call"
                sublabel={autoNote ?? 'Off: only people who can manage this channel rename calls.'}
                dim={value.locked}
                control={
                    <ClToggle
                        checked={value.starter_can_rename}
                        onChange={v => set({ starter_can_rename: v })}
                        disabled={disabled || value.locked}
                        aria-label="Call starters can rename their call"
                    />
                }
            />
            <div className="px-3 py-2 text-[11px]" aria-live="polite">
                {error ? (
                    <span className="text-cl-flash" role="alert">{error}</span>
                ) : (
                    <span className="text-cl-faint" data-testid="call-naming-example">
                        Example: <span className="text-cl-muted">{preview.start}</span>
                        {preview.whilePlaying
                            ? <> → <span className="text-cl-muted">{preview.whilePlaying}</span> while playing {EXAMPLE_GAME}</>
                            : value.locked ? ' — never changes' : ' — stays the same while playing'}
                    </span>
                )}
            </div>
        </div>
    );
};

export default CallNamingSection;
