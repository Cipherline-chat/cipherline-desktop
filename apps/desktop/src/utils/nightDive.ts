/**
 * nightDive — "Night dive": between midnight and 05:00 local time the sea the
 * app floats in gets deeper. Pure and DOM-free on purpose (vitest here is
 * `environment: node`): this file DECIDES, hooks/useNightDive.ts applies the
 * verdict as `<html data-depth="night">`, styles/night-dive.css darkens the
 * BACKGROUND layers only (the water behind the cards and the backgrounds of
 * the main views — never a panel, card, input, button, border, accent or
 * text colour), and components/NightDiveSea.tsx paints the deep-sea backdrop
 * and plays the slow descent / ascent behind the content.
 *
 * There is no switch: it is simply part of the app (the only opt-out is the
 * system's reduced-motion setting, which makes the change instant and skips
 * the animation — the darker background still applies).
 *
 * Time is always the user's LOCAL wall clock (`Date#getHours`), never UTC and
 * never "N hours since X", so a daylight-saving jump cannot move the window:
 * the hour label on the clock is what counts.
 */

/** The attribute set on <html> while it is night. */
export const DEPTH_ATTR = 'data-depth';
export const DEPTH_NIGHT = 'night';

/**
 * Window event fired when the mode CHANGES (not on every minute check), plus
 * once at startup. Other parts of the app (the Keys mascot) listen for it.
 * `detail` is a {@link NightDiveDetail}.
 */
export const NIGHT_DIVE_EVENT = 'cipherline:night-dive';

export type NightDiveReason = 'enter' | 'exit' | 'initial';
export interface NightDiveDetail {
    active: boolean;
    reason: NightDiveReason;
}

/** 00:00 inclusive … 05:00 exclusive, local time. */
export const NIGHT_START_HOUR = 0;
export const NIGHT_END_HOUR = 5;

/** How often a running client re-checks the clock (also on focus / wake). */
export const NIGHT_RECHECK_MS = 60_000;

/** The slice of an element this needs (`document.documentElement`, or a fake). */
export interface DepthRoot {
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
}

/** 00:00–04:59 local. The window is half-open: 04:59:59.999 is night, 05:00:00 is not. */
export function isNightHour(d: Date): boolean {
    const h = d.getHours();
    return h >= NIGHT_START_HOUR && h < NIGHT_END_HOUR;
}

/** Set or clear the root attribute. Idempotent; returns the state applied. */
export function applyDepth(root: DepthRoot, active: boolean): boolean {
    if (active) root.setAttribute(DEPTH_ATTR, DEPTH_NIGHT);
    else root.removeAttribute(DEPTH_ATTR);
    return active;
}

/**
 * What should be announced, given the last state we announced (`null` = never
 * announced yet) and the state now? `null` = nothing (an unchanged minute check).
 */
export function nightDiveReason(prev: boolean | null, next: boolean): NightDiveReason | null {
    if (prev === null) return 'initial';
    if (prev === next) return null;
    return next ? 'enter' : 'exit';
}

// ── the transition ───────────────────────────────────────────────────────────

export type TransitionKind = 'descend' | 'ascend';

/** Only a real change plays the animation; the startup announcement never does. */
export function transitionKind(detail: NightDiveDetail): TransitionKind | null {
    if (detail.reason === 'enter') return 'descend';
    if (detail.reason === 'exit') return 'ascend';
    return null;
}

/** The background fade (CSS --nd-fade) and the whole descent / ascent. The
 *  sea stays mounted a little past the fade so nothing is cut short. */
export const FADE_MS = 5000;
export const TRANSITION_MS = 5800;

export interface BubbleSpec {
    /** Left position, % of the window width. */
    x: number;
    /** Sideways drift over the rise, px. */
    dx: number;
    /** Diameter, px. */
    size: number;
    /** Start delay, ms. */
    delay: number;
    /** Rise duration, ms. */
    dur: number;
    /** How far it rises, % of the window height. */
    rise: number;
}

/** Deterministic pseudo-random in [0,1) from an index (no Math.random: the
 *  field is identical every time and testable). */
function unit(i: number, salt: number): number {
    let t = (i + 1) * 2654435761 + salt * 40503;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * A few small bubbles drifting up BEHIND the content during the descent /
 * ascent. Deterministic, spread across the window, and every one has finished
 * before TRANSITION_MS.
 */
export function bubbleSpecs(count = 7): BubbleSpec[] {
    const out: BubbleSpec[] = [];
    for (let i = 0; i < count; i++) {
        // Even spread across the width with a little jitter, so they never clump.
        const x = Math.round(((i + 0.2 + unit(i, 0) * 0.6) / count) * 88 + 6);
        out.push({
            x,
            dx: Math.round((unit(i, 1) - 0.5) * 40),          // ±20 px sway
            size: 4 + Math.round(unit(i, 2) * 6),             // 4 … 10 px
            delay: 400 + Math.round(i * 230 + unit(i, 3) * 150),
            dur: 2800 + Math.round(unit(i, 4) * 900),         // 2.8 … 3.7 s
            rise: 45 + Math.round(unit(i, 5) * 50),           // 45 … 95 %
        });
    }
    return out;
}

export interface MoteSpec {
    /** Left position, % of the window width. */
    x: number;
    /** Diameter, px. */
    size: number;
    /** One full drift, seconds (slow: ambience, not weather). */
    dur: number;
    /** Negative start offset, seconds — mid-drift on the first frame. */
    delay: number;
    /** Sideways drift over the cycle, px. */
    dx: number;
    /** Peak opacity. */
    peak: number;
}

/** The few faint bioluminescent motes that live in the night sea. */
export function moteSpecs(count = 6): MoteSpec[] {
    const out: MoteSpec[] = [];
    for (let i = 0; i < count; i++) {
        const dur = 70 + Math.round(unit(i, 6) * 40);          // 70 … 110 s
        out.push({
            x: Math.round(((i + 0.5) / count) * 90 + 5 + (unit(i, 7) - 0.5) * 8),
            size: 2 + Math.round(unit(i, 8) * 2),              // 2 … 4 px
            dur,
            delay: -Math.round(unit(i, 9) * dur),
            dx: Math.round((unit(i, 10) - 0.5) * 60),          // ±30 px
            peak: Math.round((0.22 + unit(i, 11) * 0.18) * 100) / 100, // .22 … .40
        });
    }
    return out;
}

/**
 * Title-bar overlay colour that matches the app's top drag bar in each mode,
 * so the Windows caption buttons blend in (the OS paints it, not CSS). The
 * night value mirrors styles/night-dive.css `--nd-bar`; a test keeps them equal.
 */
export const ABYSS_DAY = '#0B0F1E';
export const ABYSS_NIGHT = '#05070F';
export function titleBarColor(night: boolean): string {
    return night ? ABYSS_NIGHT : ABYSS_DAY;
}
