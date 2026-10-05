/**
 * BackupSection — unified encrypted backup UI (Settings → Storage).
 *
 * One passphrase, one schedule, two destinations (local folder + Google Drive).
 * Everything is encrypted on-device before it's written anywhere; nothing
 * backup-related touches the Cipherline server.
 */
import { trackActivity } from '../utils/freezeLog';
import React, { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
    Lock, Download, Upload, AlertTriangle, ShieldCheck,
    FolderOpen, Loader2, Clock, Image as ImageIcon, Folder, Info,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import {
    runBackup, restoreFromDrive, restoreFromLocalFile, getCachedPassword, setCachedPassword,
    getLastBackupAt, getDriveBackupInfo, getDestinationStamps, backupFileName, DEFAULT_MAX_ATTACHMENT_BYTES,
    type DriveBackupProgress, type DestinationLabel, type DestinationStamp, type BackupStaleWarning,
} from '../services/driveBackup';
import { readBackupCfg, writeBackupCfg, type BackupCfg } from '../hooks/useBackupAutoSchedule';
import { DriveFolderPicker } from './DriveFolderPicker';
import { ClToggle, ClButton, ClInput, ClSelect, ClModal } from './cl';
import type { ClSelectOption } from './cl';

// Module-level cache — persists across BackupSection remounts within the same
// Electron session. Reset only on explicit disconnect / reconnect.
let _linkedCache: { linked: boolean; email?: string } = { linked: false };
let _linkedCacheLoaded = false;
let _hostnameCache = '';

function sanitizeHostname(h: string): string {
    return h.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase().replace(/-+/g, '-').replace(/^-|-$/, '');
}
function defaultFileBase(hostname: string): string {
    const safe = sanitizeHostname(hostname);
    return safe ? `cipherline-backup-${safe}` : 'cipherline-backup';
}

/* ── Google "G" mark ─────────────────────────────────────────────────────── */
const GoogleMark: React.FC<{ size?: number }> = ({ size = 15 }) => (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
        <path fill="#4285F4" d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z" />
        <path fill="#34A853" d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z" />
        <path fill="#FBBC05" d="M11.69 28.18c-.44-1.32-.69-2.73-.69-4.18s.25-2.86.69-4.18v-5.7H4.34A21.98 21.98 0 0 0 2 24c0 3.55.85 6.91 2.34 9.88l7.35-5.7z" />
        <path fill="#EA4335" d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7z" />
    </svg>
);

const reveal = {
    initial: { height: 0, opacity: 0 },
    animate: { height: 'auto' as const, opacity: 1 },
    exit: { height: 0, opacity: 0 },
    transition: { duration: 0.22, ease: [0.16, 1, 0.3, 1] as const },
};

type IntervalKey = '6h' | '12h' | '24h' | '3d' | '7d' | '30d';
const INTERVALS: Record<IntervalKey, { label: string; ms: number }> = {
    '6h': { label: 'Every 6 hours', ms: 6 * 3600_000 },
    '12h': { label: 'Every 12 hours', ms: 12 * 3600_000 },
    '24h': { label: 'Every 24 hours', ms: 24 * 3600_000 },
    '3d': { label: 'Every 3 days', ms: 3 * 86400_000 },
    '7d': { label: 'Every 7 days', ms: 7 * 86400_000 },
    '30d': { label: 'Every 30 days', ms: 30 * 86400_000 },
};
const INTERVAL_OPTIONS: ClSelectOption<IntervalKey>[] = (Object.keys(INTERVALS) as IntervalKey[]).map(k => ({
    value: k, label: INTERVALS[k].label,
}));
const msToKey = (ms: number): IntervalKey => {
    const keys = Object.keys(INTERVALS) as IntervalKey[];
    return keys.find(k => ms <= INTERVALS[k].ms) ?? '30d';
};
type AttachmentCapKey = '10m' | '25m' | '100m' | '500m' | 'none';
const ATTACHMENT_CAPS: Record<AttachmentCapKey, { label: string; bytes: number }> = {
    '10m': { label: '10 MB', bytes: 10 * 1024 * 1024 },
    '25m': { label: '25 MB', bytes: 25 * 1024 * 1024 },
    '100m': { label: '100 MB', bytes: 100 * 1024 * 1024 },
    '500m': { label: '500 MB', bytes: 500 * 1024 * 1024 },
    'none': { label: 'No limit', bytes: 0 },
};
const ATTACHMENT_CAP_OPTIONS: ClSelectOption<AttachmentCapKey>[] = (Object.keys(ATTACHMENT_CAPS) as AttachmentCapKey[]).map(k => ({
    value: k, label: ATTACHMENT_CAPS[k].label,
}));
const bytesToCapKey = (bytes: number): AttachmentCapKey => {
    if (bytes <= 0) return 'none';
    const keys = (Object.keys(ATTACHMENT_CAPS) as AttachmentCapKey[]).filter(k => k !== 'none');
    return keys.find(k => bytes <= ATTACHMENT_CAPS[k].bytes) ?? '500m';
};
const fmtTime = (iso: string | null): string => {
    if (!iso) return 'Never';
    try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return 'Unknown'; }
};
const fmtBytes = (n: number): string => {
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
    if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(n >= 100 * 1024 ** 2 ? 0 : 1)} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} KB`;
    return `${n} B`;
};
const PROGRESS_LABEL: Record<string, string> = {
    export: 'Gathering your data…', encrypt: 'Encrypting…', local: 'Writing local copy…',
    upload: 'Uploading to Drive…', verify: 'Verifying…', download: 'Downloading…', decrypt: 'Decrypting…', apply: 'Restoring…',
};

export const BackupSection: React.FC = () => {
    const { user, token } = useAuth();
    const toast = useToast();
    const userId = user?.user_id;

    const [linked, setLinked] = useState<{ linked: boolean; email?: string }>(_linkedCache);
    const [connecting, setConnecting] = useState(false);
    const [password, setPassword] = useState('');
    const [hasSavedPw, setHasSavedPw] = useState(false);
    const [showPw, setShowPw] = useState(false);
    const [cfg, setCfg] = useState<BackupCfg>(() => ({
        enabled: false, intervalMs: 24 * 3600_000, driveIntervalMs: 7 * 86400_000, localEnabled: false, localDir: null,
        driveEnabled: false, driveFolderName: 'Cipherline Backups', driveFolderId: null,
        backupFileBase: 'cipherline-backup',
        includeAttachments: true, maxAttachmentBytes: DEFAULT_MAX_ATTACHMENT_BYTES,
    }));
    const [stamps, setStamps] = useState<Partial<Record<DestinationLabel, DestinationStamp>>>(
        () => (userId ? getDestinationStamps(userId) : {}),
    );
    const [showDrivePicker, setShowDrivePicker] = useState(false);
    const [drivePickerToken, setDrivePickerToken] = useState<string | null>(null);
    const [busy, setBusy] = useState<'backup' | 'restore' | null>(null);
    const [progress, setProgress] = useState<DriveBackupProgress | null>(null);
    const [lastBackup, setLastBackup] = useState<string | null>(null);
    const [confirmRestore, setConfirmRestore] = useState<null | 'drive' | 'local'>(null);
    /**
     * Advisory "this file is older than the last backup this device wrote"
     * prompt. It is NOT a block: the primary button proceeds, one click, and
     * it is deliberately styled like the ordinary restore confirmation rather
     * than like an error — the likely cause is that the user went back to an
     * earlier Drive revision on purpose. It never appears without a recorded
     * floor to compare against (a new device sees nothing at all).
     */
    const [staleAsk, setStaleAsk] = useState<null | { warning: BackupStaleWarning; decide: (ok: boolean) => void }>(null);
    const askAboutStaleBackup = useCallback(
        (warning: BackupStaleWarning) => new Promise<boolean>(resolve => {
            setStaleAsk({ warning, decide: (ok) => { setStaleAsk(null); resolve(ok); } });
        }),
        [],
    );

    useEffect(() => {
        if (!window.electronAPI) return;
        if (!_linkedCacheLoaded) {
            window.electronAPI.gdriveAuthStatus?.().then(s => {
                _linkedCache = s; _linkedCacheLoaded = true; setLinked(s);
            }).catch((err: unknown) => {
                console.error('[BackupSection] gdriveAuthStatus failed:', err);
            });
        }
        if (!_hostnameCache) {
            window.electronAPI.getDeviceName?.().then(h => { _hostnameCache = h || ''; }).catch(() => {});
        }
        getCachedPassword().then(pw => { if (pw) { setPassword(pw); setHasSavedPw(true); } }).catch(() => {});
        if (userId) {
            const c = readBackupCfg(userId);
            if (!c.backupFileBase || c.backupFileBase === 'cipherline-backup') {
                const host = _hostnameCache;
                if (host) {
                    const seeded = { ...c, backupFileBase: defaultFileBase(host) };
                    writeBackupCfg(userId, seeded);
                    setCfg(seeded);
                } else {
                    setCfg(c);
                    window.electronAPI.getDeviceName?.().then(h => {
                        _hostnameCache = h || '';
                        if (h) {
                            const seeded2 = { ...c, backupFileBase: defaultFileBase(h) };
                            writeBackupCfg(userId, seeded2);
                            setCfg(seeded2);
                        }
                    }).catch(() => {});
                }
            } else {
                setCfg(c);
            }
            setLastBackup(getLastBackupAt(userId));
            getDriveBackupInfo(c.driveFolderName, c.driveFolderId, c.backupFileBase).then(info => {
                if (info?.exists && info.modifiedTime) {
                    setLastBackup(prev => prev ?? info.modifiedTime!);
                    // No local record of a Drive backup (fresh install, restored
                    // config) — show what's actually sitting in Drive.
                    setStamps(prev => prev.drive ? prev : { ...prev, drive: { at: info.modifiedTime!, bytes: info.sizeBytes ?? 0 } });
                }
            }).catch(() => {});
        }
    }, [userId]);

    const persist = useCallback((next: Partial<BackupCfg>) => {
        setCfg(prev => { const m = { ...prev, ...next }; if (userId) writeBackupCfg(userId, m); return m; });
    }, [userId]);

    const onConnect = useCallback(async () => {
        if (!window.electronAPI?.gdriveAuthStart) {
            toast.push({ kind: 'error', title: 'Google Drive', message: 'Desktop bridge not loaded. Fully quit and re-run the app.' });
            return;
        }
        setConnecting(true);
        try {
            const info = await window.electronAPI.gdriveAuthStart();
            if (info) {
                const s = { linked: true as const, email: info.email };
                _linkedCache = s; _linkedCacheLoaded = true; setLinked(s);
                persist({ driveEnabled: true });
            }
        } catch (err: any) {
            toast.push({ kind: 'error', title: 'Google Drive', message: err?.message || 'Connection failed or was cancelled.' });
        } finally { setConnecting(false); }
    }, [toast, persist]);

    const onDisconnect = useCallback(async () => {
        await window.electronAPI?.gdriveDisconnect?.().catch(() => {});
        _linkedCache = { linked: false }; _linkedCacheLoaded = true;
        setLinked({ linked: false });
        persist({ driveEnabled: false });
    }, [persist]);

    const onPickDriveFolder = useCallback(async () => {
        try {
            const t = await window.electronAPI?.gdriveGetToken?.();
            if (!t) throw new Error('Google Drive is not connected.');
            setDrivePickerToken(t);
            setShowDrivePicker(true);
        } catch (err: any) {
            toast.push({ kind: 'error', title: 'Folder picker', message: err?.message || 'Could not open the folder picker.' });
        }
    }, [toast]);

    const onPickFolder = useCallback(async () => {
        const r = await window.electronAPI?.showOpenDialog?.({ title: 'Choose backup folder', properties: ['openDirectory', 'createDirectory'] });
        if (r && !r.canceled && r.filePaths[0]) persist({ localDir: r.filePaths[0], localEnabled: true });
    }, [persist]);

    const wantLocal = cfg.localEnabled && !!cfg.localDir;
    const wantDrive = cfg.driveEnabled && linked.linked;
    const destinationsReady = wantLocal || wantDrive;

    const onBackupNow = useCallback(async () => {
        if (!userId || !token) return;
        if (!password) { toast.push({ kind: 'error', title: 'Backup', message: 'Enter a backup passphrase first.' }); return; }
        if (!wantLocal && !wantDrive) { toast.push({ kind: 'error', title: 'Backup', message: 'Pick a local folder and/or connect Google Drive.' }); return; }
        setBusy('backup'); setProgress(null);
        try {
            await setCachedPassword(password); setHasSavedPw(true);
            // Labelled for Settings → Advanced → Performance log, like backup:auto.
            const res = await trackActivity('backup:manual', () => runBackup({
                userId, token, password,
                includeAttachments: cfg.includeAttachments, maxAttachmentBytes: cfg.maxAttachmentBytes,
                destinations: { localDir: wantLocal ? cfg.localDir : null, drive: wantDrive, driveFolderName: cfg.driveFolderName, driveFolderId: cfg.driveFolderId, fileName: cfg.backupFileBase },
                onProgress: setProgress,
            }));
            // No timestamp write here — runBackup stamps both keys itself, so
            // every caller (and every future one) is covered by construction.
            setLastBackup(res.at);
            setStamps(getDestinationStamps(userId));
            // The previously-selected Drive folder had gone stale (403/404 —
            // revoked grant, deleted, moved) and this run fell back to the
            // default folder instead of failing. Stop pointing at the dead
            // folder: persist the replacement and say so, distinctly from the
            // normal success toast.
            if (res.driveFolderRecovered) {
                persist({ driveFolderId: res.driveFolderRecovered.folderId, driveFolderName: res.driveFolderRecovered.folderName });
                toast.push({
                    kind: 'warning',
                    title: 'Google Drive folder changed',
                    message: `Your selected Drive folder is no longer accessible — backed up to the default folder ("${res.driveFolderRecovered.folderName}") instead.`,
                });
            }
            // Say what actually happened per destination: an in-place update
            // reports the few bytes appended, a fresh write the whole file.
            const parts: string[] = [];
            if (res.local && !res.local.skipped) {
                parts.push(res.local.mode === 'update'
                    ? `local folder updated in place (+${fmtBytes(res.local.bytesWritten)})`
                    : `local folder written (${fmtBytes(res.local.bytes)})`);
            }
            if (res.drive && !res.drive.skipped) parts.push(`Google Drive uploaded (${fmtBytes(res.drive.bytes)})`);
            const skippedAtt = res.attachments?.attachmentsSkipped ?? 0;
            const attNote = skippedAtt > 0 ? ` ${skippedAtt} file${skippedAtt === 1 ? '' : 's'} over the size limit left out.` : '';

            // Each destination is reported on its own — a Drive failure
            // (auth expired, network down, 403/SCOPE_MISSING) never masks
            // whether the local destination actually ran, and vice versa.
            const failParts: string[] = [];
            if (res.errors?.local) failParts.push(`Local backup failed: ${res.errors.local}`);
            if (res.errors?.drive) failParts.push(`Google Drive backup failed: ${res.errors.drive}`);

            if (failParts.length && parts.length) {
                toast.push({ kind: 'error', title: 'Backup partially failed', message: `${parts.join('; ')}. ${failParts.join(' ')}` });
            } else if (failParts.length) {
                toast.push({ kind: 'error', title: 'Backup failed', message: failParts.join(' ') });
            } else {
                toast.push(parts.length
                    ? { kind: 'success', title: 'Backed up', message: `${res.fileName}: ${parts.join('; ')}.${attNote}` }
                    : { kind: 'success', title: 'Already up to date', message: 'Nothing changed since your last backup.' });
            }
        } catch (err: any) {
            toast.push({ kind: 'error', title: 'Backup failed', message: err?.message || 'Unknown error.' });
        } finally { setBusy(null); setProgress(null); }
    }, [userId, token, password, cfg, wantLocal, wantDrive, toast, persist]);

    /**
     * Turning automatic backups on has to cache the passphrase, otherwise the
     * scheduler bails on `!password` at every tick and never runs — which is
     * exactly what happened to anyone who configured backups and enabled the
     * schedule without ever pressing "Back up now" (the only thing that used
     * to call setCachedPassword). Refuse to enable rather than pretend to.
     */
    const handleToggleAuto = useCallback(async (next: boolean) => {
        if (!next) { persist({ enabled: false }); return; }
        if (!password) {
            toast.push({
                kind: 'error',
                title: 'Automatic backups',
                message: 'Enter a backup passphrase first — scheduled backups need it to encrypt.',
            });
            return;
        }
        try {
            await setCachedPassword(password);
            setHasSavedPw(true);
        } catch {
            toast.push({ kind: 'error', title: 'Automatic backups', message: "Couldn't save the passphrase securely." });
            return;
        }
        persist({ enabled: true });
    }, [password, persist, toast]);

    const doRestore = useCallback(async (source: 'drive' | 'local') => {
        if (!userId) return;
        if (!password) { toast.push({ kind: 'error', title: 'Restore', message: 'Enter your backup passphrase.' }); return; }
        setConfirmRestore(null); setBusy('restore'); setProgress(null);
        try {
            let applied = true;
            if (source === 'drive') {
                const res = await restoreFromDrive({ userId, password, folderName: cfg.driveFolderName, folderId: cfg.driveFolderId, fileBase: cfg.backupFileBase, onProgress: setProgress, onStaleBackup: askAboutStaleBackup });
                // Same stale-folder recovery as backing up: the stored folder
                // ID no longer worked, so this restored from the default
                // folder instead — stop pointing at the dead one.
                if (res.folderRecovered) {
                    persist({ driveFolderId: res.folderRecovered.folderId, driveFolderName: res.folderRecovered.folderName });
                }
                applied = res.restored;
            } else {
                const r = await window.electronAPI?.showOpenDialog?.({ title: 'Choose backup file', filters: [{ name: 'Cipherline backup', extensions: ['enc'] }], properties: ['openFile'] });
                if (!r || r.canceled || !r.filePaths[0]) { setBusy(null); return; }
                // Read by path: the main process serves the file by range, so a
                // large backup isn't pulled into memory just to check the index.
                const res = await restoreFromLocalFile({ userId, filePath: r.filePaths[0], password, onProgress: setProgress, onStaleBackup: askAboutStaleBackup });
                applied = res.restored;
            }
            // The user looked at the "older than the last one" prompt and
            // backed out. Nothing was written; that's a normal outcome, not a
            // failure, so it gets no error toast and no reload.
            if (!applied) { setBusy(null); setProgress(null); return; }
            toast.push({ kind: 'success', title: 'Restored', message: 'Backup applied — reloading…' });
            setTimeout(() => window.location.reload(), 1400);
        } catch (err: any) {
            toast.push({ kind: 'error', title: 'Restore failed', message: err?.message || 'Wrong passphrase or no backup found.' });
        } finally { setBusy(null); setProgress(null); }
    }, [userId, password, cfg.driveFolderName, cfg.driveFolderId, cfg.backupFileBase, toast, persist, askAboutStaleBackup]);

    const progressLabel = progress
        ? progress.transfer && progress.transfer.total > 0
            ? `${PROGRESS_LABEL[progress.phase] ?? ''} ${Math.min(100, Math.round(progress.transfer.done / progress.transfer.total * 100))}%`
            : PROGRESS_LABEL[progress.phase]
        : null;

    return (
        <div className="sd-card overflow-hidden" style={{ padding: 0 }}>
            {/* Header */}
            <div className="flex items-start gap-3.5 p-5 pb-4">
                <span className="sd-tile"><ShieldCheck size={17} /></span>
                <div className="min-w-0">
                    <h3 className="text-[16px] leading-tight" style={{ color: 'var(--cl-text)', fontFamily: 'var(--cl-font-display)', fontWeight: 500, margin: 0 }}>Encrypted backup</h3>
                    <p className="text-[12.5px] leading-relaxed mt-1" style={{ color: 'var(--cl-faint)' }}>
                        Encrypted on this device with your passphrase, then saved where you choose.
                        Nothing is stored on Cipherline's servers. Forget the passphrase and it's unrecoverable.
                    </p>
                </div>
            </div>

            <div className="px-5 pb-5 space-y-4">
                {/* Passphrase */}
                <div>
                    <label className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cl-faint)' }}>Passphrase</label>
                    <div className="relative mt-1.5">
                        <span className="absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none z-10" style={{ color: 'var(--cl-faint)' }}>
                            <Lock size={15} />
                        </span>
                        <ClInput
                            type={showPw ? 'text' : 'password'}
                            value={password}
                            onChange={e => setPassword(e.target.value)}
                            placeholder={hasSavedPw ? '•••••••••••• (saved on this device)' : 'Choose a strong passphrase'}
                            style={{ paddingLeft: 40, paddingRight: 56, width: '100%' }}
                        />
                        <ClButton
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setShowPw(s => !s)}
                            style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', zIndex: 1 }}
                        >
                            {showPw ? 'Hide' : 'Show'}
                        </ClButton>
                    </div>
                </div>

                {/* Filename */}
                <div>
                    <label className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cl-faint)' }}>Filename</label>
                    <div className="mt-1.5 space-y-1.5">
                        <ClInput
                            type="text"
                            value={cfg.backupFileBase}
                            onChange={e => persist({ backupFileBase: e.target.value })}
                            placeholder="cipherline-backup"
                            style={{ width: '100%' }}
                        />
                        <p className="text-[11px]" style={{ color: 'var(--cl-faint)' }}>
                            One file, kept up to date: <span className="font-mono" style={{ color: 'var(--cl-muted)' }}>{backupFileName(cfg.backupFileBase)}</span>
                        </p>
                    </div>
                </div>

                {/* Destinations */}
                <div className="space-y-2.5">
                    <label className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--cl-faint)' }}>Back up to</label>

                    {/* Local folder */}
                    <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--cl-border)', background: 'rgba(0,0,0,.15)' }}>
                        <div className="flex items-center gap-3 p-3.5">
                            <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'rgba(255,255,255,.05)' }}>
                                <Folder size={15} style={{ color: 'var(--cl-muted)' }} />
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="text-[13.5px] font-medium" style={{ color: 'var(--cl-text)' }}>Local folder</div>
                                <div className="text-[11.5px]" style={{ color: 'var(--cl-faint)' }}>One encrypted file, updated in place — only what changed is written</div>
                            </div>
                            <ClToggle checked={cfg.localEnabled} onChange={v => persist({ localEnabled: v })} />
                        </div>
                        <AnimatePresence initial={false}>
                            {cfg.localEnabled && (
                                <motion.div {...reveal} className="overflow-hidden">
                                    <div className="px-3.5 pb-3.5 flex items-center gap-2">
                                        <div className="flex-1 text-[12px] truncate rounded-lg px-3 py-2" style={{ color: 'var(--cl-muted)', background: 'rgba(0,0,0,.25)', border: '1px solid var(--cl-border)' }}>
                                            {cfg.localDir || <span style={{ fontStyle: 'italic', color: 'var(--cl-faint)' }}>No folder selected</span>}
                                        </div>
                                        <ClButton size="sm" variant="ghost" onClick={onPickFolder}>
                                            <FolderOpen size={13} /> Choose
                                        </ClButton>
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>

                    {/* Google Drive */}
                    <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--cl-border)', background: 'rgba(0,0,0,.15)' }}>
                        <div className="flex items-center gap-3 p-3.5">
                            <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'rgba(255,255,255,.05)' }}>
                                <GoogleMark size={15} />
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="text-[13.5px] font-medium" style={{ color: 'var(--cl-text)' }}>Google Drive</div>
                                <div className="text-[11.5px] truncate" style={{ color: 'var(--cl-faint)' }}>
                                    {linked.linked ? `${linked.email} · one file; Drive keeps earlier versions ~30 days` : "Encrypted before upload — Google can't read it"}
                                </div>
                                {/* In-product privacy notice (Google API user-data policy):
                                    what connecting grants, in one breath. */}
                                {!linked.linked && (
                                    <div className="text-[11px] mt-1 leading-snug" style={{ color: 'var(--cl-faint)', whiteSpace: 'normal' }}>
                                        Connecting creates a “Cipherline Backups” folder in your Drive; the app only ever
                                        reads files it created there. Your Google account stays on this device — never on our servers.
                                    </div>
                                )}
                            </div>
                            {linked.linked
                                ? <ClToggle checked={cfg.driveEnabled} onChange={v => persist({ driveEnabled: v })} />
                                : (
                                    /* Kit ghost button; the colored G sits on a white disc per
                                       Google's dark-theme branding (never a white button face —
                                       and never a background on the .clb wrapper, which paints
                                       OUTSIDE the kit cap and reads as a broken white box). */
                                    <ClButton
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        onClick={onConnect}
                                        disabled={connecting}
                                        loading={connecting}
                                        style={{ flexShrink: 0 }}
                                    >
                                        {!connecting && (
                                            <span
                                                className="inline-flex items-center justify-center rounded-full shrink-0"
                                                style={{ width: 18, height: 18, background: '#fff' }}
                                            >
                                                <GoogleMark size={11} />
                                            </span>
                                        )}
                                        {connecting ? 'Connecting…' : 'Connect'}
                                    </ClButton>
                                )}
                        </div>
                        <AnimatePresence initial={false}>
                            {linked.linked && cfg.driveEnabled && (
                                <motion.div {...reveal} className="overflow-hidden">
                                    <div className="px-3.5 pb-3.5 space-y-2.5">
                                        <div>
                                            <label className="text-[11px]" style={{ color: 'var(--cl-faint)' }}>Backup folder</label>
                                            <div className="flex items-center gap-2 mt-1">
                                                <div className="flex-1 flex items-center gap-1.5 text-[12.5px] truncate rounded-lg px-3 py-2" style={{ color: 'var(--cl-muted)', background: 'rgba(0,0,0,.25)', border: '1px solid var(--cl-border)' }}>
                                                    <Folder size={13} style={{ color: 'var(--cl-faint)', flexShrink: 0 }} />
                                                    <span className="truncate">{cfg.driveFolderName || 'Cipherline Backups'}</span>
                                                    {!cfg.driveFolderId && <span className="text-[10px] shrink-0" style={{ color: 'var(--cl-faint)' }}>(default)</span>}
                                                </div>
                                                <ClButton size="sm" variant="ghost" onClick={onPickDriveFolder}>
                                                    <FolderOpen size={13} /> Choose…
                                                </ClButton>
                                            </div>
                                            <p className="text-[10.5px] mt-1" style={{ color: 'var(--cl-faint)' }}>
                                                Browse your Drive and pick any folder, or create a new one.
                                            </p>
                                        </div>
                                        <div className="flex items-start gap-2 rounded-lg px-3 py-2" style={{ background: 'rgba(255,255,255,.04)', border: '1px solid var(--cl-border)' }}>
                                            <Info size={13} className="shrink-0 mt-0.5" style={{ color: 'var(--cl-lume)' }} />
                                            <p className="text-[11px] leading-relaxed" style={{ color: 'var(--cl-faint)' }}>
                                                Drive can't update part of a file, so every backup uploads the whole file again
                                                {stamps.drive?.bytes ? <> (last upload <span style={{ color: 'var(--cl-muted)' }}>{fmtBytes(stamps.drive.bytes)}</span>)</> : null}.
                                                Nothing is uploaded when nothing has changed. If it's large, give Drive its own, less frequent schedule below.
                                            </p>
                                        </div>
                                        <ClButton variant="ghost" size="sm" onClick={onDisconnect}>
                                            Disconnect Google Drive
                                        </ClButton>
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                </div>

                {/* Include attachments + per-file size limit */}
                <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--cl-border)', background: 'rgba(0,0,0,.1)' }}>
                    <div className="flex items-center gap-3 px-3.5 py-3">
                        <ImageIcon size={15} style={{ color: 'var(--cl-faint)', flexShrink: 0 }} />
                        <span className="text-[13px] flex-1" style={{ color: 'var(--cl-muted)' }}>Include images &amp; files</span>
                        <ClToggle checked={cfg.includeAttachments} onChange={v => persist({ includeAttachments: v })} />
                    </div>
                    <AnimatePresence initial={false}>
                        {cfg.includeAttachments && (
                            <motion.div {...reveal} className="overflow-hidden">
                                <div className="px-3.5 pb-3.5 flex items-center gap-3">
                                    <span className="text-[12px] flex-1" style={{ color: 'var(--cl-faint)' }}>Skip files larger than</span>
                                    <ClSelect<AttachmentCapKey>
                                        value={bytesToCapKey(cfg.maxAttachmentBytes)}
                                        onChange={k => persist({ maxAttachmentBytes: ATTACHMENT_CAPS[k].bytes })}
                                        options={ATTACHMENT_CAP_OPTIONS}
                                        style={{ width: 160 }}
                                    />
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>

                {/* Actions */}
                <div className="flex flex-wrap items-center gap-2.5">
                    <ClButton
                        onClick={onBackupNow}
                        disabled={busy !== null || !destinationsReady}
                        loading={busy === 'backup'}
                    >
                        <Upload size={15} />
                        {busy === 'backup' ? (progressLabel || 'Backing up…') : 'Back up now'}
                    </ClButton>
                    {linked.linked && (
                        <ClButton variant="ghost" onClick={() => setConfirmRestore('drive')} disabled={busy !== null}>
                            <Download size={14} /> Restore from Drive
                        </ClButton>
                    )}
                    <ClButton variant="ghost" onClick={() => setConfirmRestore('local')} disabled={busy !== null}>
                        <FolderOpen size={14} /> Restore from file
                    </ClButton>
                </div>

                {/* Progress / attachments */}
                <AnimatePresence>
                    {busy && progress?.attachments && (
                        <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="text-[11.5px] flex items-center gap-1.5" style={{ color: 'var(--cl-lume)', opacity: .8 }}>
                            <Loader2 size={12} className="animate-spin" /> Bundling attachments {progress.attachments.done}/{progress.attachments.total}
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* Schedule */}
                <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--cl-border)', background: 'rgba(0,0,0,.15)' }}>
                    <div className="flex items-center gap-3 p-3.5">
                        <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'rgba(255,255,255,.05)' }}>
                            <Clock size={15} style={{ color: 'var(--cl-muted)' }} />
                        </div>
                        <div className="flex-1 min-w-0">
                            <div className="text-[13.5px] font-medium" style={{ color: 'var(--cl-text)' }}>Automatic backups</div>
                            <div className="text-[11.5px]" style={{ color: 'var(--cl-faint)' }}>Last backup: {fmtTime(lastBackup)}</div>
                        </div>
                        <ClToggle checked={cfg.enabled} onChange={v => handleToggleAuto(v)} />
                    </div>
                    <AnimatePresence initial={false}>
                        {cfg.enabled && (
                            <motion.div {...reveal} className="overflow-hidden">
                                <div className="px-3.5 pb-3.5 space-y-2.5">
                                    {wantLocal && (
                                        <div>
                                            <div className="flex items-center justify-between mb-1">
                                                <label className="text-[11px] flex items-center gap-1.5" style={{ color: 'var(--cl-faint)' }}><Folder size={11} /> Local folder</label>
                                                <span className="text-[10.5px]" style={{ color: 'var(--cl-faint)' }}>
                                                    Last: {fmtTime(stamps.local?.at ?? null)}{stamps.local?.bytes ? ` · ${fmtBytes(stamps.local.bytes)}` : ''}
                                                </span>
                                            </div>
                                            <ClSelect<IntervalKey>
                                                value={msToKey(cfg.intervalMs)}
                                                onChange={k => persist({ intervalMs: INTERVALS[k].ms })}
                                                options={INTERVAL_OPTIONS}
                                                style={{ width: '100%' }}
                                            />
                                        </div>
                                    )}
                                    {wantDrive && (
                                        <div>
                                            <div className="flex items-center justify-between mb-1">
                                                <label className="text-[11px] flex items-center gap-1.5" style={{ color: 'var(--cl-faint)' }}><GoogleMark size={11} /> Google Drive</label>
                                                <span className="text-[10.5px]" style={{ color: 'var(--cl-faint)' }}>
                                                    Last: {fmtTime(stamps.drive?.at ?? null)}{stamps.drive?.bytes ? ` · ${fmtBytes(stamps.drive.bytes)}` : ''}
                                                </span>
                                            </div>
                                            <ClSelect<IntervalKey>
                                                value={msToKey(cfg.driveIntervalMs)}
                                                onChange={k => persist({ driveIntervalMs: INTERVALS[k].ms })}
                                                options={INTERVAL_OPTIONS}
                                                style={{ width: '100%' }}
                                            />
                                            <p className="text-[10.5px] mt-1" style={{ color: 'var(--cl-faint)' }}>Uploads the whole file each time — weekly is a sensible default for large backups.</p>
                                        </div>
                                    )}
                                    {!destinationsReady && (
                                        <div className="flex items-center gap-1.5 text-[11.5px]" style={{ color: 'var(--cl-glow)' }}>
                                            <AlertTriangle size={12} /> Pick a destination above for scheduled backups to run.
                                        </div>
                                    )}
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            </div>

            {/* Drive folder picker */}
            {showDrivePicker && drivePickerToken && (
                <DriveFolderPicker
                    token={drivePickerToken}
                    onSelect={folder => {
                        persist({ driveFolderId: folder.id, driveFolderName: folder.name });
                        setShowDrivePicker(false);
                        setDrivePickerToken(null);
                    }}
                    onClose={() => { setShowDrivePicker(false); setDrivePickerToken(null); }}
                />
            )}

            {/* Restore confirm */}
            <ClModal open={!!confirmRestore} onClose={() => setConfirmRestore(null)} width={380}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                    <div style={{ width: 36, height: 36, borderRadius: 12, background: 'rgba(245,158,11,.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <AlertTriangle size={17} style={{ color: 'var(--cl-glow)' }} />
                    </div>
                    <h4 style={{ margin: 0 }}>Restore backup?</h4>
                </div>
                <p style={{ fontSize: 13, color: 'var(--cl-muted)', lineHeight: 1.6, marginBottom: 20 }}>
                    This overwrites this device's messages and settings with the {confirmRestore === 'drive' ? 'Google Drive' : 'selected file'} backup, then reloads.
                </p>
                <div className="mrow">
                    <ClButton variant="ghost" size="sm" onClick={() => setConfirmRestore(null)}>Cancel</ClButton>
                    <ClButton size="sm" onClick={() => confirmRestore && doRestore(confirmRestore)}>
                        {confirmRestore === 'drive' ? 'Restore from Drive' : 'Choose file & restore'}
                    </ClButton>
                </div>
            </ClModal>

            {/* Advisory: the file is older than the last backup this device
                wrote here. Info-styled, primary action proceeds. Closing it
                any other way (backdrop, Esc) is a decline, which leaves the
                device untouched — never a silent restore. */}
            <ClModal open={!!staleAsk} onClose={() => staleAsk?.decide(false)} width={400}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                    <div style={{ width: 36, height: 36, borderRadius: 12, background: 'rgba(56,189,248,.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <Clock size={17} style={{ color: 'var(--cl-glow)' }} />
                    </div>
                    <h4 style={{ margin: 0 }}>{staleAsk?.warning.title}</h4>
                </div>
                <p style={{ fontSize: 13, color: 'var(--cl-muted)', lineHeight: 1.6, marginBottom: 20 }}>
                    {staleAsk?.warning.message}
                </p>
                <div className="mrow">
                    <ClButton variant="ghost" size="sm" onClick={() => staleAsk?.decide(false)}>Cancel</ClButton>
                    <ClButton size="sm" onClick={() => staleAsk?.decide(true)}>Restore anyway</ClButton>
                </div>
            </ClModal>
        </div>
    );
};
