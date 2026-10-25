import React from 'react';
import type { PublicProfile } from '../../utils/profileCache';
import { ProfileIntegrationsPanels } from '../integrations/ProfileIntegrationsPanels';
import { hasIntegrationPanels } from '../../hooks/useIntegrations';

/**
 * SEAM (INTEGRATION_SLOTS.md): the integration panels at the END of the full
 * profile's Integrations tab - the Steam showcase (level, library, last two
 * weeks) and the Spotify showcase. Owned by the integrations work
 * (components/integrations/ProfileIntegrationsPanels.tsx). Draws nothing when
 * there is nothing to show.
 *
 * Render plain blocks; the tab supplies the spacing (16px gap) and the scroll.
 * Titled cards use `pfp-panel-card` with `<h3 className="pcd-sec-title">`.
 */
export interface ProfileIntegrationsExtrasProps {
    userId: string;
    isSelf: boolean;
    profile: PublicProfile;
    token: string;
}

export const ProfileIntegrationsExtras: React.FC<ProfileIntegrationsExtrasProps> = ({ userId, isSelf, profile, token }) => (
    <ProfileIntegrationsPanels userId={userId} isSelf={isSelf} token={token} steamId={profile.steam?.steam_id ?? null} />
);

/** Whether the tab should show for these panels alone (read by the Integrations tab). */
// eslint-disable-next-line react-refresh/only-export-components -- the seam contract asks for this export next to the component
export const hasIntegrationExtras = (profile: PublicProfile | null | undefined): boolean => hasIntegrationPanels(profile);

export default ProfileIntegrationsExtras;
