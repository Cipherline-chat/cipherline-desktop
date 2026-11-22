import React from 'react';
import { Activity, Image as ImageIcon, PartyPopper, Sparkles, Snowflake } from 'lucide-react';
import { ClRadioGroup, ClToggle } from '../../cl';
import { useSeasonalEffects } from '../../../hooks/useSeasonalEffects';
import { useAmbientMotion } from '../../../hooks/useAmbientMotion';
import {
    useMotionSnapshot, setReduceMotion, setImageMode, setEffectsEnabled,
    type ReduceMotionMode, type ImageMotionMode,
} from '../../../utils/a11y/motionPrefs';

/**
 * Settings → Accessibility → "Motion & effects". One card for everything that
 * moves on screen (it replaces the Appearance pane's old Motion card, which
 * now points here — accessibility needs one findable home, and these three
 * controls are the same question: how much moves):
 *
 *  - Reduce motion: Follow my system (default) / Always reduce / Allow full motion
 *  - Animated images: Play automatically / Only on hover / Never
 *  - Celebrations and effects (+ Home ambience, Marine snow, which sit under it)
 *
 * State and rules live in utils/a11y/motionPrefs.ts; this file is presentation.
 * Calls, screen share and video are never affected by any of it.
 */

const REDUCE_OPTIONS: { value: ReduceMotionMode; label: string }[] = [
    { value: 'system', label: 'Follow my system' },
    { value: 'on', label: 'Always reduce' },
    { value: 'off', label: 'Allow full motion' },
];
const IMAGE_OPTIONS: { value: ImageMotionMode; label: string }[] = [
    { value: 'always', label: 'Play automatically' },
    { value: 'hover', label: 'Only on hover or focus' },
    { value: 'never', label: 'Never' },
];

export const MotionEffectsCard: React.FC = () => {
    const m = useMotionSnapshot();
    const [ambient, setAmbient] = useAmbientMotion();
    const [seasonal, setSeasonal] = useSeasonalEffects();

    const imagesShown: ImageMotionMode = m.images ?? (m.legacyAutoPlayGifs ? 'always' : 'hover');
    // Someone who turned "Automatically play GIFs" off before this existed: GIFs are on hover,
    // everything else is untouched until they choose here.
    const migratedHoverOnly = m.images === undefined && !m.legacyAutoPlayGifs;

    return (
        <div className="sd-card" data-labels="Reduce motion|Animated images|Celebrations and effects|Home ambience|Marine snow|GIF playback">
            <h3>Motion &amp; effects</h3>
            <p className="sd-sub">How much moves on screen. Calls, screen sharing and video are never affected.</p>

            {/* Reduce motion */}
            <div className="sd-row a11y-row" style={{ borderTop: 'none' }}>
                <span className="sd-tile"><Activity size={16} /></span>
                <div className="sd-rl">
                    <b id="a11y-reduce-label">Reduce motion</b>
                    <span>Turns off sliding, floating and looping decoration across the app. Follow my system uses your computer’s own setting; the other two override it for Cipherline only.</span>
                </div>
            </div>
            <div className="a11y-opts" role="radiogroup" aria-labelledby="a11y-reduce-label">
                <ClRadioGroup options={REDUCE_OPTIONS} value={m.reduce} onChange={setReduceMotion} direction="row" gap={18} />
            </div>
            <div className="a11y-foot">
                <span className="a11y-note" role="status" aria-live="polite">
                    {m.reduced ? 'Motion is reduced right now.' : 'Full motion right now.'}
                    {m.reduce === 'system' ? ' (From your system setting.)' : ''}
                </span>
            </div>

            {/* Animated images */}
            <div className="sd-row a11y-row">
                <span className={`sd-tile${imagesShown === 'never' ? ' sd-tile--dim' : ''}`}><ImageIcon size={16} /></span>
                <div className="sd-rl">
                    <b id="a11y-images-label">Animated images</b>
                    <span>GIFs, animated emoji, and animated profile pictures, server icons and banners. A paused GIF shows its first frame and a play button.</span>
                </div>
            </div>
            <div className="a11y-opts" role="radiogroup" aria-labelledby="a11y-images-label">
                <ClRadioGroup options={IMAGE_OPTIONS} value={imagesShown} onChange={setImageMode} direction="row" gap={18} />
            </div>
            <div className="a11y-foot">
                <span className="a11y-note">
                    {migratedHoverOnly
                        ? 'GIFs only play on hover, as you set before. Emoji, profile pictures and banners are unchanged until you choose here.'
                        : 'Profile pictures and banners already play only on hover, while someone speaks, or in an opened profile.'}
                </span>
            </div>

            {/* Celebrations and effects */}
            <div className="sd-row a11y-row">
                <span className={`sd-tile${m.effects ? '' : ' sd-tile--dim'}`}><PartyPopper size={16} /></span>
                <div className="sd-rl">
                    <b>Celebrations and effects</b>
                    <span>Confetti, the Pro welcome card, gift unwrapping, high-fives, first-friend and level-up moments, and the mascot’s idle animations. When off, each one still happens, as a still picture with no movement.</span>
                </div>
                <div className="sd-rc">
                    <ClToggle checked={m.effects} onChange={setEffectsEnabled} aria-label="Celebrations and effects" />
                </div>
            </div>
            <div className="sd-row">
                <span className={`sd-tile${ambient && m.effects ? '' : ' sd-tile--dim'}`}><Sparkles size={16} /></span>
                <div className="sd-rl">
                    <b>Home ambience</b>
                    <span>Bioluminescent motes rise through the home screen and behind Settings, and small things breathe. Purely decorative.</span>
                </div>
                <div className="sd-rc">
                    <ClToggle checked={ambient} onChange={setAmbient} disabled={!m.effects} aria-label="Home ambience" />
                </div>
            </div>
            <div className="sd-row">
                <span className={`sd-tile${seasonal && m.effects ? '' : ' sd-tile--dim'}`}><Snowflake size={16} /></span>
                <div className="sd-rl">
                    <b>Marine snow</b>
                    <span>Through December and the first week of January, the detritus that always drifts down here becomes visible. No effect the rest of the year.</span>
                </div>
                <div className="sd-rc">
                    <ClToggle checked={seasonal} onChange={setSeasonal} disabled={!m.effects} aria-label="Marine snow" />
                </div>
            </div>
            <div className="a11y-foot">
                <span className="a11y-note">Some GIFs from other people flash. “Only on hover or focus” or “Never” keeps them still until you choose to play one. Automatic flash detection is planned.</span>
            </div>
        </div>
    );
};
