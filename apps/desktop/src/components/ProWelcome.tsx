/**
 * ProWelcome — the celebration shown the first time an account is detected to
 * have an active *paid* subscription. Because the Stripe checkout completes in
 * the external browser (the app can't observe it directly), this fires off the
 * subscription-status poll + a window-focus refresh: when the user returns to the
 * app after paying and the status reads `active` with a real subscription, we
 * thank them and nudge them to polish their profile. Shown once (a per-user flag
 * in the Dashboard gates it).
 */
import React from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { Crown, X } from 'lucide-react';
import { ClButton } from './ClButton';
import { ClModal } from './cl';
import { useModalExit } from '../hooks/useModalExit';
import { useNotificationPrefs } from '../contexts/NotificationContext';
import { playSound } from '../utils/notificationSounds';

const COLORS = ['#25E0C8', '#5e8ee0', '#FFC94D', '#4ADE80', '#FF8FB1'];

// Deterministic confetti rain — same every time, no Math.random at render.
const CONFETTI = Array.from({ length: 42 }, (_, i) => ({
    left: (i * 2.4 + (i % 4) * 5) % 100,
    color: COLORS[i % COLORS.length],
    delay: (i % 12) * 0.13,
    dur: 2.4 + (i % 5) * 0.35,
    rot: (i * 57) % 360,
    size: 6 + (i % 3) * 3,
}));

// 8-spoke burst around the crown.
const BURST = Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * Math.PI * 2;
    return { x: Math.cos(a) * 58, y: Math.sin(a) * 58 };
});

export const ProWelcome: React.FC<{ onClose: () => void }> = ({ onClose }) => {
    const { closing, handleClose } = useModalExit(onClose, 260);
    const notifPrefs = useNotificationPrefs();
    // Fires once on mount — this whole component is gated to once per account.
    React.useEffect(() => { playSound('celebration', notifPrefs.prefs); },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        []);
    return (
        <>
            {/* Confetti rain — its own portal: the kit card's entrance transform
                would trap a fixed layer, so it can't live inside the modal. Sits
                one step above the overlay and rains over the whole celebration. */}
            {createPortal(
                <motion.div
                    className="fixed inset-0 overflow-hidden pointer-events-none"
                    style={{ zIndex: 2001 }}
                    initial={{ opacity: 0 }} animate={{ opacity: closing ? 0 : 1 }}
                >
                    {CONFETTI.map((c, i) => (
                        <motion.span
                            key={i}
                            className="absolute"
                            style={{ left: `${c.left}%`, top: -20, width: c.size, height: c.size * 1.4, background: c.color, borderRadius: 2 }}
                            initial={{ y: -20, opacity: 0, rotate: 0 }}
                            animate={{ y: '104vh', opacity: [0, 1, 1, 0.7], rotate: c.rot + 360 }}
                            transition={{ duration: c.dur, delay: c.delay, repeat: Infinity, repeatDelay: 0.7, ease: 'linear' }}
                        />
                    ))}
                </motion.div>,
                document.body,
            )}

            <ClModal
                open={!closing}
                onClose={handleClose}
                width={420}
                label="Welcome to Cipherline Pro"
                overlayStyle={{ zIndex: 2000 }}
                cardClassName="text-center"
                cardStyle={{ padding: '36px 32px', borderRadius: 24, borderColor: 'rgba(37,224,200,0.2)', boxShadow: '0 20px 60px rgba(0,0,0,0.6)' }}
            >
                <button onClick={handleClose} className="absolute top-3.5 right-3.5 text-cl-faint hover:text-cl-text transition-colors" aria-label="Close">
                    <X size={18} />
                </button>

                {/* crown burst */}
                <div className="relative mx-auto mb-5" style={{ width: 92, height: 92 }}>
                    {BURST.map((b, i) => (
                        <motion.span
                            key={i}
                            className="absolute rounded-full"
                            style={{ left: '50%', top: '50%', width: 5, height: 5, marginLeft: -2.5, marginTop: -2.5, background: '#FFC94D' }}
                            initial={{ opacity: 0, x: 0, y: 0 }}
                            animate={{ opacity: [0, 1, 0], x: b.x, y: b.y }}
                            transition={{ duration: 0.7, delay: 0.16, ease: 'easeOut' }}
                        />
                    ))}
                    <motion.div
                        className="w-full h-full rounded-3xl flex items-center justify-center"
                        style={{ background: 'rgba(255,201,77,0.14)', boxShadow: '0 0 40px rgba(255,201,77,0.45)', color: '#FFC94D' }}
                        initial={{ scale: 0, rotate: -25 }}
                        animate={{ scale: 1, rotate: 0, transition: { type: 'spring', stiffness: 300, damping: 13, delay: 0.1 } }}
                    >
                        <Crown size={46} strokeWidth={2} />
                    </motion.div>
                </div>

                <motion.h2
                    className="text-[26px] font-bold leading-tight mb-2"
                    style={{ fontFamily: 'var(--cl-font-display)', color: 'var(--cl-text)' }}
                    initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0, transition: { delay: 0.22 } }}
                >
                    Welcome to Cipherline Pro!
                </motion.h2>
                <motion.p
                    className="text-cl-muted text-sm leading-relaxed mb-7"
                    style={{ maxWidth: 320, marginInline: 'auto' }}
                    initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0, transition: { delay: 0.3 } }}
                >
                    Thank you for subscribing — every feature is unlocked. Now let’s make your profile shine.
                </motion.p>
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0, transition: { delay: 0.38 } }}>
                    <ClButton fullWidth onClick={handleClose}>Close</ClButton>
                </motion.div>
            </ClModal>
        </>
    );
};

export default ProWelcome;
