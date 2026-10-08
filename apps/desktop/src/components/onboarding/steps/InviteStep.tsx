import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Check, Copy, Ticket, UserPlus } from 'lucide-react';
import { formatUserTag } from '@cipherline/shared';
import { ClButton } from '../../ClButton';
import { ClToggle } from '../../cl';
import { ServerIcon } from '../../server/ServerIcon';
import { useInvitePreview } from '../../../hooks/useInvitePreview';
import type { ServerInfo } from '../../../hooks/useServers';
import type { MyReferral, ReferrerTag } from '../../../utils/signupAttribution';
import cipherlineMark from '../../../assets/cipherline-mark.svg';
import { StepActions } from '../OnboardingFlow';
import type { FriendRequestResult, StepProps } from '../types';
import { COL, DotTagLayer, PAIR_X, burst, codeText, pair, place } from '../dots';
import type { DotField, DotTag, OrbSpec } from '../dots';
import { MAX_REFERRAL_REWARDS, joinEarnedBonus, joinTally, splitReferralLink } from './inviteText';
import './invite.css';

/**
 * Step 4: "You were referred" / "Bring one friend", plus the server-invite
 * acknowledgement and the optional official-server row.
 * Port of ob6/js/main.js R.invite + paintFriendBox + paintLinkBox +
 * enterInviteDots (README "Referral and invite (step 4)").
 *
 * Nothing here acts on its own:
 *   - the friend request (to the referrer, or to a friend who just joined
 *     with your link) is ONE explicit click, through the same
 *     POST /friends/request every "Add friend" button uses;
 *   - the server invite is only acknowledged; the join PROMPT opens after
 *     the ending (the Dashboard owns it);
 *   - the official-server toggle only records the choice in `flow`; the
 *     ending performs the join.
 */

/** World radius the scene is fitted into (the prototype's place(viz, 1.2, …, -10)). */
const VIZ_R = 1.2;
const VIZ_DY = -10;
/** A stable empty list: useInvitePreview re-derives membership when this changes identity. */
const NO_SERVERS: ServerInfo[] = [];
/** The code-to-orbs sequence plays once per account per session (the prototype's st.refAnimated). */
const refPlayed = new Set<string>();

const sleep = (ms: number) => new Promise<void>(r => window.setTimeout(r, ms));
// Usernames are identities (case-sensitive, shown as name#tag everywhere):
// never re-case them. The prototype capitalised "sam" because it was a demo
// first name; a real "obA_x" must not become "ObA_x".
const cap = (s: string) => s;
const initial = (s: string) => (s ? s[0].toUpperCase() : '?');

/** Text shapes are rasterised from canvas text: wait for the faces they use. */
async function fontsReady(): Promise<void> {
    try {
        const f = document.fonts;
        await Promise.race([
            Promise.all([f.load('700 100px "JetBrains Mono"'), f.load('600 100px Fredoka')]).then(() => f.ready),
            sleep(1500),
        ]);
    } catch { /* no FontFaceSet: draw with whatever is there */ }
}

/** The kit's `.cl-conf` burst (AuthScreen's authConfetti). Skipped under reduced motion. */
function confetti(x: number, y: number, reduced: boolean) {
    if (reduced) return;
    const colors = ['var(--cl-lume)', 'var(--cl-flash)', 'var(--cl-glow)', 'var(--cl-ok)'];
    for (let i = 0; i < 22; i++) {
        const s = document.createElement('span');
        s.className = 'cl-conf';
        s.style.cssText = `position:fixed;z-index:999;left:${x}px;top:${y}px;background:${colors[i % colors.length]}`;
        const ang = (Math.PI * 2 * i) / 22 + Math.random() * 0.4;
        const dist = 60 + Math.random() * 95;
        s.style.setProperty('--dx', `${Math.cos(ang) * dist}px`);
        s.style.setProperty('--dy', `${Math.sin(ang) * dist - 30}px`);
        s.style.setProperty('--rot', `${Math.random() * 600 - 300}deg`);
        document.body.appendChild(s);
        window.setTimeout(() => s.remove(), 850);
    }
}

type ReqState = 'idle' | 'sending' | FriendRequestResult;
interface Friend { username: string; discriminator: number | null }

/** "Add Sam as a friend?" — one click, never automatic. */
const FriendBox: React.FC<{
    who: Friend;
    state: ReqState;
    onSend: () => void;
}> = ({ who, state, onSend }) => {
    const tag = formatUserTag(who.username, who.discriminator);
    if (state === 'sent' || state === 'already') {
        return (
            <div className="box" data-ob-friend="sent">
                <div className="done-line" role="status"><Check size={16} strokeWidth={3} /> Friend request sent to {tag}</div>
            </div>
        );
    }
    if (state === 'failed') {
        return (
            <div className="box" data-ob-friend="failed">
                <div className="fr-row" role="status">
                    <div className="fr-t">
                        <b>Couldn’t send that one</b>
                        <span>You can still add {tag} from Friends.</span>
                    </div>
                </div>
            </div>
        );
    }
    // A tag without a #number cannot be addressed by the friend-request API.
    const canSend = who.discriminator !== null;
    return (
        <div className="box" data-ob-friend="offer">
            <div className="fr-row">
                <div className="fr-t">
                    <b>Add {cap(who.username)} as a friend?</b>
                    <span>{canSend ? 'Nothing is sent until you click.' : 'You can add them from Friends when you arrive.'}</span>
                </div>
                {canSend && (
                    <ClButton variant="ghost" onClick={onSend} loading={state === 'sending'}>
                        <span className="ob-inv-btn"><UserPlus size={16} /> Send friend request</span>
                    </ClButton>
                )}
            </div>
        </div>
    );
};

/** "Your link" + Copy link. */
const LinkBox: React.FC<{
    referral: MyReferral | null | undefined;
    copied: boolean;
    copyFailed: boolean;
    onCopy: () => void;
}> = ({ referral, copied, copyFailed, onCopy }) => {
    const { prefix, code } = referral ? splitReferralLink(referral.url) : { prefix: 'cipherline.chat/ref/', code: null };
    return (
        <div className="box" data-ob-link>
            <p className="lbl">Your link</p>
            {referral === null ? (
                <p className="small" style={{ marginTop: 0 }}>We couldn’t load your link just now. It stays in <b>Finish setting up</b> and in Settings.</p>
            ) : (
                <>
                    <div className="lbox">
                        <span className="lbox-url">
                            {prefix}{code ? <em>{code}</em> : <i className="lbox-skel" aria-label="Loading" />}
                        </span>
                        <ClButton size="sm" onClick={onCopy} disabled={!referral} className={copied ? 'is-done' : undefined}>
                            <span className="ob-inv-btn">
                                {copied ? <><Check size={15} strokeWidth={3} /> Copied</> : <><Copy size={15} /> Copy link</>}
                            </span>
                        </ClButton>
                    </div>
                    <p className="small">
                        {copyFailed
                            ? 'Couldn’t copy it. Select the link above instead.'
                            : <>You can just continue: the link stays in <b>Finish setting up</b> and in Settings.</>}
                    </p>
                </>
            )}
        </div>
    );
};

/** "You’re invited to <server>." — the server's real name and icon from the invite preview. */
const InviteRow: React.FC<{ code: string; token: string }> = ({ code, token }) => {
    const { preview, state } = useInvitePreview(code, token, NO_SERVERS);
    // Give the preview a moment before settling on the generic wording, so a
    // normal answer never flickers "a server" -> the name.
    const [waited, setWaited] = useState(false);
    useEffect(() => { const t = window.setTimeout(() => setWaited(true), 1500); return () => window.clearTimeout(t); }, []);
    const ok = !!preview && (state === 'valid' || state === 'joined');
    const pending = !ok && state === 'loading' && !waited;
    return (
        <div className="box inv" data-ob-invite={ok ? 'named' : pending ? 'loading' : 'generic'}>
            {ok && preview ? (
                <ServerIcon
                    serverId={preview.server_id}
                    name={preview.server_name}
                    attachmentId={preview.server_icon}
                    keyB64={preview.server_icon_key_b64}
                    nonceB64={preview.server_icon_nonce_b64}
                    token={token}
                    className="inv-ic"
                />
            ) : (
                <span className="inv-ic inv-ic--none" aria-hidden><Ticket size={22} /></span>
            )}
            <div className="t">
                <b>
                    You’re invited to {pending
                        ? <i className="inv-skel" aria-label="Loading the server name" />
                        : (ok && preview ? preview.server_name : 'a server')}
                </b>
                <span>We’ll ask if you want to join as soon as the app opens.</span>
            </div>
        </div>
    );
};

export const InviteStep: React.FC<StepProps> = ({ deps, flow, setFlow, reducedMotion, dots, showDots, onNext, onBack }) => {
    // Frozen for the life of the step: answering the offer calls
    // clearReferrer(), and the step must not flip modes if a host re-reads it.
    const [referrer] = useState<ReferrerTag | null>(() => deps.referrer);
    const hasReferrer = !!referrer;
    const myName = flow.username || deps.user?.username || '';
    const referrerTag = referrer ? formatUserTag(referrer.username, referrer.discriminator) : '';
    const bonusDays = deps.bonusDays;

    // ── referral: the one-click friend request to the referrer ──────────────
    const [refReq, setRefReq] = useState<ReqState>(() => (
        referrer && flow.friendRequestSentTo === referrerTag ? 'sent' : 'idle'
    ));
    // ── chip reveal (pop + slam once the dots have joined the two orbs) ────
    const [chip, setChip] = useState<'hidden' | 'pop' | 'quiet'>('hidden');

    // ── no referral: my link, and a friend joining with it ──────────────────
    const [referral, setReferral] = useState<MyReferral | null | undefined>(undefined);
    const [copied, setCopied] = useState(false);
    const [copyFailed, setCopyFailed] = useState(false);
    const [friend, setFriend] = useState<Friend | null>(null);
    const [joins, setJoins] = useState(0);
    const [friendReq, setFriendReq] = useState<ReqState>('idle');

    const [tags, setTags] = useState<DotTag[] | null>(null);
    const vizRef = useRef<HTMLDivElement>(null);
    const h1Ref = useRef<HTMLHeadingElement>(null);
    const [tagRoot, setTagRoot] = useState<Element | null>(null);
    useLayoutEffect(() => { setTagRoot(vizRef.current?.closest('[data-ob-root]') ?? document.body); }, []);

    // Latest values for async sequences and subscriptions set up once.
    const live = useRef({ deps, dots, reducedMotion, myName, friend });
    useLayoutEffect(() => { live.current = { deps, dots, reducedMotion, myName, friend }; });
    const mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

    const meOrb = useCallback((): OrbSpec => ({ glyph: initial(live.current.myName), color: COL.lume }), []);
    const meLabel = useCallback(() => `${live.current.myName || 'you'} (you)`, []);
    const pairTags = useCallback((left: string, right: string, rightFaded = false) => {
        setTags([
            { id: 'l', at: [-PAIR_X, -0.56, 0], text: left, cls: 'name' },
            { id: 'r', at: [PAIR_X, -0.56, 0], text: right, cls: rightFaded ? 'faded' : 'name' },
        ]);
    }, []);

    // ── the dot canvas: on while this step is up ────────────────────────────
    useEffect(() => { showDots(true); }, [showDots]);

    // Keep the scene fitted to the visual column: on resize, when the column
    // changes size, when the wizard scrolls, and once the step's enter
    // animation (a translateX) has finished.
    useEffect(() => {
        const viz = vizRef.current;
        if (!dots || !viz) return undefined;
        const fit = (ms: number) => { void place(dots, viz, VIZ_R, ms, VIZ_DY); };
        const onResize = () => fit(0);
        window.addEventListener('resize', onResize);
        const scroller = viz.closest('.ob-wiz');
        scroller?.addEventListener('scroll', onResize, { passive: true });
        const anim = viz.closest('.ob-step-anim');
        const onAnimEnd = (e: Event) => { if (e.target === anim) fit(250); };
        anim?.addEventListener('animationend', onAnimEnd);
        let firstObs = true;
        const ro = typeof ResizeObserver !== 'undefined'
            ? new ResizeObserver(() => { if (firstObs) { firstObs = false; return; } fit(350); })
            : null;
        ro?.observe(viz);
        return () => {
            window.removeEventListener('resize', onResize);
            scroller?.removeEventListener('scroll', onResize);
            anim?.removeEventListener('animationend', onAnimEnd);
            ro?.disconnect();
        };
    }, [dots]);

    // ── the entrance scene ──────────────────────────────────────────────────
    useEffect(() => {
        const F: DotField | null = dots;
        const rm = live.current.reducedMotion;
        if (!F) {
            // No field (yet): the shell creates it after this step mounts, and
            // it stays null when WebGL is unavailable. The step still works
            // without the sculpture; reveal the chip unless the field turns up.
            if (!referrer) return undefined;
            const t = window.setTimeout(() => setChip(rm ? 'quiet' : 'pop'), 400);
            return () => window.clearTimeout(t);
        }
        let alive = true;
        (async () => {
            const N = F.N;
            void F.param('follow', 0.6, 600); void F.param('repel', 0.5, 600); void F.param('bright', 1.25, 600);
            void F.param('px', 15, 600); void F.param('drift', 1, 600); void F.param('pitch', 0, 600); void F.param('yaw', 0, 600);
            await new Promise<void>(r => requestAnimationFrame(() => r()));
            if (!alive) return;
            // The canvas was faded out (or never shown): jump into place.
            void place(F, vizRef.current, VIZ_R, 0, VIZ_DY);
            if (referrer) {
                // Built after fontsReady(): the orb glyphs are canvas text too.
                const joined = () => pair(N, { glyph: initial(referrer.username), color: COL.ice }, meOrb(), true);
                const key = live.current.deps.userId;
                if (rm || refPlayed.has(key)) {
                    // Reduced motion (or a return visit): the joined state, no spelling.
                    await fontsReady();
                    if (!alive) return;
                    F.snap(joined());
                    pairTags(referrerTag, meLabel());
                    setChip('quiet');
                    return;
                }
                refPlayed.add(key);
                F.snap(burst(N, { r: 2.4, bright: 0.35 }));
                await fontsReady();
                if (!alive) return;
                const code = live.current.deps.referralCode || referrer.username.toUpperCase();
                await F.morph(codeText(N, code), { ms: 1000, stagger: 0.5, arc: 0.4 });
                await sleep(450);
                if (!alive) return;
                void F.morph(joined(), { ms: 1250, stagger: 0.45, arc: 0.55 });
                await sleep(900);
                if (!alive) return;
                setChip('pop');
                F.pulse(0.9);
                pairTags(referrerTag, meLabel());
            } else {
                await fontsReady();
                if (!alive) return;
                const f = live.current.friend;
                if (f) {
                    F.snap(pair(N, meOrb(), { glyph: initial(f.username), color: COL.ice }, true));
                    pairTags(meLabel(), formatUserTag(f.username, f.discriminator));
                    return;
                }
                const s = pair(N, meOrb(), null, false);
                if (rm) F.snap(s);
                else { F.snap(burst(N, { r: 2.4, bright: 0.35 })); void F.morph(s, { ms: 1300, stagger: 0.5, arc: 0.45 }); }
                if (!rm) await sleep(700);
                if (!alive || live.current.friend) return;
                pairTags(meLabel(), 'your friend?', true);
            }
        })();
        return () => { alive = false; };
        // The scene is built once per field; names are read through `live`.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dots]);

    // ── no referral: my link ────────────────────────────────────────────────
    useEffect(() => {
        if (hasReferrer) return undefined;
        let alive = true;
        live.current.deps.fetchMyReferral()
            .then(r => { if (alive) setReferral(r); })
            .catch(() => { if (alive) setReferral(null); });
        return () => { alive = false; };
    }, [hasReferrer]);

    // ── no referral: a friend signs up with my link while I'm here ─────────
    useEffect(() => {
        if (hasReferrer) return undefined;
        return live.current.deps.onReferralRedeemed((ev) => {
            if (!mounted.current || !ev?.username) return;
            const f: Friend = { username: ev.username, discriminator: ev.discriminator ?? null };
            setFriend(f);
            setJoins(n => n + 1);
            setFriendReq('idle');
            const { dots: F, reducedMotion: rm } = live.current;
            if (F) {
                setTags(null);
                const shape = pair(F.N, meOrb(), { glyph: initial(f.username), color: COL.ice }, true);
                if (rm) {
                    F.snap(shape);
                    pairTags(meLabel(), formatUserTag(f.username, f.discriminator));
                } else {
                    void F.morph(shape, { ms: 1200, stagger: 0.4, arc: 0.7 });
                    window.setTimeout(() => {
                        if (!mounted.current) return;
                        F.pulse(1.1);
                        pairTags(meLabel(), formatUserTag(f.username, f.discriminator));
                    }, 850);
                }
            }
            // Celebrate from the new headline once it has rendered.
            requestAnimationFrame(() => {
                const r = h1Ref.current?.getBoundingClientRect();
                if (r) confetti(r.left + 120, r.top + 20, rm);
            });
        });
    }, [hasReferrer, meOrb, meLabel, pairTags]);

    // ── actions ─────────────────────────────────────────────────────────────
    const sendTo = useCallback(async (who: Friend, set: (s: ReqState) => void, isReferrer: boolean) => {
        if (who.discriminator === null) return;
        set('sending');
        let res: FriendRequestResult;
        try { res = await live.current.deps.sendFriendRequest(who.username, who.discriminator); } catch { res = 'failed'; }
        set(res);
        if (res === 'sent' || res === 'already') setFlow({ friendRequestSentTo: formatUserTag(who.username, who.discriminator) });
        // The offer has been answered: one-shot, so the Dashboard's
        // ReferrerFriendOffer never asks again.
        if (isReferrer) live.current.deps.clearReferrer();
    }, [setFlow]);

    const onCopy = useCallback(async () => {
        if (!referral) return;
        try {
            await live.current.deps.writeClipboard(referral.url);
            setCopied(true);
            setCopyFailed(false);
        } catch {
            setCopyFailed(true);
        }
    }, [referral]);

    // ── copy column ─────────────────────────────────────────────────────────
    let copy: React.ReactNode;
    if (referrer) {
        const code = deps.referralCode || referrerTag;
        copy = (
            <>
                <p className="eyebrow">You were referred</p>
                <h1 className="h1">{cap(referrer.username)} brought you in.</h1>
                <p className="lede">You signed up with <b>{referrerTag}</b>’s link. Add them so they’re in your friends list when you arrive.</p>
                <div
                    className={`refchip${chip === 'pop' ? ' pop' : ''}`}
                    style={chip === 'hidden' ? { visibility: 'hidden' } : undefined}
                    data-ob-refchip={chip}
                >
                    <code>{code}</code>
                    <span className={`stamp${chip === 'pop' ? ' slam' : ''}`}>Applied</span>
                    {!!bonusDays && bonusDays > 0 && <span className="bn">+{bonusDays} days of Pro for you both</span>}
                </div>
                {bonusDays === 0 && (
                    <span className={`bonus muted${chip === 'pop' ? ' pop' : ''}`} style={chip === 'hidden' ? { visibility: 'hidden' } : undefined}>
                        No bonus days came with this code.
                    </span>
                )}
                <FriendBox
                    who={referrer}
                    state={refReq}
                    onSend={() => { void sendTo(referrer, setRefReq, true); }}
                />
            </>
        );
    } else if (!friend) {
        copy = (
            <>
                <p className="eyebrow">Bring your people</p>
                <h1 className="h1">Bring one friend.</h1>
                <p className="lede">Cipherline is better with the people you actually talk to. When a friend signs up with your link, you both get <b>7 days of Pro</b>. Up to {MAX_REFERRAL_REWARDS} friends.</p>
                <LinkBox referral={referral} copied={copied} copyFailed={copyFailed} onCopy={() => { void onCopy(); }} />
            </>
        );
    } else {
        const tag = formatUserTag(friend.username, friend.discriminator);
        // How many have used the link: what /billing/referral said on arrival,
        // plus the joins seen here. Unknown when the fetch failed.
        const n = referral ? referral.count + joins : null;
        const tally = joinTally(n);
        const rewarded = joinEarnedBonus(n);
        copy = (
            <>
                <p className="eyebrow">Bring your people</p>
                <h1 className={`h1${reducedMotion ? '' : ' ob-inv-h1-in'}`} ref={h1Ref} key={`h-${joins}`}>
                    {cap(friend.username)} joined with your link!
                </h1>
                <p className="lede"><b>{tag}</b> just signed up with your link.{tally}</p>
                {referral && (
                    <div className="refchip pop">
                        <code>{referral.code}</code>
                        <span className="ok"><Check size={14} strokeWidth={3} /> used by {friend.username}</span>
                        {rewarded && <span className="bn">+7 days of Pro for you both</span>}
                    </div>
                )}
                <FriendBox
                    key={`f-${joins}`}
                    who={friend}
                    state={friendReq}
                    onSend={() => { void sendTo(friend, setFriendReq, false); }}
                />
            </>
        );
    }

    return (
        <div className="step ob-invite" data-ob-step="invite" data-ob-mode={referrer ? 'ref' : friend ? 'joined' : 'link'}>
            <div className="copy">
                {copy}
                {deps.pendingInviteCode && <InviteRow code={deps.pendingInviteCode} token={deps.token} />}
                <div className="off">
                    <span className="mk"><img src={cipherlineMark} alt="" draggable={false} /></span>
                    <div className="t">
                        <b>Also join the official Cipherline server</b>
                        <span>News, help and other people trying Cipherline.</span>
                    </div>
                    <ClToggle
                        checked={flow.joinOfficial}
                        onChange={(v) => setFlow({ joinOfficial: v })}
                        aria-label="Also join the official Cipherline server"
                    />
                </div>
                <StepActions onBack={onBack} onNext={onNext} nextLabel="Open Cipherline" nextIcon={<ArrowRight size={16} />} />
            </div>
            <div className="viz" ref={vizRef} aria-hidden />
            {/* Portalled to the overlay root: the step wrapper's finished enter
                animation keeps a (identity) transform + filter, which would make
                it the containing block of this `position: fixed` layer. */}
            {tagRoot && createPortal(<DotTagLayer field={dots} tags={tags} />, tagRoot)}
        </div>
    );
};
