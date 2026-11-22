/**
 * Message text size — Settings → Accessibility → Size. Scales what you READ
 * in a conversation (message bodies, inline/block code, per-span Small /
 * Normal / Large proportionally, emoji with the text, jumbo emoji, the
 * composer, reply quotes, system rows) and nothing else; the rest of the UI
 * is "Interface size" (utils/a11y/uiScale.ts).
 *
 * ONE carrier: two CSS custom properties on <html>, set by
 * `applyMessageTextSize`:
 *   --cl-msg-text-px     the body size (default 15px = MESSAGE_BODY_PX)
 *   --cl-msg-text-scale  that / 15, for the pieces that have their own base
 *                        size (composer 14.5px, code blocks 12.5px, reply
 *                        quotes 12px, system rows 11px)
 * Every consumer reads them with a fallback equal to today's value, so
 * nothing changes at the default, before hydration, or in a harness that
 * never sets them. Line-heights in those consumers are unitless / 'normal',
 * so they stay proportional.
 *
 * Stored in secureLocalStore (`cipherline_msg_text_px`, backed up: a
 * preference that means the same thing on any machine). Never raw
 * localStorage; nothing is written on mount.
 */
import { MESSAGE_BODY_PX } from '../formatting/messageSize';

export const MESSAGE_TEXT_STEPS = [12, 13, 14, 15, 16, 18, 20, 24] as const;
export const MESSAGE_TEXT_DEFAULT = MESSAGE_BODY_PX;
export const MESSAGE_TEXT_STORE_KEY = 'cipherline_msg_text_px';
export const MESSAGE_TEXT_CHANGED_EVENT = 'cipherline:msg-text-size-changed';

export const MSG_TEXT_PX_VAR = '--cl-msg-text-px';
export const MSG_TEXT_SCALE_VAR = '--cl-msg-text-scale';

export function isMessageTextStep(v: unknown): v is number {
    return typeof v === 'number' && (MESSAGE_TEXT_STEPS as readonly number[]).includes(v);
}

export function parseMessageTextSize(raw: string | null | undefined): number {
    if (typeof raw !== 'string' || !/^\d{2}$/.test(raw)) return MESSAGE_TEXT_DEFAULT;
    const n = Number(raw);
    return isMessageTextStep(n) ? n : MESSAGE_TEXT_DEFAULT;
}

/** The two custom-property values for a size (scale rounded to 4 places; 15 -> exactly "1"). */
export function messageTextVars(px: number): { [MSG_TEXT_PX_VAR]: string; [MSG_TEXT_SCALE_VAR]: string } {
    const size = isMessageTextStep(px) ? px : MESSAGE_TEXT_DEFAULT;
    return {
        [MSG_TEXT_PX_VAR]: `${size}px`,
        [MSG_TEXT_SCALE_VAR]: String(+(size / MESSAGE_BODY_PX).toFixed(4)),
    };
}

/** Sets the vars on an element (default: <html>). */
export function applyMessageTextSize(px: number, el: HTMLElement | null = typeof document !== 'undefined' ? document.documentElement : null): void {
    if (!el) return;
    const vars = messageTextVars(px);
    el.style.setProperty(MSG_TEXT_PX_VAR, vars[MSG_TEXT_PX_VAR]);
    el.style.setProperty(MSG_TEXT_SCALE_VAR, vars[MSG_TEXT_SCALE_VAR]);
}

/** The message body's font-size for a whole-message scale (Small/Normal/Large). */
export function messageBodyFontSize(sizeScale = 1): string {
    const base = `var(${MSG_TEXT_PX_VAR}, ${MESSAGE_BODY_PX}px)`;
    return sizeScale === 1 ? base : `calc(${base} * ${+sizeScale.toFixed(3)})`;
}

/** A piece with its own base px size (reply quote 12px, system row 11px...) that follows the text size. */
export function msgTextPx(basePx: number): string {
    return `calc(${basePx}px * var(${MSG_TEXT_SCALE_VAR}, 1))`;
}

/** An em-sized piece (jumbo emoji) that follows the text size. */
export function msgTextEm(em: number): string {
    return `calc(${em}em * var(${MSG_TEXT_SCALE_VAR}, 1))`;
}

export function messageTextValueText(px: number): string {
    return px === MESSAGE_TEXT_DEFAULT ? `${px} pixels, default` : `${px} pixels`;
}
