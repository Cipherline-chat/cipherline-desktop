import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, X, HardDriveDownload, ShieldCheck, Gift, ChevronRight, Copy, Link2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import { useNotificationPrefs } from '../contexts/NotificationContext';
import { playSound } from '../utils/notificationSounds';
import { API_BASE } from '../constants';
import { secureLocalStore } from '../utils/secureLocalStore';
import { hasBackupSetUp } from '../hooks/useBackupAutoSchedule';
import { writeToClipboard } from '../utils/clipboard';
import { nudges } from '../utils/firstWeekNudgeStore';
import type { PaneId } from './settings/SettingsScreen';
import { Keys } from './mascot/Keys';

/**
 * "Finish setting up" — the dismissible Dashboard checklist for optional
 * post-onboarding tasks: automatic backups, 2FA, and trial-extending referrals.
 *
 * Gating: renders only for genuinely-onboarded accounts (the wizard sets
 * `cipherline_onboarded_v2_${userId}=1`) that haven't dismissed it.
 *
 * State is re-checked every time the parent settings modal closes (via
 * `refreshSignal`), so checkmarks update as soon as the user returns.
 *
 * Auto-dismisses once backups + 2FA are done. If all three items are done
 * (backup + 2FA + at least 1 referral), a confetti celebration fires first.
 */

const onboardedKey = (uid: string) => `cipherline_onboarded_v2_${uid}`;
const dismissedKey = (uid: string) => `cipherline_checklist_dismissed_${uid}`;

const COLORS = ['#25E0C8', '#5e8ee0', '#FFC94D', '#4ADE80', '#FF8FB1'];
const CONFETTI = Array.from({ length: 28 }, (_, i) => ({
    left: (i * 3.6 + (i % 5) * 4) % 100,
    color: COLORS[i % COLORS.length],
    delay: (i % 10) * 0.12,
    dur: 1.8 + (i % 4) * 0.3,
    rot: (i * 57) % 360,
    size: 5 + (i % 3) * 3,
}));

type Status = 'todo' | 'done';

const StatusDot: React.FC<{ status: Status; icon: React.ReactNode }> = ({ status, icon }) => (
    <span
        className="shrink-0 grid place-items-center rounded-full"
        style={{
            width: 34, height: 34,
            background: status === 'done' ? 'rgba(74,222,128,.14)' : 'var(--cl-surface)',
            border: `1px solid ${status === 'done' ? 'rgba(74,222,128,.5)' : 'var(--cl-border)'}`,
            color: status === 'done' ? 'var(--cl-ok)' : 'var(--cl-lume)',
        }}
    >
        {status === 'done' ? <Check size={16} /> : icon}
    </span>
);

interface ReferralStatus {
    referral_code: string | null;
    referrals_count: number;
    rewards_claimed: number;
    max_referrals: number;
    days_per_referral: number;
}

interface Props {
    onOpenSettings: (tab: PaneId) => void;
    refreshSignal: number;
}

export const OnboardingChecklist: React.FC<Props> = ({ onOpenSettings, refreshSignal }) => {
    const { user, token } = useAuth();
    const { push: pushToast } = useToast();
    const notifPrefs = useNotificationPrefs();
    const userId = user?.user_id ?? null;

    const [dismissed, setDismissed] = useState(false);
    const [celebrating, setCelebrating] = useState(false);

    const gateOpen = useMemo(() => {
        if (!userId || dismissed) return false;
        const onboarded = secureLocalStore.getItem(onboardedKey(userId)) === '1';
        const already = secureLocalStore.getItem(dismissedKey(userId)) === '1';
        return onboarded && !already;
    }, [userId, dismissed]);

    const [backupDone, setBackupDone] = useState<boolean>(() => {
        try { return userId ? hasBackupSetUp(userId) : false; } catch { return false; }
    });
    const [twoFaDone, setTwoFaDone] = useState(false);
    const [referral, setReferral] = useState<ReferralStatus | null>(null);
    const [copied, setCopied] = useState<'code' | 'link' | null>(null);

    // Re-check all state whenever settings closes (refreshSignal bumps) or on mount.
    useEffect(() => {
        if (!gateOpen || !userId || !token) return;
        try { setBackupDone(hasBackupSetUp(userId)); } catch { /* unchanged */ }
        axios.get(`${API_BASE}/auth/2fa/totp/status`, { headers: { Authorization: `Bearer ${token}` } })
            .then(r => setTwoFaDone(!!r.data?.enabled))
            .catch(() => {});
        axios.get<ReferralStatus>(`${API_BASE}/billing/referral`, { headers: { Authorization: `Bearer ${token}` } })
            .then(r => setReferral(r.data))
            .catch(() => {});
    }, [gateOpen, userId, token, refreshSignal]);

    // Auto-dismiss once backup + 2FA done. If referral also done, celebrate first.
    const dismissQueued = useRef(false);
    useEffect(() => {
        if (!gateOpen || !userId) return;
        if (dismissQueued.current) return;
        if (!backupDone || !twoFaDone) return;

        dismissQueued.current = true;
        const refCount = referral?.referrals_count ?? 0;
        const allThree = refCount >= 1;
        if (allThree) {
            setCelebrating(true);
            // The confetti used to fall in silence. Its own pref category, so
            // it's mutable like every other cue.
            playSound('celebration', notifPrefs.prefs);
        }

        secureLocalStore.setItem(dismissedKey(userId), '1');
        const t = setTimeout(() => setDismissed(true), allThree ? 3400 : 1400);
        return () => clearTimeout(t);
    // notifPrefs is a dep because the celebration cue reads it. Re-running is a
    // no-op: dismissQueued short-circuits on the first line.
    }, [gateOpen, userId, backupDone, twoFaDone, referral, notifPrefs]);

    const handleDismiss = () => {
        if (userId) secureLocalStore.setItem(dismissedKey(userId), '1');
        setDismissed(true);
    };

    const handleCopyCode = useCallback(() => {
        const code = referral?.referral_code;
        if (!code) return;
        writeToClipboard(code).then(() => {
            setCopied('code');
            pushToast({ kind: 'success', message: 'Referral code copied!' });
            setTimeout(() => setCopied(null), 2000);
        }).catch(() => pushToast({ kind: 'error', message: 'Could not copy — try selecting and copying manually.' }));
    }, [referral?.referral_code, pushToast]);

    const handleCopyLink = useCallback(() => {
        const code = referral?.referral_code;
        if (!code) return;
        writeToClipboard(`https://cipherline.chat/ref/${code}`).then(() => {
            setCopied('link');
            pushToast({ kind: 'success', message: 'Referral link copied!' });
            nudges.notify({ kind: 'invite_sent' });
            setTimeout(() => setCopied(null), 2000);
        }).catch(() => pushToast({ kind: 'error', message: 'Could not copy — try selecting and copying manually.' }));
    }, [referral?.referral_code, pushToast]);

    const refCount = referral?.referrals_count ?? 0;
    const maxRef   = referral?.max_referrals ?? 5;
    const daysEarned = refCount * (referral?.days_per_referral ?? 7);
    const refAnyDone = refCount >= 1;
    const refAllDone = refCount >= maxRef;

    return (
        <AnimatePresence>
            {/* Full-viewport confetti rain — appears on top of everything when celebrating */}
            {gateOpen && celebrating && (
                <motion.div
                    key="confetti-overlay"
                    className="fixed inset-0 pointer-events-none overflow-hidden"
                    style={{ zIndex: 59 }}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.3 }}
                >
                    {CONFETTI.map((c, i) => (
                        <motion.span
                            key={i}
                            className="absolute"
                            style={{ left: `${c.left}%`, top: 0, width: c.size, height: c.size * 1.4, background: c.color, borderRadius: 2 }}
                            initial={{ y: -20, opacity: 0, rotate: 0 }}
                            animate={{ y: '110vh', opacity: [0, 1, 1, 0.4], rotate: c.rot + 360 }}
                            transition={{ duration: c.dur * 1.6, delay: c.delay, ease: 'linear' }}
                        />
                    ))}
                </motion.div>
            )}

            {/* Main checklist card */}
            {gateOpen && (
            <motion.div
                key="checklist-card"
                data-ob-anchor="onboarding-checklist"
                initial={{ opacity: 0, y: 20, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ y: 180, opacity: 0, transition: { duration: 0.42, ease: [0.4, 0, 1, 1] } }}
                transition={{ duration: 0.28, ease: [0.34, 1.56, 0.64, 1] }}
                className="fixed z-[60] rounded-2xl overflow-hidden"
                style={{
                    right: 18, bottom: 18, width: 372,
                    background: 'var(--cl-deep)',
                    border: '1px solid var(--cl-border)',
                    boxShadow: 'var(--cl-shadow-menu, 0 14px 34px rgba(0,0,0,.5))',
                }}
            >
                {/* Party celebration overlay — fires when all three items are done */}
                <AnimatePresence>
                    {celebrating && (
                        <motion.div
                            className="absolute inset-0 rounded-2xl flex flex-col items-center justify-center gap-3"
                            style={{ background: 'var(--cl-deep)', zIndex: 20 }}
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.35 }}
                        >
                            {/* Keys mascot — waving */}
                            <motion.div
                                initial={{ scale: 0, rotate: -15 }}
                                animate={{ scale: 1, rotate: 0 }}
                                transition={{ type: 'spring', stiffness: 260, damping: 13, delay: 0.12 }}
                                className="relative z-10"
                            >
                                <Keys size={100} wave interactive={false} waveOnMount={false} />
                            </motion.div>
                            <motion.div
                                initial={{ opacity: 0, y: 8 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ delay: 0.3 }}
                                className="relative z-10 text-center px-6"
                            >
                                <p className="text-cl-text font-bold text-[16px]" style={{ fontFamily: 'var(--cl-font-display)' }}>
                                    You're all set!
                                </p>
                                <p className="text-cl-faint text-[12px] mt-1">
                                    Account secured, backups running, friends invited.
                                </p>
                            </motion.div>
                        </motion.div>
                    )}
                </AnimatePresence>

                {/* Header */}
                <div className="flex items-start gap-3 px-4 pt-4 pb-3">
                    <div className="flex-1 min-w-0">
                        <h3 className="text-cl-text font-semibold text-[15px] leading-tight" style={{ fontFamily: 'var(--cl-font-display)' }}>
                            Finish setting up
                        </h3>
                        <p className="text-cl-faint text-[12px] mt-0.5">
                            A few optional steps to keep your account safe.
                        </p>
                    </div>
                    <button
                        onClick={handleDismiss}
                        aria-label="Dismiss"
                        className="shrink-0 grid place-items-center rounded-lg text-cl-faint hover:text-cl-text hover:bg-white/[0.06] transition-colors"
                        style={{ width: 28, height: 28 }}
                    >
                        <X size={16} />
                    </button>
                </div>

                <div className="px-4 pb-4 flex flex-col gap-2.5">
                    {/* 1 — Automatic backups */}
                    <button
                        onClick={() => { if (!backupDone) onOpenSettings('storage'); }}
                        disabled={backupDone}
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left disabled:cursor-default transition-colors hover:bg-white/[0.04] disabled:hover:bg-transparent"
                        style={{ border: '1px solid var(--cl-border)', background: 'var(--cl-abyss)' }}
                    >
                        <StatusDot status={backupDone ? 'done' : 'todo'} icon={<HardDriveDownload size={16} />} />
                        <span className="flex-1 min-w-0">
                            <span className="block text-cl-text text-[13.5px] font-medium">Turn on automatic backups</span>
                            <span className="block text-cl-faint text-[11.5px]">
                                {backupDone ? 'Backups are on.' : 'Encrypted, on a schedule you control.'}
                            </span>
                        </span>
                        {!backupDone && <ChevronRight size={16} className="text-cl-faint shrink-0" />}
                    </button>

                    {/* 2 — Two-factor auth */}
                    <button
                        onClick={() => { if (!twoFaDone) onOpenSettings('profile'); }}
                        disabled={twoFaDone}
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left disabled:cursor-default transition-colors hover:bg-white/[0.04] disabled:hover:bg-transparent"
                        style={{ border: '1px solid var(--cl-border)', background: 'var(--cl-abyss)' }}
                    >
                        <StatusDot status={twoFaDone ? 'done' : 'todo'} icon={<ShieldCheck size={16} />} />
                        <span className="flex-1 min-w-0">
                            <span className="block text-cl-text text-[13.5px] font-medium">Add two-factor authentication</span>
                            <span className="block text-cl-faint text-[11.5px]">
                                {twoFaDone ? '2FA is on.' : 'Protect sign-in with an authenticator app.'}
                            </span>
                        </span>
                        {!twoFaDone && <ChevronRight size={16} className="text-cl-faint shrink-0" />}
                    </button>

                    {/* 3 — Refer a friend */}
                    <div className="rounded-xl" style={{ border: '1px solid var(--cl-border)', background: 'var(--cl-abyss)' }}>
                        <button
                            onClick={() => onOpenSettings('billing')}
                            className="w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.04] rounded-xl"
                        >
                            <StatusDot status={refAnyDone ? 'done' : 'todo'} icon={<Gift size={16} />} />
                            <span className="flex-1 min-w-0">
                                <span className="block text-cl-text text-[13.5px] font-medium">Refer a friend</span>
                                <span className="block text-cl-faint text-[11.5px]">
                                    {refAllDone
                                        ? `${maxRef} referrals done — +${daysEarned} free trial days earned!`
                                        : `+7 free trial days for you and your friend. Up to ${maxRef} friends.`}
                                </span>
                            </span>
                            <ChevronRight size={16} className="text-cl-faint shrink-0" />
                        </button>

                        {/* Inline code + share — quick-access without leaving the checklist */}
                        {referral?.referral_code && (
                            <div className="px-3 pb-3 flex flex-col gap-2">
                                {/* Code copy row */}
                                <div
                                    className="flex items-center gap-2 rounded-lg px-3 py-2"
                                    style={{ background: 'var(--cl-surface)', border: '1px solid var(--cl-border)' }}
                                >
                                    <span
                                        className="flex-1 text-cl-lume font-mono font-bold tracking-widest text-[14px] select-all"
                                        style={{ letterSpacing: '0.18em' }}
                                    >
                                        {referral.referral_code}
                                    </span>
                                    <button
                                        onClick={(e) => { e.stopPropagation(); handleCopyCode(); }}
                                        title="Copy referral code"
                                        className="shrink-0 flex items-center gap-1 rounded px-1.5 text-[11px] font-medium transition-colors"
                                        style={{ color: copied === 'code' ? 'var(--cl-ok)' : 'var(--cl-muted)', height: 28 }}
                                    >
                                        {copied === 'code' ? <><Check size={12} />Copied!</> : <><Copy size={12} />Copy</>}
                                    </button>
                                </div>

                                {/* Share link row */}
                                <button
                                    onClick={(e) => { e.stopPropagation(); handleCopyLink(); }}
                                    className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-white/[0.04]"
                                    style={{ border: '1px solid var(--cl-border)', background: 'transparent' }}
                                >
                                    <Link2 size={13} className="text-cl-muted shrink-0" />
                                    <span className="flex-1 text-cl-muted text-[12px] truncate">
                                        cipherline.chat/ref/{referral.referral_code}
                                    </span>
                                    <span className="shrink-0 text-[11px] font-medium" style={{ color: copied === 'link' ? 'var(--cl-ok)' : 'var(--cl-lume)' }}>
                                        {copied === 'link' ? 'Copied!' : 'Copy link'}
                                    </span>
                                </button>

                                {/* Progress */}
                                <div className="flex flex-col gap-1">
                                    <div className="flex justify-between items-center">
                                        <span className="text-cl-faint text-[11px]">
                                            {refCount}/{maxRef} referrals
                                        </span>
                                        {daysEarned > 0 && (
                                            <span className="text-cl-ok text-[11px] font-medium">
                                                +{daysEarned} free trial days earned
                                            </span>
                                        )}
                                    </div>
                                    <div
                                        className="rounded-full overflow-hidden"
                                        style={{ height: 4, background: 'var(--cl-border)' }}
                                    >
                                        <motion.div
                                            className="h-full rounded-full"
                                            style={{ background: 'var(--cl-lume)' }}
                                            initial={{ width: 0 }}
                                            animate={{ width: `${Math.min(100, (refCount / maxRef) * 100)}%` }}
                                            transition={{ duration: 0.6, ease: 'easeOut' }}
                                        />
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </motion.div>
            )}
        </AnimatePresence>
    );
};

export default OnboardingChecklist;
