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
    connections: [
        { label: 'Steam', keywords: ['connect steam', 'verified steam', 'steam level', 'recently played', 'steam games', 'link steam'] },
        { label: 'Share what I\u2019m listening to', keywords: ['listening', 'music', 'now playing', 'spotify', 'apple music', 'song', 'listening status'] },
        { label: 'Include music playing in my browser', keywords: ['youtube', 'browser', 'web player'] },
        { label: 'Spotify showcase', keywords: ['playlists', 'albums', 'spotify', 'playlist showcase', 'music'] },
    ],
    appearance: [
        { label: 'Start with Windows', keywords: ['autostart', 'auto start', 'login', 'boot', 'startup', 'open at login', 'start on login', 'login items', 'launch at login'] },
        { label: 'Start minimized', keywords: ['taskbar', 'launch minimized'] },
        { label: 'Minimize to tray', keywords: ['system tray', 'close to tray', 'background'] },
        { label: 'Seasonal ambience', keywords: ['marine snow', 'effects', 'decorations'] },
        { label: 'Home ambience', keywords: ['motes', 'ambient motion', 'animations', 'bioluminescence'] },
        { label: 'GIF playback', keywords: ['autoplay', 'animation'] },
    ],
    personalize: [
        { label: 'My Emojis', keywords: ['custom emoji', 'personal emoji', 'emojis', 'emoticons', 'stickers', 'add emoji', 'upload emoji', 'animated emoji', 'reactions'] },
        { label: 'Add emoji', keywords: ['upload picture', 'import emoji', 'gif emoji', 'crop', 'resize'] },
        { label: 'Rename or reorder emojis', keywords: ['sort', 'delete emoji', 'remove emoji', 'arrange'] },
        { label: 'Most played this week', keywords: ['games', 'playtime', 'play time', 'activity', 'profile', 'friends'] },
        { label: 'Show my most played games to friends', keywords: ['most played', 'top games', 'hours played', 'share games', 'opt in'] },
    ],
    devices: [
        { label: 'Your devices', keywords: ['sessions', 'linked devices', 'this device'] },
        { label: 'Revoke device', keywords: ['sign out other devices', 'remove device', 'kick'] },
        { label: 'Sign out everywhere else', keywords: ['revoke others', 'log out all', 'sign out other devices'] },
        { label: 'Device history sync', keywords: ['transfer history', 'new device'] },
    ],
    voice: [
        { label: 'Microphone', keywords: ['input device', 'mic'] },
        { label: 'Input volume', keywords: ['microphone level', 'mic volume', 'gain'] },
        { label: 'Mic test', keywords: ['listen to mic', 'hear myself', 'level meter', 'test mic', 'microphone level'] },
        { label: 'Noise suppression', keywords: ['rnnoise', 'background noise', 'ns', 'strong', 'light', 'latency', 'delay', 'speex', 'noise suppression engine'] },
        { label: 'Voice gate', keywords: ['noise gate', 'threshold', 'activity threshold', 'sensitivity', 'voice activity'] },
        { label: 'Push to talk', keywords: ['ptt', 'hold to talk'] },
        { label: 'Echo cancellation', keywords: ['echo', 'aec', 'feedback', 'speakers'] },
        { label: 'Auto gain control', keywords: ['agc', 'auto gain', 'volume normalization', 'loudness'] },
        { label: 'Mic EQ', keywords: ['equalizer', 'eq', 'bass', 'treble'] },
        { label: 'Audio health', keywords: ['audio diagnostics', 'mic problems'] },
        { label: 'Speakers', keywords: ['output device', 'headphones', 'audio output'] },
        { label: 'Output volume', keywords: ['speaker volume', 'test speakers', 'master volume'] },
        { label: 'Normalize voice volume', keywords: ['loud people', 'quiet people', 'incoming volume'] },
        { label: 'Your audio devices', keywords: ['per device', 'remembered devices', 'headphones settings', 'headset', 'forget device', 'device profiles', 'audio devices'] },
        { label: 'Camera', keywords: ['webcam', 'video device', 'preview'] },
        { label: 'Picture adjustments', keywords: ['brightness', 'contrast', 'saturation', 'camera adjustments'] },
        { label: 'Prioritize calls and screen share while gaming', keywords: ['game', 'gaming', 'freeze', 'frozen', 'stutter', 'fps', 'camera freezes', 'screen share', 'screen share freezes', 'priority'] },
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
        { label: 'Suppress when chat is open', keywords: ['focused', 'foreground', 'mute while reading'] },
        { label: 'Badge count', keywords: ['unread count', 'dock badge'] },
        { label: 'Per-sound settings', keywords: ['mention sound', 'call sound', 'custom sounds', 'ringtone', 'celebration'] },
    ],
    keybinds: [
        { label: 'Keyboard shortcuts', keywords: ['hotkeys', 'bindings'] },
        { label: 'Mute keybind', keywords: ['push to talk', 'ptt', 'toggle mute'] },
        { label: 'Global shortcuts', keywords: ['background keybinds', 'system wide'] },
        { label: 'Lock screen keybind', keywords: ['screen lock hotkey'] },
        { label: 'Drawing request keybinds', keywords: ['annotation', 'annotate', 'allow drawing', 'approve request', 'decline request'] },
    ],
    activity: [
        { label: 'Show game activity', keywords: ['rich presence', 'playing status', 'now playing'] },
        { label: 'Detected game', keywords: ['currently playing', 'running now'] },
        { label: 'Ignored games', keywords: ['ignore process', 'hide game'] },
        { label: 'Custom games', keywords: ['add game', 'tag executable'] },
        { label: 'Running now', keywords: ['processes', 'running processes', 'exe'] },
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
        { label: 'Server storage', keywords: ['server history', 'purge server', 'channel history', 'free space'] },
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
        { label: 'Show stream stats', keywords: ['hud', 'overlay', 'stats', 'bitrate'] },
        { label: 'Screen share encoder', keywords: ['codec', 'h264', 'h.264', 'h265', 'h.265', 'hevc', 'vp8', 'vp9', 'encoder'] },
        { label: 'Performance log', keywords: ['freeze', 'freezes', 'stall', 'hang', 'not responding'] },
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
