import React, { useCallback, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, Copy, Download, Eye, FileUp, Import, Link2, SearchX, Send, Share2, Users } from 'lucide-react';
import { ClButton, ClInput, ClModal, ClTextarea } from '../../cl';
import { DialogBody, DialogError, DialogFooter, DialogHeader } from '../../dialog/DialogFrame';
import {
    CUSTOM_THEME_ERROR_TEXT, CUSTOM_THEME_SHARE_MAX, deriveCustomTheme, encodeShareCode, parseThemeImport,
    themeFileJson, type CustomThemeDef,
} from '../../../theme/customTheme';
import { buildThemeLink, themeCodeFromLink, themeShareMessage } from '../../../theme/themeLink';
import { useAuth } from '../../../contexts/AuthContext';
import { EncryptedAvatar } from '../../EncryptedAvatar';
import { PeopleListbox, PeopleSearchField, PickerEmptyState } from '../../peoplePicker/PeoplePicker';
import { useThemeShareActions } from '../../themeShare/ThemeShareActionsContext';
import { buildPickerSections, flattenSections, moveHighlight, pickerKeyIntent, toPickerPeople, type PickerPerson } from '../../../utils/peoplePicker';
import { CustomThemePreview } from './CustomThemePreview';
import { startThemePreview } from '../../../theme/engine';
import '../../../styles/custom-themes.css';
import '../../../styles/theme-share.css';
import { copyText } from '../../../utils/clipboard';

/**
 * Share a custom theme — send it to a friend (an E2EE DM holding the theme
 * link), copy the link (`https://cipherline.chat/theme#clth1.…`,
 * theme/themeLink.ts), copy the `clth1.` code, or save a .json file — and
 * import one (paste a code, a link or JSON, or open a file). No upload, no
 * fetch: the link carries the theme in its fragment, which never reaches a
 * server. An import is parsed with exactly the editor's rules
 * (theme/customTheme.ts parseThemeImport: colours only, readability guard)
 * and previewed before anything is saved.
 */

/** Files above this are not themes; never read them. */
const FILE_MAX_BYTES = 16 * 1024;

function safeFileName(name: string): string {
    const base = name.replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'theme';
    return `${base}.cipherline-theme.json`;
}

async function saveJson(name: string, json: string): Promise<'saved' | 'canceled' | 'failed'> {
    const bytes = new TextEncoder().encode(json);
    try {
        if (window.electronAPI?.saveFileAs) {
            const r = await window.electronAPI.saveFileAs({ title: 'Save theme', defaultPath: safeFileName(name), filters: [{ name: 'Cipherline theme', extensions: ['json'] }] }, bytes);
            return r.canceled ? 'canceled' : 'saved';
        }
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = safeFileName(name);
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return 'saved';
    } catch { return 'failed'; }
}

/** Pasted text that is a theme LINK -> its code, so the import box accepts links too. */
function importTextOf(text: string): string {
    const code = themeCodeFromLink(text.trim());
    return code ?? text;
}

export const CustomThemeExportDialog: React.FC<{ def: CustomThemeDef; onClose: () => void }> = ({ def, onClose }) => {
    const code = useMemo(() => encodeShareCode(def), [def]);
    const link = useMemo(() => buildThemeLink(def), [def]);
    const theme = useMemo(() => deriveCustomTheme(def), [def]);
    const share = useThemeShareActions();
    const [step, setStep] = useState<'share' | 'send'>('share');
    const [copied, setCopied] = useState<'link' | 'code' | null>(null);
    const [status, setStatus] = useState('');
    const copy = async (what: 'link' | 'code') => {
        const ok = await copyText(what === 'link' ? link : code);
        setCopied(ok ? what : null);
        setStatus(ok ? '' : `Could not copy. Select the ${what} and copy it yourself.`);
    };
    if (step === 'send') return <ThemeSendStep def={def} onBack={() => setStep('share')} onClose={onClose} />;
    return (
        <ClModal open onClose={onClose} width={560} label={`Share ${def.name}`} cardClassName="dlg-card cts-card">
            <DialogHeader icon={<Share2 size={18} />} title={`Share “${def.name}”`} subtitle="Send it to a friend, or copy a link or code. It holds only a name and colours." />
            <DialogBody>
                <div className="cts-preview"><CustomThemePreview theme={theme} compact /></div>
                {share.available && (
                    <div className="cts-send-cta">
                        <span className="cts-send-cta-ic" aria-hidden="true"><Send size={16} /></span>
                        <span className="cts-send-cta-text">
                            <b>Send to a friend</b>
                            <span>They get a card with this preview in your DM, end-to-end encrypted.</span>
                        </span>
                        <ClButton size="sm" onClick={() => setStep('send')}>Send to a friend</ClButton>
                    </div>
                )}
                <label className="cte-label" htmlFor="cts-link">Theme link</label>
                <div className="cts-row">
                    <input id="cts-link" className="cts-link" value={link} readOnly onFocus={(e) => e.currentTarget.select()} spellCheck={false} aria-describedby="cts-privacy" />
                    <ClButton variant="ghost" size="sm" onClick={() => void copy('link')}>
                        {copied === 'link' ? <><Check size={14} /> Copied</> : <><Link2 size={14} /> Copy link</>}
                    </ClButton>
                </div>
                <p id="cts-privacy" className="cts-privacy">The theme rides in the part after #, which browsers never send to a server. Opened in a browser, the page reads it on that device.</p>
                <label className="cte-label" htmlFor="cts-code">Theme code</label>
                <div className="cts-row">
                    <ClTextarea id="cts-code" className="cts-code" value={code} readOnly rows={2} onFocus={(e) => e.currentTarget.select()} spellCheck={false} />
                    <ClButton variant="ghost" size="sm" onClick={() => void copy('code')}>
                        {copied === 'code' ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy code</>}
                    </ClButton>
                </div>
            </DialogBody>
            <DialogFooter hint={status || (copied ? 'Copied.' : '')}>
                <ClButton variant="ghost" onClick={async () => {
                    const r = await saveJson(def.name, themeFileJson(def));
                    setStatus(r === 'saved' ? 'Saved.' : r === 'failed' ? 'Could not save the file.' : '');
                }}><Download size={14} /> Save as file…</ClButton>
                <ClButton onClick={onClose}>Done</ClButton>
            </DialogFooter>
        </ClModal>
    );
};

/** Longest note sent with a theme (the link goes on its own line after it). */
export const THEME_NOTE_MAX = 300;

/**
 * "Send to a friend": pick ONE friend with the app's people picker (search,
 * keyboard, presence — the same rows as "New message"), add an optional note,
 * send. What goes out is an ordinary E2EE text message: the note, then the
 * theme link. After a send the dialog offers another friend, or Done.
 */
const ThemeSendStep: React.FC<{ def: CustomThemeDef; onBack: () => void; onClose: () => void }> = ({ def, onBack, onClose }) => {
    const share = useThemeShareActions();
    const { token } = useAuth();
    const [search, setSearch] = useState('');
    const [pickedId, setPickedId] = useState<string | null>(null);
    const [highlightRaw, setHighlightedId] = useState<string | null>(null);
    const [scrollSignal, setScrollSignal] = useState(0);
    const [note, setNote] = useState('');
    const [sendingId, setSendingId] = useState<string | null>(null);
    const [error, setError] = useState('');
    const [sentTo, setSentTo] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const uid = useId();
    const listboxId = `${uid}-people`;
    const optionId = useCallback((userId: string) => `${uid}-opt-${userId}`, [uid]);
    const [now] = useState(() => Date.now());

    const rows = useMemo(() => {
        const q = search.trim().toLowerCase();
        return share.friends.filter((f) => f.username.toLowerCase().includes(q));
    }, [share.friends, search]);
    const people = useMemo(() => toPickerPeople({
        rows, conversations: share.conversations, statuses: share.friendStatuses, presence: share.presence, lastActivityAt: share.lastActivityAt,
    }), [rows, share.conversations, share.friendStatuses, share.presence, share.lastActivityAt]);
    const sections = useMemo(() => buildPickerSections(people, search), [people, search]);
    const ordered = useMemo(() => flattenSections(sections), [sections]);
    const orderedIds = useMemo(() => ordered.map((p) => p.user_id), [ordered]);
    const picked = pickedId ? ordered.find((p) => p.user_id === pickedId) ?? null : null;
    const selectedSet = useMemo(() => new Set(picked ? [picked.user_id] : []), [picked]);
    const highlightedId = highlightRaw && orderedIds.includes(highlightRaw) ? highlightRaw : orderedIds[0] ?? null;

    const send = async (who: PickerPerson | null) => {
        if (!who || sendingId) return;
        setSendingId(who.user_id);
        setError('');
        const ok = await share.sendText(who.user_id, themeShareMessage(def, note.slice(0, THEME_NOTE_MAX)));
        setSendingId(null);
        if (ok) { setSentTo(who.username); setPickedId(null); setNote(''); }
        else setError(`Couldn't send to ${who.username}. Check your connection and try again.`);
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        const intent = pickerKeyIntent(
            { key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing },
            { query: search, selectionCount: 0, multiSelect: false },
        );
        if (!intent) return;
        if (intent.type === 'move') {
            e.preventDefault();
            setHighlightedId(moveHighlight(orderedIds, highlightedId, intent.delta));
            setScrollSignal((n) => n + 1);
        } else if (intent.type === 'first' || intent.type === 'last') {
            e.preventDefault();
            setHighlightedId(intent.type === 'first' ? orderedIds[0] ?? null : orderedIds[orderedIds.length - 1] ?? null);
            setScrollSignal((n) => n + 1);
        } else if (intent.type === 'open') {
            // Enter picks the highlighted friend (sending needs the explicit Send).
            e.preventDefault();
            if (highlightedId) setPickedId(highlightedId);
        }
    };

    let placeholder: React.ReactNode = null;
    if (share.friends.length === 0) {
        placeholder = <PickerEmptyState icon={<Users size={24} />} title="No friends yet" body="Themes go to friends in your DMs. Add a friend first, or copy the link instead." />;
    } else if (ordered.length === 0) {
        placeholder = <PickerEmptyState icon={<SearchX size={24} />} title={<>No friends match “{search.trim()}”</>} body="Check the spelling, or copy the link instead." />;
    }
    const activeDescendant = !placeholder && highlightedId ? optionId(highlightedId) : undefined;

    return (
        <ClModal open onClose={onClose} width={520} label={`Send ${def.name} to a friend`} cardClassName="dlg-card cts-card">
            <DialogHeader icon={<Send size={18} />} title={`Send “${def.name}” to a friend`} subtitle="They get a card with a preview in your DM. End-to-end encrypted, like every message." />
            <DialogBody>
                {sentTo ? (
                    <div className="cts-sent" role="status"><Check size={18} strokeWidth={3} />Sent to {sentTo}. They can preview it and save it from your DM.</div>
                ) : (
                    <>
                        <PeopleSearchField
                            ref={inputRef}
                            autoFocus
                            query={search}
                            onQueryChange={setSearch}
                            onKeyDown={onKeyDown}
                            placeholder="Search friends"
                            ariaLabel="Search friends"
                            listboxId={listboxId}
                            activeDescendant={activeDescendant}
                            disabled={!!sendingId}
                        />
                        <PeopleListbox
                            id={listboxId}
                            label="Friends"
                            sections={sections}
                            highlightedId={highlightedId}
                            scrollSignal={scrollSignal}
                            selectedIds={selectedSet}
                            multiSelect={false}
                            optionId={optionId}
                            renderAvatar={(p) => <EncryptedAvatar attachmentId={p.avatar_url ?? null} userId={p.user_id} token={token} className="w-full h-full" fallbackSize={17} disableClickProfile />}
                            onHighlight={setHighlightedId}
                            onRowClick={(p) => { setError(''); setHighlightedId(p.user_id); setPickedId((prev) => (prev === p.user_id ? null : p.user_id)); }}
                            onRowAction={(p) => void send(p)}
                            rowActionLabel={() => 'Send'}
                            showRowAction={!picked}
                            busyId={sendingId}
                            disabled={!!sendingId}
                            now={now}
                            placeholder={placeholder}
                        />
                        <label className="cte-label cts-note-label" htmlFor="cts-note">Add a note (optional)</label>
                        <ClInput id="cts-note" value={note} maxLength={THEME_NOTE_MAX} onChange={(e) => setNote(e.target.value)} placeholder={`Try my ${def.base} theme`} disabled={!!sendingId} />
                    </>
                )}
            </DialogBody>
            {error && <DialogError>{error}</DialogError>}
            <DialogFooter hint={sentTo ? '' : picked ? `To ${picked.username}` : 'Pick a friend'}>
                {sentTo ? (
                    <>
                        <ClButton variant="ghost" onClick={() => setSentTo(null)}>Send to someone else</ClButton>
                        <ClButton onClick={onClose}>Done</ClButton>
                    </>
                ) : (
                    <>
                        <ClButton variant="ghost" onClick={onBack} disabled={!!sendingId}><ArrowLeft size={14} /> Back</ClButton>
                        <ClButton onClick={() => void send(picked)} disabled={!picked} loading={!!sendingId}><Send size={14} /> Send</ClButton>
                    </>
                )}
            </DialogFooter>
        </ClModal>
    );
};

export const CustomThemeImportDialog: React.FC<{
    onClose: () => void;
    /** Save the imported theme; `use` = also apply it. Return false when the library refused. */
    onImport: (def: CustomThemeDef, use: boolean) => boolean;
    /** Pre-filled text (a theme link's code, tests / harness). */
    initialText?: string;
    /** Opened from a theme link (chat card, deep link): no paste box, a larger preview, this title. */
    fromLink?: { title: string };
}> = ({ onClose, onImport, initialText = '', fromLink }) => {
    // Preview: the theme on the WHOLE app (the top-right bar saves or stops it;
    // nothing is stored). The dialog closes so the app itself is what you see.
    const [text, setText] = useState(initialText);
    const [fileError, setFileError] = useState('');
    const [saveError, setSaveError] = useState('');
    const fileRef = useRef<HTMLInputElement>(null);
    const parsed = useMemo(() => (text.trim() ? parseThemeImport(importTextOf(text)) : null), [text]);
    const theme = useMemo(() => (parsed?.ok ? deriveCustomTheme(parsed.def) : null), [parsed]);

    const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        setFileError('');
        if (!f) return;
        if (f.size > FILE_MAX_BYTES) { setFileError('That file is too large to be a theme.'); return; }
        try { setText(await f.text()); } catch { setFileError('Could not read that file.'); }
    };
    const save = (use: boolean) => {
        if (!parsed?.ok) return;
        if (!onImport(parsed.def, use)) setSaveError('Could not save: your themes are still loading, or you already have 24.');
    };
    const preview = () => {
        if (!parsed?.ok) return;
        startThemePreview(parsed.def);
        onClose();
    };

    return (
        <ClModal open onClose={onClose} width={fromLink ? 680 : 600} label={fromLink?.title ?? 'Import a theme'} cardClassName="dlg-card cts-card">
            <DialogHeader
                icon={<Import size={18} />}
                title={fromLink?.title ?? 'Import a theme'}
                subtitle={fromLink ? 'From a theme link. Preview tries it on the whole app; nothing changes until you save it.' : 'Paste a theme code or link, or open a theme file. You will see it before it is saved.'}
            />
            <DialogBody>
                {!fromLink && (
                    <>
                        <label className="cte-label" htmlFor="cts-paste">Theme code, link or file contents</label>
                        <ClTextarea
                            id="cts-paste"
                            className="cts-code"
                            value={text}
                            maxLength={CUSTOM_THEME_SHARE_MAX * 2}
                            onChange={(e) => { setText(e.target.value); setSaveError(''); }}
                            rows={3}
                            placeholder="clth1.…"
                            spellCheck={false}
                        />
                        <div className="cts-file-row">
                            <ClButton variant="ghost" size="sm" onClick={() => fileRef.current?.click()}><FileUp size={14} /> Open file…</ClButton>
                            <input ref={fileRef} type="file" accept=".json,application/json" hidden tabIndex={-1} onChange={onFile} data-testid="theme-import-file" />
                            <span className="cts-file-note">Only colours and a name are read. Nothing is fetched.</span>
                        </div>
                    </>
                )}
                {fileError && <DialogError>{fileError}</DialogError>}
                {parsed && !parsed.ok && <DialogError>{CUSTOM_THEME_ERROR_TEXT[parsed.error]}</DialogError>}
                {parsed?.ok && theme && (
                    <div className="cts-result" aria-live="polite">
                        <div className="cts-result-head">
                            <b>{parsed.def.name}</b>
                            <span>{parsed.def.base === 'dark' ? 'Dark' : 'Light'} base{parsed.def.glow ? ', glow' : ''}</span>
                        </div>
                        <div className="cts-preview"><CustomThemePreview theme={theme} compact={!fromLink} /></div>
                    </div>
                )}
                {saveError && <DialogError>{saveError}</DialogError>}
            </DialogBody>
            <DialogFooter>
                <ClButton variant="ghost" onClick={onClose}>{fromLink ? 'Close' : 'Cancel'}</ClButton>
                <ClButton variant="ghost" onClick={preview} disabled={!parsed?.ok} tooltip="Try it on the whole app. Nothing is saved."><Eye size={14} /> Preview</ClButton>
                <ClButton variant="ghost" onClick={() => save(false)} disabled={!parsed?.ok}>Save</ClButton>
                <ClButton onClick={() => save(true)} disabled={!parsed?.ok}>Save and use</ClButton>
            </DialogFooter>
        </ClModal>
    );
};
