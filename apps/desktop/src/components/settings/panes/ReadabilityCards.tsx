import React, { useRef } from 'react';
import { Rows3, MoveVertical, Baseline, CaseSensitive, Clock, ScanLine, Link2, BellRing, AlignJustify, MoveHorizontal, RotateCcw } from 'lucide-react';
import { ClButton, ClSlider, ClToggle } from '../../cl';
import { useReadability } from '../../../hooks/useReadability';
import { useToast } from '../../../contexts/ToastContext';
import {
    FONT_LABELS, GROUP_GAP_MAX, GROUP_GAP_MIN, effectiveGroupGap,
    type ReadabilityId, type ReadabilityValue,
} from '../../../utils/a11y/readability';
import { formatClock } from '../../../utils/a11y/timeFormat';
import { MESSAGE_BODY_CLASS, MESSAGE_BODY_LINE_HEIGHT } from '../../../utils/formatting/messageSize';
import { messageBodyFontSize } from '../../../utils/a11y/messageTextSize';
import '../../../styles/readability.css';

/**
 * The readability cards of Settings → Accessibility (messages, text, focus and
 * links, notifications). Each control is a native radio group or toggle with
 * roving arrow keys, writes through useReadability (secureLocalStore, no write
 * on mount) and shows its effect at once: the sample conversation below the
 * message settings is drawn with the REAL row classes, so it follows the
 * <html> data attributes exactly like the chat does.
 */

interface ChoiceOption<T extends string> { value: T; label: string; style?: React.CSSProperties }

/** A single-select row of buttons: radiogroup semantics, roving tabindex, arrow keys. */
export function A11yChoice<T extends string>({ label, value, options, onChange }: {
    label: string; value: T; options: ChoiceOption<T>[]; onChange: (v: T) => void;
}) {
    const refs = useRef<Array<HTMLButtonElement | null>>([]);
    const idx = Math.max(0, options.findIndex(o => o.value === value));
    const move = (to: number) => {
        const i = (to + options.length) % options.length;
        onChange(options[i].value);
        refs.current[i]?.focus();
    };
    return (
        <div className="a11y-choice" role="radiogroup" aria-label={label}>
            {options.map((o, i) => (
                <button
                    key={o.value}
                    ref={n => { refs.current[i] = n; }}
                    type="button"
                    role="radio"
                    aria-checked={value === o.value}
                    tabIndex={i === idx ? 0 : -1}
                    data-on={value === o.value || undefined}
                    style={o.style}
                    onClick={() => onChange(o.value)}
                    onKeyDown={e => {
                        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(i + 1); }
                        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(i - 1); }
                    }}
                >{o.label}</button>
            ))}
        </div>
    );
}

const Row: React.FC<{ icon: React.ReactNode; title: string; desc: React.ReactNode; first?: boolean; stack?: boolean; children: React.ReactNode }> = ({ icon, title, desc, first, stack, children }) => (
    <div className={`sd-row a11y-row${stack ? ' a11y-row--stack' : ''}`} style={first ? { borderTop: 'none' } : undefined}>
        <span className="sd-tile">{icon}</span>
        <div className="sd-rl"><b>{title}</b><span>{desc}</span></div>
        <div className="sd-rc a11y-rc">{children}</div>
    </div>
);

const SAMPLE_NOW = new Date(2026, 10, 20, 9, 41);

export const ReadabilityCards: React.FC = () => {
    const { prefs, set, setGroupGap } = useReadability();
    const toast = useToast();
    const pick = <K extends ReadabilityId>(id: K) => (v: ReadabilityValue<K>) => set(id, v);
    const gap = effectiveGroupGap(prefs.density, prefs.groupGap);

    return (
        <>
            <div className="sd-card" data-labels="Message spacing|Cozy|Compact|Space between message groups|Line spacing|Letter spacing|Density">
                <h3>Messages</h3>
                <p className="sd-sub">How tightly a conversation is laid out. Compact fits more on screen with smaller pictures; the time of a grouped message appears when you point at it.</p>

                <Row first icon={<Rows3 size={16} />} title="Message spacing" desc="Cozy is the default layout. Compact tightens every row.">
                    <A11yChoice label="Message spacing" value={prefs.density} onChange={pick('density')}
                        options={[{ value: 'cozy', label: 'Cozy' }, { value: 'compact', label: 'Compact' }]} />
                </Row>

                <Row icon={<MoveVertical size={16} />} title="Space between message groups" desc="The gap above a new sender, 0 to 24 pixels." stack>
                    <div className="a11y-gap">
                        <ClSlider
                            value={gap}
                            min={GROUP_GAP_MIN}
                            max={GROUP_GAP_MAX}
                            step={1}
                            onChange={v => setGroupGap(v)}
                            formatLabel={v => `${v}px`}
                            resetValue={effectiveGroupGap(prefs.density, null)}
                            ariaLabel="Space between message groups"
                            ariaValueText={`${gap} pixels${prefs.groupGap === null ? ', default' : ''}`}
                            style={{ width: '100%' }}
                        />
                        <span className="a11y-value" aria-hidden="true">{gap}px</span>
                        <ClButton size="sm" variant="ghost" onClick={() => setGroupGap(null)} disabled={prefs.groupGap === null}>
                            <RotateCcw size={13} /> Reset
                        </ClButton>
                    </div>
                </Row>

                <Row icon={<AlignJustify size={16} />} title="Line spacing" desc="Room between the lines of a message.">
                    <A11yChoice label="Line spacing" value={prefs.leading} onChange={pick('leading')}
                        options={[{ value: 'normal', label: 'Normal' }, { value: 'relaxed', label: 'Relaxed' }]} />
                </Row>

                <Row icon={<MoveHorizontal size={16} />} title="Letter spacing" desc="Room between letters and words in a message.">
                    <A11yChoice label="Letter spacing" value={prefs.tracking} onChange={pick('tracking')}
                        options={[{ value: 'normal', label: 'Normal' }, { value: 'wide', label: 'Wide' }]} />
                </Row>

                {/* Sample conversation: the real row classes, so it follows the settings above. */}
                <div className="a11y-preview-frame a11y-chat-sample" role="img" aria-label="Sample conversation">
                    <div className="a11y-sample-feed" style={{ fontFamily: 'var(--cl-font-body)' }}>
                        <div className="cl-msg-row cl-msg-row--head group relative flex gap-3 py-0.5 pr-2 pl-3">
                            <span className="cl-msg-av a11y-pv-av" aria-hidden="true">M</span>
                            <div className="relative flex flex-col min-w-0 flex-1">
                                <div className="cl-msg-head flex items-baseline gap-2 mb-0.5">
                                    <span className="text-[14px] font-semibold leading-tight" style={{ color: 'var(--cl-text)' }}>Mara</span>
                                    <span className="text-[11px] text-cl-faint leading-tight">Today at {formatClock(SAMPLE_NOW, [])}</span>
                                </div>
                                <div className={MESSAGE_BODY_CLASS} style={{ fontSize: messageBodyFontSize(), lineHeight: MESSAGE_BODY_LINE_HEIGHT }}>
                                    Are we still on for tonight? I put the plan in <a className="cl-fmt-link" href="#sample" onClick={e => e.preventDefault()} tabIndex={-1}>this doc</a>.
                                </div>
                            </div>
                        </div>
                        <div className="cl-msg-row group relative flex gap-3 py-0.5 pr-2 pl-3">
                            <div className="cl-msg-gutter w-10 shrink-0" data-t="9:42" aria-hidden="true" />
                            <div className="relative flex flex-col min-w-0 flex-1">
                                <div className={MESSAGE_BODY_CLASS} style={{ fontSize: messageBodyFontSize(), lineHeight: MESSAGE_BODY_LINE_HEIGHT }}>
                                    Yes! Bring the notes, and a charger if you have a spare.
                                </div>
                            </div>
                        </div>
                        <div className="cl-msg-row cl-msg-row--head group relative flex gap-3 py-0.5 pr-2 pl-3">
                            <span className="cl-msg-av a11y-pv-av a11y-pv-av--alt" aria-hidden="true">T</span>
                            <div className="relative flex flex-col min-w-0 flex-1">
                                <div className="cl-msg-head flex items-baseline gap-2 mb-0.5">
                                    <span className="text-[14px] font-semibold leading-tight" style={{ color: 'var(--cl-text)' }}>Theo</span>
                                    <span className="text-[11px] text-cl-faint leading-tight">Today at {formatClock(new Date(SAMPLE_NOW.getTime() + 180000), [])}</span>
                                </div>
                                <div className={MESSAGE_BODY_CLASS} style={{ fontSize: messageBodyFontSize(), lineHeight: MESSAGE_BODY_LINE_HEIGHT }}>
                                    On my way.
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <div className="sd-card" data-labels="Font|Atkinson Hyperlegible|Lexend|OpenDyslexic|Dyslexia|Time format|12-hour|24-hour|Clock">
                <h3>Text</h3>
                <p className="sd-sub">The typeface for the app and for messages, and how times are written. Code stays in its own monospace font, and a message written in its own font keeps it.</p>

                <Row first stack icon={<CaseSensitive size={16} />} title="Font" desc="Atkinson Hyperlegible, Lexend and OpenDyslexic are built for easier reading. They ship inside the app; nothing is downloaded.">
                    <A11yChoice label="Font" value={prefs.font} onChange={pick('font')}
                        options={([
                            ['default', 'Nunito'], ['atkinson', 'Atkinson Hyperlegible'], ['lexend', 'Lexend'], ['opendyslexic', 'OpenDyslexic'],
                        ] as const).map(([value, name]) => ({
                            value, label: value === 'default' ? `Default (${name})` : FONT_LABELS[value],
                            style: value === 'default' ? undefined : { fontFamily: `'Cipherline ${value === 'atkinson' ? 'Atkinson Hyperlegible' : value === 'lexend' ? 'Lexend' : 'OpenDyslexic'}', 'Nunito', sans-serif` },
                        }))} />
                </Row>

                <Row icon={<Clock size={16} />} title="Time format" desc={<>Every time in the app. Now: {formatClock(SAMPLE_NOW, [])}.</>}>
                    <A11yChoice label="Time format" value={prefs.time} onChange={pick('time')}
                        options={[{ value: 'auto', label: 'Automatic' }, { value: '12h', label: '12-hour' }, { value: '24h', label: '24-hour' }]} />
                </Row>
            </div>

            <div className="sd-card" data-labels="Always show focus outline|Keyboard focus|Underline links|Links">
                <h3>Focus and links</h3>
                <p className="sd-sub">Make it easier to see where you are and what you can click.</p>
                <Row first icon={<ScanLine size={16} />} title="Always show focus outline" desc="A strong ring around whatever has focus, also after a mouse click. Off keeps the ring for keyboard use only.">
                    <ClToggle checked={prefs.focus === 'on'} onChange={v => set('focus', v ? 'on' : 'off')} aria-label="Always show focus outline" />
                </Row>
                <Row icon={<Link2 size={16} />} title="Underline links" desc="Links in messages are always underlined, not only coloured.">
                    <ClToggle checked={prefs.links === 'on'} onChange={v => set('links', v ? 'on' : 'off')} aria-label="Underline links" />
                </Row>
            </div>

            <div className="sd-card" data-labels="Notification duration|Toast|Pop-ups|Until I close them">
                <h3>Notifications that stay</h3>
                <p className="sd-sub">How long the small pop-ups in the corner stay on screen.</p>
                <Row first icon={<BellRing size={16} />} title="Pop-up duration" desc="Normal is about 4 seconds. Long is twice that. With Until I close them, a pop-up stays until you close it.">
                    <A11yChoice label="Pop-up duration" value={prefs.toast} onChange={pick('toast')}
                        options={[{ value: 'normal', label: 'Normal' }, { value: 'long', label: 'Long' }, { value: 'sticky', label: 'Until I close them' }]} />
                </Row>
                <div className="a11y-foot">
                    <span className="a11y-note" />
                    <ClButton size="sm" variant="ghost" onClick={() => toast.push({ kind: 'info', title: 'Sample pop-up', message: 'This is how long a pop-up stays with your setting.' })}>
                        <Baseline size={13} /> Show a sample
                    </ClButton>
                </div>
            </div>
        </>
    );
};
