import React, { useMemo, useState } from 'react';
import { Server, Archive } from 'lucide-react';
import { PurgeDropdown, PurgeConfirmModal } from './PurgeControls';
import { StorageRow } from './StorageRow';
import { ServerIcon } from './server/ServerIcon';
import { formatBytes } from '../utils/formatBytes';
import {
    aggregateServerStorage, countServerPurge, describePurgeResult, sumServerStorage,
    SERVER_PURGE_WARNING, LEFT_SERVER_PURGE_WARNING,
    type ServerPurgeResult, type ServerStorageRow, type StorageChannel, type StorageServer,
} from '../utils/serverStorage';

export interface ServerStorageData {
    servers: readonly StorageServer[];
    /** serverId -> channels; a server missing here hasn't loaded yet. */
    serverChannels: Readonly<Record<string, readonly StorageChannel[] | undefined>>;
    /** Dashboard's channel history cache, keyed by channel id. */
    channelMessages: Readonly<Record<string, readonly unknown[] | undefined>>;
    /** Channel lists of servers the user has left (from the on-device cache). */
    leftServerChannels?: Readonly<Record<string, readonly StorageChannel[] | undefined>>;
    /** channelId -> message ids a purge must keep (pins, saves, "save forever"). */
    protectedIds?: Readonly<Record<string, readonly string[] | undefined>>;
    /** Message ids saved forever account-wide (retention policy), kept in every channel. */
    protectedMessageIds?: readonly string[];
    protectedAttachmentIds?: readonly string[];
    token?: string | null;
    /** The server list is still being fetched. */
    loading?: boolean;
    /** The server list failed to load. */
    error?: boolean;
    /**
     * Purge LOCAL history of these channels (older than the window; 0 = all).
     * Must never ask the server to delete anything for anyone else.
     * `member` is false for a Left server / unmatched threads, whose saved set
     * can no longer be read from the server.
     */
    onPurge: (channelIds: string[], olderThanMs: number, opts: { member: boolean }) => Promise<ServerPurgeResult>;
}

const SECTION_TITLE_STYLE = { color: 'var(--cl-text)', fontFamily: 'var(--cl-font-display)', fontWeight: 500, margin: 0 } as const;

function subtitleFor(row: ServerStorageRow): string | undefined {
    if (row.kind === 'joined') {
        if (!row.channelsKnown) return undefined;
        const n = row.channelIds.length;
        return `${n} ${n === 1 ? 'channel' : 'channels'}`;
    }
    if (row.kind === 'left') {
        if (!row.channelNames.length) return undefined;
        const shown = row.channelNames.slice(0, 3).map(n => `#${n}`).join(', ');
        const more = row.channelNames.length - 3;
        return more > 0 ? `${shown} +${more}` : shown;
    }
    return 'Not part of any server you are in';
}

export const ServerStorageSection: React.FC<{ data: ServerStorageData }> = ({ data }) => {
    const {
        servers, serverChannels, channelMessages, leftServerChannels, protectedIds,
        protectedMessageIds, protectedAttachmentIds, token = null, loading = false, error = false, onPurge,
    } = data;

    const rows = useMemo(() => aggregateServerStorage({
        servers, serverChannels, channelMessages, leftServerChannels,
        // Only trust "this thread belongs to no server we're in" once the list is final.
        serverListComplete: !loading && !error,
    }), [servers, serverChannels, channelMessages, leftServerChannels, loading, error]);

    const totals = useMemo(() => sumServerStorage(rows), [rows]);
    const maxBytes = rows.reduce((m, r) => Math.max(m, r.totalBytes), 0) || 1;
    const protectedMsg = useMemo(() => new Set(protectedMessageIds ?? []), [protectedMessageIds]);
    const protectedAtt = useMemo(() => new Set(protectedAttachmentIds ?? []), [protectedAttachmentIds]);

    const [busyKey, setBusyKey] = useState<string | null>(null);
    const [status, setStatus] = useState<Record<string, { tone: 'ok' | 'warn'; text: string }>>({});
    const [pending, setPending] = useState<{ row: ServerStorageRow; label: string; ms: number; count: number } | null>(null);

    const planInput = (row: ServerStorageRow, ms: number) => ({
        channelMessages,
        channelIds: row.channelIds,
        olderThanMs: ms,
        protectedIdsFor: (cid: string) => {
            const ids = protectedIds?.[cid];
            if (!ids || !ids.length) return protectedMsg.size ? protectedMsg : undefined;
            const all = new Set(ids);
            for (const id of protectedMsg) all.add(id);
            return all;
        },
        protectedAttachmentIds: protectedAtt,
    });

    const commit = async (row: ServerStorageRow, ms: number) => {
        setBusyKey(row.rowKey);
        setStatus(s => { const rest = { ...s }; delete rest[row.rowKey]; return rest; });
        try {
            const result = await onPurge(row.channelIds, ms, { member: row.kind === 'joined' });
            setStatus(s => ({ ...s, [row.rowKey]: describePurgeResult(result) }));
        } catch {
            setStatus(s => ({ ...s, [row.rowKey]: { tone: 'warn', text: 'Something went wrong; nothing may have been removed. Try again.' } }));
        } finally {
            setBusyKey(null);
        }
    };

    return (
        <div className="sd-card" data-testid="server-storage">
            <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-3">
                    <Server className="w-5 h-5" style={{ color: 'var(--cl-lume)' }} />
                    <h3 className="text-base" style={SECTION_TITLE_STYLE}>Server storage</h3>
                </div>
                {rows.length > 0 && (
                    <span className="text-[11px]" style={{ color: 'var(--cl-faint)' }}>
                        {formatBytes(totals.totalBytes)} · {totals.messageCount.toLocaleString()} msgs
                    </span>
                )}
            </div>
            <p className="text-xs mb-4" style={{ color: 'var(--cl-faint)' }}>
                Channel history cached on this device. Purging a server clears this device only; it never deletes
                anything for other members, and pinned or saved messages are kept.
            </p>

            {rows.length === 0 ? (
                <div role="status" className="text-xs italic py-4 text-center rounded-lg" style={{ color: 'var(--cl-faint)', background: 'rgba(0,0,0,.2)', border: '1px solid var(--cl-border)' }}>
                    {loading
                        ? 'Loading your servers…'
                        : error
                            ? 'Couldn’t load your servers. Reopen Settings to try again.'
                            : 'You aren’t in any servers.'}
                </div>
            ) : (
                <div className="flex flex-col gap-3">
                    {rows.map(row => {
                        const known = row.channelsKnown;
                        const busy = busyKey === row.rowKey;
                        return (
                            <StorageRow
                                key={row.rowKey}
                                title={row.name}
                                badge={row.kind === 'left' ? 'Left' : undefined}
                                subtitle={subtitleFor(row)}
                                lead={row.kind === 'joined' && row.serverId ? (
                                    <ServerIcon
                                        serverId={row.serverId}
                                        name={row.name}
                                        attachmentId={servers.find(s => s.server_id === row.serverId)?.icon_attachment ?? null}
                                        keyB64={servers.find(s => s.server_id === row.serverId)?.icon_key_b64 ?? null}
                                        nonceB64={servers.find(s => s.server_id === row.serverId)?.icon_nonce_b64 ?? null}
                                        token={token}
                                        className="w-8 h-8 rounded-lg text-[11px] shrink-0 overflow-hidden"
                                    />
                                ) : (
                                    <span className="w-8 h-8 rounded-lg shrink-0 flex items-center justify-center" style={{ background: 'rgba(255,255,255,.05)', color: 'var(--cl-faint)' }}>
                                        <Archive className="w-4 h-4" aria-hidden="true" />
                                    </span>
                                )}
                                sizeLabel={known ? formatBytes(row.totalBytes) : 'Loading…'}
                                barPct={known ? Math.round((row.totalBytes / maxBytes) * 100) : 0}
                                countLabel={known ? `${row.messageCount.toLocaleString()} msgs` : ''}
                                attachmentCount={row.attachmentCount}
                                status={status[row.rowKey] ?? null}
                                purge={
                                    <PurgeDropdown
                                        disabled={!known || row.messageCount === 0 || busy}
                                        countFor={ms => countServerPurge(planInput(row, ms))}
                                        onSelect={(ms, label) => setPending({
                                            row, label, ms,
                                            count: countServerPurge(planInput(row, ms)),
                                        })}
                                    />
                                }
                            />
                        );
                    })}
                </div>
            )}

            {pending && (
                <PurgeConfirmModal
                    count={pending.count}
                    label={pending.label}
                    convTitle={pending.row.name}
                    warning={pending.row.kind === 'joined' ? SERVER_PURGE_WARNING : LEFT_SERVER_PURGE_WARNING}
                    onCancel={() => setPending(null)}
                    onConfirm={() => {
                        const { row, ms } = pending;
                        setPending(null);
                        void commit(row, ms);
                    }}
                />
            )}
        </div>
    );
};
