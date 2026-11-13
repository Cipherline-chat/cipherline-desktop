import React, { useState } from 'react';
import axios from 'axios';
import { ClToggle } from '../../cl';
import { API_BASE } from '../../../constants';
import { useToast } from '../../../contexts/ToastContext';
import { SettingsDisclosure } from '../SettingsDisclosure';
import { SteamConnect } from './SteamConnect';
import { SteamShowcase } from '../../integrations/SteamShowcase';
import { forgetSteamCard, useSteamCard, type SteamCard } from '../../../hooks/useProfileRelations';
import { useMyIntegrations } from '../../../hooks/useIntegrations';
import { patchErrorMessage } from '../../../utils/patchErrorMessage';
// SteamConnect's rows (ps-steam), the settings rows (su-row) and the stats preview (ig-*) live in these sheets.
import '../../../styles/settings-ui.css';
import '../../../styles/profile-settings.css';
import '../../../styles/integrations.css';

/**
 * Settings > Profile > Showcase > Steam: your verified Steam account, the one
 * place it is managed (owner, 2026-10-28: "put the Steam part only under the
 * Profile section"; it used to be the first card of Settings > Connections).
 *
 *  - Connect / unlink: Steam OpenID (SteamConnect / useSteamConnect). You sign
 *    in on Steam's own page; the server checks Steam's answer and records the
 *    SteamID. This client never sends one.
 *  - "Show Steam stats on my profile" (PUT /steam/stats), with a preview of
 *    the showcase it adds, only when the server has STEAM_WEB_API_KEY
 *    (`available.steamData`); otherwise a line saying so. Dormant = not drawn.
 *
 * The card's section list above (ProfileExtrasSection) has a "Steam" row for
 * WHERE it sits on your card; this is WHAT it is.
 */
export const ProfileSteamSection: React.FC<{
    token: string | null;
    userId: string | undefined;
    /** The server says this account has a verified Steam link (`user.steam`). */
    linked: boolean;
    /** Re-read /auth/me (the pane's refreshProfile). */
    onChanged: () => void | Promise<void>;
}> = ({ token, userId, linked, onChanged }) => {
    const steamCard = useSteamCard(linked ? userId ?? null : null, token);
    const mine = useMyIntegrations(linked ? token : null);
    const available = mine.data?.available ?? null;

    return (
        <SettingsDisclosure
            id="profile.steam" variant="card" title="Steam" defaultOpen
            summary={linked ? `Verified${steamCard?.persona_name ? `: ${steamCard.persona_name}` : ''}` : 'Not connected'}
            labels={['Steam account', 'Steam', 'Connect Steam', 'Steam level', 'Recently played', 'Show Steam stats on my profile', 'Steam achievements']}
        >
            <div data-testid="profile-steam">
                <div className="ps-secs-head" style={{ marginTop: 0 }}>
                    <h4 id="ps-steam-h">Steam account</h4>
                    <span className="ps-count">{linked ? 'Verified' : 'Not connected'}</span>
                </div>
                <SteamConnect token={token} userId={userId} linked={linked} card={steamCard} onChanged={onChanged} />
                {linked && available && !available.steamData && (
                    <p className="su-hint" data-testid="steam-stats-unavailable">Steam stats (level, games, hours) are not switched on for this Cipherline server yet. Your verified Steam account still shows.</p>
                )}
                {linked && available?.steamData && userId && (
                    <SteamStatsSection token={token} userId={userId} card={steamCard} />
                )}
            </div>
        </SettingsDisclosure>
    );
};

/** "Show Steam stats on my profile" + the preview. Moved verbatim from the old Connections pane. */
const SteamStatsSection: React.FC<{ token: string | null; userId: string; card: SteamCard | null }> = ({ token, userId, card }) => {
    const toast = useToast();
    const [shown, setShown] = useState<boolean | null>(null);
    const [busy, setBusy] = useState(false);
    const on = shown ?? !(card?.statsHidden ?? false);
    const set = async (v: boolean) => {
        if (!token || busy) return;
        setBusy(true);
        setShown(v);
        try {
            await axios.put(`${API_BASE}/steam/stats`, { show: v }, { headers: { Authorization: `Bearer ${token}` } });
            forgetSteamCard(userId);
        } catch (err) {
            setShown(!v);
            toast.push({ kind: 'error', title: 'Could not save', message: patchErrorMessage(err, 'Try again in a moment.') });
        } finally {
            setBusy(false);
        }
    };
    return (
        <div className="ig-preview">
            <div className="su-row">
                <div className="su-row-text">
                    <span className="su-row-label">Show Steam stats on my profile</span>
                    <span className="su-row-hint">Level, games, hours, most played and recent achievements, to whoever can see your links.</span>
                </div>
                <div className="su-row-ctl">
                    <ClToggle checked={on} disabled={busy || !token} onChange={(v) => void set(v)} aria-label="Show Steam stats on my profile" />
                </div>
            </div>
            {card?.activity ? (
                <div data-state={on ? 'shown' : 'hidden'} className="ig-steam-preview">
                    {!on && <p className="su-hint" style={{ margin: 0 }}>Hidden. Only you can see this preview.</p>}
                    <SteamShowcase activity={card.activity} token={token} isSelf personaName={card.persona_name} avatar={card.avatar} />
                </div>
            ) : (
                <p className="su-hint" style={{ margin: 0 }}>{card ? 'Steam did not answer just now. Your stats show again once it does.' : 'Loading your Steam stats…'}</p>
            )}
        </div>
    );
};

export default ProfileSteamSection;
