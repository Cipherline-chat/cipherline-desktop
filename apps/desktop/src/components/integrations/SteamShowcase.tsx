import React from 'react';
import { EyeOff, Gamepad2, RefreshCw, Trophy } from 'lucide-react';
import { ProfileLinkIcon } from '../ProfileLinkIcon';
import { IntegrationArt } from './IntegrationArt';
import { openExternalLink } from '../../utils/openExternalLink';
import {
    formatDay, formatHours, formatMonth, formatPlaytime, steamLevelColor, steamPrivacyText, yearsSince, STEAM_PRIVACY_CACHE_NOTE,
    type SteamActivity, type SteamGameArt,
} from '../../utils/integrations/api';
import '../../styles/integrations.css';

/**
 * The Steam showcase. Data: GET /v1/users/:id/steam `activity` (the API's
 * STEAM_WEB_API_KEY; absent = this block is not drawn). Every image comes
 * through our art proxy (clients never talk to Steam). A game opens its Steam
 * store page through the validated external-link path.
 *
 *  - SteamShowcase   the full panel (full profile > Integrations, Settings >
 *                    Connections): identity, level + XP to the next level,
 *                    years on Steam, games / hours / badges, playing now, most
 *                    played ever, the last two weeks, recent achievements.
 *  - SteamHighlight  one compact row for the profile preview and the
 *                    overview's Steam block.
 *  - SteamPrivacyHint what Steam is hiding, and (on your own profile) the
 *                    exact Steam privacy setting that would show it.
 */

export const SteamLevelBadge: React.FC<{ level: number; size?: 'sm' | 'md' }> = ({ level, size = 'md' }) => (
    <span
        className="ig-lvl" data-size={size}
        style={{ ['--ig-lvl' as string]: steamLevelColor(level) } as React.CSSProperties}
        title={`Steam level ${level}`} aria-label={`Steam level ${level}`}
    >{level}</span>
);

const storeUrl = (appId: number) => `https://store.steampowered.com/app/${appId}/`;
export const SteamPrivacyHint: React.FC<{ activity: SteamActivity; isSelf: boolean }> = ({ activity, isSelf }) => {
    const t = steamPrivacyText(activity, isSelf);
    if (!t) return null;
    return (
        <p className="ig-steam-private" data-self={isSelf ? 'true' : undefined} data-testid="steam-privacy-hint">
            <EyeOff size={14} aria-hidden="true" />
            <span>{t}</span>
        </p>
    );
};

/**
 * The owner's notice when Steam is private and nothing public is left to show
 * (see steamHasShowcaseStats): what they will look like, how to change it, and
 * "Check again" (re-reads the card; the server caches Steam's answer, so the
 * copy says how long a change can take). Viewers never see this: they get no
 * card, just the verified Steam connection.
 */
export const SteamPrivateNotice: React.FC<{
    activity: SteamActivity;
    onCheckAgain?: () => void | Promise<void>;
    className?: string;
}> = ({ activity, onCheckAgain, className }) => {
    const [busy, setBusy] = React.useState(false);
    const what = activity.private ? 'profile' : 'game details';
    const check = async () => {
        if (!onCheckAgain || busy) return;
        setBusy(true);
        try { await onCheckAgain(); } finally { setBusy(false); }
    };
    return (
        <div className={['ig-steam-private', 'ig-steam-notice', className ?? ''].filter(Boolean).join(' ')} data-self="true" data-testid="steam-private-notice" role="status">
            <EyeOff size={14} aria-hidden="true" />
            <div>
                <p style={{ margin: 0 }}><b>Your Steam {what} {activity.private ? 'is' : 'are'} private.</b> Steam info (games, playtime, level and more) won't show on your Cipherline profile. You appear as a verified Steam account.</p>
                <p style={{ margin: '4px 0 0' }}>To show it: in Steam, open your profile, then Edit Profile &gt; Privacy Settings, and set <b>My profile</b> and <b>Game details</b> to Public. {STEAM_PRIVACY_CACHE_NOTE}</p>
                {onCheckAgain && (
                    <button type="button" className="ig-steam-recheck" onClick={() => void check()} disabled={busy} data-testid="steam-check-again" style={{ marginTop: 6, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <RefreshCw size={12} aria-hidden="true" />{busy ? 'Checking...' : 'Check again'}
                    </button>
                )}
            </div>
        </div>
    );
};

const GameRow: React.FC<{
    appId: number; name: string; art: SteamGameArt; token: string | null;
    big: string; small: string; meter: number; label: string;
}> = ({ appId, name, art, token, big, small, meter, label }) => (
    <li>
        <button
            type="button" className="ig-game"
            onClick={(e) => { e.stopPropagation(); openExternalLink(storeUrl(appId)); }}
            aria-label={`${name}: ${label}. Opens the Steam store page.`}
        >
            <IntegrationArt refs={[art.capsule, art.icon]} token={token} className="ig-capsule"
                fallback={<ProfileLinkIcon platform="steam" size={16} />} />
            <span className="ig-game-txt">
                <b>{name}</b>
                <span className="ig-game-meter" aria-hidden="true"><i style={{ transform: `scaleX(${Math.max(0.02, Math.min(1, meter))})` }} /></span>
            </span>
            <span className="ig-game-hours">
                <b>{big}</b>
                <span>{small}</span>
            </span>
        </button>
    </li>
);

export const SteamShowcase: React.FC<{
    activity: SteamActivity;
    token: string | null;
    isSelf?: boolean;
    /** The Steam persona + avatar, for the heading. */
    personaName?: string | null;
    avatar?: string | null;
    className?: string;
}> = ({ activity: a, token, isSelf = false, personaName, avatar, className }) => {
    const years = yearsSince(a.memberSince);
    const peak2w = Math.max(1, ...a.recent.map((g) => g.minutes2w));
    const peakAll = Math.max(1, ...a.topGames.map((g) => g.minutesTotal));
    const stats: Array<{ k: string; v: string; label: string }> = [];
    if (a.gameCount !== null) stats.push({ k: 'games', v: a.gameCount.toLocaleString('en-US'), label: a.gameCount === 1 ? 'game' : 'games' });
    if (a.totalMinutes !== null && a.totalMinutes > 0) stats.push({ k: 'hours', v: formatHours(a.totalMinutes).replace(/ h$/, ''), label: a.totalMinutes < 60 ? 'played' : 'hours played' });
    if (a.badgeCount !== null) stats.push({ k: 'badges', v: a.badgeCount.toLocaleString('en-US'), label: a.badgeCount === 1 ? 'badge' : 'badges' });
    if (years !== null) stats.push({ k: 'years', v: years < 1 ? '<1' : String(years), label: years === 1 ? 'year on Steam' : 'years on Steam' });
    const ach = a.achievements;
    const nothing = !a.private && !a.gamesPrivate && a.recent.length === 0 && a.topGames.length === 0 && !a.nowPlaying;

    return (
        <section className={['ig-steam', className ?? ''].filter(Boolean).join(' ')} aria-label="Steam" data-testid="steam-showcase">
            <div className="ig-steam-head">
                {avatar !== undefined && (
                    <span className="ig-steam-av" aria-hidden="true">
                        {avatar ? <img src={avatar} alt="" draggable={false} /> : <ProfileLinkIcon platform="steam" size={20} />}
                    </span>
                )}
                <span className="ig-steam-id">
                    <b><ProfileLinkIcon platform="steam" size={13} />{personaName ?? 'Steam'}</b>
                    <span>{[a.memberSince ? `Member since ${formatMonth(a.memberSince)}` : null].filter(Boolean).join(' · ') || 'Verified on Steam'}</span>
                </span>
                {a.level !== null && a.level > 0 && (
                    <span className="ig-steam-lvl">
                        <SteamLevelBadge level={a.level} />
                        {a.xp && (
                            <span className="ig-xp" title={`${a.xp.intoLevel.toLocaleString('en-US')} / ${a.xp.levelSpan.toLocaleString('en-US')} XP`}>
                                <span className="ig-xp-bar" role="progressbar" aria-valuemin={0} aria-valuemax={a.xp.levelSpan} aria-valuenow={a.xp.intoLevel}
                                    aria-label={`${a.xp.toNext.toLocaleString('en-US')} XP to level ${a.level + 1}`}>
                                    <i style={{ transform: `scaleX(${a.xp.intoLevel / a.xp.levelSpan})` }} />
                                </span>
                                <span className="ig-xp-txt">{a.xp.toNext.toLocaleString('en-US')} XP to {a.level + 1}</span>
                            </span>
                        )}
                    </span>
                )}
            </div>

            {stats.length > 0 && (
                <ul className="ig-stats" aria-label="Steam stats">
                    {stats.map((s) => <li key={s.k} data-stat={s.k}><b>{s.v}</b><span>{s.label}</span></li>)}
                </ul>
            )}

            <SteamPrivacyHint activity={a} isSelf={isSelf} />

            {a.nowPlaying && (
                <div className="ig-steam-now" data-testid="steam-now-playing">
                    <IntegrationArt refs={a.nowPlaying.art ? [a.nowPlaying.art.capsule, a.nowPlaying.art.icon] : null} token={token} className="ig-capsule"
                        fallback={<Gamepad2 size={16} />} />
                    <span><span className="ig-now-kind">Playing now</span><b>{a.nowPlaying.name}</b></span>
                </div>
            )}

            {a.topGames.length > 0 && (
                <div className="ig-steam-sec">
                    <h4 className="ig-sub">Most played</h4>
                    <ul className="ig-games">
                        {a.topGames.map((g) => (
                            <GameRow key={g.appId} appId={g.appId} name={g.name} art={g.art} token={token}
                                big={formatHours(g.minutesTotal)} small="all time" meter={g.minutesTotal / peakAll}
                                label={`${formatHours(g.minutesTotal)} played in total`} />
                        ))}
                    </ul>
                </div>
            )}

            {a.recent.length > 0 && (
                <div className="ig-steam-sec">
                    <h4 className="ig-sub">Last two weeks</h4>
                    <ul className="ig-games">
                        {a.recent.map((g) => (
                            <GameRow key={g.appId} appId={g.appId} name={g.name} art={g.art} token={token}
                                big={formatPlaytime(g.minutes2w)} small={`${formatPlaytime(g.minutesTotal)} total`} meter={g.minutes2w / peak2w}
                                label={`${formatPlaytime(g.minutes2w)} in the last two weeks, ${formatPlaytime(g.minutesTotal)} in total`} />
                        ))}
                    </ul>
                </div>
            )}

            {ach && (
                <div className="ig-steam-sec" data-testid="steam-achievements">
                    <h4 className="ig-sub"><Trophy size={12} aria-hidden="true" /> Achievements in {ach.game}</h4>
                    <div className="ig-ach-sum">
                        <span className="ig-xp-bar" role="progressbar" aria-valuemin={0} aria-valuemax={ach.total} aria-valuenow={ach.unlocked}
                            aria-label={`${ach.unlocked} of ${ach.total} achievements`}>
                            <i style={{ transform: `scaleX(${ach.unlocked / ach.total})` }} />
                        </span>
                        <span className="ig-ach-n">{ach.unlocked} / {ach.total}</span>
                    </div>
                    {ach.recent.length > 0 && (
                        <ul className="ig-ach">
                            {ach.recent.map((r) => (
                                <li key={`${r.name}-${r.unlockedOn ?? ''}`} title={r.description ?? undefined}>
                                    <IntegrationArt refs={r.icon} token={token} className="ig-ach-ico" fallback={<Trophy size={14} />} />
                                    <span className="ig-ach-txt"><b>{r.name}</b>{r.description && <span>{r.description}</span>}</span>
                                    {r.unlockedOn && <time dateTime={r.unlockedOn}>{formatDay(r.unlockedOn)}</time>}
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {nothing && (
                <p className="ig-steam-private">{isSelf ? 'Nothing played on Steam in the last two weeks.' : 'Nothing played on Steam lately.'}</p>
            )}
        </section>
    );
};

/**
 * One compact row: level, the headline numbers, and what is playing now (or
 * the most played game). For the profile preview and the overview's Steam
 * block; pressing it opens the full Steam panel.
 */
export const SteamHighlight: React.FC<{
    activity: SteamActivity;
    /** Reserved (the row draws no art: one line has no room for a capsule). */
    token: string | null;
    /** Reserved: the row reads the same for everyone (the full hint lives on the panel). */
    isSelf?: boolean;
    onOpen?: (e: React.MouseEvent) => void;
    style?: React.CSSProperties;
    className?: string;
}> = ({ activity: a, onOpen, style, className }) => {
    const years = yearsSince(a.memberSince);
    const facts = [
        a.gameCount !== null ? `${a.gameCount.toLocaleString('en-US')} ${a.gameCount === 1 ? 'game' : 'games'}` : null,
        a.totalMinutes ? formatHours(a.totalMinutes) : null,
        years !== null && years >= 1 ? `${years} ${years === 1 ? 'yr' : 'yrs'}` : null,
    ].filter(Boolean).join(' · ');
    const feature = a.nowPlaying
        ? { kind: 'Playing', name: a.nowPlaying.name }
        : a.topGames[0] ? { kind: 'Most played', name: a.topGames[0].name } : null;
    // No "details are private" line here (owner 2026-11-16): the card shows what Steam does share
    // (e.g. the level) and says nothing about what it hides. The account owner gets the how-to
    // notice in their own settings / profile instead (SteamPrivateNotice).
    if (a.level === null && !facts && !feature) return null;
    const inner = (
        <>
            {/* The level leads the row (far left), then a full-size "Steam" label (owner 2026-10-28). */}
            {a.level !== null && a.level > 0 && <SteamLevelBadge level={a.level} size="sm" />}
            <span className="ppo-hl-title ig-hl-steam"><ProfileLinkIcon platform="steam" size={14} /> Steam</span>
            <span className="ig-hl">
                <span className="ig-hl-txt">
                    {feature ? (
                        <>
                            <b>{feature.kind === 'Playing' ? <span className="ig-hl-live">Playing </span> : null}{feature.name}</b>
                            <span>{facts || (feature.kind === 'Most played' ? 'Most played' : '')}</span>
                        </>
                    ) : (
                        <>
                            <b>{a.level !== null ? `Level ${a.level}` : 'Steam'}</b>
                            {facts && <span>{facts}</span>}
                        </>
                    )}
                </span>
            </span>
        </>
    );
    const cls = ['ppo-hl', 'ig-hl-wrap', className ?? ''].filter(Boolean).join(' ');
    return onOpen
        ? <button type="button" className={cls} style={style} onClick={onOpen} data-testid="steam-highlight">{inner}</button>
        : <div className={cls} style={style} data-testid="steam-highlight">{inner}</div>;
};

export default SteamShowcase;
