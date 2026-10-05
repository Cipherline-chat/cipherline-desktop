import React from 'react';
import { ShieldOff, Eye, MessageCircle, UserCheck, AlertCircle, FileText, ScrollText, ExternalLink, ImageIcon, Smartphone, Search } from 'lucide-react';
import { type PrivacySettingsHook, type ImageAutoLoadMode } from '../hooks/usePrivacySettings';
import type { ScreenLockHook } from '../hooks/useScreenLock';
import type { KeybindHook } from '../hooks/useKeybinds';
import { ClToggle, ClButton, ClSelect } from './cl';
import type { ClSelectOption } from './cl';
import { openExternalLink } from '../utils/openExternalLink';
import ScreenLockSettings from './ScreenLockSettings';
import { useGifSettings } from '../hooks/useGifSettings';
import { klipyConfigured, KLIPY_NOTICE_TEXT } from '../utils/klipy';

const IMAGE_AUTO_LOAD_OPTIONS: ClSelectOption<ImageAutoLoadMode>[] = [
    { value: 'known', label: 'Known hosts only (recommended)' },
    { value: 'always', label: 'Always' },
    { value: 'never', label: 'Never' },
];

/**
 * Midnight · Privacy & Safety — Descent redesign (phase 3): sd-card
 * sections with icon-tile rows. Same five switches, same behavior.
 */
interface PrivacySettingsProps {
    privacy: PrivacySettingsHook;
    screenLock: ScreenLockHook;
    keybinds: KeybindHook;
}

const PrivacySettings: React.FC<PrivacySettingsProps> = ({ privacy, screenLock, keybinds }) => {
    const {
        settings,
        setScreenCaptureProtection,
        setShowReadReceipts,
        setShowTypingIndicators,
        setAllowFriendRequests,
        setImageAutoLoad,
        setShowMobilePresence,
    } = privacy;
    // Standalone instance — useGifSettings keeps every mounted instance in
    // sync through its change event, so no prop plumbing is needed.
    const gif = useGifSettings();
    const klipyAvailable = klipyConfigured();

    return (
        <>
            <ScreenLockSettings screenLock={screenLock} keybinds={keybinds} />

            {/* Messaging */}
            <div className="sd-card">
                <h3>Messaging</h3>
                <p className="sd-sub">Receipts and typing are routed device-to-device — the server never sees either.</p>
                <div className="sd-row" style={{ borderTop: 'none' }}>
                    <span className={`sd-tile${settings.showReadReceipts ? '' : ' sd-tile--dim'}`}><Eye size={16} /></span>
                    <div className="sd-rl">
                        <b>Send read receipts</b>
                        <span>Let others know when you’ve read their messages. When off, you also won’t see theirs.</span>
                    </div>
                    <div className="sd-rc">
                        <ClToggle checked={settings.showReadReceipts} onChange={setShowReadReceipts} />
                    </div>
                </div>
                <div className="sd-row">
                    <span className={`sd-tile${settings.showTypingIndicators ? '' : ' sd-tile--dim'}`}><MessageCircle size={16} /></span>
                    <div className="sd-rl">
                        <b>Show typing indicators</b>
                        <span>When off, others won’t see when you’re composing a message.</span>
                    </div>
                    <div className="sd-rc">
                        <ClToggle checked={settings.showTypingIndicators} onChange={setShowTypingIndicators} />
                    </div>
                </div>
            </div>

            {/* Social */}
            <div className="sd-card">
                <h3>Reachability</h3>
                <div className="sd-row" style={{ borderTop: 'none' }}>
                    <span className={`sd-tile${settings.allowFriendRequests ? '' : ' sd-tile--dim'}`}><UserCheck size={16} /></span>
                    <div className="sd-rl">
                        <b>Allow friend requests</b>
                        <span>When off, nobody can send you one. Existing friends are unaffected.</span>
                    </div>
                    <div className="sd-rc">
                        <ClToggle checked={settings.allowFriendRequests} onChange={setAllowFriendRequests} />
                    </div>
                </div>
                <div className="sd-row">
                    <span className={`sd-tile${settings.showMobilePresence ? '' : ' sd-tile--dim'}`}><Smartphone size={16} /></span>
                    <div className="sd-rl">
                        <b>Show when you’re on mobile</b>
                        <span>When the only place you’re online is your phone, people who can see your status see a small phone instead of the dot. It never says which phone, or how many devices you have. Appear Offline hides it along with everything else.</span>
                    </div>
                    <div className="sd-rc">
                        <ClToggle checked={settings.showMobilePresence} onChange={setShowMobilePresence} />
                    </div>
                </div>
            </div>

            {/* Media */}
            <div className="sd-card">
                <h3>Images &amp; GIFs</h3>
                <p className="sd-sub">
                    A linked image is never fetched automatically from a host that could be the sender's own
                    server — that would hand them a read receipt and your IP the moment the message renders.
                    Well-known media CDNs (Giphy, Tenor, Imgur, Discord, Twitter/X) aren't the sender and can't
                    exploit that, so they're safe to auto-display by default.
                </p>
                <div className="sd-row" style={{ borderTop: 'none' }}>
                    <span className="sd-tile"><ImageIcon size={16} /></span>
                    <div className="sd-rl">
                        <b>Automatically display linked images</b>
                        <span>Every other host still shows a "Load image" placeholder until you click it.</span>
                    </div>
                    <div className="sd-rc">
                        <ClSelect<ImageAutoLoadMode>
                            value={settings.imageAutoLoad}
                            onChange={setImageAutoLoad}
                            options={IMAGE_AUTO_LOAD_OPTIONS}
                            ariaLabel="Automatically display linked images"
                            style={{ width: 220 }}
                        />
                    </div>
                </div>
                <div className="sd-row">
                    <span className={`sd-tile${gif.settings.klipyEnabled && klipyAvailable ? '' : ' sd-tile--dim'}`}><Search size={16} /></span>
                    <div className="sd-rl">
                        <b>GIF search (KLIPY)</b>
                        <span>
                            {KLIPY_NOTICE_TEXT} GIFs from KLIPY in your chats also load from KLIPY's servers while
                            this is on. When it's off, nothing is sent to KLIPY: the picker shows only your favorite
                            GIFs and a KLIPY GIF someone sends you waits for a tap before it loads.
                            {!klipyAvailable && <> GIF search isn't available in this build.</>}
                        </span>
                    </div>
                    <div className="sd-rc">
                        <ClToggle
                            checked={gif.settings.klipyEnabled}
                            onChange={gif.setKlipyEnabled}
                            aria-label="GIF search (KLIPY)"
                        />
                    </div>
                </div>
            </div>

            {/* App Security */}
            <div className="sd-card">
                <h3>This window</h3>
                <div className="sd-row" style={{ borderTop: 'none' }}>
                    <span className={`sd-tile${settings.screenCaptureProtection ? '' : ' sd-tile--dim'}`}><ShieldOff size={16} /></span>
                    <div className="sd-rl">
                        <b>Hide from screenshots &amp; recordings</b>
                        <span>
                            Cipherline appears blank in OS screenshots and screen recorders. Fully effective
                            on Windows; on macOS this blocks screenshots but not recordings (platform limitation).
                        </span>
                    </div>
                    <div className="sd-rc">
                        <ClToggle checked={settings.screenCaptureProtection} onChange={setScreenCaptureProtection} />
                    </div>
                </div>
            </div>

            {/* Content & Safety */}
            {/* Policies — the privacy policy and terms, one click from the app
                (Google's app-verification bar: "prominently displayed in your
                app interface"). Opened through the validated external-link path. */}
            <div className="sd-card">
                <h3>Policies</h3>
                <p className="sd-sub">What we can see, what we can’t, and what you agreed to. The same text as on cipherline.chat.</p>
                <div className="sd-row" style={{ borderTop: 'none' }}>
                    <span className="sd-tile"><FileText size={16} /></span>
                    <div className="sd-rl">
                        <b>Privacy Policy</b>
                        <span>How Cipherline handles your data — including the optional Google Drive backups.</span>
                    </div>
                    <div className="sd-rc">
                        <ClButton size="sm" variant="ghost" onClick={() => { openExternalLink('https://cipherline.chat/privacy'); }}>
                            <ExternalLink size={13} /> Open
                        </ClButton>
                    </div>
                </div>
                <div className="sd-row">
                    <span className="sd-tile"><ScrollText size={16} /></span>
                    <div className="sd-rl">
                        <b>Terms of Service</b>
                        <span>The agreement between you and Cipherline LLC.</span>
                    </div>
                    <div className="sd-rc">
                        <ClButton size="sm" variant="ghost" onClick={() => { openExternalLink('https://cipherline.chat/terms'); }}>
                            <ExternalLink size={13} /> Open
                        </ClButton>
                    </div>
                </div>
            </div>

            <div className="sd-card">
                <h3>Content</h3>
                <div className="sd-row" style={{ borderTop: 'none' }}>
                    <span className="sd-tile sd-tile--warm"><AlertCircle size={16} /></span>
                    <div className="sd-rl">
                        <b>Show age-restricted content <span style={{ color: 'var(--cl-glow)', fontWeight: 700, fontSize: 11 }}>coming soon</span></b>
                        <span>Allow channels and servers marked age-restricted to display their content. 18+ only.</span>
                    </div>
                    <div className="sd-rc">
                        <ClToggle checked={false} onChange={() => {}} disabled />
                    </div>
                </div>
            </div>
        </>
    );
};

export default PrivacySettings;
