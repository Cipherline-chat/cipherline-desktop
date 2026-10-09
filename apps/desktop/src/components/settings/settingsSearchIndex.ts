import type { PaneId } from './SettingsScreen';

/**
 * Search index for the Descent's gauge search — what makes it search
 * SETTINGS, not just the twelve tab names. Each pane lists the labels of the
 * settings it actually renders, plus synonyms people genuinely type ("autostart"
 * for Start with Windows, "ptt" for push-to-talk). Curated by hand because the
 * panes are separate components whose rows only exist once mounted — there is
 * no DOM to search until you've already navigated to the pane, which is the
 * exact chicken-and-egg this index solves.
 *
 * Keep entries in sync when adding a setting: the label a user SEES is the
 * minimum; add keywords for what they'd TYPE. settingsSearchIndex.test.ts
 * enforces that every pane has entries at all.
 */

export interface SettingsIndexEntry {
    /** The visible label of the setting (shown as the match hint). */
    label: string;
    /** Extra words that should find it — synonyms, jargon, old names. */
    keywords?: string[];
}

export const SETTINGS_INDEX: Record<PaneId, SettingsIndexEntry[]> = {
    profile: [
        { label: 'Display name', keywords: ['username', 'rename'] },
        { label: 'Avatar', keywords: ['profile picture', 'photo', 'pfp'] },
        { label: 'Banner', keywords: ['header image'] },
        { label: 'Change password', keywords: ['security', 'credentials'] },
        { label: 'Two-factor authentication', keywords: ['2fa', 'totp', 'authenticator'] },
        { label: 'Recovery key', keywords: ['backup key', 'account recovery'] },
    ],
    appearance: [
        { label: 'Start with Windows', keywords: ['autostart', 'auto start', 'login', 'boot', 'startup', 'open at login', 'start on login', 'login items', 'launch at login'] },
        { label: 'Start minimized', keywords: ['taskbar', 'launch minimized'] },
        { label: 'Minimize to tray', keywords: ['system tray', 'close to tray', 'background'] },
        { label: 'Seasonal ambience', keywords: ['marine snow', 'effects', 'decorations'] },
        { label: 'Home ambience', keywords: ['motes', 'ambient motion', 'animations', 'bioluminescence'] },
        { label: 'GIF playback', keywords: ['autoplay', 'animation'] },
    ],
    devices: [
        { label: 'Your devices', keywords: ['sessions', 'linked devices', 'this device'] },
        { label: 'Revoke device', keywords: ['sign out other devices', 'remove device', 'kick'] },
        { label: 'Sign out everywhere else', keywords: ['revoke others', 'log out all', 'sign out other devices'] },
        { label: 'Device history sync', keywords: ['transfer history', 'new device'] },
    ],
    voice: [
        { label: 'Microphone', keywords: ['input device', 'mic'] },
        { label: 'Speakers', keywords: ['output device', 'headphones', 'audio output'] },
        { label: 'Microphone level', keywords: ['input volume', 'gain', 'sensitivity'] },
        { label: 'Noise suppression', keywords: ['rnnoise', 'background noise', 'ns'] },
        { label: 'Voice gate', keywords: ['noise gate', 'threshold'] },
        { label: 'Volume normalization', keywords: ['loudness', 'agc', 'auto gain'] },
        { label: 'Camera', keywords: ['webcam', 'video device', 'preview'] },
        { label: 'Camera adjustments', keywords: ['brightness', 'contrast', 'saturation'] },
        { label: 'Prioritize call video while gaming', keywords: ['game', 'gaming', 'freeze', 'frozen', 'stutter', 'fps', 'camera freezes', 'screen share freezes', 'priority'] },
        { label: 'Camera quality', keywords: ['resolution', '1080p', '1440p', '720p', 'hd', 'webcam quality', 'sharpness'] },
        { label: 'Incoming video quality', keywords: ['data saver', 'reduced', 'bandwidth', 'metered', 'other cameras', 'lag', 'slow'] },
    ],
    notifications: [
        { label: 'Desktop notifications', keywords: ['popups', 'toasts'] },
        { label: 'Notification sounds', keywords: ['volume', 'mute sounds', 'audio cues'] },
        { label: 'Message preview', keywords: ['show content', 'privacy', 'hide message text'] },
        { label: 'Show profile pictures', keywords: ['avatar', 'notification icon', 'sender picture', 'profile photo'] },
        { label: 'Quick reply', keywords: ['inline reply'] },
        { label: 'Getting-started tips', keywords: ['nudges', 'hints', 'first week', 'tips', 'onboarding'] },
        { label: 'Keyword alerts', keywords: ['highlight words', 'watchwords'] },
        { label: 'Do Not Disturb', keywords: ['dnd', 'quiet hours', 'silence'] },
        { label: 'DND schedule', keywords: ['night mode', 'sleep hours'] },
        { label: 'Flash taskbar', keywords: ['blink', 'attention'] },
        { label: 'Badge count', keywords: ['unread count', 'dock badge'] },
        { label: 'Per-sound settings', keywords: ['mention sound', 'call sound', 'custom sounds', 'ringtone', 'celebration'] },
    ],
    keybinds: [
        { label: 'Keyboard shortcuts', keywords: ['hotkeys', 'bindings'] },
        { label: 'Mute keybind', keywords: ['push to talk', 'ptt', 'toggle mute'] },
        { label: 'Global shortcuts', keywords: ['background keybinds', 'system wide'] },
        { label: 'Lock screen keybind', keywords: ['screen lock hotkey'] },
    ],
    activity: [
        { label: 'Show game activity', keywords: ['rich presence', 'playing status', 'now playing'] },
        { label: 'Detected game', keywords: ['currently playing', 'running now'] },
        { label: 'Ignored games', keywords: ['ignore process', 'hide game'] },
        { label: 'Custom games', keywords: ['add game', 'tag executable'] },
    ],
    privacy: [
        { label: 'Reachability', keywords: ['who can message', 'friend requests', 'dms from'] },
        { label: 'Screen Lock', keywords: ['pin', 'lock app', 'inactivity lock'] },
        { label: 'Link previews', keywords: ['embeds', 'url preview'] },
        { label: 'Screen capture warning', keywords: ['recording detection', 'screenshot'] },
        { label: 'Safety numbers', keywords: ['verify', 'identity verification', 'fingerprint'] },
        { label: 'Privacy Policy', keywords: ['policy', 'legal', 'gdpr', 'google drive data'] },
        { label: 'Terms of Service', keywords: ['terms', 'legal', 'agreement', 'tos'] },
    ],
    storage: [
        { label: 'Encrypted backups', keywords: ['auto backup', 'backup folder', 'google drive', 'restore'] },
        { label: 'Message retention', keywords: ['auto delete', 'expiry', 'disappearing'] },
        { label: 'Clear history', keywords: ['purge', 'delete messages', 'free space'] },
        { label: 'Orphaned chats', keywords: ['leftover data'] },
    ],
    billing: [
        { label: 'Your plan', keywords: ['subscription', 'pro', 'upgrade', 'premium'] },
        { label: 'Payment method', keywords: ['card', 'billing portal', 'invoice'] },
        { label: 'Trial', keywords: ['free trial', 'extend'] },
        { label: 'Refer a friend', keywords: ['referral', 'invite reward'] },
    ],
    advanced: [
        { label: 'Update channel', keywords: ['staging', 'stable', 'beta', 'version'] },
        { label: 'Report a problem', keywords: ['bug', 'bug report', 'feedback', 'support', 'help', 'crash', 'issue', 'diagnostics', 'fps', 'lag'] },
        { label: 'Automatically send crash reports', keywords: ['crash reports', 'telemetry', 'auto send'] },
        { label: 'Delivery diagnostics', keywords: ['debug', 'message delivery', 'logs'] },
        { label: 'Build info', keywords: ['version number', 'about'] },
    ],
    danger: [
        { label: 'Sign out', keywords: ['log out', 'logout'] },
        { label: 'Delete account', keywords: ['erase', 'close account', 'gdpr', 'remove account'] },
    ],
};

/** Panes whose indexed settings match `q`, with the matched labels (for the
 *  hint line under the nav item). A pane whose own tab label matches is the
 *  caller's business — this only searches the settings themselves. */
export function searchSettingsIndex(q: string): Partial<Record<PaneId, string[]>> {
    const needle = q.trim().toLowerCase();
    if (!needle) return {};
    const out: Partial<Record<PaneId, string[]>> = {};
    for (const pane of Object.keys(SETTINGS_INDEX) as PaneId[]) {
        const hits = SETTINGS_INDEX[pane]
            .filter(e =>
                e.label.toLowerCase().includes(needle) ||
                (e.keywords ?? []).some(k => k.includes(needle)))
            .map(e => e.label);
        if (hits.length) out[pane] = hits;
    }
    return out;
}
