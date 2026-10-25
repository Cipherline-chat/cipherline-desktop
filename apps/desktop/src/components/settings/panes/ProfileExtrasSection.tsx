import React, { useEffect, useState } from 'react';
import axios from 'axios';
import {
    ArrowDown, ArrowUp, BadgeCheck, BarChart3, ChevronDown, Gamepad2, Heart, Link2, Lock, Pencil, Plus, Trophy, X, type LucideIcon,
} from 'lucide-react';
import { ClButton, ClModal } from '../../cl';
import { API_BASE } from '../../../constants';
import { useToast } from '../../../contexts/ToastContext';
import { useUserAchievements } from '../../../hooks/useUserAchievements';
import { ACHIEVEMENTS } from '../../../utils/achievements/catalog';
import { patchErrorMessage } from '../../../utils/patchErrorMessage';
import { SettingsDisclosure } from '../SettingsDisclosure';
import { ProfileLinksEditor } from './ProfileLinksEditor';
import { ProfileGamesEditor } from './ProfileGamesEditor';
import { SteamConnect } from './SteamConnect';
import { useSteamCard } from '../../../hooks/useProfileRelations';
import {
    BLOCK_LABELS, INTERESTS, INTERESTS_MAX, MAX_LEVEL, SHOWCASE_BLOCKS, SLOT_LEVELS,
    TOP_ACHIEVEMENTS_MAX, BASE_SHOWCASE_SLOTS, cleanInterests, interestLabel, nextSlotLevel, showcaseBlocksOf,
    type InterestGroup, type ShowcaseBlock,
} from '../../../utils/profileExtras';
import { levelFill } from '../../../utils/profileCardLayout';
import { sanitizeLinks, type ProfileLink } from '../../../utils/profileLinks';
import type { ProfilePreviewData } from './ProfilePreviewCard';
import '../../../styles/profile-settings.css';

/**
 * Settings > Profile > Showcase: what your card shows.
 *
 *  - Your level (a ring) and what the next level adds.
 *  - The card's sections in order. Each row says what is in it; open it to
 *    edit that content right there (Steam, games, links, interests, featured
 *    achievements). Rows stay open until you close them (several at once).
 *    Reorder with the arrows, remove with the cross, add from the list of
 *    unused ones while you have a free slot.
 *
 * Every control saves at once (optimistic, reverted with the server's message
 * on failure) and PATCHes only the key that changed, so an older API keeps
 * working. The SERVER computes the level and enforces the slot count and every
 * limit; the locked slots here are UX. Nothing in this section is a paid perk.
 */

export interface ProfileExtrasSaved {
    profile_level?: { level: number; points: number; next_level_points: number | null; showcase_slots: number };
    profile_showcase?: { blocks: string[]; top_achievements: string[] };
    interests?: string[];
    widget_games?: string[] | null;
    profile_links?: Array<{ platform: string; handle: string }> | null;
    /** Your verified Steam account (server-set). */
    steam?: { steam_id: string } | null;
}

const BLOCK_ICONS: Record<ShowcaseBlock, LucideIcon> = {
    links: Link2, games: Gamepad2, steam: BadgeCheck, achievements: Trophy, most_played: BarChart3, interests: Heart,
};
/** The card calls the achievements section just "Achievements" (it shows the count too). */
const sectionLabel = (b: ShowcaseBlock): string => (b === 'achievements' ? 'Achievements' : BLOCK_LABELS[b]);
/** What each section is, for the "Add a section" list. */
const BLOCK_HINTS: Record<ShowcaseBlock, string> = {
    links: 'Steam and socials',
    games: 'Up to five favorites',
    steam: 'Your verified Steam account',
    achievements: 'Your three best',
    most_played: 'This week, friends only',
    interests: 'Shared ones light up',
};

export const ProfileExtrasSection: React.FC<{
    token: string | null;
    userId: string | undefined;
    saved: ProfileExtrasSaved;
    /** Drafts for the pane's live preview card. */
    onPreview?: (patch: Partial<ProfilePreviewData>) => void;
    onSaved: (body: Record<string, unknown>) => void | Promise<void>;
}> = ({ token, userId, saved, onPreview, onSaved }) => {
    const toast = useToast();
    const achievements = useUserAchievements(userId, true);
    const [busy, setBusy] = useState(false);
    const [editInterests, setEditInterests] = useState(false);
    // Rows stay open until closed; opening one never closes another.
    const [open, setOpen] = useState<ReadonlySet<ShowcaseBlock>>(() => new Set());
    const toggleOpen = (b: ShowcaseBlock, v?: boolean) => setOpen((prev) => {
        const next = new Set(prev);
        if (v ?? !next.has(b)) next.add(b); else next.delete(b);
        return next;
    });
    const steamCard = useSteamCard(saved.steam ? userId ?? null : null, token);
    const [adding, setAdding] = useState(false);

    const level = saved.profile_level?.level ?? 0;
    const slots = saved.profile_level?.showcase_slots ?? BASE_SHOWCASE_SLOTS;
    const cfg = showcaseBlocksOf(saved.profile_showcase);
    const [blocks, setBlocks] = useState<ShowcaseBlock[]>(cfg.blocks);
    const [top, setTop] = useState<string[]>(cfg.top_achievements);
    const [interests, setInterests] = useState<string[]>(cleanInterests(saved.interests));
    const [games, setGames] = useState<string[]>(saved.widget_games ?? []);
    const [links, setLinks] = useState<ProfileLink[]>(sanitizeLinks(saved.profile_links));

    // Follow the server copy when /auth/me refreshes (another device, or our own save).
    const savedKey = JSON.stringify([saved.profile_showcase, saved.interests, saved.widget_games, saved.profile_links]);
    const [seenKey, setSeenKey] = useState(savedKey);
    if (savedKey !== seenKey) {
        setSeenKey(savedKey);
        setBlocks(cfg.blocks); setTop(cfg.top_achievements);
        setInterests(cleanInterests(saved.interests));
        setGames(saved.widget_games ?? []); setLinks(sanitizeLinks(saved.profile_links));
    }

    useEffect(() => {
        onPreview?.({ level, blocks, topAchievements: top, interests, games, links });
    }, [onPreview, level, blocks, top, interests, games, links]);

    /** PATCH only `body`; on failure run `revert` and show the server's reason. */
    const save = async (body: Record<string, unknown>, revert: () => void) => {
        if (!token) return;
        setBusy(true);
        try {
            await axios.patch(`${API_BASE}/auth/profile`, body, { headers: { Authorization: `Bearer ${token}` } });
            await onSaved(body);
        } catch (err) {
            console.error('Failed to save profile showcase', err);
            revert();
            toast.push({ kind: 'error', title: 'Not saved', message: patchErrorMessage(err, 'Could not save that. Please try again.') });
        } finally {
            setBusy(false);
        }
    };

    const saveShowcase = (nextBlocks: ShowcaseBlock[], nextTop: string[]) => {
        const before = { blocks, top };
        const topClean = nextBlocks.includes('achievements') ? nextTop : [];
        setBlocks(nextBlocks); setTop(topClean);
        void save({ profile_showcase: { blocks: nextBlocks, top_achievements: topClean } }, () => { setBlocks(before.blocks); setTop(before.top); });
    };
    const move = (i: number, d: -1 | 1) => {
        const j = i + d;
        if (j < 0 || j >= blocks.length) return;
        const next = [...blocks];
        [next[i], next[j]] = [next[j], next[i]];
        saveShowcase(next, top);
    };
    const remove = (b: ShowcaseBlock) => { toggleOpen(b, false); saveShowcase(blocks.filter((x) => x !== b), top); };
    const add = (b: ShowcaseBlock) => { setAdding(false); toggleOpen(b, true); saveShowcase([...blocks, b], top); };
    const toggleTop = (id: string) => {
        const next = top.includes(id) ? top.filter((x) => x !== id) : [...top, id].slice(0, TOP_ACHIEVEMENTS_MAX);
        saveShowcase(blocks, next);
    };
    const toggleInterest = (id: string) => {
        const before = interests;
        if (!before.includes(id) && before.length >= INTERESTS_MAX) return;
        const next = before.includes(id) ? before.filter((x) => x !== id) : [...before, id].slice(0, INTERESTS_MAX);
        setInterests(next);
        void save({ interests: next }, () => setInterests(before));
    };
    const saveGames = (next: string[]) => {
        const before = games;
        setGames(next);
        void save({ widgets: { games: next } }, () => setGames(before));
    };
    const saveLinks = (next: ProfileLink[]) => {
        const before = links;
        setLinks(next);
        void save({ links: next }, () => setLinks(before));
    };

    const unlockedIds = new Set((achievements.data?.unlocked ?? []).map((u) => u.id));
    const unlockedDefs = ACHIEVEMENTS.filter((a) => unlockedIds.has(a.id));
    const unused = SHOWCASE_BLOCKS.filter((b) => !blocks.includes(b));
    const nextPts = saved.profile_level?.next_level_points ?? null;
    const pts = saved.profile_level?.points ?? 0;
    const nextSlot = nextSlotLevel(level);
    const groups: InterestGroup[] = ['Games', 'Music', 'Hobbies', 'Tech'];
    const full = blocks.length >= slots;

    /** One line saying what is in a section ("3 games"), or what it still needs. */
    const summaryOf = (b: ShowcaseBlock): { text: string; empty: boolean } => {
        const n = (count: number, one: string, many: string, none: string) => ({ text: count === 0 ? none : `${count} ${count === 1 ? one : many}`, empty: count === 0 });
        switch (b) {
            case 'links': return n(links.length, 'link', 'links', 'Add a link to show this');
            case 'games': return n(games.length, 'game', 'games', 'Add a game to show this');
            case 'steam': return saved.steam ? { text: steamCard?.persona_name ? `Verified: ${steamCard.persona_name}` : 'Verified', empty: false } : { text: 'Connect Steam to show this', empty: true };
            case 'interests': return n(interests.length, 'interest', 'interests', 'Pick an interest to show this');
            case 'achievements': return { text: top.length ? `${top.length} featured` : 'Your rarest, picked for you', empty: false };
            case 'most_played': return { text: 'Friends only, when sharing is on', empty: false };
            default: return { text: '', empty: false };
        }
    };

    const editor = (b: ShowcaseBlock): React.ReactNode => {
        switch (b) {
            case 'games': return <ProfileGamesEditor games={games} disabled={busy} onChange={saveGames} />;
            case 'steam': return (
                <SteamConnect
                    token={token} userId={userId} linked={!!saved.steam} card={steamCard}
                    onChanged={() => onSaved({})}
                />
            );
            case 'links': return (
                <ProfileLinksEditor
                    links={links} disabled={busy} onChange={saveLinks}
                    verifiedSteam={saved.steam ? { label: steamCard?.persona_name ?? 'Steam account' } : null}
                />
            );
            case 'interests': return (
                <div role="group" aria-label="Interests">
                    {interests.length > 0 && (
                        <ul className="ps-chips" aria-label="Picked interests">
                            {interests.map((id) => <li key={id} className="ps-chip"><span>{interestLabel(id)}</span></li>)}
                        </ul>
                    )}
                    <div className="ps-inline">
                        <ClButton variant="ghost" size="sm" onClick={() => setEditInterests(true)}><Pencil size={13} /> {interests.length ? 'Edit interests' : 'Pick interests'}</ClButton>
                    </div>
                    <p className="ps-note">Up to {INTERESTS_MAX}. Same visibility as your favorite games.</p>
                </div>
            );
            case 'achievements': return (
                <div role="group" aria-label="Featured achievements">
                    {unlockedDefs.length === 0 ? (
                        <p className="ps-note" style={{ marginTop: 0 }}>Your card shows your achievements as you unlock them.</p>
                    ) : (
                        <>
                            <div className="ps-chips">
                                <button type="button" className="ps-chip" aria-pressed={top.length === 0} disabled={busy || top.length === 0} onClick={() => saveShowcase(blocks, [])}>
                                    <span>Automatic</span>
                                </button>
                                {unlockedDefs.map((a) => {
                                    const on = top.includes(a.id);
                                    const isFull = !on && top.length >= TOP_ACHIEVEMENTS_MAX;
                                    return (
                                        <button key={a.id} type="button" className="ps-chip" aria-pressed={on} disabled={busy || isFull} onClick={() => toggleTop(a.id)}>
                                            <span>{a.name}</span>
                                        </button>
                                    );
                                })}
                            </div>
                            <p className="ps-note">Automatic shows your rarest. Or pick up to {TOP_ACHIEVEMENTS_MAX} ({top.length} picked).</p>
                        </>
                    )}
                </div>
            );
            case 'most_played': return (
                <p className="ps-note" style={{ marginTop: 0 }}>
                    Your top three games this week. Only friends see it, and only while sharing is on in Personalize, under Activity.
                </p>
            );
            default: return null;
        }
    };

    const ringR = 21, ringC = 2 * Math.PI * ringR;

    return (
        <>
            <SettingsDisclosure
                id="profile.showcase" variant="card" title="Showcase"
                summary={`Level ${level}${level >= MAX_LEVEL ? ' (max)' : ''}, ${blocks.length} of ${slots} sections`}
                labels={['Showcase', 'Level', 'Steam', 'Connect Steam', 'Top achievements', 'Games & links', 'Favorite games', 'Links', 'Interests']}
            >
                <div data-testid="extras-section" aria-busy={busy}>
                    <div className="ps-level" data-testid="level-card">
                        <span className="ps-level-ring" role="img" aria-label={`Level ${level} of ${MAX_LEVEL}`}>
                            <svg viewBox="0 0 48 48" aria-hidden="true">
                                <circle cx="24" cy="24" r={ringR} fill="none" stroke="rgba(255,255,255,.1)" strokeWidth="3.5" />
                                <circle
                                    className="pbm-arc" cx="24" cy="24" r={ringR} fill="none" stroke="var(--cl-lume, #25E0C8)" strokeWidth="3.5" strokeLinecap="round"
                                    strokeDasharray={`${(ringC * levelFill(level, MAX_LEVEL)).toFixed(2)} ${ringC.toFixed(2)}`}
                                />
                            </svg>
                            <b>{level}</b>
                        </span>
                        <span className="ps-level-txt">
                            <b>Level {level}{level >= MAX_LEVEL ? ', the top' : ''}</b>
                            <span>
                                {nextPts ? `${pts} of ${nextPts} points to level ${level + 1}. ` : `${pts} points. `}
                                {nextSlot ? `Level ${nextSlot} adds a section.` : 'Every section slot is yours.'}
                            </span>
                            <span>Achievements and easter eggs earn points.</span>
                        </span>
                    </div>

                    <div className="ps-secs-head">
                        <h4 id="px-showcase-h">Sections on your card</h4>
                        <span className="ps-count">{blocks.length} of {slots}</span>
                    </div>
                    <ol className="ps-secs" aria-labelledby="px-showcase-h" data-testid="showcase-slots">
                        {blocks.map((b, i) => {
                            const isOpen = open.has(b);
                            const sum = summaryOf(b);
                            const Icon = BLOCK_ICONS[b];
                            return (
                                <li key={b} className="ps-sec" data-open={isOpen ? 'true' : undefined} data-testid={`showcase-slot-${i}`}>
                                    <div className="ps-sec-row">
                                        <button
                                            type="button" className="ps-sec-main" aria-expanded={isOpen} aria-controls={`ps-sec-${b}`}
                                            onClick={() => toggleOpen(b)}
                                        >
                                            <span className="ps-sec-ico">{React.createElement(Icon, { size: 16, 'aria-hidden': true })}</span>
                                            <span className="ps-sec-txt">
                                                <b>{sectionLabel(b)}</b>
                                                <span data-empty={sum.empty ? 'true' : undefined}>{sum.text}</span>
                                            </span>
                                            <ChevronDown size={15} className="su-pick-chev" aria-hidden="true" />
                                        </button>
                                        <button type="button" className="su-iconbtn" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label={`Move ${BLOCK_LABELS[b]} up`}><ArrowUp size={14} /></button>
                                        <button type="button" className="su-iconbtn" disabled={busy || i === blocks.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${BLOCK_LABELS[b]} down`}><ArrowDown size={14} /></button>
                                        <button type="button" className="su-iconbtn" disabled={busy} onClick={() => remove(b)} aria-label={`Remove ${BLOCK_LABELS[b]} from your card`}><X size={14} /></button>
                                    </div>
                                    {isOpen && <div className="ps-sec-body" id={`ps-sec-${b}`}>{editor(b)}</div>}
                                </li>
                            );
                        })}
                    </ol>

                    {unused.length > 0 && (
                        <div className="ps-add">
                            <button
                                type="button" className="ps-add-btn" aria-expanded={adding} disabled={full}
                                onClick={() => setAdding((v) => !v)} data-testid="showcase-add"
                            >
                                {full ? <Lock size={14} aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
                                {full ? (nextSlot ? `All ${slots} slots in use. Level ${nextSlot} adds one.` : `All ${slots} slots in use.`) : 'Add a section'}
                            </button>
                            {adding && !full && (
                                <div className="ps-add-list" role="group" aria-label="Add to your card">
                                    {unused.map((b) => (
                                        <button key={b} type="button" className="ps-add-opt" disabled={busy} onClick={() => add(b)}>
                                            <span className="ps-sec-ico">{React.createElement(BLOCK_ICONS[b], { size: 16, 'aria-hidden': true })}</span>
                                            <span className="ps-sec-txt"><b>{sectionLabel(b)}</b><span>{BLOCK_HINTS[b]}</span></span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                    {!full && nextSlot && SLOT_LEVELS.includes(nextSlot as (typeof SLOT_LEVELS)[number]) && (
                        <p className="ps-locked"><Lock size={11} aria-hidden="true" /> Level {nextSlot} adds another slot.</p>
                    )}
                    <p className="ps-note">Your card opens the first four; the rest fold under &ldquo;Show more&rdquo;. Achievements and most played still appear after these when you leave them out.</p>
                </div>
            </SettingsDisclosure>

            <ClModal open={editInterests} onClose={() => setEditInterests(false)} width={520} label="Edit interests">
                <div className="p-5" data-testid="interests-dialog">
                    <div className="flex items-baseline justify-between gap-3 mb-3">
                        <h3 className="m-0 text-[16px]" style={{ fontFamily: 'var(--cl-font-display)' }}>Interests</h3>
                        <span className="ps-count">{interests.length} of {INTERESTS_MAX}</span>
                    </div>
                    <div className="custom-scrollbar" style={{ maxHeight: '55vh', overflowY: 'auto' }}>
                        {groups.map((g) => (
                            <div key={g} className="mb-3" role="group" aria-label={g}>
                                <p className="ps-sub">{g}</p>
                                <div className="ps-chips">
                                    {INTERESTS.filter((i) => i.group === g).map((i) => {
                                        const on = interests.includes(i.id);
                                        const isFull = !on && interests.length >= INTERESTS_MAX;
                                        return (
                                            <button
                                                key={i.id} type="button" className="ps-chip" aria-pressed={on} disabled={busy || isFull}
                                                title={isFull ? `You can pick up to ${INTERESTS_MAX}` : undefined}
                                                onClick={() => toggleInterest(i.id)}
                                            ><span>{i.label}</span></button>
                                        );
                                    })}
                                </div>
                            </div>
                        ))}
                    </div>
                    <div className="flex justify-end mt-4">
                        <ClButton variant="primary" onClick={() => setEditInterests(false)}>Done</ClButton>
                    </div>
                </div>
            </ClModal>
        </>
    );
};

export default ProfileExtrasSection;
