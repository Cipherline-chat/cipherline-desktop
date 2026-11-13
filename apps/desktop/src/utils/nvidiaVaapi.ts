import secureLocalStore from './secureLocalStore';

/**
 * Linux + NVIDIA: the VA-API video driver prompt (main: electron/nvidia-vaapi-install.ts).
 *
 * The renderer only ever asks "install the NVIDIA VA-API driver" - no package name crosses the bridge. Replies are
 * `unknown` at the bridge and narrowed here, so a stale/odd main process degrades to "nothing to show".
 *
 * The "card dismissed" flag is device-local and NOT in backups (backupRegistry.ts): it describes this machine's GPU/packages.
 */
export type NvidiaVaapiState = 'none' | 'install' | 'modeset' | 'restart';
export interface NvidiaVaapiStatus { state: NvidiaVaapiState; pkg: string; command: string; modesetNote: string | null; canInstall: boolean }
export type NvidiaVaapiOutcome = 'installed' | 'not_found' | 'denied' | 'unavailable' | 'failed' | 'busy' | 'unsupported';
export interface NvidiaVaapiInstallResult { outcome: NvidiaVaapiOutcome; status: NvidiaVaapiStatus }

const NONE: NvidiaVaapiStatus = { state: 'none', pkg: '', command: '', modesetNote: null, canInstall: false };
const STATES: readonly string[] = ['none', 'install', 'modeset', 'restart'];
const OUTCOMES: readonly string[] = ['installed', 'not_found', 'denied', 'unavailable', 'failed', 'busy', 'unsupported'];

export function parseNvidiaVaapiStatus(v: unknown): NvidiaVaapiStatus {
    if (!v || typeof v !== 'object') return NONE;
    const r = v as Record<string, unknown>;
    if (typeof r.state !== 'string' || !STATES.includes(r.state)) return NONE;
    return {
        state: r.state as NvidiaVaapiState,
        pkg: typeof r.pkg === 'string' ? r.pkg.slice(0, 48) : '',
        command: typeof r.command === 'string' ? r.command.slice(0, 200) : '',
        modesetNote: typeof r.modesetNote === 'string' ? r.modesetNote.slice(0, 500) : null,
        canInstall: r.canInstall === true,
    };
}

export function parseNvidiaVaapiInstallResult(v: unknown): NvidiaVaapiInstallResult {
    const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    return {
        outcome: typeof r.outcome === 'string' && OUTCOMES.includes(r.outcome) ? r.outcome as NvidiaVaapiOutcome : 'failed',
        status: parseNvidiaVaapiStatus(r.status),
    };
}

const SHOWN_KEY = 'cipherline_nvidia_vaapi_prompt_shown';
export function isNvidiaVaapiCardDismissed(): boolean { try { return secureLocalStore.getItem(SHOWN_KEY) === '1'; } catch { return false; } }
export function dismissNvidiaVaapiCard(): void { try { secureLocalStore.setItem(SHOWN_KEY, '1'); } catch { /* locked store: this session only */ } }

/** Whether the one-time card should be on screen. A restart prompt (after an install this session) is not suppressed by a past dismissal. */
export function shouldShowNvidiaVaapiCard(s: NvidiaVaapiStatus, dismissed: boolean): boolean {
    if (s.state === 'none') return false;
    if (s.state === 'restart') return true;
    return !dismissed;
}

/** One sentence per outcome for the card / Settings row. */
export function nvidiaVaapiOutcomeText(o: NvidiaVaapiOutcome, status: NvidiaVaapiStatus): string {
    switch (o) {
        case 'installed':
            return status.state === 'modeset'
                ? 'Installed. One more step: ' + (status.modesetNote ?? '')
                : 'Installed. Restart Cipherline to use it.';
        case 'not_found': return 'Your software sources don’t offer this package (on Fedora it comes from RPM Fusion). Use the command below instead.';
        case 'denied': return 'The installation wasn’t authorised, so nothing was installed.';
        case 'unavailable': return 'This system can’t install packages from here. Use the command below instead.';
        case 'busy': return 'An installation is already running.';
        case 'unsupported': return 'Nothing to install on this computer.';
        default: return 'The installation didn’t complete. Use the command below instead.';
    }
}

export async function fetchNvidiaVaapiStatus(): Promise<NvidiaVaapiStatus> {
    try { return parseNvidiaVaapiStatus(await window.electronAPI?.getNvidiaVaapiStatus?.()); } catch { return NONE; }
}

export async function requestNvidiaVaapiInstall(): Promise<NvidiaVaapiInstallResult> {
    try {
        const raw = await window.electronAPI?.installNvidiaVaapiDriver?.();
        return raw === undefined ? { outcome: 'unavailable', status: NONE } : parseNvidiaVaapiInstallResult(raw);
    } catch { return { outcome: 'failed', status: NONE }; }
}
