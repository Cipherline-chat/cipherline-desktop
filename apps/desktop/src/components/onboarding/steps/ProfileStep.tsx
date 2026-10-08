import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Image as ImageIcon, Trash2 } from 'lucide-react';
import { USERNAME_REGEX, padDiscriminator } from '@cipherline/shared';
import { ClImageCropper, ClInput, ClTextarea } from '../../cl';
import { Keys } from '../../mascot/Keys';
import { Banner } from '../../Banner';
import { EncryptedAvatar } from '../../EncryptedAvatar';
import { AVATAR_OUTPUT, BANNER_OUTPUT } from '../../../utils/imageCrop';
import { IMAGE_ACCEPT_ATTR, validateImageUpload } from '../../../utils/imageUploadValidation';
import { StepActions } from '../OnboardingFlow';
import { hasLiveTrial } from '../ending/endingTrial';
import { ProfileCardPreview } from '../ProfileCardPreview';
import type { OnboardingUser, StepProps } from '../types';
import './profile.css';

/**
 * Step 3: "Make it yours." (approved prototype: scratchpad ob6, README
 * "Profile: the real card, in 3D"; js/main.js R.profile).
 *
 * - The name is REQUIRED and IS the username. Signup no longer sends one:
 *   the account has a temporary `user_<hex>` name and /auth/me says
 *   `username_pending` until PATCH /auth/profile receives a username, which
 *   re-allocates the #tag server-side and clears the flag. So once a valid
 *   name settles, it is PATCHed on its own and the #tag shown is the one the
 *   SERVER answered; Continue waits for that.
 * - Photo (circle crop, 512²) and banner (Settings → Profile's wide crop,
 *   1500×600) go through the real ClImageCropper, and are uploaded on
 *   Continue (encrypted, same paths as Settings), then saved with the bio in
 *   one PATCH.
 * - The live card is the real profile popover in 3D (ProfileCardPreview).
 * - Keys reacts in a speech bubble (the old wizard's lines, plus the banner).
 */

/** How long a name must sit still before it is saved (and Keys reacts). */
const NAME_SETTLE_MS = 750;
const BIO_MAX = 160;
const TEMP_NAME_RE = /^user_[0-9a-f]{10}$/;

const GREETING = 'Nice to meet you! 👋';
const GREETING_2 = 'Let’s set up your profile.';
const keysNameLine = (n: string) => [`Love it — ${n}!`, `${n} — great name!`, `Nice to meet you, ${n}!`][n.length % 3];

/** The account already has a name of its own (not signup's temporary one). */
function hasRealName(user: OnboardingUser | null): boolean {
    if (!user) return false;
    if (user.username_pending === true) return false;
    if (user.username_pending === false) return true;
    // An API that predates the flag: judge by the temporary name's shape.
    return !TEMP_NAME_RE.test(user.username);
}

function apiMessage(e: unknown): string | null {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = (e as any)?.response?.data?.message;
    if (Array.isArray(m)) return m.filter(x => typeof x === 'string').join(' ') || null;
    return typeof m === 'string' && m ? m : null;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const httpStatus = (e: unknown): number | undefined => (e as any)?.response?.status;

/** A picked image: the cropped blob awaiting upload + its local preview URL,
 *  or the attachment already saved on the account. */
interface MediaState {
    blob: Blob | null;
    url: string | null;
    savedId: string | null;
    /** The user removed an image the account had. */
    removed: boolean;
}

type CropKind = 'avatar' | 'banner';

export const ProfileStep: React.FC<StepProps> = ({ deps, flow, setFlow, reducedMotion, onNext, onBack }) => {
    const { user } = deps;
    const realName = hasRealName(user);
    // The card shows the Pro pill exactly when the new account's trial started
    // (an active trial wears the badge like a paying user; a withheld one is
    // free). Same facts as the ending's trial beat.
    const proPill = hasLiveTrial({
        trialGranted: deps.trialGranted,
        referralApplied: deps.referralApplied,
        bonusDays: deps.bonusDays,
        referrerName: deps.referrer?.username ?? null,
        subscription: deps.subscription,
    });

    // ── the name (= username) ───────────────────────────────────────────────
    const [name, setName] = useState(() => flow.username ?? (realName && user ? user.username : ''));
    /** What the server has accepted (server truth). */
    const [saved, setSaved] = useState<{ username: string; discriminator: number | null } | null>(() =>
        flow.username ? { username: flow.username, discriminator: flow.discriminator }
            : realName && user ? { username: user.username, discriminator: user.discriminator } : null);
    const [nameInFlight, setNameInFlight] = useState(false);
    /** The last save error, for the value it failed on (no auto-retry loop). */
    const [nameError, setNameError] = useState<{ value: string; message: string; retryable: boolean } | null>(null);
    const v = name.trim();
    const nameValid = USERNAME_REGEX.test(v);
    const nameConfirmed = nameValid && saved?.username === v;

    // ── bio, photo, banner ──────────────────────────────────────────────────
    const [bio, setBio] = useState(() => flow.bio || user?.bio || '');
    const [avatar, setAvatar] = useState<MediaState>(() => ({ blob: null, url: flow.avatarPreview, savedId: user?.avatar_url ?? null, removed: false }));
    const [banner, setBanner] = useState<MediaState>(() => ({ blob: null, url: flow.bannerPreview, savedId: user?.banner_url ?? null, removed: false }));
    // A resume after a restart mounts this step before /auth/me has answered
    // (AuthContext starts with a blank profile). Adopt what the account already
    // saved once it arrives, unless the person has started typing/picking.
    // (Adjusted during render, React's "information from previous renders"
    // pattern, rather than in an effect.)
    const [adopted, setAdopted] = useState(() => !!user?.username);
    if (!adopted && user?.username) {
        setAdopted(true);
        if (hasRealName(user) && !name && !saved) {
            setName(user.username);
            setSaved({ username: user.username, discriminator: user.discriminator });
        }
        if (!bio && user.bio) setBio(user.bio);
        if (user.avatar_url && !avatar.savedId && !avatar.blob && !avatar.removed) setAvatar(m => ({ ...m, savedId: user.avatar_url }));
        if (user.banner_url && !banner.savedId && !banner.blob && !banner.removed) setBanner(m => ({ ...m, savedId: user.banner_url }));
    }
    const [cropTarget, setCropTarget] = useState<{ kind: CropKind; file: File } | null>(null);
    const [fileError, setFileError] = useState('');
    const avatarInput = useRef<HTMLInputElement>(null);
    const bannerInput = useRef<HTMLInputElement>(null);

    // ── Continue ────────────────────────────────────────────────────────────
    const [busy, setBusy] = useState(false);
    const [saveError, setSaveError] = useState('');
    /** Uploads already done for a blob, so a retry after a later failure does not re-upload. */
    const uploaded = useRef(new Map<Blob, string>());

    // ── Keys ────────────────────────────────────────────────────────────────
    const [line, setLine] = useState(GREETING);
    const interacted = useRef(false);
    const kkRef = useRef<HTMLDivElement>(null);
    const say = useCallback((l: string) => { interacted.current = true; setLine(l); }, []);
    const bounce = useCallback(() => {
        const el = kkRef.current;
        if (!el || reducedMotion) return;
        el.classList.remove('bounce');
        void el.offsetWidth;
        el.classList.add('bounce');
    }, [reducedMotion]);
    useEffect(() => {
        const t = window.setTimeout(() => { if (!interacted.current) setLine(GREETING_2); }, 1700);
        return () => window.clearTimeout(t);
    }, []);

    // Focus the name once the card has landed (not on touch screens).
    const nameRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        const t = window.setTimeout(() => {
            if (!window.matchMedia('(pointer: coarse)').matches) nameRef.current?.focus({ preventScroll: true });
        }, reducedMotion ? 0 : 1100);
        return () => window.clearTimeout(t);
    }, [reducedMotion]);

    // ── save the name once it settles ───────────────────────────────────────
    // One PATCH at a time; whenever the input and the server's answer differ
    // (and nothing is in flight, and this value has not just failed), a settled
    // valid name is saved. A response that arrives after the input moved on is
    // still server truth, so the effect simply runs again for the new value.
    const latestName = useRef(v);
    useEffect(() => { latestName.current = v; }, [v]);
    const mounted = useRef(true);
    // (Set on every mount: StrictMode mounts, unmounts and re-mounts in dev.)
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    // Through a ref: the host rebuilds `deps` whenever the Dashboard under the
    // overlay re-renders, and a changing callback would restart the settle timer.
    const patchRef = useRef(deps.patchProfile);
    useEffect(() => { patchRef.current = deps.patchProfile; }, [deps.patchProfile]);
    const saveName = useCallback(async (value: string) => {
        setNameInFlight(true);
        try {
            const me = await patchRef.current({ username: value });
            if (!mounted.current) return;
            setSaved({ username: me.username, discriminator: me.discriminator });
            setNameError(null);
            if (me.username === latestName.current) { say(keysNameLine(me.username)); bounce(); }
        } catch (e) {
            if (!mounted.current) return;
            const status = httpStatus(e);
            setNameError({
                value,
                message: apiMessage(e) || 'Couldn’t save your name. Check your connection and try again.',
                retryable: status === undefined || status >= 500,
            });
        } finally {
            if (mounted.current) setNameInFlight(false);
        }
    }, [say, bounce]);
    useEffect(() => {
        if (!nameValid || nameInFlight || busy) return;
        if (saved?.username === v) return;
        if (nameError?.value === v) return;
        const t = window.setTimeout(() => { void saveName(v); }, NAME_SETTLE_MS);
        return () => window.clearTimeout(t);
    }, [v, nameValid, nameInFlight, busy, saved, nameError, saveName]);

    // ── pickers + the cropper ───────────────────────────────────────────────
    // Local preview URLs are revoked when replaced/removed or when the step
    // goes away, EXCEPT the ones committed to the flow (later steps show them).
    const committed = useRef(new Set<string>([flow.avatarPreview, flow.bannerPreview].filter((u): u is string => !!u)));
    const release = (url: string | null) => { if (url && url.startsWith('blob:') && !committed.current.has(url)) URL.revokeObjectURL(url); };
    const mediaRef = useRef({ avatar, banner });
    useEffect(() => { mediaRef.current = { avatar, banner }; }, [avatar, banner]);
    useEffect(() => () => { release(mediaRef.current.avatar.url); release(mediaRef.current.banner.url); }, []);

    const openPicker = (kind: CropKind) => {
        if (busy) return;
        (kind === 'avatar' ? avatarInput : bannerInput).current?.click();
    };
    const onFile = (kind: CropKind) => (e: React.ChangeEvent<HTMLInputElement>) => {
        const result = validateImageUpload(e.target.files?.[0]);
        // Always clear the input: cancelling the cropper and re-picking the
        // same file must fire a change event again.
        e.target.value = '';
        if (!result.ok) { setFileError(result.reason); return; }
        setFileError('');
        setCropTarget({ kind, file: result.file });
    };
    const onCropped = (blob: Blob) => {
        const kind = cropTarget?.kind;
        setCropTarget(null);
        if (!kind) return;
        const url = URL.createObjectURL(blob);
        const set = kind === 'avatar' ? setAvatar : setBanner;
        release((kind === 'avatar' ? avatar : banner).url);
        set(m => ({ ...m, blob, url, removed: false }));
        say(kind === 'avatar' ? 'Ooh, nice photo! 📸' : 'Ooh, nice banner! 🌄');
        bounce();
    };
    const remove = (kind: CropKind) => {
        const m = kind === 'avatar' ? avatar : banner;
        release(m.url);
        (kind === 'avatar' ? setAvatar : setBanner)({ blob: null, url: null, savedId: null, removed: !!m.savedId || m.removed });
    };

    // ── Continue: upload, one PATCH, hand over ──────────────────────────────
    const canContinue = nameConfirmed && !nameInFlight && !busy;
    const onContinue = async () => {
        if (!canContinue) return;
        setBusy(true);
        setSaveError('');
        try {
            const upload = async (m: MediaState, fn: (b: Blob) => Promise<string>) => {
                if (!m.blob) return undefined;
                const done = uploaded.current.get(m.blob);
                if (done) return done;
                const id = await fn(m.blob);
                uploaded.current.set(m.blob, id);
                return id;
            };
            const avatarId = await upload(avatar, deps.uploadAvatar);
            const bannerId = await upload(banner, deps.uploadBanner);
            const body: Record<string, unknown> = { username: v, bio: bio.trim() };
            if (avatarId) body.avatar_url = avatarId;
            else if (avatar.removed) body.avatar_url = null;
            if (bannerId) body.banner_url = bannerId;
            else if (banner.removed) body.banner_url = null;
            const me = await deps.patchProfile(body);
            [avatar.url, banner.url].forEach(u => { if (u) committed.current.add(u); });
            setFlow({
                username: me.username,
                discriminator: me.discriminator,
                bio: bio.trim(),
                avatarPreview: avatar.url,
                bannerPreview: banner.url,
            });
            onNext();
        } catch (e) {
            if (mounted.current) setSaveError(apiMessage(e) || 'Couldn’t save your profile. Check your connection and try again.');
        } finally {
            if (mounted.current) setBusy(false);
        }
    };

    // ── what the form says about the name ───────────────────────────────────
    const errFor = nameError && nameError.value === v ? nameError : null;
    const nameBad = (!!v && !nameValid) || !!errFor;
    let nameMsg: React.ReactNode;
    if (v && !nameValid) nameMsg = '3–32 characters: letters, digits, and underscore only.';
    else if (errFor) {
        nameMsg = (
            <>
                {errFor.message}
                {errFor.retryable && <button type="button" className="retry" onClick={() => setNameError(null)}>Try again</button>}
            </>
        );
    } else if (nameConfirmed) {
        nameMsg = <>Friends find you by your tag, <b>{v}#{padDiscriminator(saved?.discriminator ?? 0)}</b>.</>;
    } else if (nameValid) {
        nameMsg = <>Friends find you by your tag, <b>{v}</b><span className="pend">#····</span>.</>;
    } else nameMsg = 'Friends find you by name + #tag.';

    const hasAvatar = !!(avatar.url || avatar.savedId);
    const hasBanner = !!(banner.url || banner.savedId);

    return (
        <div className="step step--profile" data-ob-step="profile">
            <div className="copy">
                <p className="eyebrow">Profile</p>
                <h1 className="h1">Make it yours.</h1>
                <p className="lede">This is your card, what people see when they click your name. Add a photo and a banner, or keep it simple.</p>

                <div className="pf-media">
                    <div className="pf-pick">
                        <button type="button" className="pf-btn" onClick={() => openPicker('avatar')} disabled={busy}>
                            <span className={`pf-thumb pf-thumb--round${hasAvatar ? ' has' : ''}`}>
                                {avatar.url ? <img src={avatar.url} alt="" />
                                    : avatar.savedId ? <EncryptedAvatar attachmentId={avatar.savedId} userId={deps.userId} token={deps.token} className="w-full h-full" disableClickProfile bypassFriendGate />
                                        : <Camera size={18} aria-hidden />}
                            </span>
                            <span className="pf-t"><b>Photo</b><small>{hasAvatar ? 'Change · circle crop' : 'Add a photo'}</small></span>
                        </button>
                        {hasAvatar && (
                            <button type="button" className="pf-x" aria-label="Remove photo" title="Remove photo" onClick={() => remove('avatar')} disabled={busy}>
                                <Trash2 size={13} />
                            </button>
                        )}
                    </div>
                    <div className="pf-pick">
                        <button type="button" className="pf-btn" onClick={() => openPicker('banner')} disabled={busy}>
                            <span className={`pf-thumb pf-thumb--wide${hasBanner ? ' has' : ''}`}>
                                {hasBanner
                                    ? <Banner attachmentId={banner.url ? null : banner.savedId} fallbackUserId={deps.userId} token={deps.token} height={44} bypassFriendGate src={banner.url} />
                                    : <ImageIcon size={18} aria-hidden />}
                            </span>
                            <span className="pf-t"><b>Banner</b><small>{hasBanner ? 'Change · wide crop' : 'Add a banner'}</small></span>
                        </button>
                        {hasBanner && (
                            <button type="button" className="pf-x" aria-label="Remove banner" title="Remove banner" onClick={() => remove('banner')} disabled={busy}>
                                <Trash2 size={13} />
                            </button>
                        )}
                    </div>
                    <input ref={avatarInput} type="file" accept={IMAGE_ACCEPT_ATTR} hidden onChange={onFile('avatar')} />
                    <input ref={bannerInput} type="file" accept={IMAGE_ACCEPT_ATTR} hidden onChange={onFile('banner')} />
                </div>
                {fileError && <p className="fmsg err pf-file-err" role="alert">{fileError}</p>}

                <div className="fgrp pf-name">
                    <label className="lbl pf-lbl" htmlFor="ob-pf-name">Your name <span className="sub">· your username, sets your #tag</span></label>
                    <ClInput
                        ref={nameRef}
                        id="ob-pf-name"
                        value={name}
                        onChange={e => { interacted.current = true; setName(e.target.value); }}
                        placeholder="Pick a name"
                        maxLength={32}
                        autoComplete="off"
                        spellCheck={false}
                        aria-required="true"
                        aria-invalid={nameBad}
                        aria-describedby="ob-pf-name-msg"
                        disabled={busy}
                    />
                    <p className={`fmsg${nameBad ? ' err' : ''}`} id="ob-pf-name-msg" aria-live="polite">{nameMsg}</p>
                </div>

                <div className="fgrp pf-bio">
                    <label className="lbl pf-lbl" htmlFor="ob-pf-bio">Bio <span className="sub">· optional</span><span className="cnt" aria-hidden>{bio.length} / {BIO_MAX}</span></label>
                    <ClTextarea
                        id="ob-pf-bio"
                        value={bio}
                        onChange={e => {
                            const had = !!bio.trim();
                            setBio(e.target.value);
                            if (!had && e.target.value.trim()) bounce();   // Keys stays silent for the bio
                        }}
                        placeholder="A line about you — show up however you like."
                        maxLength={BIO_MAX}
                        rows={3}
                        disabled={busy}
                    />
                </div>

                {saveError && <p className="ob-err" role="alert">{saveError}</p>}
                <StepActions onBack={onBack} onNext={onContinue} nextDisabled={!canContinue} loading={busy} />
            </div>

            <div className="pv">
                <div className="keysbox" aria-live="polite">
                    <div className="kk" ref={kkRef} onAnimationEnd={() => kkRef.current?.classList.remove('bounce')}>
                        <Keys size={70} interactive={false} waveOnMount={false} />
                    </div>
                    <div className="bubble" key={line}>{line}</div>
                </div>
                <ProfileCardPreview
                    userId={deps.userId}
                    token={deps.token}
                    name={nameValid ? v : null}
                    discriminator={nameConfirmed ? saved?.discriminator ?? null : null}
                    bio={bio}
                    avatarSrc={avatar.url}
                    bannerSrc={banner.url}
                    avatarId={avatar.savedId}
                    bannerId={banner.savedId}
                    reducedMotion={reducedMotion}
                    paused={!!cropTarget}
                    isPro={proPill}
                    onPickAvatar={() => openPicker('avatar')}
                    onPickBanner={() => openPicker('banner')}
                />
            </div>

            <ClImageCropper
                open={!!cropTarget}
                file={cropTarget?.file ?? null}
                outputWidth={cropTarget?.kind === 'banner' ? BANNER_OUTPUT.width : AVATAR_OUTPUT.width}
                outputHeight={cropTarget?.kind === 'banner' ? BANNER_OUTPUT.height : AVATAR_OUTPUT.height}
                shape={cropTarget?.kind === 'banner' ? 'rect' : 'circle'}
                title={cropTarget?.kind === 'banner' ? 'Position your banner' : 'Position your avatar'}
                onCancel={() => setCropTarget(null)}
                onConfirm={onCropped}
            />
        </div>
    );
};
