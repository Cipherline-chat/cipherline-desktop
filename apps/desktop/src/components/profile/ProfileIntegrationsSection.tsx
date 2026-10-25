import React from 'react';
import { BadgeCheck, Link2, Plus } from 'lucide-react';
import { ProfileLinkIcon } from '../ProfileLinkIcon';
import { isLinkPlatform, platformLabel } from '../../utils/profileLinks';
import { openExternalLink } from '../../utils/openExternalLink';
import { requestOpenSettings } from '../../utils/openSettingsRequest';
import type { ProfileConnection } from './integrationTypes';

/**
 * The full profile's Integrations tab: one card per connected account
 * (hooks/useProfileConnections.ts), then `children` (ProfileIntegrationsExtras).
 * See INTEGRATION_SLOTS.md.
 */

/** Where "Connect accounts" goes on your own profile. The integrations work points this at its pane. */
export const CONNECT_ACCOUNTS_PANE = 'connections' as const;

const label = (p: string) => (isLinkPlatform(p) ? platformLabel(p) : p.charAt(0).toUpperCase() + p.slice(1));

export const ProfileIntegrationsSection: React.FC<{
    connections: readonly ProfileConnection[];
    isSelf: boolean;
    /** Close the profile before Settings opens over it. */
    onBeforeOpenSettings?: () => void;
    children?: React.ReactNode;
}> = ({ connections, isSelf, onBeforeOpenSettings, children }) => (
    <div className="pfi" data-testid="profile-integrations">
        {connections.length > 0 ? (
            <ul className="pfi-grid">
                {connections.map((c) => {
                    const head = (
                        <>
                            <span className="pfi-ico" data-platform={c.platform}>
                                {isLinkPlatform(c.platform) ? <ProfileLinkIcon platform={c.platform} size={18} /> : <Link2 size={18} aria-hidden="true" />}
                            </span>
                            <span className="pfi-txt">
                                <b>{c.name}</b>
                                <span>
                                    {label(c.platform)}
                                    {c.verified && <><BadgeCheck size={12} strokeWidth={2.5} aria-hidden="true" /> Verified</>}
                                </span>
                            </span>
                        </>
                    );
                    return (
                        <li key={`${c.platform}:${c.name}`} className="pfi-card">
                            {c.url ? (
                                <button type="button" className="pfi-head" onClick={(e) => { e.stopPropagation(); openExternalLink(c.url!); }}
                                    aria-label={`${c.name} on ${label(c.platform)}${c.verified ? ', verified' : ''}. Opens in your browser.`}>
                                    {head}
                                </button>
                            ) : <div className="pfi-head">{head}</div>}
                            {c.body && <div className="pfi-body">{c.body}</div>}
                        </li>
                    );
                })}
            </ul>
        ) : (
            <p className="pfp-empty">{isSelf ? 'You have not connected any accounts yet.' : 'No connected accounts to show.'}</p>
        )}
        {children}
        {isSelf && (
            <button type="button" className="pfp-ghost" onClick={(e) => { e.stopPropagation(); onBeforeOpenSettings?.(); requestOpenSettings(CONNECT_ACCOUNTS_PANE); }}>
                <Plus size={14} aria-hidden="true" /> Connect accounts
            </button>
        )}
    </div>
);

export default ProfileIntegrationsSection;
