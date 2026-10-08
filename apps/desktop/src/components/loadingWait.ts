/**
 * The non-React half of AppLoadingScreen: status copy and the cross-mount
 * wait clock. Kept out of the component file so that file only exports
 * components and constants (React Fast Refresh).
 */

/**
 * What is actually being waited on, for the status line. Only pass a stage
 * the caller KNOWS is in progress — the line must never claim work that
 * isn't happening.
 *   'start' — generic (default): nothing more specific is known.
 *   'auth'  — restoring a stored session / refreshing its token.
 *   'sync'  — signed in; conversations, friends and servers are loading
 *             (HydrationGate).
 */
export type LoadingStage = 'start' | 'auth' | 'sync';

export const STAGE_LABEL: Readonly<Record<LoadingStage, string>> = {
    start: 'Getting things ready',
    auth: 'Signing you in',
    sync: 'Catching up on your chats',
};

export const SLOW_LABEL = 'Taking a little longer than usual. Hang tight.';

/** The offline screen's copy for the game stage (OfflineScreen → AppLoadingScreen `offline`). */
export const OFFLINE_LABEL = "You're offline";
export const OFFLINE_SUB = 'Cipherline will reconnect automatically.';

/** Two screens mounted within this gap are one continuous wait. */
export const HANDOFF_MS = 1500;

export const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * The app shows the loading screen twice in a row on a normal start — once
 * from App.tsx while the session is restored, then again from HydrationGate
 * while data loads — and those are separate mounts. Without this, the intro
 * fade would replay at the handoff (a visible blink), the loading bar would
 * jump back to the start of its sweep and the slow-hint clock would reset.
 * So the wait is tracked here: a mount that follows an unmount within
 * HANDOFF_MS continues the same wait. Module state, but only timing — never
 * any user data.
 *
 * -1 means "none" (0 is a legitimate performance.now() value).
 */
const session = { start: -1, endedAt: -1 };

export interface WaitStart {
    /** performance.now() at which this wait began. */
    t0: number;
    /** Whether it continues a previous screen's wait. */
    continued: boolean;
}

/** Called once per mount (in a state initialiser). Pure read. */
export function beginWait(t: number = now()): WaitStart {
    const continued = session.start >= 0 && session.endedAt >= 0 && t - session.endedAt < HANDOFF_MS;
    return continued ? { t0: session.start, continued } : { t0: t, continued };
}
/** A screen is on screen for the wait that began at t0. */
export function holdWait(t0: number): void {
    session.start = t0;
    session.endedAt = -1;
}
/** That screen went away. */
export function releaseWait(): void {
    session.endedAt = now();
}
/** Test hook: forget any previous wait. */
export function __resetLoadingSession(): void {
    session.start = -1;
    session.endedAt = -1;
}

/* ── The loading bar's honest bands ───────────────────────────────────────── */

export interface ProgressBand { floor: number; ceil: number; done: boolean }

/**
 * What the bar may show, from what is actually known: which stage we are in
 * and, while syncing, how many of the core loads (conversations, friends,
 * servers) have settled. The bar creeps from `floor` toward `ceil` without
 * reaching it, so it slows down rather than lies; while loading, `ceil` never
 * passes 0.9, so the bar can never sit full while work is still going. Only
 * `done` (the app has loaded) takes it to the end.
 */
export function progressBand(stage: LoadingStage, settled: number, loaded: boolean): ProgressBand {
    if (stage === 'start') return { floor: 0, ceil: 0.18, done: loaded };
    if (stage === 'auth') return { floor: 0.12, ceil: 0.34, done: loaded };
    const k = Math.max(0, Math.min(1, settled));
    const floor = 0.34 + 0.52 * k; // 0.34 → 0.86 as conversations, friends, servers settle
    return { floor, ceil: Math.min(0.9, floor + 0.52 / 3), done: loaded };
}

/* ── The easter-egg game vs. the exit ─────────────────────────────────────── */

export type GameState = 'idle' | 'playing' | 'over';

/** After this long on screen, "Press Space to play" fades in. */
export const HINT_MS = 1500;

/**
 * Never yank someone out of the game. The screen leaves when the app has
 * loaded (`loaded`) AND no game is up — or they asked to go (`continued`:
 * Enter or Esc). A crash ('over') still holds: the score card stays until
 * they choose (Enter/Esc into the app, Space to play again); nothing ever
 * continues on its own.
 */
export function isLeaving(loaded: boolean, game: GameState, continued: boolean): boolean {
    return loaded && (game === 'idle' || continued);
}
/** "Cipherline is ready · Enter to continue": loaded, a game up, not yet asked to go. */
export function showsReadyChip(loaded: boolean, game: GameState, continued: boolean): boolean {
    return loaded && game !== 'idle' && !continued;
}

/** After a crash, Enter/Esc wait this long, so keys mashed mid-run don't skip the score. */
export const OVER_GUARD_MS = 400;
