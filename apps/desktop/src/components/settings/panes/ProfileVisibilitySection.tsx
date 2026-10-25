import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { ClSelect, ClToggle } from '../../cl';
import { API_BASE } from '../../../constants';
import { useToast } from '../../../contexts/ToastContext';
import { SettingsDisclosure } from '../SettingsDisclosure';
import {
    VISIBILITY_FIELDS, FIELD_LABELS, PRESET_LABELS, resolveVisibility, detectPreset, presetPatch, fieldPatch,
    applyVisibilityPatch, visibleFor,
    type ProfileVisibility, type VisibilityPreset, type VisibilityField, type ViewAs,
} from '../../../utils/profileVisibility';

/**
 * "Who can see this" — one preset dropdown, plus a folded "Customize per field"
 * list of Everyone / Friends toggles. The pane's sticky preview shows the
 * result ("View as" lives above it): this component reports what each audience
 * would be shown through `onView`.
 *
 * The server enforces all of it; this only edits the setting. Each change is
 * saved at once (optimistic, reverted with a toast on failure) instead of
 * riding the profile save bar: a privacy control that silently needs a second
 * click is a privacy control that gets left half-applied.
 *
 * Always public and not listed here: username, #tag, avatar, badges, theme,
 * decoration, effect and the egg showcase. Custom status and the current game keep their existing presence
 * gating and are not part of these settings.
 */

type PresetOrCustom = VisibilityPreset | 'custom';

export interface PreviewVisibility {
    seen: Record<VisibilityField, boolean>;
    friendsOnly: VisibilityField[];
}

export interface ProfileVisibilitySectionProps {
    token: string | null;
    /** The saved setting (/auth/me `profile_visibility`); `undefined` = Public. */
    saved: ProfileVisibility | undefined;
    /** The audience the sticky preview is drawn for. */
    viewAs: ViewAs;
    /** What `viewAs` would be shown, for the preview. */
    onView?: (v: PreviewVisibility) => void;
    /** Called after a successful save so the caller can refresh /auth/me. */
    onSaved: (body: Record<string, unknown>) => void | Promise<void>;
}

export const ProfileVisibilitySection: React.FC<ProfileVisibilitySectionProps> = ({
    token, saved, viewAs, onView, onSaved,
}) => {
    const toast = useToast();
    const [vis, setVis] = useState<ProfileVisibility>(saved ?? {});
    const [busy, setBusy] = useState(false);
    // Follow the server copy when /auth/me refreshes (another device, or our
    // own save): adjust state during render, keyed on the prop's identity.
    const [seenSaved, setSeenSaved] = useState(saved);
    if (saved !== seenSaved) { setSeenSaved(saved); setVis(saved ?? {}); }

    const resolved = resolveVisibility(vis);
    const current: PresetOrCustom = detectPreset(vis);

    useEffect(() => {
        onView?.({
            seen: visibleFor(vis, viewAs),
            friendsOnly: VISIBILITY_FIELDS.filter((f) => resolveVisibility(vis)[f] === 'friends'),
        });
    }, [onView, vis, viewAs]);

    const save = async (patch: ProfileVisibility) => {
        if (!token || busy) return;
        const before = vis;
        setVis(applyVisibilityPatch(before, patch));   // optimistic
        setBusy(true);
        try {
            const body = { profile_visibility: patch };
            await axios.patch(`${API_BASE}/auth/profile`, body, { headers: { Authorization: `Bearer ${token}` } });
            await onSaved(body);
        } catch (err) {
            console.error('Failed to save profile visibility', err);
            setVis(before);
            toast.push({ kind: 'error', title: 'Not saved', message: 'Could not update who can see your profile. Please try again.' });
        } finally {
            setBusy(false);
        }
    };

    const presetOptions: Array<{ value: PresetOrCustom; label: string }> = [
        ...(['public', 'friends_more', 'private'] as const).map((p) => ({ value: p, label: PRESET_LABELS[p].label })),
        // "Custom" is a state, not a choice: it only appears while the field
        // toggles match no preset.
        ...(current === 'custom' ? [{ value: 'custom' as const, label: 'Custom' }] : []),
    ];
    const blurb = current === 'custom'
        ? 'Custom: you have set individual fields. Pick a preset to reset them.'
        : PRESET_LABELS[current].blurb;
    const friendsCount = VISIBILITY_FIELDS.filter((f) => resolved[f] === 'friends').length;

    return (
        <SettingsDisclosure
            id="profile.privacy" variant="card" title="Who can see this"
            summary={current === 'custom' ? 'Custom' : PRESET_LABELS[current].label}
            labels={['Profile visibility', 'Privacy']}
        >
            <div aria-busy={busy}>
                <p className="su-hint" style={{ marginTop: 0 }}>
                    Your username, #tag, avatar, badges, theme, decoration, effect and pinned eggs are always public.
                </p>
                <div className="su-row">
                    <div className="su-row-text">
                        <span className="su-row-label" id="pv-preset-label">Profile visibility</span>
                        <span className="su-row-hint" aria-live="polite">{blurb}</span>
                    </div>
                    <div className="su-row-ctl" style={{ width: 188 }}>
                        <ClSelect
                            ariaLabel="Profile visibility" disabled={busy} value={current} options={presetOptions}
                            onChange={(v) => { if (v !== 'custom') void save(presetPatch(v)); }}
                            style={{ width: '100%' }}
                        />
                    </div>
                </div>

                <SettingsDisclosure
                    id="profile.privacy-fields" title="Customize per field"
                    summary={friendsCount === 0 ? 'Everything is visible to everyone' : `${friendsCount} of ${VISIBILITY_FIELDS.length} friends only`}
                >
                    <div role="group" aria-label="Per-field visibility">
                        {VISIBILITY_FIELDS.map((f) => (
                            <div key={f} className="su-row">
                                <span className="su-row-label" style={{ fontWeight: 600 }}>{FIELD_LABELS[f]}</span>
                                <span className="su-row-ctl text-[12px]" style={{ color: 'var(--cl-muted)' }}>
                                    <span aria-hidden="true">{resolved[f] === 'friends' ? 'Friends' : 'Everyone'}</span>
                                    <ClToggle
                                        checked={resolved[f] === 'friends'}
                                        disabled={busy}
                                        aria-label={`${FIELD_LABELS[f]}: friends only`}
                                        onChange={(on) => void save(fieldPatch(f, on ? 'friends' : 'everyone'))}
                                    />
                                </span>
                            </div>
                        ))}
                        <p className="su-hint">On = friends only. Friends are people you have accepted; blocked people never count.</p>
                    </div>
                </SettingsDisclosure>
            </div>
        </SettingsDisclosure>
    );
};
