import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2, Type, RotateCcw } from 'lucide-react';
import { ClButton, ClSlider } from '../../cl';
import { useUiScale } from '../../../hooks/useUiScale';
import { useMessageTextSize } from '../../../hooks/useMessageTextSize';
import {
    UI_SCALE_STEPS, UI_SCALE_DEFAULT, uiScaleAt, uiScaleIndex, uiScaleLabel, uiScaleValueText, isLimited,
} from '../../../utils/a11y/uiScale';
import {
    MESSAGE_TEXT_STEPS, MESSAGE_TEXT_DEFAULT, MSG_TEXT_PX_VAR, MSG_TEXT_SCALE_VAR,
    messageTextVars, messageBodyFontSize, msgTextPx, messageTextValueText,
} from '../../../utils/a11y/messageTextSize';
import { MESSAGE_BODY_CLASS, MESSAGE_BODY_LINE_HEIGHT } from '../../../utils/formatting/messageSize';
import { MotionEffectsCard } from './MotionEffectsCard';
import '../../../styles/formatting.css';
import { ReadabilityCards } from './ReadabilityCards';
import '../../../styles/a11y.css';

/**
 * Settings → Accessibility. First slice of the accessibility suite (owner,
 * 2026-11-20: "people have been asking to increase the size of chats, and
 * overall scale of the app"). One card per concern; later slices (contrast,
 * motion, themes) add their own `sd-card` below "Size" and their labels to
 * settingsSearchIndex.ts → accessibility.
 *
 * Size card:
 *  - Interface size: the whole window (electron/ui-scale.ts, applied by the
 *    host as a zoom factor). Committed on RELEASE, not mid-drag — rescaling
 *    the window under a dragged thumb would yank the slider away from the
 *    pointer. While dragging, the preview shows the size (CSS zoom relative
 *    to what is applied). Keyboard changes commit at once.
 *  - Message text size: conversations only (utils/a11y/messageTextSize.ts),
 *    live as you drag (it never moves the pane itself).
 */

const idxOfText = (px: number) => Math.max(0, (MESSAGE_TEXT_STEPS as readonly number[]).indexOf(px));
const textAt = (i: number) => MESSAGE_TEXT_STEPS[Math.max(0, Math.min(MESSAGE_TEXT_STEPS.length - 1, Math.round(i)))];

/** Step labels under a slider; steps the display can't hold are dimmed. */
const StepTicks: React.FC<{ labels: string[]; active: number; disabledFrom?: number; id: string }> = ({ labels, active, disabledFrom, id }) => (
    <div className="a11y-ticks" id={id} aria-hidden="true">
        {labels.map((l, i) => (
            <span key={l} data-active={i === active || undefined} data-off={(disabledFrom !== undefined && i > disabledFrom) || undefined}>{l}</span>
        ))}
    </div>
);

export const AccessibilityPane: React.FC = () => {
    const ui = useUiScale();
    const [textPx, setTextPx] = useMessageTextSize();

    // Interface size: the pending slider value (shown + previewed) vs what the host applied.
    const applied = ui.state?.percent ?? UI_SCALE_DEFAULT;
    const effective = ui.state?.effective ?? UI_SCALE_DEFAULT;
    const max = ui.state?.max ?? UI_SCALE_STEPS[UI_SCALE_STEPS.length - 1];
    const [pending, setPending] = useState<number | null>(null);
    const shown = pending ?? applied;
    const dragging = useRef(false);
    // Mirrors `pending` for the window pointerup listener; written where pending is set.
    const pendingRef = useRef<number | null>(null);

    const commit = useCallback((v: number) => {
        pendingRef.current = null;
        setPending(null);
        if (v !== applied) ui.set(v);
    }, [applied, ui]);

    useEffect(() => {
        const up = () => {
            if (!dragging.current) return;
            dragging.current = false;
            const v = pendingRef.current;
            if (v !== null) commit(v);
        };
        window.addEventListener('pointerup', up, true);
        window.addEventListener('pointercancel', up, true);
        return () => {
            window.removeEventListener('pointerup', up, true);
            window.removeEventListener('pointercancel', up, true);
        };
    }, [commit]);

    const onScaleChange = (i: number) => {
        const v = uiScaleAt(i);
        if (dragging.current) { pendingRef.current = v; setPending(v); }
        else commit(v);
    };

    const limited = ui.state ? isLimited(ui.state) : false;
    const previewZoom = Math.min(shown, max) / effective;
    const textVars = messageTextVars(textPx);

    return (
        <>
            <div className="sd-card" data-labels="Interface size|Message text size|Zoom">
                <h3>Size</h3>
                <p className="sd-sub">Make Cipherline easier to read. Interface size scales everything; message text size changes only conversations.</p>

                {/* Interface size */}
                <div className="sd-row a11y-row" style={{ borderTop: 'none' }}>
                    <span className="sd-tile"><Maximize2 size={16} /></span>
                    <div className="sd-rl">
                        <b id="a11y-ui-scale-label">Interface size</b>
                        <span>
                            {ui.supported
                                ? <>Everything in the window. Shortcut: <kbd className="a11y-kbd">Ctrl</kbd> <kbd className="a11y-kbd">+</kbd> / <kbd className="a11y-kbd">−</kbd>, <kbd className="a11y-kbd">Ctrl</kbd> <kbd className="a11y-kbd">0</kbd> resets.</>
                                : 'Not available in this version of the app.'}
                        </span>
                    </div>
                    <div className="sd-rc a11y-value" aria-hidden="true">{uiScaleLabel(shown)}</div>
                </div>
                <div className="a11y-slider" onPointerDownCapture={() => { dragging.current = true; }}>
                    <ClSlider
                        value={uiScaleIndex(shown)}
                        min={0}
                        max={UI_SCALE_STEPS.length - 1}
                        step={1}
                        onChange={onScaleChange}
                        formatLabel={i => uiScaleLabel(uiScaleAt(i))}
                        resetValue={uiScaleIndex(UI_SCALE_DEFAULT)}
                        disabled={!ui.supported || !ui.state}
                        ariaLabel="Interface size"
                        ariaValueText={uiScaleValueText(shown, limited && pending === null ? effective : undefined)}
                        style={{ width: '100%' }}
                    />
                    <StepTicks id="a11y-ui-ticks" labels={UI_SCALE_STEPS.map(uiScaleLabel)} active={uiScaleIndex(shown)} disabledFrom={uiScaleIndex(max)} />
                </div>
                <div className="a11y-foot">
                    <span className="a11y-note" role="status" aria-live="polite">
                        {limited && pending === null
                            ? `Limited to ${uiScaleLabel(effective)} by your display. Move the window to a bigger screen and it goes up to ${uiScaleLabel(applied)}.`
                            : shown > max
                                ? `This display fits up to ${uiScaleLabel(max)}.`
                                : ''}
                    </span>
                    <ClButton size="sm" variant="ghost" onClick={() => commit(UI_SCALE_DEFAULT)} disabled={!ui.supported || applied === UI_SCALE_DEFAULT}>
                        <RotateCcw size={13} /> Reset
                    </ClButton>
                </div>

                {/* Message text size */}
                <div className="sd-row a11y-row">
                    <span className="sd-tile"><Type size={16} /></span>
                    <div className="sd-rl">
                        <b id="a11y-text-size-label">Message text size</b>
                        <span>Messages, the message box, replies and conversation notices.</span>
                    </div>
                    <div className="sd-rc a11y-value" aria-hidden="true">{textPx}px</div>
                </div>
                <div className="a11y-slider">
                    <ClSlider
                        value={idxOfText(textPx)}
                        min={0}
                        max={MESSAGE_TEXT_STEPS.length - 1}
                        step={1}
                        onChange={i => setTextPx(textAt(i))}
                        formatLabel={i => `${textAt(i)}px`}
                        resetValue={idxOfText(MESSAGE_TEXT_DEFAULT)}
                        ariaLabel="Message text size"
                        ariaValueText={messageTextValueText(textPx)}
                        style={{ width: '100%' }}
                    />
                    <StepTicks id="a11y-text-ticks" labels={MESSAGE_TEXT_STEPS.map(n => String(n))} active={idxOfText(textPx)} />
                </div>
                <div className="a11y-foot">
                    <span className="a11y-note" />
                    <ClButton size="sm" variant="ghost" onClick={() => setTextPx(MESSAGE_TEXT_DEFAULT)} disabled={textPx === MESSAGE_TEXT_DEFAULT}>
                        <RotateCcw size={13} /> Reset
                    </ClButton>
                </div>

                {/* Live preview: the pending interface size (relative zoom) and the text size. */}
                <div className="a11y-preview-frame" aria-label="Preview" role="img">
                    <div
                        className="a11y-preview"
                        style={{
                            zoom: previewZoom,
                            [MSG_TEXT_PX_VAR as string]: textVars[MSG_TEXT_PX_VAR],
                            [MSG_TEXT_SCALE_VAR as string]: textVars[MSG_TEXT_SCALE_VAR],
                        } as React.CSSProperties}
                    >
                        <div className="a11y-pv-sys cl-sys-text">Mara joined the channel</div>
                        <div className="a11y-pv-row">
                            <span className="a11y-pv-av" aria-hidden="true">M</span>
                            <div className="a11y-pv-col">
                                <div className="a11y-pv-head"><b>Mara</b><span>Today at 9:41</span></div>
                                <div className="a11y-pv-quote" style={{ fontSize: msgTextPx(12) }}>Replying to Theo: are we still on for tonight?</div>
                                <div className={MESSAGE_BODY_CLASS} style={{ fontSize: messageBodyFontSize(), lineHeight: MESSAGE_BODY_LINE_HEIGHT }}>
                                    Yes! Bring the <code className="cl-fmt-code">notes.md</code> file <span style={{ fontSize: '1.25em' }}>🎉</span>{' '}
                                    <span style={{ fontSize: 'calc(1em * 1.5)' }}>see you at 8</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Readability: messages, text, focus and links, notifications (ReadabilityCards.tsx). */}
            <ReadabilityCards />
            <MotionEffectsCard />
        </>
    );
};
