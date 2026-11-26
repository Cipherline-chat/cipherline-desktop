import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Copy, Download, ExternalLink, Eye, EyeOff, Hash, KeyRound, MessageSquare, PlayCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { ClButton, ClCheckbox, ClInput, ClRadioGroup } from '../cl';
import { DialogHeader, DialogBody, DialogFooter, DialogError } from '../dialog/DialogFrame';
import { DialogForm, DialogField, DialogStack, DialogNote, DialogSteps } from '../dialog/DialogExtras';
import { BusyLabel } from '../dialog/BusyLabel';
import { ChannelTree } from './DiscordTemplateImport';
import { roleColorCss, rolesForDisplay, sanitizeServerNameInput } from '../../utils/discordTemplate';
import { DEVELOPER_PORTAL_URL, DISCORD_IMPORT_VIDEO_URL, VIDEO_TITLE, botPageUrl, buildInviteUrl, videoUrlToOpen } from '../../utils/discordImport/invite';
import { prepareGuildImage } from '../../utils/discordImport/image';
import { writeToClipboard } from '../../utils/clipboard';
import type { EncryptedUpload, RunnerDeps } from '../../utils/discordImport/runner';
import { HISTORY_WINDOW_SUMMARY } from '../../utils/discordImport/historyWindow';
import {
    ANNOUNCEMENT_TEXT, CONSENT_TEXT, HISTORY_CONSENT_CONTENT, HISTORY_CONSENT_MEMBERS,
    canContinue, guildImportErrorMessage, guildListView, nextGuildPoll, nextStep, prevStep, setupIndex, SETUP_STEPS,
    type GuildListOutcome, type WizardStep,
} from '../../utils/discordImport/steps';
import type { DiscordHistoryHost } from '../../utils/discordImport/history/host';
import { getImportJob, importJobRunning, startCopyJob, startImportJob } from '../../utils/discordImport/backgroundImport';
import { DiscordImportProgressView } from './discordImport/DiscordImportProgressView';
import { CopyMapStep } from './discordImport/CopyMapStep';
import { autoMatch, copyPlan, copyable, mentionRefs, retarget, sourceKeysOf, type CopyRow, type CopyTargetChannel } from '../../utils/discordImport/copyMapping';
import type { ImportChannelMap } from '../../utils/discordImport/history/host';
import type {
    DiscordAppInfo, DiscordGuildListItem, DiscordImportApi, GuildImportRequest, GuildImportResponse, GuildPreview, GuildSnapshot,
} from '../../utils/discordImport/types';
import '../../styles/dialog-server.css';

/**
 * What the host (Dashboard, through useServers) provides: everything that talks
 * to CIPHERLINE. Everything that talks to Discord goes through `api` (the
 * preload bridge into the main process, where the bot token lives).
 */
export interface DiscordGuildImportHost {
    preview(guild: Record<string, unknown>): Promise<GuildPreview>;
    /** Must resolve to the API's WHOLE answer (Dashboard: makeImportGuildHandler). */
    importGuild(req: GuildImportRequest): Promise<GuildImportResponse>;
    listEmojiNames(serverId: string): Promise<string[]>;
    createEmoji(serverId: string, body: { name: string; attachment_id: string; key_b64: string; nonce_b64: string }): Promise<void>;
    upload(blob: Blob, mime: string, opts?: { serverId?: string; signal?: AbortSignal }): Promise<EncryptedUpload>;
    /** Upload a role's icon picture and set it (absent: role icon pictures are reported, not copied). */
    setRoleIcon?(serverId: string, roleId: string, blob: Blob, mime: string, signal?: AbortSignal): Promise<void>;
    /** Create a server sticker from a Discord sticker's bytes (absent: stickers are reported, not copied). */
    createSticker?: RunnerDeps['createSticker'];
}

export interface DiscordGuildImportProps {
    api: DiscordImportApi;
    host: DiscordGuildImportHost;
    onBack: () => void;
    /** "Open server" on the last step: the host navigates and the modal closes. */
    onOpenServer: (serverId: string, serverName: string) => void | Promise<void>;
    /** Close the modal. Once the import runs it keeps going (backgroundImport.ts); absent: Back. */
    onClose?: () => void;
    onOpenExternal: (url: string) => void;
    /** Messages + pins (phase 2). Absent = the structure-only wizard. */
    history?: DiscordHistoryHost;
    /** Test / harness seams. */
    prepareImage?: RunnerDeps['prepareImage'];
    initialStep?: WizardStep;
    /** The "Watch a video" link (DISCORD_IMPORT_VIDEO_URL); hidden while empty or not a YouTube https link. */
    videoUrl?: string;
    /**
     * "Copy messages from Discord" into THIS existing server (owner or IMPORT_HISTORY): no new server, only
     * messages, into the existing text channels the admin maps (needs `history`).
     */
    copyInto?: CopyIntoServer;
}

/** The existing server a copy fills, and its text channels (the targets). */
export interface CopyIntoServer { serverId: string; serverName: string; channels: CopyTargetChannel[] }

/** Discord channel types whose messages come over: text (0) and announcement (5). */
const HISTORY_TYPES = new Set([0, 5]);

/** The snapshot's message channels: number (the snapshot id) and name, in Discord order. */
export function historyChannelsOf(snapshot: GuildSnapshot | null): Array<{ num: number; name: string }> {
    const chans = (snapshot?.body as { channels?: Array<{ id?: unknown; type?: unknown; name?: unknown; position?: unknown }> } | undefined)?.channels ?? [];
    return chans
        .filter(c => typeof c.id === 'number' && typeof c.type === 'number' && HISTORY_TYPES.has(c.type))
        .map(c => ({ num: c.id as number, name: typeof c.name === 'string' ? c.name : 'channel', pos: typeof c.position === 'number' ? c.position : 0 }))
        .sort((a, b) => a.pos - b.pos || a.num - b.num)
        .map(({ num, name }) => ({ num, name }));
}

const Code: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <code className="whitespace-nowrap font-mono text-[11.5px] text-cl-text bg-cl-surface/80 border border-cl-border/60 rounded-md px-1 py-[1px]">{children}</code>
);

const GuideStep: React.FC<{ n: number; title: string; children: React.ReactNode }> = ({ n, title, children }) => (
    <li className="flex gap-2.5 min-w-0">
        <span
            className="shrink-0 w-5 h-5 mt-[1px] rounded-full flex items-center justify-center text-[11px] font-bold"
            style={{ background: 'var(--cl-lume-tint)', color: 'var(--cl-lume-text)' }}
            aria-hidden="true"
        >{n}</span>
        <div className="min-w-0">
            <span className="block text-cl-text font-semibold">{title}</span>
            {children}
        </div>
    </li>
);

type CopyState = 'idle' | 'copied' | 'failed';

/** Shown when the clipboard refused: the text, already selected, so Ctrl+C works. */
const CopyFallback: React.FC<{ text: string; label: string; testId: string }> = ({ text, label, testId }) => {
    const ref = useRef<HTMLTextAreaElement>(null);
    useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
    return (
        <div className="flex flex-col gap-1 min-w-0" role="alert">
            <span className="text-[12px] text-cl-muted">Couldn’t copy automatically. It’s selected below: press Ctrl+C (⌘C on a Mac).</span>
            <textarea
                ref={ref} readOnly value={text} aria-label={label} data-testid={testId} rows={3}
                onFocus={e => e.currentTarget.select()}
                className="w-full resize-none rounded-lg bg-cl-sink/60 border border-cl-border p-2 text-[12px] text-cl-text font-mono"
            />
        </div>
    );
};

/** One privileged intent on the token step: on (tick) or off (what is lost, and how to fix it). */
const IntentRow: React.FC<{ on: boolean; name: string; why: string }> = ({ on, name, why }) => (
    <li className="flex gap-2 items-start min-w-0" data-testid={`intent-${on ? 'on' : 'off'}`}>
        {on
            ? <CheckCircle2 size={15} className="shrink-0 mt-[2px] text-cl-lume" aria-hidden="true" />
            : <AlertTriangle size={15} className="shrink-0 mt-[2px]" style={{ color: 'var(--cl-glow-text, var(--cl-glow))' }} aria-hidden="true" />}
        <span className="min-w-0">
            <b className="text-cl-text">{name}</b>{' '}
            <span className="text-cl-faint">{on ? 'is on' : 'is off'}</span>
            <span className="block text-cl-muted">{why}</span>
        </span>
    </li>
);

const COPY_SUBTITLES: Partial<Record<WizardStep, string>> = {
    preview: 'Choose which channels to fill',
    run: 'Copying messages',
};

const SUBTITLES: Record<WizardStep, string> = {
    token: 'Create a bot on Discord and paste its token',
    guild: 'Add the bot to your server, then pick it',
    preview: 'Review what will be created',
    consent: 'One last check',
    run: 'Building your server',
    done: 'All set',
    keep: 'Imported messages are normal messages',
};

/**
 * "Watch the walkthrough" card (owner 2026-11-22 / 2026-11-26). Our own markup only: no YouTube iframe,
 * thumbnail or request on render. A real button; opens in the system browser via onOpen.
 */
const VideoLink: React.FC<{ href: string | null; onOpen: (url: string) => void }> = ({ href, onOpen }) => href ? (
    <div data-testid="video-link-row">
        <button
            type="button"
            data-testid="video-link"
            onClick={() => onOpen(href)}
            className="w-full min-w-0 flex items-center gap-3 rounded-xl bg-cl-sink/60 border border-cl-border p-3 text-left cursor-pointer transition-colors hover:border-cl-lume focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{ outlineColor: 'var(--cl-lume-text)' }}
        >
            <span className="shrink-0 w-9 h-9 rounded-full flex items-center justify-center" style={{ background: 'var(--cl-lume-tint)', color: 'var(--cl-lume-text)' }}>
                <PlayCircle size={20} aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-semibold text-cl-text">Watch the walkthrough</span>
                <span className="block text-[12px] text-cl-faint truncate">{VIDEO_TITLE}</span>
                <span className="block text-[11.5px] text-cl-faint">Opens in your browser · YouTube</span>
            </span>
            <ExternalLink size={14} className="shrink-0 text-cl-faint" aria-hidden="true" />
        </button>
    </div>
) : null;

export const DiscordGuildImport: React.FC<DiscordGuildImportProps> = ({
    api, host, history, onBack, onOpenServer, onOpenExternal, onClose, prepareImage = prepareGuildImage, initialStep = 'token',
    videoUrl = DISCORD_IMPORT_VIDEO_URL, copyInto,
}) => {
    // An import already running (or finished, not yet dismissed): one at a time, so its progress / report shows.
    const [step, setStep] = useState<WizardStep>(() => (getImportJob() ? 'run' : initialStep));
    const video = useMemo(() => videoUrlToOpen(videoUrl), [videoUrl]);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    // token
    const [token, setToken] = useState('');
    const [showToken, setShowToken] = useState(false);
    const [bot, setBot] = useState<{ id: string; name: string } | null>(null);
    /** The token's application, from main. The invite link is built from its id: nothing is typed. */
    const [app, setApp] = useState<DiscordAppInfo | null>(null);
    const [appChecking, setAppChecking] = useState(false);
    const [storageReady, setStorageReady] = useState(true);
    // guild (invite + pick)
    const [copied, setCopied] = useState<CopyState>('idle');
    const [listErr, setListErr] = useState<{ code: string; message: string } | null>(null);
    const [listing, setListing] = useState(false);
    const [pollStopped, setPollStopped] = useState(false);
    const [pollRun, setPollRun] = useState(0);
    const listingRef = useRef(false);
    const busyRef = useRef(false);
    useEffect(() => { busyRef.current = busy; }, [busy]);
    const [guilds, setGuilds] = useState<DiscordGuildListItem[] | null>(null);
    const [guildId, setGuildId] = useState<string | null>(null);
    // preview
    const [snapshot, setSnapshot] = useState<GuildSnapshot | null>(null);
    const [preview, setPreview] = useState<GuildPreview | null>(null);
    const [name, setName] = useState('');
    const [withImages, setWithImages] = useState(true);
    const [withEmojis, setWithEmojis] = useState(true);
    const [withStickers, setWithStickers] = useState(true);
    const [showNotMapped, setShowNotMapped] = useState(true);
    // consent
    const [consent, setConsent] = useState(false);
    // ── Messages (phase 2) ──
    const [withHistory, setWithHistory] = useState(!!history);
    const [historyPick, setHistoryPick] = useState<Set<number>>(new Set());
    const [consentMembers, setConsentMembers] = useState(false);
    const [consentContent, setConsentContent] = useState(false);
    const [annCopied, setAnnCopied] = useState<CopyState>('idle');
    // ── Copy into an existing server ──
    const copyMode = !!copyInto && !!history;
    const [copyRows, setCopyRows] = useState<CopyRow[] | null>(null);
    const [copyPick, setCopyPick] = useState<Set<number>>(new Set());
    const [copyMap, setCopyMap] = useState<ImportChannelMap | null>(null);
    const [endingActive, setEndingActive] = useState(false);
    const ids = { token: useId(), name: useId(), err: useId(), tokenHelp: useId(), notMapped: useId(), servers: useId() };

    // Built ONLY from the application id main read from the token: it always invites the token's own bot.
    const inviteUrl = useMemo(() => buildInviteUrl(app?.id), [app]);

    /** Re-read the token's application (id for the invite, which intents are on). */
    const checkApp = useCallback(async () => {
        if (!api.checkApp) { setError('Restart Cipherline to finish updating, then try again.'); return; }
        setAppChecking(true); setError(null);
        const r = await api.checkApp();
        setAppChecking(false);
        if (!r.ok) { setError(r.error.message); return; }
        setApp(r.app);
    }, [api]);

    // Is a token already saved on this device? (One saved before the application was recorded is re-read once.)
    useEffect(() => {
        let live = true;
        void api.status().then(r => {
            if (!live || !r.ok) return;
            setStorageReady(r.storageReady);
            if (r.bot) {
                setBot(r.bot);
                if (r.app) setApp(r.app); else void checkApp();
            }
        });
        return () => { live = false; };
    }, [api, checkApp]);

    // Leaving during setup (the modal closing) stops this wizard's Discord requests. Never once an import
    // runs: it is the app's now (backgroundImport.ts), and main's cancel would stop its reads too.
    useEffect(() => () => { if (!importJobRunning()) void api.cancel(); }, [api]);

    const tokenValid = bot !== null && app !== null;
    /** Message Content Intent off = Discord sends messages blank: the message copy is not offered. */
    const contentOk = app?.intents.messageContent !== false;
    const historyChoices = useMemo(() => historyChannelsOf(snapshot), [snapshot]);
    const historyOn = !!history && withHistory && contentOk && historyChoices.length > 0;
    const facts = {
        tokenValid, guildId, previewReady: !!preview && !!snapshot, serverName: name, consent, busy,
        withHistory: historyOn, historyConsent: { members: consentMembers, content: consentContent }, historyChannels: historyPick.size,
    };
    const plan = useMemo(() => copyPlan(copyRows ?? [], copyPick), [copyRows, copyPick]);
    const quotaLeft = copyMap ? copyMap.imports.limit - copyMap.imports.used : null;
    /** The copy's own gates: at least one channel, no two into one, content readable, quota left, all consents. */
    const copyCan = (s: WizardStep): boolean => {
        if (s === 'token' || s === 'guild') return canContinue(s, facts);
        const mapOk = !busy && !!snapshot && copyRows !== null && contentOk && plan.channels.length > 0 && plan.clash.length === 0 && quotaLeft !== 0;
        if (s === 'preview') return mapOk;
        if (s === 'consent') return mapOk && consent && consentMembers && consentContent;
        return false;
    };
    const can = (s: WizardStep): boolean => (copyMode ? copyCan(s) : canContinue(s, facts));

    /** One look at the bot's server list. Never overlaps itself; a failure keeps the list we already have. */
    const loadGuilds = useCallback(async (): Promise<GuildListOutcome> => {
        if (listingRef.current) return { ok: true };
        listingRef.current = true;
        setListing(true);
        try {
            const r = await api.listGuilds();
            if (!r.ok) {
                setListErr({ code: r.error.code, message: r.error.message });
                return { ok: false, code: r.error.code, retryAfterMs: r.error.retryAfterMs };
            }
            setListErr(null);
            setGuilds(r.guilds);
            setGuildId(g => (g && r.guilds.some(x => x.id === g) ? g : r.guilds.length === 1 ? r.guilds[0].id : null));
            return { ok: true };
        } finally {
            listingRef.current = false;
            setListing(false);
        }
    }, [api]);

    // While "add the bot" is open, the list refreshes itself (every 5 s, slower on trouble, never on a dead token,
    // never while a preview is loading), so the server shows up on its own after the user approves the invite.
    useEffect(() => {
        if (step !== 'guild') return;
        let live = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const started = Date.now();
        const tick = async () => {
            const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
            const r: GuildListOutcome = hidden || busyRef.current ? { ok: true } : await loadGuilds();
            if (!live) return;
            const wait = nextGuildPoll(r, Date.now() - started, hidden);
            if (wait === null) { setPollStopped(true); return; }
            timer = setTimeout(() => { void tick(); }, wait);
        };
        void tick();
        return () => { live = false; if (timer) clearTimeout(timer); };
    }, [step, pollRun, loadGuilds]);

    const refreshGuilds = () => {
        if (pollStopped) { setPollStopped(false); setPollRun(n => n + 1); } // restarts the gentle polling too
        else void loadGuilds();
    };

    /**
     * Copy through the app's clipboard path (utils/clipboard: Electron main's clipboard module first). The wizard
     * used to call navigator.clipboard directly, which the app's permission policy refuses
     * (decidePermissionRequest denies 'clipboard-sanitized-write'), and swallowed the error: "nothing happens".
     * On failure the text is shown selected, ready for Ctrl+C.
     */
    const copyText = async (text: string, set: (s: CopyState) => void) => {
        try {
            await writeToClipboard(text);
            set('copied');
            setTimeout(() => set('idle'), 1800);
        } catch {
            set('failed');
        }
    };
    const copyInvite = async () => { if (inviteUrl) await copyText(inviteUrl, setCopied); };

    const submitToken = async () => {
        if (busy || !token.trim()) return;
        setBusy(true); setError(null);
        const r = await api.connect(token);
        setBusy(false);
        setToken('');             // the token leaves this component's memory as soon as main has it
        setShowToken(false);
        if (!r.ok) { setError(r.error.message); return; }
        setBot(r.bot);
        // A new token is a new bot: nothing from a previous one (its id, its servers) may carry over.
        setGuilds(null); setGuildId(null); setListErr(null);
        if (r.app) setApp(r.app); else { setApp(null); void checkApp(); }
    };

    const forgetToken = async () => {
        await api.forget();
        setBot(null); setApp(null); setGuilds(null); setGuildId(null); setListErr(null); setSnapshot(null); setPreview(null); setConsent(false);
        setError(null);
        setStep('token');
    };

    /** Copy mode: read the Discord server, ask the API where its channels already landed, auto-match. */
    const loadCopyMap = async () => {
        if (!guildId || !copyInto || !history) return;
        setBusy(true); setError(null);
        try {
            const snap = await api.snapshot(guildId);
            if (!snap.ok) { setError(snap.error.message); return; }
            const sources = historyChannelsOf(snap.snapshot).map(c => ({ ...c, sourceKey: snap.snapshot.channelKeys?.[c.num] }));
            let map: ImportChannelMap | null = null;
            if (history.channelMap) {
                try { map = await history.channelMap(copyInto.serverId, sourceKeysOf(sources)); }
                catch (err) {
                    const st = (err as { response?: { status?: number } } | null)?.response?.status;
                    if (st !== 404) { setError(guildImportErrorMessage(err)); return; } // 404: an older API, match by name only
                }
            }
            const rows = autoMatch(sources, copyInto.channels, map);
            setSnapshot(snap.snapshot);
            setCopyMap(map);
            setCopyRows(rows);
            setCopyPick(new Set(rows.filter(copyable).map(r => r.source.num)));
            setConsent(false); setConsentMembers(false); setConsentContent(false);
            setStep('preview');
        } catch (err) {
            setError(guildImportErrorMessage(err));
        } finally {
            setBusy(false);
        }
    };

    /** "End it now": this account's own open session in the server (an interrupted import), keeping its rows. */
    const endActiveSession = async () => {
        if (!copyInto || !history?.endActive || endingActive) return;
        setEndingActive(true); setError(null);
        try {
            await history.endActive(copyInto.serverId);
            if (copyMap) setCopyMap({ ...copyMap, active: null });
        } catch (err) {
            setError(guildImportErrorMessage(err));
        } finally {
            setEndingActive(false);
        }
    };

    const loadPreview = async () => {
        if (copyMode) { await loadCopyMap(); return; }
        if (!guildId) return;
        setBusy(true); setError(null);
        try {
            const snap = await api.snapshot(guildId);
            if (!snap.ok) { setError(snap.error.message); return; }
            const p = await host.preview(snap.snapshot.body);
            setSnapshot(snap.snapshot);
            setPreview(p);
            setName(sanitizeServerNameInput(p.blueprint.server.name).slice(0, 50));
            setWithImages(true); setWithEmojis(true); setWithStickers(true); setConsent(false);
            setConsentMembers(false); setConsentContent(false);
            setHistoryPick(new Set(historyChannelsOf(snap.snapshot).map(c => c.num)));
            setStep('preview');
        } catch (err) {
            setError(guildImportErrorMessage(err));
        } finally {
            setBusy(false);
        }
    };

    /** Copy mode: hand the copy to the app as a job (same pill, toast, Stop, Retry, report). */
    const startCopy = () => {
        if (!copyInto || !history || !snapshot || !guildId || !copyRows || !copyCan('consent')) return;
        if (importJobRunning()) { setStep('run'); return; }
        setError(null);
        startCopyJob({
            api, history, guildId, guildName: snapshot.guild.name,
            server: { id: copyInto.serverId, name: copyInto.serverName },
            channels: plan.channels, channelRefs: mentionRefs(copyRows),
        });
        setStep('run');
    };

    /** Hand the import to the app (backgroundImport.ts): closing this modal from here on never stops it. */
    const startRun = () => {
        if (copyMode) { startCopy(); return; }
        if (!snapshot || !preview || !guildId || !canContinue('consent', facts)) return;
        if (importJobRunning()) { setStep('run'); return; } // one at a time: show the running one
        setError(null);
        startImportJob({
            api, host, history, guildId, snapshot, serverName: name.trim(),
            description: preview.blueprint.server.description?.slice(0, 1000) ?? null,
            includeImages: withImages, includeEmojis: withEmojis, includeStickers: withStickers,
            historyChannels: historyOn && history ? historyChoices.filter(c => historyPick.has(c.num)) : [],
            prepareImage,
        });
        setStep('run');
    };

    const goNext = async () => {
        if (!can(step)) return;
        if (step === 'token') { setError(null); setPollStopped(false); setStep('guild'); return; } // the list loads (and keeps refreshing) on its own
        if (step === 'guild') { await loadPreview(); return; }
        if (step === 'consent') { startRun(); return; }
        setError(null);
        setStep(nextStep(step));
    };
    const goBack = () => {
        const p = prevStep(step);
        setError(null);
        if (p) setStep(p); else onBack();
    };

    const header = (
        <DialogHeader icon={<Download size={18} strokeWidth={2.2} />} title={copyMode ? 'Copy messages from Discord' : 'Import from Discord'} subtitle={(copyMode ? COPY_SUBTITLES[step] : undefined) ?? SUBTITLES[step]} />
    );
    const idx = setupIndex(step);
    const hint = idx !== null ? <DialogSteps index={idx} count={SETUP_STEPS.length} /> : undefined;

    // ── Step 1: the bot token (first: everything else is derived from it) ──
    if (step === 'token') {
        const intentsOff = !!app && (!app.intents.messageContent || !app.intents.members);
        return (
            <>
                {header}
                <DialogForm onSubmit={() => { if (tokenValid) void goNext(); else if (!bot) void submitToken(); }}>
                    <DialogBody className="dlg-body--scroll">
                        <DialogStack>
                            {!bot && (
                                <>
                                    <DialogNote tone="info" icon={<ShieldCheck size={15} aria-hidden="true" />}>
                                        Cipherline copies your Discord server through a bot that you create. The bot’s token stays on this
                                        computer and is never sent to Cipherline. Use a bot, never your own Discord login.
                                    </DialogNote>
                                    <VideoLink href={video} onOpen={onOpenExternal} />
                                    <ol className="m-0 p-0 list-none space-y-2.5 text-[12.5px] leading-[1.5] text-cl-muted" aria-label="Get a bot token">
                                        <GuideStep n={1} title="Create the bot">
                                            In the Discord Developer Portal, press <b className="text-cl-text">New Application</b>, name it (for
                                            example <Code>Cipherline Importer</Code>) and press <b className="text-cl-text">Create</b>.
                                            <div className="mt-1.5 flex justify-start" data-testid="portal-link-row">
                                                <button type="button" className="dlg-linkbtn" onClick={() => onOpenExternal(DEVELOPER_PORTAL_URL)}>
                                                    Open the Developer Portal <ExternalLink size={12} aria-hidden="true" />
                                                </button>
                                            </div>
                                        </GuideStep>
                                        <GuideStep n={2} title="Turn on two switches">
                                            Open <b className="text-cl-text">Bot</b> in the left menu. Under <b className="text-cl-text">Privileged Gateway
                                            Intents</b>, turn on <b className="text-cl-text">Server Members Intent</b> (so roles land on the right people)
                                            and <b className="text-cl-text">Message Content Intent</b> (without it Discord sends every message blank).
                                            Press <b className="text-cl-text">Save Changes</b>.
                                        </GuideStep>
                                        <GuideStep n={3} title="Copy the token">
                                            On the same page, press <b className="text-cl-text">Reset Token</b>, confirm, then <b className="text-cl-text">Copy</b>.
                                            Treat it like a password.
                                        </GuideStep>
                                        <GuideStep n={4} title="Paste it here">
                                            The invite link for your server is made from it in the next step.
                                        </GuideStep>
                                    </ol>
                                </>
                            )}
                            {bot ? (
                                <div className="rounded-xl bg-cl-sink/60 border border-cl-border p-3.5 flex items-center gap-3 min-w-0" data-testid="saved-bot">
                                    <KeyRound size={18} className="shrink-0 text-cl-lume" aria-hidden="true" />
                                    <div className="min-w-0 flex-1">
                                        <div className="text-[13.5px] font-bold text-cl-text truncate">{bot.name}</div>
                                        <div className="text-[12px] text-cl-faint">Token saved, encrypted, on this computer only</div>
                                    </div>
                                    <ClButton type="button" size="sm" variant="ghost" onClick={() => { void forgetToken(); }}>Use a different token</ClButton>
                                </div>
                            ) : (
                                <DialogField
                                    label="Bot token"
                                    htmlFor={ids.token}
                                    error={error}
                                    errorId={ids.err}
                                >
                                    <div className="flex gap-2 items-center">
                                        <ClInput
                                            id={ids.token}
                                            autoFocus
                                            type={showToken ? 'text' : 'password'}
                                            value={token}
                                            onChange={e => { setToken(e.target.value); setError(null); }}
                                            placeholder="Paste the token from the Bot page"
                                            maxLength={220}
                                            spellCheck={false}
                                            autoComplete="off"
                                            aria-invalid={!!error}
                                            aria-describedby={error ? ids.err : undefined}
                                            disabled={busy || !storageReady}
                                        />
                                        <ClButton
                                            type="button" size="sm" variant="ghost"
                                            onClick={() => setShowToken(s => !s)}
                                            aria-pressed={showToken}
                                            aria-label={showToken ? 'Hide token' : 'Show token'}
                                        >
                                            {showToken ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
                                        </ClButton>
                                    </div>
                                </DialogField>
                            )}
                            {bot && app && (
                                <section aria-label="Bot settings" className="flex flex-col gap-2" data-testid="intents">
                                    <ul className="m-0 p-0 list-none space-y-2 text-[12.5px] leading-[1.45]">
                                        <IntentRow on={app.intents.members} name="Server Members Intent"
                                            why={app.intents.members ? 'Roles can land on the right people.' : 'Needed to see who has which role. Without it, roles come over but nobody is in them.'} />
                                        <IntentRow on={app.intents.messageContent} name="Message Content Intent"
                                            why={app.intents.messageContent ? 'Messages can come over with their text.' : 'Needed to copy messages: without it Discord sends every message blank, so messages can’t be copied.'} />
                                    </ul>
                                    {intentsOff && (
                                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px]">
                                            <span className="text-cl-muted">Turn it on, press Save Changes, then check again.</span>
                                            <button type="button" className="dlg-linkbtn" onClick={() => onOpenExternal(botPageUrl(app.id))}>
                                                Open the Bot page <ExternalLink size={12} aria-hidden="true" />
                                            </button>
                                            <button type="button" className="dlg-linkbtn" onClick={() => { void checkApp(); }} disabled={appChecking}>
                                                <RefreshCw size={12} aria-hidden="true" /> {appChecking ? 'Checking…' : 'Check again'}
                                            </button>
                                        </div>
                                    )}
                                </section>
                            )}
                            {bot && !app && (
                                <DialogNote tone="warn" icon={<AlertTriangle size={15} aria-hidden="true" />}>
                                    {appChecking ? 'Reading the bot’s settings from Discord…' : 'Couldn’t read the bot’s settings from Discord yet.'}{' '}
                                    {!appChecking && (
                                        <button type="button" className="dlg-linkbtn" onClick={() => { void checkApp(); }}>
                                            <RefreshCw size={12} aria-hidden="true" /> Try again
                                        </button>
                                    )}
                                </DialogNote>
                            )}
                            {!storageReady && (
                                <DialogNote tone="warn" icon={<AlertTriangle size={15} aria-hidden="true" />} role="alert">
                                    Secure storage is locked on this computer, so a token can’t be saved safely. Unlock it and try again.
                                </DialogNote>
                            )}
                            {bot && (
                                <DialogNote id={ids.tokenHelp} tone="info" icon={<ShieldCheck size={15} aria-hidden="true" />}>
                                    The token is checked with Discord from this computer and kept encrypted here. It is never sent to Cipherline.
                                    Reset it in the Developer Portal when you are done.
                                </DialogNote>
                            )}
                        </DialogStack>
                    </DialogBody>
                    {error && bot && <DialogError>{error}</DialogError>}
                    <DialogFooter hint={busy ? 'Checking the token with Discord…' : hint}>
                        <ClButton type="button" variant="ghost" size="sm" onClick={goBack} disabled={busy}>Back</ClButton>
                        {bot ? (
                            <ClButton type="submit" size="sm" disabled={!can('token')}>Continue</ClButton>
                        ) : (
                            <ClButton type="submit" size="sm" disabled={!token.trim() || !storageReady} className={busy ? 'dlg-busy' : undefined}>
                                <BusyLabel busy={busy}>Check token</BusyLabel>
                            </ClButton>
                        )}
                    </DialogFooter>
                </DialogForm>
            </>
        );
    }

    // ── Step 2: add the bot to the server, then pick it ──────────────────
    if (step === 'guild') {
        const view = guildListView(guilds, listErr);
        const botName = bot?.name ?? 'your bot';
        const picked = guilds?.find(g => g.id === guildId) ?? null;
        const openInvite = inviteUrl ? (
            <button type="button" className="dlg-linkbtn" onClick={() => onOpenExternal(inviteUrl)}>
                Open the invite link <ExternalLink size={12} aria-hidden="true" />
            </button>
        ) : null;
        return (
            <>
                {header}
                <DialogForm onSubmit={() => { void goNext(); }}>
                    <DialogBody className="dlg-body--scroll">
                        <DialogStack>
                            <VideoLink href={video} onOpen={onOpenExternal} />
                            <ol className="m-0 p-0 list-none space-y-2.5 text-[12.5px] leading-[1.5] text-cl-muted" aria-label="Add the bot">
                                <GuideStep n={1} title={`Invite ${botName} to your server`}>
                                    Open the link, pick the Discord server you want to copy and press <b className="text-cl-text">Authorize</b>.
                                    {inviteUrl && (
                                        <div className="flex flex-wrap gap-2 mt-1.5" data-testid="invite-box">
                                            <ClButton type="button" size="sm" onClick={() => onOpenExternal(inviteUrl)}>
                                                <ExternalLink size={13} aria-hidden="true" /> Open invite link
                                            </ClButton>
                                            <ClButton type="button" size="sm" variant="ghost" onClick={() => { void copyInvite(); }}>
                                                <Copy size={13} aria-hidden="true" /> {copied === 'copied' ? 'Copied' : 'Copy link'}
                                            </ClButton>
                                            <span className="sr-only" data-testid="invite-url">{inviteUrl}</span>
                                        </div>
                                    )}
                                    {inviteUrl && copied === 'failed' && <div className="mt-1.5"><CopyFallback text={inviteUrl} label="Invite link" testId="invite-fallback" /></div>}
                                </GuideStep>
                                <GuideStep n={2} title="Pick the server below">
                                    It shows up here by itself a few seconds after you approve.
                                </GuideStep>
                            </ol>
                            <DialogNote tone="info" icon={<ShieldCheck size={15} aria-hidden="true" />}>
                                <b>Why Administrator?</b> The import copies everything: every channel (private ones too), roles and each
                                member’s permissions. Discord only shows a bot all of that when it is an Administrator. Cipherline only{' '}
                                <b>reads</b> through it: it never posts, edits, deletes or changes anything on Discord. The token never leaves
                                this computer. When you are done, you can kick the bot and reset its token.
                            </DialogNote>
                            <section aria-labelledby={ids.servers} className="flex flex-col gap-2">
                                <div className="flex items-center gap-3 min-w-0">
                                    <h3 id={ids.servers} className="text-[12.5px] font-semibold text-cl-text m-0 truncate min-w-0 flex-1">
                                        Servers {botName} is in
                                    </h3>
                                    <span className="text-[11.5px] text-cl-faint shrink-0" aria-live="polite" data-testid="poll-status">
                                        {listing ? 'Checking…' : pollStopped ? '' : 'Updates by itself'}
                                    </span>
                                    <button type="button" className="dlg-linkbtn shrink-0" onClick={refreshGuilds} disabled={listing}>
                                        <RefreshCw size={13} aria-hidden="true" /> Refresh
                                    </button>
                                </div>
                                {view.kind === 'loading' && (
                                    <div className="flex flex-col gap-2" aria-hidden="true">
                                        <div className="dlg-skel" style={{ height: 40, width: '100%' }} />
                                        <div className="dlg-skel" style={{ height: 40, width: '100%' }} />
                                    </div>
                                )}
                                {view.kind === 'list' && guilds && (
                                    <ClRadioGroup
                                        value={guildId ?? ''}
                                        onChange={v => { setGuildId(v); setError(null); }}
                                        gap={8}
                                        options={guilds.map(g => ({
                                            value: g.id,
                                            label: (
                                                <span className="flex flex-col min-w-0">
                                                    <span className="text-[13.5px] font-semibold text-cl-text truncate">{g.name}</span>
                                                    {g.admin === false && (
                                                        <span className="text-[11.5px]" style={{ color: 'var(--cl-glow-text, var(--cl-glow))' }}>Added without Administrator: private channels will be missing</span>
                                                    )}
                                                </span>
                                            ),
                                        }))}
                                    />
                                )}
                                {view.kind === 'list' && listErr && (
                                    <div className="text-[11.5px] text-cl-faint" role="status">Couldn’t refresh just now; trying again.</div>
                                )}
                                {view.kind === 'no-servers' && (
                                    <DialogNote tone="warn" icon={<AlertTriangle size={15} aria-hidden="true" />} data-testid="no-servers">
                                        <b>{botName}</b> isn’t in any server yet. Open the invite link above, pick your server and press Authorize;
                                        it appears here within a few seconds. Only servers this exact bot (the one whose token you pasted) has
                                        joined are listed, so if you added a different bot, add this one too. {openInvite}
                                    </DialogNote>
                                )}
                                {view.kind === 'unreachable' && (
                                    <DialogNote tone="warn" icon={<AlertTriangle size={15} aria-hidden="true" />} data-testid="unreachable" role="alert">
                                        <b>Couldn’t reach Discord.</b> {view.message} {pollStopped ? 'Press Refresh to try again.' : 'Trying again shortly.'}
                                    </DialogNote>
                                )}
                                {view.kind === 'token-problem' && (
                                    <DialogNote tone="warn" icon={<AlertTriangle size={15} aria-hidden="true" />} data-testid="token-problem" role="alert">
                                        {view.message}{' '}
                                        <button type="button" className="dlg-linkbtn" onClick={() => { void forgetToken(); }}>Paste a new token</button>
                                    </DialogNote>
                                )}
                                {picked?.admin === false && (
                                    <DialogNote tone="warn" icon={<AlertTriangle size={15} aria-hidden="true" />} data-testid="not-admin">
                                        {botName} is in <b>{picked.name}</b> without Administrator, so it can’t see private channels or their
                                        messages. Open the invite link again, pick the same server and approve it; Discord updates the bot. {openInvite}
                                    </DialogNote>
                                )}
                            </section>
                        </DialogStack>
                    </DialogBody>
                    {error && <DialogError>{error}</DialogError>}
                    <DialogFooter hint={busy ? 'Reading the server…' : hint}>
                        <ClButton type="button" variant="ghost" size="sm" onClick={goBack} disabled={busy}>Back</ClButton>
                        <ClButton type="submit" size="sm" disabled={!can('guild')} className={busy ? 'dlg-busy' : undefined}>
                            <BusyLabel busy={busy}>{copyMode ? 'Choose channels' : 'Preview'}</BusyLabel>
                        </ClButton>
                    </DialogFooter>
                </DialogForm>
            </>
        );
    }

    // ── Copy mode, step 3: which Discord channel fills which existing channel ──
    if (copyMode && step === 'preview' && snapshot && copyRows) {
        return (
            <>
                {header}
                <DialogForm onSubmit={() => { void goNext(); }}>
                    <DialogBody className="dlg-body--scroll">
                        <DialogStack>
                            {!contentOk && (
                                <DialogNote tone="warn" icon={<AlertTriangle size={15} aria-hidden="true" />} data-testid="content-intent-off">
                                    <b>Message Content Intent is off</b>, so Discord would send every message blank. Turn it on in the
                                    bot’s settings, press Save Changes, then check again.{' '}
                                    <button type="button" className="dlg-linkbtn" onClick={() => onOpenExternal(botPageUrl(app?.id))}>
                                        Open the Bot page <ExternalLink size={12} aria-hidden="true" />
                                    </button>{' '}
                                    <button type="button" className="dlg-linkbtn" onClick={() => { void checkApp(); }} disabled={appChecking}>
                                        <RefreshCw size={12} aria-hidden="true" /> {appChecking ? 'Checking…' : 'Check again'}
                                    </button>
                                </DialogNote>
                            )}
                            <CopyMapStep
                                guildName={snapshot.guild.name}
                                serverName={copyInto!.serverName}
                                rows={copyRows}
                                targets={copyInto!.channels}
                                picked={copyPick}
                                map={copyMap}
                                clash={plan.clash}
                                onPick={(num, on) => setCopyPick(prev => { const n = new Set(prev); if (on) n.add(num); else n.delete(num); return n; })}
                                onPickAll={(on) => setCopyPick(on ? new Set(copyRows.filter(copyable).map(r => r.source.num)) : new Set())}
                                onRetarget={(num, t) => {
                                    const next = retarget(copyRows, num, t, copyMap);
                                    setCopyRows(next);
                                    setCopyPick(prev => { const n = new Set(prev); const r = next.find(x => x.source.num === num); if (r && copyable(r)) n.add(num); else n.delete(num); return n; });
                                }}
                                onEndActive={history?.endActive ? () => { void endActiveSession(); } : undefined}
                                endingActive={endingActive}
                            />
                        </DialogStack>
                    </DialogBody>
                    {error && <DialogError>{error}</DialogError>}
                    <DialogFooter hint={hint}>
                        <ClButton type="button" variant="ghost" size="sm" onClick={goBack}>Back</ClButton>
                        <ClButton type="submit" size="sm" disabled={!can('preview')}>Continue</ClButton>
                    </DialogFooter>
                </DialogForm>
            </>
        );
    }

    // ── Copy mode, step 4: consent ──
    if (copyMode && step === 'consent' && snapshot && copyRows) {
        const n = plan.channels.length;
        return (
            <>
                {header}
                <DialogForm onSubmit={() => { void goNext(); }}>
                    <DialogBody className="dlg-body--scroll">
                        <DialogStack>
                            <ul className="m-0 pl-4 text-[13px] leading-[1.55] text-cl-muted space-y-1" aria-label="What will happen" data-testid="copy-consent-list">
                                <li>Recent messages and every pin from <b className="text-cl-text">{n} Discord channel{n === 1 ? '' : 's'}</b> of <b className="text-cl-text">{snapshot.guild.name}</b> are
                                    copied into <b className="text-cl-text">{plan.channels.map(c => `#${copyInto!.channels.find(t => t.channel_id === c.channelId)?.name ?? c.name}`).join(', ')}</b> in <b className="text-cl-text">{copyInto!.serverName}</b>.</li>
                                <li>They appear under each person’s name and picture, encrypted on this computer before they are sent. Nothing in the server is deleted or changed.</li>
                                <li>Your Discord server is <b className="text-cl-text">not changed</b>. The bot only reads.</li>
                                {copyMap && <li>This uses one of the server’s {copyMap.imports.limit} message imports per {copyMap.imports.window_days} days ({copyMap.imports.used} used).</li>}
                            </ul>
                            <ClCheckbox className="text-left" checked={consent} onChange={v => { setConsent(v); setError(null); }} label={CONSENT_TEXT} />
                            <ClCheckbox className="text-left" checked={consentMembers} onChange={v => { setConsentMembers(v); setError(null); }} label={HISTORY_CONSENT_MEMBERS} />
                            <ClCheckbox className="text-left" checked={consentContent} onChange={v => { setConsentContent(v); setError(null); }} label={HISTORY_CONSENT_CONTENT} />
                            <DialogNote tone="info" icon={<ShieldCheck size={15} aria-hidden="true" />}>
                                Only copy a server you run. This is not a way to copy someone else’s community.
                            </DialogNote>
                        </DialogStack>
                    </DialogBody>
                    {error && <DialogError>{error}</DialogError>}
                    <DialogFooter hint={can('consent') ? hint : 'Tick all three boxes to continue'}>
                        <ClButton type="button" variant="ghost" size="sm" onClick={goBack}>Back</ClButton>
                        <ClButton type="submit" size="sm" disabled={!can('consent')}>Copy messages</ClButton>
                    </DialogFooter>
                </DialogForm>
            </>
        );
    }

    // ── Step 4: preview ──────────────────────────────────────────────────
    if (step === 'preview' && preview && snapshot) {
        const bp = preview.blueprint;
        const notMapped = [...snapshot.notMapped, ...bp.skipped];
        return (
            <>
                {header}
                <DialogForm onSubmit={() => { void goNext(); }}>
                    <DialogBody className="dlg-body--scroll">
                        <DialogStack>
                            <DialogField label="New server name" htmlFor={ids.name} aside={`${name.length}/50`}>
                                <ClInput
                                    id={ids.name}
                                    autoComplete="off"
                                    value={name}
                                    onChange={e => setName(sanitizeServerNameInput(e.target.value))}
                                    maxLength={50}
                                />
                            </DialogField>
                            <div className="dlg-help flex flex-wrap gap-x-1 min-w-0" data-testid="preview-counts">
                                <span>From Discord server</span>
                                <span className="text-cl-muted font-semibold truncate min-w-0">{snapshot.guild.name}</span>
                                <span>
                                    · {snapshot.counts.roles} role{snapshot.counts.roles === 1 ? '' : 's'}
                                    {' · '}{snapshot.counts.categories} categor{snapshot.counts.categories === 1 ? 'y' : 'ies'}
                                    {' · '}{snapshot.counts.channels} channel{snapshot.counts.channels === 1 ? '' : 's'}
                                    {' · '}{snapshot.counts.emojis} emoji{snapshot.counts.emojis === 1 ? '' : 's'}
                                </span>
                            </div>
                            <div className="grid gap-3 sm:grid-cols-[1.4fr_1fr]">
                                <section aria-label="Channels" className="rounded-xl bg-cl-sink/60 border border-cl-border p-3 max-h-[200px] overflow-y-auto">
                                    <ChannelTree preview={preview} />
                                </section>
                                <section aria-label="Roles" className="rounded-xl bg-cl-sink/60 border border-cl-border p-3 max-h-[200px] overflow-y-auto">
                                    <h3 className="text-[11px] uppercase tracking-wide text-cl-faint font-semibold m-0 mb-2">Roles</h3>
                                    <ul className="m-0 p-0 list-none space-y-1.5">
                                        {rolesForDisplay(bp).map(r => (
                                            <li key={r.ref} className="flex items-center gap-2 text-[13px] text-cl-text min-w-0">
                                                <span className="w-2.5 h-2.5 rounded-full shrink-0 border border-cl-border" style={{ background: roleColorCss(r.color) ?? 'transparent' }} aria-hidden="true" />
                                                <span className="truncate" style={{ color: roleColorCss(r.color) ?? undefined }}>{r.name}</span>
                                            </li>
                                        ))}
                                        <li className="flex items-center gap-2 text-[13px] text-cl-muted">
                                            <span className="w-2.5 h-2.5 rounded-full shrink-0 border border-cl-border" aria-hidden="true" />
                                            @everyone
                                        </li>
                                    </ul>
                                    <div className="text-[11px] text-cl-faint mt-2 leading-snug">You’re the owner, above every role.</div>
                                </section>
                            </div>
                            {(snapshot.guild.hasIcon || snapshot.guild.hasBanner || snapshot.emojis.length > 0 || (snapshot.stickers?.length ?? 0) > 0) && (
                                <div className="flex flex-col gap-2" role="group" aria-label="Also copy">
                                    {(snapshot.guild.hasIcon || snapshot.guild.hasBanner) && (
                                        <ClCheckbox checked={withImages} onChange={setWithImages}
                                            label={`Copy the server ${snapshot.guild.hasIcon && snapshot.guild.hasBanner ? 'icon and banner' : snapshot.guild.hasIcon ? 'icon' : 'banner'}`} />
                                    )}
                                    {snapshot.emojis.length > 0 && (
                                        <ClCheckbox checked={withEmojis} onChange={setWithEmojis}
                                            label={`Copy ${snapshot.emojis.length} custom emoji${snapshot.emojis.length === 1 ? '' : 's'} (animated ones stay animated when they fit)`} />
                                    )}
                                    {(snapshot.stickers?.length ?? 0) > 0 && (
                                        <ClCheckbox checked={withStickers} onChange={setWithStickers}
                                            label={`Copy ${snapshot.stickers!.length} sticker${snapshot.stickers!.length === 1 ? '' : 's'} as server stickers`} />
                                    )}
                                </div>
                            )}
                            {history && historyChoices.length > 0 && (
                                <section aria-labelledby={`${ids.notMapped}-msgs`} className="rounded-xl border border-cl-border p-3 flex flex-col gap-2" data-testid="history-section">
                                    <h3 id={`${ids.notMapped}-msgs`} className="text-[12px] uppercase tracking-wide text-cl-faint font-semibold m-0 flex items-center gap-1.5">
                                        <MessageSquare size={13} aria-hidden="true" /> Messages
                                    </h3>
                                    {!contentOk && (
                                        <DialogNote tone="warn" icon={<AlertTriangle size={15} aria-hidden="true" />} data-testid="content-intent-off">
                                            <b>Message Content Intent is off</b>, so Discord would send every message blank. Turn it on in the
                                            bot’s settings, press Save Changes, then check again.{' '}
                                            <button type="button" className="dlg-linkbtn" onClick={() => onOpenExternal(botPageUrl(app?.id))}>
                                                Open the Bot page <ExternalLink size={12} aria-hidden="true" />
                                            </button>{' '}
                                            <button type="button" className="dlg-linkbtn" onClick={() => { void checkApp(); }} disabled={appChecking}>
                                                <RefreshCw size={12} aria-hidden="true" /> {appChecking ? 'Checking…' : 'Check again'}
                                            </button>
                                        </DialogNote>
                                    )}
                                    <ClCheckbox checked={withHistory && contentOk} onChange={setWithHistory} disabled={!contentOk} label="Bring over recent messages and every pinned message" />
                                    <div className="dlg-help">
                                        {HISTORY_WINDOW_SUMMARY}{' '}
                                        They arrive as normal messages under each person’s name and picture, so they delete 30 days after the import
                                        (files after 14 days) unless you save them. Pins are saved for you.
                                    </div>
                                    {withHistory && contentOk && (
                                        <fieldset className="m-0 p-0 border-0 flex flex-col gap-1 max-h-[160px] overflow-y-auto" data-testid="history-channels">
                                            <legend className="sr-only">Channels to copy messages from</legend>
                                            <div className="flex items-center gap-3 text-[12px] text-cl-faint mb-0.5">
                                                <span>{historyPick.size} of {historyChoices.length} channels</span>
                                                <button type="button" className="dlg-linkbtn" onClick={() => setHistoryPick(new Set(historyChoices.map(c => c.num)))}>All</button>
                                                <button type="button" className="dlg-linkbtn" onClick={() => setHistoryPick(new Set())}>None</button>
                                            </div>
                                            {historyChoices.map(c => (
                                                <ClCheckbox key={c.num} checked={historyPick.has(c.num)}
                                                    onChange={v => setHistoryPick(prev => { const n = new Set(prev); if (v) n.add(c.num); else n.delete(c.num); return n; })}
                                                    label={<span className="inline-flex items-center gap-1 min-w-0"><Hash size={12} aria-hidden="true" /><span className="truncate">{c.name}</span></span>} />
                                            ))}
                                        </fieldset>
                                    )}
                                </section>
                            )}
                            {bp.warnings.length > 0 && (
                                <ul className="m-0 p-0 list-none flex flex-col gap-2" aria-label="Before you create">
                                    {bp.warnings.map(w => (
                                        <li key={w}><DialogNote tone="warn" icon={<AlertTriangle size={15} aria-hidden="true" />}>{w}</DialogNote></li>
                                    ))}
                                </ul>
                            )}
                            <div>
                                <button type="button" className="dlg-linkbtn" onClick={() => setShowNotMapped(s => !s)} aria-expanded={showNotMapped} aria-controls={ids.notMapped}>
                                    {showNotMapped ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                    What won’t come over ({notMapped.length})
                                </button>
                                {showNotMapped && (
                                    <ul id={ids.notMapped} className="m-0 mt-2 p-0 list-none space-y-1.5 max-h-[180px] overflow-y-auto" data-testid="not-mapped">
                                        {notMapped.map((s, i) => (
                                            <li key={`${s.item}-${i}`} className="text-[12px] leading-snug">
                                                <span className="text-cl-text font-semibold">{s.item}</span>
                                                <span className="text-cl-faint"> — {s.reason}</span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        </DialogStack>
                    </DialogBody>
                    <DialogFooter hint={hint}>
                        <ClButton type="button" variant="ghost" size="sm" onClick={goBack}>Back</ClButton>
                        <ClButton type="submit" size="sm" disabled={!canContinue('preview', facts)}>Continue</ClButton>
                    </DialogFooter>
                </DialogForm>
            </>
        );
    }

    // ── Step 5: consent ──────────────────────────────────────────────────
    if (step === 'consent' && snapshot) {
        return (
            <>
                {header}
                <DialogForm onSubmit={() => { void goNext(); }}>
                    <DialogBody className="dlg-body--scroll">
                        <DialogStack>
                            <ul className="m-0 pl-4 text-[13px] leading-[1.55] text-cl-muted space-y-1" aria-label="What will happen">
                                <li>A <b className="text-cl-text">new Cipherline server</b> called <b className="text-cl-text">{name.trim()}</b> is created, and you own it.</li>
                                <li>Its roles, categories, channels and permissions are copied from <b className="text-cl-text">{snapshot.guild.name}</b>.</li>
                                <li>Your Discord server is <b className="text-cl-text">not changed</b>. The bot only reads.</li>
                                {historyOn ? (
                                    <>
                                        <li>Recent messages and every pin from <b className="text-cl-text">{historyPick.size} channel{historyPick.size === 1 ? '' : 's'}</b> are
                                            copied under each person’s name and picture, encrypted on this computer before they are sent.</li>
                                        <li>Members are not copied. People join with an invite.</li>
                                    </>
                                ) : (
                                    <li>No messages, files or members are copied. People join with an invite.</li>
                                )}
                            </ul>
                            <ClCheckbox className="text-left" checked={consent} onChange={v => { setConsent(v); setError(null); }} label={CONSENT_TEXT} />
                            {historyOn && (
                                <>
                                    <ClCheckbox className="text-left" checked={consentMembers} onChange={v => { setConsentMembers(v); setError(null); }} label={HISTORY_CONSENT_MEMBERS} />
                                    <ClCheckbox className="text-left" checked={consentContent} onChange={v => { setConsentContent(v); setError(null); }} label={HISTORY_CONSENT_CONTENT} />
                                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                                        <button type="button" className="dlg-linkbtn" data-testid="copy-announcement" onClick={() => { void copyText(ANNOUNCEMENT_TEXT, setAnnCopied); }}>
                                            {annCopied === 'copied'
                                                ? <><CheckCircle2 size={12} aria-hidden="true" /> Copied</>
                                                : <><Copy size={12} aria-hidden="true" /> Copy an announcement for your members</>}
                                        </button>
                                        <span className="sr-only" aria-live="polite">{annCopied === 'copied' ? 'Announcement copied' : ''}</span>
                                        <button type="button" className="dlg-linkbtn" onClick={() => onOpenExternal('https://cipherline.chat/terms')}>
                                            Read the Terms <ExternalLink size={12} aria-hidden="true" />
                                        </button>
                                    </div>
                                    {annCopied === 'failed' && <CopyFallback text={ANNOUNCEMENT_TEXT} label="Announcement for your members" testId="announcement-fallback" />}
                                </>
                            )}
                            <DialogNote tone="info" icon={<ShieldCheck size={15} aria-hidden="true" />}>
                                Only copy a server you run. This is not a way to copy someone else’s community.
                            </DialogNote>
                        </DialogStack>
                    </DialogBody>
                    {error && <DialogError>{error}</DialogError>}
                    <DialogFooter hint={canContinue('consent', facts) ? hint : historyOn ? 'Tick all three boxes to continue' : 'Tick the box to continue'}>
                        <ClButton type="button" variant="ghost" size="sm" onClick={goBack}>Back</ClButton>
                        <ClButton type="submit" size="sm" disabled={!canContinue('consent', facts)}>Import server</ClButton>
                    </DialogFooter>
                </DialogForm>
            </>
        );
    }

    // ── After "Import server": the app-level job's progress, report and "server save" popup ──
    if (step === 'run' || step === 'done' || step === 'keep') {
        return (
            <DiscordImportProgressView
                onClose={onClose ?? onBack}
                onOpenServer={onOpenServer}
                onBackToSetup={(msg) => { setError(msg); setStep(snapshot && (preview || copyRows) ? 'consent' : 'token'); }}
            />
        );
    }

    return null;
};

export default DiscordGuildImport;
