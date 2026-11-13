import secureLocalStore from './secureLocalStore';

/**
 * Linux + Intel/AMD: the VA-API video ENCODER driver prompt (main: electron/video-encode-driver.ts).
 *
 * The renderer only ever asks "install the encoder driver" - no package name crosses the bridge. Replies are `unknown` at the bridge and
 * narrowed here, so a stale/odd main process degrades to "nothing to show". Main already keeps this card silent while the NVIDIA card
 * has something to say (one card at a time).
 *
 * The "card dismissed" flag is device-local and NOT in backups (backupRegistry.ts).
 */
export type VideoEncodeDriverState = 'none' | 'install' | 'restart';
export interface VideoEncodeDriverStatus { state: VideoEncodeDriverState; vendor: 'intel' | 'amd' | ''; pkg: string; command: string; repoHint: string | null; canInstall: boolean }
export type VideoEncodeDriverOutcome = 'installed' | 'not_found' | 'denied' | 'unavailable' | 'failed' | 'busy' | 'unsupported';
export interface VideoEncodeDriverInstallResult { outcome: VideoEncodeDriverOutcome; status: VideoEncodeDriverStatus }

const NONE: VideoEncodeDriverStatus = { state: 'none', vendor: '', pkg: '', command: '', repoHint: null, canInstall: false };
const STATES: readonly string[] = ['none', 'install', 'restart'];
const OUTCOMES: readonly string[] = ['installed', 'not_found', 'denied', 'unavailable', 'failed', 'busy', 'unsupported'];

export function parseVideoEncodeDriverStatus(v: unknown): VideoEncodeDriverStatus {
    if (!v || typeof v !== 'object') return NONE;
    const r = v as Record<string, unknown>;
    if (typeof r.state !== 'string' || !STATES.includes(r.state)) return NONE;
    return {
        state: r.state as VideoEncodeDriverState,
        vendor: r.vendor === 'intel' || r.vendor === 'amd' ? r.vendor : '',
        pkg: typeof r.pkg === 'string' ? r.pkg.slice(0, 48) : '',
        command: typeof r.command === 'string' ? r.command.slice(0, 200) : '',
        repoHint: typeof r.repoHint === 'string' ? r.repoHint.slice(0, 300) : null,
        canInstall: r.canInstall === true,
    };
}

export function parseVideoEncodeDriverInstallResult(v: unknown): VideoEncodeDriverInstallResult {
    const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    return {
        outcome: typeof r.outcome === 'string' && OUTCOMES.includes(r.outcome) ? r.outcome as VideoEncodeDriverOutcome : 'failed',
        status: parseVideoEncodeDriverStatus(r.status),
    };
}

const SHOWN_KEY = 'cipherline_video_encode_driver_prompt_shown';
export function isVideoEncodeDriverCardDismissed(): boolean { try { return secureLocalStore.getItem(SHOWN_KEY) === '1'; } catch { return false; } }
export function dismissVideoEncodeDriverCard(): void { try { secureLocalStore.setItem(SHOWN_KEY, '1'); } catch { /* locked store: this session only */ } }

/** Whether the one-time card should be on screen. A restart prompt (after an install this session) is not suppressed by a past dismissal. */
export function shouldShowVideoEncodeDriverCard(s: VideoEncodeDriverStatus, dismissed: boolean): boolean {
    if (s.state === 'none') return false;
    if (s.state === 'restart') return true;
    return !dismissed;
}

export function videoEncodeDriverTitle(s: VideoEncodeDriverStatus): string {
    const who = s.vendor === 'amd' ? 'AMD' : s.vendor === 'intel' ? 'Intel' : 'graphics';
    return s.state === 'restart' ? `Restart Cipherline to use the ${who} video encoder` : `Install the ${who} video encoder driver for smoother screen sharing`;
}

/** One sentence per outcome for the card / Settings row. */
export function videoEncodeDriverOutcomeText(o: VideoEncodeDriverOutcome, status: VideoEncodeDriverStatus): string {
    switch (o) {
        case 'installed': return 'Installed. Restart Cipherline to use it.';
        case 'not_found': return 'Your software sources don’t offer this package. ' + (status.repoHint ?? '') + ' Use the command below.';
        case 'denied': return 'The installation wasn’t authorised, so nothing was installed.';
        case 'unavailable': return 'This system can’t install packages from here. Use the command below instead.';
        case 'busy': return 'An installation is already running.';
        case 'unsupported': return 'Nothing to install from here. Use the command below.';
        default: return 'The installation didn’t complete. Use the command below instead.';
    }
}

export async function fetchVideoEncodeDriverStatus(): Promise<VideoEncodeDriverStatus> {
    try { return parseVideoEncodeDriverStatus(await window.electronAPI?.getVideoEncodeDriverStatus?.()); } catch { return NONE; }
}

export async function requestVideoEncodeDriverInstall(): Promise<VideoEncodeDriverInstallResult> {
    try {
        const raw = await window.electronAPI?.installVideoEncodeDriver?.();
        return raw === undefined ? { outcome: 'unavailable', status: NONE } : parseVideoEncodeDriverInstallResult(raw);
    } catch { return { outcome: 'failed', status: NONE }; }
}
