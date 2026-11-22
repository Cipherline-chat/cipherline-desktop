/**
 * The post-import popup (owner decision 3; plan B8, D19): "Server save
 * messages you don't want deleted". Imported messages are ordinary messages,
 * so they go 30 days after the import (files after 14) unless saved.
 *
 * Per channel, "Save all" is offered ONLY when that channel fits in the
 * server's remaining storage (D19): the button is disabled otherwise and says
 * why. Saving uses the import's bulk save (one quota transaction per 500).
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Archive, CheckCircle2, Hash, RefreshCw } from 'lucide-react';
import { ClButton } from '../../cl';
import { DialogHeader, DialogBody, DialogFooter } from '../../dialog/DialogFrame';
import { DialogStack, DialogNote } from '../../dialog/DialogExtras';
import { BusyLabel } from '../../dialog/BusyLabel';
import { sizeLabel } from '../../../utils/discordImport/history/convert';
import type { ChannelReport } from '../../../utils/discordImport/history/runner';
import type { ImportStorage } from '../../../utils/discordImport/history/host';

export interface KeepChannel { channelId: string; name: string; rows: ChannelReport['savable'] }

export interface ImportKeepStepProps {
    channels: KeepChannel[];
    loadStorage(): Promise<ImportStorage>;
    /** Save these rows (≤500 per call is the caller's job). Resolves to how many were saved and how many did not fit. */
    saveAll(channelId: string, rows: ChannelReport['savable']): Promise<{ saved: number; noRoom: number }>;
    onDone(): void;
}

type ChanState = { status: 'idle' } | { status: 'saving' } | { status: 'saved'; saved: number; noRoom: number } | { status: 'error'; message: string };

export const ImportKeepStep: React.FC<ImportKeepStepProps> = ({ channels, loadStorage, saveAll, onDone }) => {
    const [storage, setStorage] = useState<ImportStorage | null>(null);
    const [storageError, setStorageError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [state, setState] = useState<Record<string, ChanState>>({});

    const refresh = useCallback(async () => {
        setLoading(true); setStorageError(null);
        try { setStorage(await loadStorage()); } catch { setStorageError('Couldn’t load this server’s storage. Check your connection and try again.'); }
        finally { setLoading(false); }
    }, [loadStorage]);
    useEffect(() => { void refresh(); }, [refresh]);

    const free = storage ? Math.max(0, storage.limit_bytes - storage.used_bytes) : 0;
    const busy = Object.values(state).some(s => s.status === 'saving');
    const withRows = channels.filter(c => c.rows.length > 0);

    const save = async (c: KeepChannel) => {
        if (busy) return;
        setState(s => ({ ...s, [c.channelId]: { status: 'saving' } }));
        try {
            const r = await saveAll(c.channelId, c.rows);
            setState(s => ({ ...s, [c.channelId]: { status: 'saved', ...r } }));
        } catch {
            setState(s => ({ ...s, [c.channelId]: { status: 'error', message: 'Couldn’t save. Try again.' } }));
        }
        void refresh();
    };

    return (
        <>
            <DialogHeader icon={<Archive size={18} strokeWidth={2.2} />} title="Server save messages you don’t want deleted" subtitle="Imported messages are normal messages" />
            <DialogBody className="dlg-body--scroll">
                <DialogStack>
                    <div className="text-[13px] leading-[1.55] text-cl-muted" data-testid="keep-copy">
                        Imported messages delete 30 days after the import (files after 14 days) unless they are saved to the server.
                        Pinned messages were saved for you. To keep anything else, hover a message, open <b className="text-cl-text">⋯</b> and
                        choose <b className="text-cl-text">Save to server</b>.
                    </div>
                    <div role="status" aria-live="polite" className="text-[12.5px] text-cl-faint" data-testid="keep-storage">
                        {loading && !storage ? 'Checking this server’s storage…'
                            : storage ? <>Saved messages count toward this server’s storage: <b className="text-cl-text">{sizeLabel(storage.used_bytes)} of {sizeLabel(storage.limit_bytes)} used</b>.</>
                            : null}
                    </div>
                    {storageError && (
                        <DialogNote tone="warn" role="alert">
                            {storageError}{' '}
                            <button type="button" className="dlg-linkbtn" onClick={() => { void refresh(); }}>
                                <RefreshCw size={12} aria-hidden="true" /> Try again
                            </button>
                        </DialogNote>
                    )}
                    {withRows.length > 0 && (
                        <ul className="m-0 p-0 list-none flex flex-col gap-1.5" aria-label="Save a whole channel" data-testid="keep-channels">
                            {withRows.map(c => {
                                const size = c.rows.reduce((t, r) => t + r.bytes, 0);
                                const st = state[c.channelId] ?? { status: 'idle' };
                                const fits = !!storage && size <= free;
                                const label = `Save all imported messages in #${c.name}`;
                                return (
                                    <li key={c.channelId} className="flex items-center gap-2 min-w-0 rounded-lg border border-cl-border bg-cl-sink/50 px-2.5 py-2">
                                        <Hash size={14} className="shrink-0 text-cl-faint" aria-hidden="true" />
                                        <div className="min-w-0 flex-1">
                                            <div className="text-[13px] text-cl-text font-semibold truncate">{c.name}</div>
                                            <div className="text-[11.5px] text-cl-faint">
                                                {c.rows.length.toLocaleString()} message{c.rows.length === 1 ? '' : 's'} · about {sizeLabel(size)}
                                                {st.status === 'saved' && <> · <span className="text-cl-ok-text">saved {st.saved.toLocaleString()}{st.noRoom ? `, ${st.noRoom} did not fit` : ''}</span></>}
                                                {st.status === 'error' && <> · <span role="alert" className="text-cl-flash-text">{st.message}</span></>}
                                                {st.status !== 'saved' && storage && !fits && <> · not enough storage left</>}
                                            </div>
                                        </div>
                                        {st.status === 'saved' ? (
                                            <CheckCircle2 size={16} className="shrink-0 text-cl-ok-text" aria-label="Saved" />
                                        ) : (
                                            <ClButton
                                                type="button" size="sm" variant="ghost"
                                                className={st.status === 'saving' ? 'dlg-busy' : undefined}
                                                disabled={!fits || busy}
                                                ariaLabel={!storage ? 'Checking storage…' : fits ? label : `${label} (not enough storage left)`}
                                                onClick={() => { void save(c); }}
                                            >
                                                <BusyLabel busy={st.status === 'saving'}>Save all</BusyLabel>
                                            </ClButton>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </DialogStack>
            </DialogBody>
            <DialogFooter hint={busy ? 'Saving… keep this window open' : 'You can save single messages any time'}>
                <ClButton type="button" size="sm" onClick={onDone} disabled={busy} autoFocus>Done</ClButton>
            </DialogFooter>
        </>
    );
};

export default ImportKeepStep;
