import React, { useRef } from 'react';
import { ChevronRight } from 'lucide-react';
import { padDiscriminator } from '@cipherline/shared';
import { EncryptedAvatar } from '../EncryptedAvatar';
import type { Mutuals } from '../../hooks/useProfileRelations';

/**
 * The card's tabs (owner request 2026-10-24): the profile itself, then
 * "Mutual friends" and "Mutual servers" - each only when it has someone in it,
 * and only on someone else's card. The server decides who is mutual (people
 * who are friends with BOTH of you; servers you are both in); this only draws
 * the lists. A row opens that person's card / goes to that server.
 *
 * Keyboard: the tabs are a roving tablist (arrows, Home, End); the rows are
 * plain buttons.
 */

export type ProfileTab = 'profile' | 'friends' | 'servers';

export const ProfileTabs: React.FC<{
    idBase: string;
    tab: ProfileTab;
    onTab: (t: ProfileTab) => void;
    friends: number;
    servers: number;
}> = ({ idBase, tab, onTab, friends, servers }) => {
    const tabs: Array<{ id: ProfileTab; label: string; n?: number }> = [
        { id: 'profile', label: 'Profile' },
        ...(friends > 0 ? [{ id: 'friends' as const, label: 'Mutual friends', n: friends }] : []),
        ...(servers > 0 ? [{ id: 'servers' as const, label: 'Mutual servers', n: servers }] : []),
    ];
    const listRef = useRef<HTMLDivElement>(null);
    const onKey = (e: React.KeyboardEvent) => {
        const i = tabs.findIndex((t) => t.id === tab);
        let j = i;
        if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') j = 0;
        else if (e.key === 'End') j = tabs.length - 1;
        else return;
        e.preventDefault();
        onTab(tabs[j].id);
        listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[j]?.focus();
    };
    return (
        <div ref={listRef} className="pcd-tabs" role="tablist" aria-label="Profile sections" onKeyDown={onKey}>
            {tabs.map((t) => (
                <button
                    key={t.id} type="button" role="tab" id={`${idBase}-tab-${t.id}`}
                    aria-selected={tab === t.id} aria-controls={`${idBase}-panel`} tabIndex={tab === t.id ? 0 : -1}
                    className="pcd-tab" data-testid={`profile-tab-${t.id}`}
                    onClick={(e) => { e.stopPropagation(); onTab(t.id); }}
                >
                    {t.label}{t.n !== undefined && <span className="pcd-tab-n">{t.n}</span>}
                </button>
            ))}
        </div>
    );
};

export const MutualsPanel: React.FC<{
    idBase: string;
    kind: 'friends' | 'servers';
    mutuals: Mutuals;
    token: string;
    onOpenUser?: (userId: string, at: { x: number; y: number }) => void;
    onOpenServer?: (serverId: string) => void;
    renderServerIcon?: (serverId: string, name: string) => React.ReactNode;
    /** Inside another tabpanel (the full profile): just the list. */
    embedded?: boolean;
}> = ({ idBase, kind, mutuals, token, onOpenUser, onOpenServer, renderServerIcon, embedded }) => (
    <div className="pcd-mutuals" {...(embedded ? {} : { role: 'tabpanel', id: `${idBase}-panel`, 'aria-labelledby': `${idBase}-tab-${kind}` })} data-testid={`profile-panel-${kind}`}>
        <ul className="pcd-rows">
            {kind === 'friends' ? mutuals.friends.map((f) => (
                <li key={f.user_id}>
                    <button
                        type="button" className="pcd-row" disabled={!onOpenUser}
                        aria-label={`${f.username}: open profile`}
                        onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); onOpenUser?.(f.user_id, { x: r.left + 40, y: r.top + r.height / 2 }); }}
                    >
                        <span className="pcd-row-av">
                            <EncryptedAvatar attachmentId={f.avatar_url} userId={f.user_id} token={token} className="w-full h-full" fallbackSize={16} disableClickProfile bypassFriendGate />
                        </span>
                        <span className="pcd-row-txt">
                            <b>{f.username}</b>
                            {f.discriminator !== null && <span>#{padDiscriminator(f.discriminator)}</span>}
                        </span>
                        <ChevronRight size={15} className="pcd-row-go" aria-hidden="true" />
                    </button>
                </li>
            )) : mutuals.servers.map((sv) => (
                <li key={sv.server_id}>
                    <button
                        type="button" className="pcd-row" disabled={!onOpenServer}
                        aria-label={`${sv.name}: go to server`}
                        onClick={(e) => { e.stopPropagation(); onOpenServer?.(sv.server_id); }}
                    >
                        <span className="pcd-row-av pcd-row-av--server">
                            {renderServerIcon?.(sv.server_id, sv.name) ?? <span className="pcd-row-initial" aria-hidden="true">{sv.name.trim().charAt(0).toUpperCase() || '?'}</span>}
                        </span>
                        <span className="pcd-row-txt"><b>{sv.name}</b></span>
                        <ChevronRight size={15} className="pcd-row-go" aria-hidden="true" />
                    </button>
                </li>
            ))}
        </ul>
    </div>
);
