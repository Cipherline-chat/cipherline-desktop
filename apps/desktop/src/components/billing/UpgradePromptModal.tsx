import React from 'react';
import { motion, useReducedMotion, type Variants } from 'framer-motion';
import { Sparkles, Upload, Video, MonitorUp } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ClModal, ClButton } from '../cl';
import { useSubscription } from '../../contexts/SubscriptionContext';
import { FREE_UPLOAD_LIMIT_LABEL, PRO_UPLOAD_LIMIT_LABEL } from '../../utils/uploadLimitCopy';

/**
 * Every pro-gated affordance in the app routes through this one modal instead
 * of jumping straight to the card. It explains WHICH feature is Pro, what Pro
 * unlocks, and the price — then the primary button opens the actual Stripe
 * checkout. (There is no server-creation reason any more: since 2026-10-04
 * every plan can create servers, so nothing about creating one is gated.)
 */
export type UpgradeReason =
    | 'video'
    | 'screenshare'
    | 'video_call'
    | 'upload';

interface Props {
    open: boolean;
    reason: UpgradeReason;
    /** Reason-specific override for the subtitle (e.g. the rejected file list). */
    detail?: string;
    onClose: () => void;
}

const COPY: Record<UpgradeReason, { Icon: LucideIcon; title: string; subtitle: string }> = {
    video: {
        Icon: Video,
        title: 'Video calling is a Pro feature',
        subtitle: 'Turn your camera on in calls with Cipherline Pro. Audio calls are always free.',
    },
    screenshare: {
        Icon: MonitorUp,
        title: 'Screen sharing is a Pro feature',
        subtitle: 'Share your screen in calls with Cipherline Pro. Audio calls are always free.',
    },
    video_call: {
        Icon: Video,
        title: 'Video calls are a Pro feature',
        subtitle: 'Start face-to-face calls with Cipherline Pro. Voice calls are always free.',
    },
    upload: {
        Icon: Upload,
        title: 'File too large for the free plan',
        subtitle: `This file exceeds the ${FREE_UPLOAD_LIMIT_LABEL} free-tier upload limit. Cipherline Pro lifts it to ${PRO_UPLOAD_LIMIT_LABEL}.`,
    },
};

const PERKS: string[] = [
    '**HD video calls** & screen sharing',
    'Upload files up to **2 GB**',
    '**Bigger saved storage** that grows with your server (100 MB to 10 GB)',
];

/** Renders a perk string, bolding the **…** spans. */
function perkContent(text: string): React.ReactNode {
    return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
        part.startsWith('**') && part.endsWith('**')
            ? <strong key={i}>{part.slice(2, -2)}</strong>
            : <React.Fragment key={i}>{part}</React.Fragment>,
    );
}

/**
 * Pro-feature explainer + upgrade CTA. Hosted globally by SubscriptionContext
 * and opened via `promptUpgrade(reason)`.
 *
 * Motion: ClModal already springs the card in on translateY; on top of that we
 * stagger the contents (icon pops, then header / perks / buttons rise in
 * sequence) with the same spring feel InAppCheckout uses, gated on
 * prefers-reduced-motion. Buttons are stacked full-width (primary on top) so
 * they're a matched pair — equal width and height, no label wrapping, and the
 * primary is the auto-focused default rather than the dismiss action.
 */
export const UpgradePromptModal: React.FC<Props> = ({ open, reason, detail, onClose }) => {
    const { openInAppCheckout } = useSubscription();
    const reduced = useReducedMotion();
    const { Icon, title, subtitle } = COPY[reason];

    const handleUpgrade = () => {
        onClose();
        openInAppCheckout();
    };

    // Parent orchestrator — staggers its direct children once the card lands.
    const container: Variants = {
        hidden: {},
        show: { transition: reduced ? {} : { staggerChildren: 0.06, delayChildren: 0.06 } },
    };
    const rise: Variants = {
        hidden: { opacity: 0, y: reduced ? 0 : 10 },
        show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 320, damping: 24 } },
    };
    // Icon gets a springier pop than the rows.
    const pop: Variants = {
        hidden: { opacity: 0, scale: reduced ? 1 : 0.4 },
        show: { opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 380, damping: 15 } },
    };
    // Perk card both rises in AND staggers its own rows.
    const perkCard: Variants = {
        hidden: { opacity: 0, y: reduced ? 0 : 10 },
        show: {
            opacity: 1, y: 0,
            transition: { type: 'spring', stiffness: 320, damping: 24, staggerChildren: reduced ? 0 : 0.045, delayChildren: reduced ? 0 : 0.03 },
        },
    };

    return (
        <ClModal open={open} onClose={onClose} width={400} label={title}>
            <motion.div className="p-6" variants={container} initial="hidden" animate="show">
                <motion.div variants={rise} className="flex items-start gap-3 mb-5">
                    <motion.div
                        variants={pop}
                        className="w-10 h-10 rounded-xl bg-cl-lume/10 border border-cl-lume/20 text-cl-lume flex items-center justify-center shrink-0"
                    >
                        <Icon size={18} />
                    </motion.div>
                    <div>
                        <h2 className="text-[1rem] font-bold text-cl-text mb-1 mt-0 leading-snug">
                            {title}
                        </h2>
                        <p className="text-sm text-cl-muted m-0 leading-snug">{detail ?? subtitle}</p>
                    </div>
                </motion.div>

                <motion.div variants={perkCard} className="bg-cl-sink border border-white/[0.06] rounded-xl p-4 mb-5 space-y-2.5">
                    <p className="text-[11px] font-semibold text-cl-lume tracking-wide uppercase m-0 mb-3">
                        What you get with Pro
                    </p>
                    {PERKS.map((perk, i) => (
                        <motion.div key={i} variants={rise} className="flex items-center gap-2 text-sm text-cl-text">
                            <Sparkles size={13} className="text-cl-lume shrink-0" />
                            <span>{perkContent(perk)}</span>
                        </motion.div>
                    ))}
                </motion.div>

                <motion.div variants={rise} className="flex flex-col gap-2.5">
                    <ClButton fullWidth onClick={handleUpgrade}>
                        Upgrade — $2.50/mo + tax
                    </ClButton>
                    <ClButton fullWidth variant="ghost" onClick={onClose}>
                        Maybe later
                    </ClButton>
                </motion.div>
            </motion.div>
        </ClModal>
    );
};
