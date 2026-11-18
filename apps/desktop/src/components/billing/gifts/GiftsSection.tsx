/**
 * Settings -> Subscription -> "Gift Pro": buy a gift (GiftProModal), and the
 * Sent / Received lists from GET /billing/gifts. Rendered by BillingTab as one
 * more `.sd-card`, styled like its neighbours.
 *
 * The lists re-read when the server pushes `gift:updated` (a friend accepted,
 * a payment settled, a refund) and after a purchase. "Resend card" re-sends the
 * E2EE `pro_gift` message for a paid gift; the card is keyed by gift id, so a
 * duplicate is harmless — it is the recovery path when the first send failed.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Crown, Gift, RefreshCw, Send } from 'lucide-react';
import { apiErrorMessage, type GiftListResponse, type GiftView } from '@cipherline/shared';
import { ClButton, ClSkeleton } from '../../cl';
import { useGiftActions } from './GiftActionsContext';
import { GiftProModal } from './GiftProModal';
import { onGiftUpdated } from './giftEvents';
import { useGiftsApi } from './giftsApi';
import { canResendCard, giftRowDetail, giftRowTitle, giftStatusChip, giftedProUntilLine } from './giftCopy';
import '../../../styles/gifts.css';

type ResendNote = { kind: 'ok' | 'bad'; text: string };

export const GiftsSection: React.FC = () => {
    const api = useGiftsApi();
    const { nameFor, sendGiftCard } = useGiftActions();
    const [data, setData] = useState<GiftListResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [modalOpen, setModalOpen] = useState(false);
    const [resending, setResending] = useState<Record<string, boolean>>({});
    const [notes, setNotes] = useState<Record<string, ResendNote>>({});
    const alive = useRef(true);
    const noteTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
    useEffect(() => {
        const timers = noteTimers.current;
        return () => {
            alive.current = false;
            for (const t of timers.values()) clearTimeout(t);
        };
    }, []);

    const seq = useRef(0);
    const load = useCallback(async () => {
        const mine = ++seq.current;
        setBusy(true);
        try {
            const res = await api.list();
            if (!alive.current || mine !== seq.current) return;
            setData({ sent: res?.sent ?? [], received: res?.received ?? [], pro_until: res?.pro_until ?? null });
            setError(null);
        } catch (err) {
            if (!alive.current || mine !== seq.current) return;
            setError(apiErrorMessage(err, 'Couldn’t load your gifts.'));
        } finally {
            if (alive.current && mine === seq.current) setBusy(false);
        }
    }, [api]);

    useEffect(() => { void load(); }, [load]);
    useEffect(() => onGiftUpdated(() => { void load(); }), [load]);

    // Is buying open? The server's GIFTS_ENABLED switch (default off until the
    // full standard monthly price exists). Unknown / failed = closed: never offer a
    // purchase the server has not said it will take.
    const [buyable, setBuyable] = useState(false);
    useEffect(() => {
        let cancelled = false;
        api.config()
            .then((cfg) => { if (!cancelled) setBuyable(cfg?.enabled === true && (cfg.offers?.length ?? 0) > 0); })
            .catch(() => { if (!cancelled) setBuyable(false); });
        return () => { cancelled = true; };
    }, [api]);

    const resend = useCallback(async (g: GiftView) => {
        if (!g.other_user_id || resending[g.gift_id]) return;
        setResending((r) => ({ ...r, [g.gift_id]: true }));
        const ok = await sendGiftCard(g.other_user_id, g.gift_id);
        if (!alive.current) return;
        setResending((r) => ({ ...r, [g.gift_id]: false }));
        setNotes((n) => ({ ...n, [g.gift_id]: ok ? { kind: 'ok', text: 'Card sent' } : { kind: 'bad', text: 'Couldn’t send — try again' } }));
        const prev = noteTimers.current.get(g.gift_id);
        if (prev) clearTimeout(prev);
        noteTimers.current.set(g.gift_id, setTimeout(() => {
            noteTimers.current.delete(g.gift_id);
            if (alive.current) setNotes((n) => { const next = { ...n }; delete next[g.gift_id]; return next; });
        }, 4000));
    }, [resending, sendGiftCard]);

    const until = giftedProUntilLine(data?.pro_until);
    const sent = data?.sent ?? [];
    const received = data?.received ?? [];
    // Buying closed and nothing to show: the section stays out of the way.
    const hidden = !buyable && !!data && !until && sent.length === 0 && received.length === 0;

    const row = (g: GiftView) => {
        const chip = giftStatusChip(g);
        const note = notes[g.gift_id];
        return (
            <div className="sd-row" key={g.gift_id} data-testid="gift-row">
                <span className="gft-row-ico" aria-hidden>
                    {g.status === 'redeemed'
                        ? <Crown size={15} style={{ color: 'var(--cl-glow)' }} />
                        : <Gift size={15} style={{ color: g.status === 'paid' ? 'var(--cl-lume)' : 'var(--cl-faint)' }} />}
                </span>
                <div className="sd-rl">
                    <b>
                        {giftRowTitle(g, nameFor(g.other_user_id))}
                        <span className={`gft-chip gft-chip--${chip.tone}`}>{chip.label}</span>
                    </b>
                    <span>{giftRowDetail(g)}</span>
                </div>
                {canResendCard(g) && g.other_user_id && (
                    <div className="sd-rc">
                        {note && (
                            <span className={`gft-resend-note gft-resend-note--${note.kind}`} role="status">{note.text}</span>
                        )}
                        <ClButton variant="ghost" size="sm" onClick={() => { void resend(g); }} loading={!!resending[g.gift_id]}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Send size={13} aria-hidden /> Resend card</span>
                        </ClButton>
                    </div>
                )}
            </div>
        );
    };

    if (hidden) return null;

    return (
        <div className="sd-card" data-testid="gifts-section">
            <div className="gft-sec-head">
                <span className="sd-tile sd-tile--warm"><Gift size={16} /></span>
                <div>
                    <h3 style={{ margin: 0 }}>Gift Pro</h3>
                    <p className="sd-sub" style={{ margin: 0 }}>
                        Give a friend 1 or 12 months of Cipherline Pro. One payment, nothing renews.
                    </p>
                </div>
                {buyable && (
                    <div className="gft-sec-cta">
                        <ClButton onClick={() => setModalOpen(true)}>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Gift size={15} aria-hidden /> Gift Pro to a friend</span>
                        </ClButton>
                    </div>
                )}
            </div>

            {until && (
                <div className="gft-until" data-testid="gift-pro-until">
                    <Crown size={22} style={{ color: 'var(--cl-glow)', flex: 'none' }} aria-hidden />
                    <div>
                        <b>{until}</b>
                        <span>A friend gave you Pro. Enjoy video, screen share and big uploads.</span>
                    </div>
                </div>
            )}

            {data === null && error ? (
                <div className="gft-empty" role="alert" style={{ borderStyle: 'solid' }}>
                    <div style={{ marginBottom: 8 }}>{error}</div>
                    <ClButton variant="ghost" size="sm" onClick={() => { void load(); }} loading={busy}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><RefreshCw size={13} aria-hidden /> Try again</span>
                    </ClButton>
                </div>
            ) : data === null ? (
                <div className="flex flex-col gap-2 mt-4" aria-busy="true" aria-label="Loading gifts">
                    <ClSkeleton style={{ width: '100%', height: 44, borderRadius: 12 }} />
                    <ClSkeleton style={{ width: '100%', height: 44, borderRadius: 12 }} />
                </div>
            ) : sent.length === 0 && received.length === 0 ? (
                <div className="gft-empty">No gifts yet. Gifts you send and receive show up here.</div>
            ) : (
                <>
                    {error && <p className="sd-sub" role="alert" style={{ margin: '12px 0 0', color: 'var(--cl-flash)' }}>{error}</p>}
                    {sent.length > 0 && (
                        <>
                            <div className="gft-list-h">Sent</div>
                            {sent.map(row)}
                        </>
                    )}
                    {received.length > 0 && (
                        <>
                            <div className="gft-list-h">Received</div>
                            {received.map(row)}
                        </>
                    )}
                </>
            )}

            {modalOpen && (
                <GiftProModal
                    onClose={() => setModalOpen(false)}
                    onPurchased={() => { void load(); }}
                />
            )}
        </div>
    );
};

export default GiftsSection;
