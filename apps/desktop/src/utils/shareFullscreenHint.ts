/**
 * "For smooth game streaming, share the game window instead."
 *
 * Hypothesis (B) of the 2026-10-14 report (game focused -> ~9 fps, Cipherline
 * focused -> 45-80 fps): a fullscreen / independent-flip game presents around
 * DWM, so a whole-SCREEN capture only receives occasional frames while the
 * game is in front. A WINDOW capture of the game does not go through that path.
 * We cannot fix a screen capture from our side - but we can notice it and say
 * so, once, with a one-click way out. Never switches the share on its own:
 * a different source changes what viewers see.
 *
 * `decideFullscreenHint` is the pure decision; `FullscreenHintGate` adds the
 * once-per-share rule and, given a `HintSeenStore`, the once-EVER-per-account
 * rule (owner, 2026-10-14: "show it once, not on every share"). The inputs come from `share:get-foreground-info`
 * (foregroundInfo.ts), sampled with the share_fps instrument (every ~10 s and
 * 2 s after a focus change) and once when the share starts.
 *
 * Shows ONLY when all of these hold:
 *   - the share is a whole SCREEN (a window share is not affected);
 *   - the foreground window is not Cipherline's;
 *   - it covers its monitor (its rectangle equals the monitor's) or Windows
 *     says a Direct3D fullscreen app is running;
 *   - that monitor is the one being shared (a game on a second monitor is not
 *     what a share of the first monitor shows);
 *   - we know which program it is (the button pre-selects its window by name).
 */
import { isForegroundUnavailable, type ForegroundDiag } from './foregroundInfo';
import { secureLocalStore } from './secureLocalStore';

// ── Once ever per account ───────────────────────────────────────────────────
// A per-account record in secureLocalStore (NEVER raw localStorage), named for
// the account so the store files it under that account's subkey. Set the moment
// the hint is shown, whether or not it is accepted. Excluded from backups
// (backupRegistry.ts): a per-device UI nicety, a restore must not carry it.
// Read only once the account's records are loaded (isAccountReady), because a
// cold namespace reads null and would show the hint again.
const SHARE_WINDOW_HINT_SEEN_PREFIX = 'cipherline_share_window_hint_seen_';
const ACTIVE_USER_KEY = 'cipherline_user_id';

/** Whether this account has already been shown the hint (one record, "1"). */
export interface HintSeenStore {
    /** The active account's records are loaded; reading before this is meaningless. */
    ready(): boolean;
    seen(): boolean;
    /** Persist "shown". Synchronous in the facade; flushed to the encrypted store by it. */
    markSeen(): void;
}

const activeUserId = (): string => secureLocalStore.getItem(ACTIVE_USER_KEY) || '';

export const accountHintSeenStore: HintSeenStore = {
    ready: () => {
        const uid = activeUserId();
        return !!uid && secureLocalStore.isAccountReady(uid);
    },
    seen: () => {
        const uid = activeUserId();
        return !!uid && secureLocalStore.getItem(SHARE_WINDOW_HINT_SEEN_PREFIX + uid) === '1';
    },
    markSeen: () => {
        const uid = activeUserId();
        if (uid) secureLocalStore.setItem(SHARE_WINDOW_HINT_SEEN_PREFIX + uid, '1');
    },
};

export const FULLSCREEN_HINT_TITLE = 'Smoother game streaming';
export const FULLSCREEN_HINT_MESSAGE = 'For smooth game streaming, share the game window instead.';
export const FULLSCREEN_HINT_ACTION = 'Pick the game window';

export type ShareKind = 'screen' | 'window' | 'unknown';

/** Windows shell programs that can cover a monitor without being a game. */
const SHELL_EXES: ReadonlySet<string> = new Set([
    'explorer.exe', 'lockapp.exe', 'searchhost.exe', 'shellexperiencehost.exe', 'startmenuexperiencehost.exe',
]);

export type HintReason =
    | 'show'
    | 'already_shown'
    | 'seen_before'
    | 'store_not_ready'
    | 'not_screen_share'
    | 'no_info'
    | 'unavailable'
    | 'cipherline_in_front'
    | 'not_covering'
    | 'other_monitor'
    | 'unknown_program';

export interface HintDecision { show: boolean; reason: HintReason; exe?: string }

/** `screen:<n>:<m>` -> 'screen', `window:...` -> 'window'. */
export function shareKindOf(sourceId: string | undefined | null): ShareKind {
    if (typeof sourceId !== 'string') return 'unknown';
    if (sourceId.startsWith('screen:')) return 'screen';
    if (sourceId.startsWith('window:')) return 'window';
    return 'unknown';
}

export function decideFullscreenHint(input: {
    kind: ShareKind;
    fg: ForegroundDiag | null;
    alreadyShown: boolean;
}): HintDecision {
    const { kind, fg } = input;
    if (kind !== 'screen') return { show: false, reason: 'not_screen_share' };
    if (!fg) return { show: false, reason: 'no_info' };
    // Linux / macOS: nothing to go on, and the DWM-bypass problem this hint
    // exists for is Windows-only anyway (electron/share-platform.ts).
    if (isForegroundUnavailable(fg)) return { show: false, reason: 'unavailable' };
    if (fg.isCipherline) return { show: false, reason: 'cipherline_in_front' };
    const covering = fg.covers || fg.state === 'QUNS_RUNNING_D3D_FULL_SCREEN';
    if (!covering) return { show: false, reason: 'not_covering' };
    if (fg.onSharedScreen !== true) return { show: false, reason: 'other_monitor' };
    if (!fg.exe || SHELL_EXES.has(fg.exe.toLowerCase())) return { show: false, reason: 'unknown_program' };
    if (input.alreadyShown) return { show: false, reason: 'already_shown' };
    return { show: true, reason: 'show', exe: fg.exe };
}

/**
 * One per share, and - with a `seen` store - one per ACCOUNT EVER: remembers
 * that the hint was shown, so it is never repeated.
 * The share's KIND is passed with each sample (a share can change source
 * mid-share: screen -> window -> screen is still one share).
 *
 * With a `seen` store: not ready -> no hint (a later sample tries again);
 * already seen -> no hint; otherwise the flag is written BEFORE the toast is
 * raised, so a crash between the two cannot show it twice.
 */
export class FullscreenHintGate {
    private shownFlag = false;
    private readonly deps: {
        /** Show the hint (a toast with the "pick the game window" button). Called at most once. */
        onHint(exe: string): void;
        /** Persistent once-ever flag. Absent = once per share only. */
        seen?: HintSeenStore;
    };

    // (No parameter property: `erasableSyntaxOnly` is on for src/.)
    constructor(deps: { onHint(exe: string): void; seen?: HintSeenStore }) {
        this.deps = deps;
    }

    get shown(): boolean { return this.shownFlag; }

    /** Feed one foreground sample. Returns the decision (for logging / tests). */
    observe(fg: ForegroundDiag | null, kind: ShareKind): HintDecision {
        const d = decideFullscreenHint({ kind, fg, alreadyShown: this.shownFlag });
        if (d.show && d.exe) {
            const seen = this.deps.seen;
            if (seen) {
                // Only consulted once everything else says "show": nothing to read otherwise.
                if (!seen.ready()) return { show: false, reason: 'store_not_ready' };
                if (seen.seen()) {
                    this.shownFlag = true;
                    return { show: false, reason: 'seen_before' };
                }
                seen.markSeen();
            }
            this.shownFlag = true;
            this.deps.onHint(d.exe);
        }
        return d;
    }
}
