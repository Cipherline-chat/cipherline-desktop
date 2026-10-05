/**
 * "Deep field" backdrop math — the slow-rising bioluminescent dots shared by the
 * sign-up screen (AuthScreen's AuthBackground) and the onboarding wizard
 * (RegistrationWizard's CinematicBackground). Centralising the generator keeps the
 * two backdrops visually identical so the dots read as *persisting* across the
 * verify-email → wizard handoff. The actual look lives in CSS (.auth-bubble /
 * .auth-aurora in index.css); this only places them.
 */

export interface BubbleSpec {
    left: string;
    size: number;
    dur: string;
    delay: string;
    sway: string;
}

/** How many bubbles to show — 8 minimum, grows with viewport width. */
export function bubbleCount(): number {
    return Math.min(Math.max(8, Math.round(window.innerWidth / 150)), 30);
}

/** Generate n bubbles spread evenly across the screen with varied sizes/speeds. */
export function makeBubbles(n: number): BubbleSpec[] {
    const SIZES  = [10, 6, 14, 8, 12, 7, 11, 9, 13, 6, 10, 8, 12, 7, 9, 11];
    const DURS   = [20, 26, 22, 18, 24, 28, 21, 25, 19, 23, 27, 20, 22, 26, 18, 24];
    const DELAYS = [0, -8, -14, -4, -11, -6, -16, -19, -3, -12, -7, -17, -2, -9, -15, -5];
    const SWAYS  = [24, -18, 30, -22, 20, -26, 18, 28, -20, 22, -28, 16, 26, -16, 24, -24];
    return Array.from({ length: n }, (_, i) => ({
        left:  `${(6 + (i / n) * 86 + (i % 3 === 1 ? 2.5 : i % 3 === 2 ? -2.5 : 0)).toFixed(1)}%`,
        size:  SIZES[i  % SIZES.length],
        dur:   `${DURS[i  % DURS.length]}s`,
        delay: `${DELAYS[i % DELAYS.length]}s`,
        sway:  `${SWAYS[i % SWAYS.length]}px`,
    }));
}
