import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Check, Globe, Headphones, ListMusic, Tv, X } from 'lucide-react';
import { ClButton, ClInput, ClToggle } from '../cl';
import { API_BASE } from '../../constants';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { SettingsDisclosure } from '../settings/SettingsDisclosure';
import { forgetUserIntegrations, useMyIntegrations } from '../../hooks/useIntegrations';
import { patchErrorMessage } from '../../utils/patchErrorMessage';
import { parseSpotifyLink, readSpotifyItems, SPOTIFY_SHOWCASE_MAX, spotifyItemUrl, type SpotifyItem } from '../../utils/integrations/api';
import { ACTIVITY_LABEL, SOURCE_LABEL, useListening } from '../../utils/integrations/listening';
import { setListeningPrefs, useListeningPrefs } from '../../utils/integrations/listeningPrefs';
import { canReadNowPlaying, getNowPlaying, nowPlayingStatus, type NowPlaying, type NowPlayingRead } from '../../utils/integrations/nowPlaying';
import { ActivitySourceIcon } from './PlatformLogo';
import { IntegrationArt } from './IntegrationArt';
import { SpotifyShowcase } from './SpotifyShowcase';
// The settings rows (su-row) live in these sheets.
import '../../styles/settings-ui.css';
import '../../styles/integrations.css';

/**
 * Settings > Activity & Style > Activity: what friends can see you up to,
 * pulled in from elsewhere (this was the whole Connections pane until it was
 * merged with Personalize, 2026-10-28; ActivityStylePane draws it).
 *
 *  - Steam is NOT here any more: it lives under Settings > Profile > Showcase
 *    (ProfileSteamSection.tsx, owner 2026-10-28).
 *  - Listening status: share what this computer is playing with friends
 *    (OS media session; OFF by default; restored with a backup).
 *  - Spotify showcase: up to three public playlists / albums (public links,
 *    no Spotify account).
 *
 * Anything the server does not offer is simply not drawn (dormant).
 */
export const ConnectionsPane: React.FC = () => {
    const { user, token } = useAuth();
    const userId = user?.user_id ?? null;
    const mine = useMyIntegrations(token ?? null);
    const available = mine.data?.available ?? null;

    return (
        <div className="ig-pane" data-testid="connections-pane">
            <ListeningSection userId={userId} />

            {available?.spotifyShowcase && (
                <SpotifySection
                    key={(mine.data?.spotify ?? []).map((i) => i.id).join('|')}
                    token={token ?? null} userId={userId}
                    items={mine.data?.spotify ?? []}
                    onSaved={(items) => { mine.setSpotify(items); forgetUserIntegrations(userId); }}
                />
            )}
            {mine.error && <p className="su-hint" role="alert">Could not load your connections. Close Settings and open it again to retry.</p>}
        </div>
    );
};

// ── Listening status ────────────────────────────────────────────────────────

/** How often the pane re-reads while it is open and the window is focused (the reader caches 3 s). */
export const PANE_POLL_MS = 4000;

const sourceLabel = (p: NowPlaying) => p.player ?? SOURCE_LABEL[p.source] ?? 'your player';

const ListeningSection: React.FC<{ userId: string | null }> = ({ userId }) => {
    const prefs = useListeningPrefs(userId);
    const live = useListening(prefs.share ? userId : null);
    const bridge = canReadNowPlaying();
    // A live read while this pane is open and the window focused, so the status
    // follows the music (start a song, it shows). Nothing is sent from here: the
    // publisher (useListeningShare) is the only thing that talks to the API.
    const [probe, setProbe] = useState<NowPlayingRead | null>(null);
    useEffect(() => {
        if (!bridge) return;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const tick = async () => {
            if (cancelled) return;
            if (document.visibilityState === 'visible' && document.hasFocus()) {
                const r = await getNowPlaying({ includeBrowser: prefs.includeBrowser, includeWatching: prefs.includeWatching });
                if (cancelled) return;
                setProbe(r);
            }
            timer = setTimeout(() => void tick(), PANE_POLL_MS);
        };
        const onFocus = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => void tick(), 150); };
        window.addEventListener('focus', onFocus);
        void tick();
        return () => { cancelled = true; if (timer) clearTimeout(timer); window.removeEventListener('focus', onFocus); };
    }, [bridge, prefs.includeBrowser, prefs.includeWatching]);

    const read: NowPlayingRead | null = bridge ? probe : { supported: false, reason: 'old_app' };
    const status = nowPlayingStatus(read, sourceLabel);
    const unsupported = status.kind === 'unsupported';
    // With sharing on, what friends see (the published record); otherwise what WOULD be shared.
    const preview = prefs.share && live
        ? { kind: live.kind, source: live.source, title: live.track, artist: live.artist, app: SOURCE_LABEL[live.source], art: live.art ?? null }
        : read?.supported && read.playing
            ? { kind: read.playing.kind, source: read.playing.source, title: read.playing.title, artist: read.playing.artist, app: SOURCE_LABEL[read.playing.source], art: read.playing.art }
            : null;
    const previewDetail = !preview ? ''
        : preview.kind === 'watching'
            ? `${preview.artist}${preview.app && preview.app !== preview.artist ? ` on ${preview.app}` : ''}`
            : `by ${preview.artist}${preview.app ? ` on ${preview.app}` : ''}`;

    return (
        <SettingsDisclosure
            id="connections.listening" variant="card" title="Listening status" defaultOpen
            summary={prefs.share ? 'Shared with friends' : 'Off'}
            labels={['Share what I’m listening to', 'Listening to', 'Music status', 'Spotify status', 'Include my browser', 'Also share what I’m watching', 'Watching', 'YouTube status']}
        >
            <p className="su-hint" style={{ margin: '0 0 4px' }}>
                Shows &ldquo;Listening to&rdquo; with the song and artist under your name, to friends only, like a game.
                It is read from your computer&rsquo;s media controls, so it works with Spotify, Apple Music, TIDAL and more, without signing in anywhere.
                Your player&rsquo;s cover stays on this device; friends see the album&rsquo;s official cover when Cipherline can find it in a public music catalogue.
            </p>
            <div className="su-row">
                <span className={`sd-tile${prefs.share ? '' : ' sd-tile--dim'}`}><Headphones size={16} /></span>
                <div className="su-row-text">
                    <span className="su-row-label">Share what I&rsquo;m listening to</span>
                    <span className="su-row-hint">{prefs.share ? 'On for this computer, also while Cipherline is in the background or the tray. Clears when nothing is playing.' : 'Off. Nothing is shared. (This page checks what is playing only while it is open.)'}</span>
                </div>
                <div className="su-row-ctl">
                    <ClToggle checked={prefs.share} disabled={!userId || unsupported} onChange={(v) => userId && setListeningPrefs(userId, { share: v })} aria-label="Share what I'm listening to" />
                </div>
            </div>
            <div className="su-row">
                <span className={`sd-tile${prefs.includeBrowser ? '' : ' sd-tile--dim'}`}><Globe size={16} /></span>
                <div className="su-row-text">
                    <span className="su-row-label">Include my browser</span>
                    <span className="su-row-hint">Music in web players such as YouTube Music, Spotify or SoundCloud, and videos too if you share what you watch.</span>
                </div>
                <div className="su-row-ctl">
                    <ClToggle checked={prefs.includeBrowser} disabled={!userId || unsupported} onChange={(v) => userId && setListeningPrefs(userId, { includeBrowser: v })} aria-label="Include my browser" />
                </div>
            </div>
            <div className="su-row">
                <span className={`sd-tile${prefs.share && prefs.includeWatching ? '' : ' sd-tile--dim'}`}><Tv size={16} /></span>
                <div className="su-row-text">
                    <span className="su-row-label">Also share what I&rsquo;m watching</span>
                    <span className="su-row-hint">
                        {prefs.share
                            ? prefs.includeWatching && !prefs.includeBrowser
                                ? 'Videos in apps (Netflix, VLC…) are shared. YouTube and other sites in your browser also need “Include my browser” above.'
                                : 'Videos and shows: “Watching” with the title and the channel or app (YouTube, Netflix, VLC…). Off: videos are never shared.'
                            : 'Turn on sharing above first. Videos are never shared while this is off.'}
                    </span>
                </div>
                <div className="su-row-ctl">
                    <ClToggle checked={prefs.includeWatching} disabled={!userId || unsupported || !prefs.share} onChange={(v) => userId && setListeningPrefs(userId, { includeWatching: v })} aria-label="Also share what I'm watching" />
                </div>
            </div>

            {/* A long title is cut to two lines here (full text on hover); every other state's text is shown whole. */}
            <p className="ig-detect" data-state={status.kind} role="status" aria-live="polite" data-testid="listening-status"
                title={status.kind === 'playing' ? status.text : undefined}>
                <span className="ig-detect-t">{status.text}</span>
            </p>
            {preview && !unsupported && (
                <div className="ig-now" data-state="playing" data-testid="listening-preview">
                    <IntegrationArt refs={null} src={preview.art} token={null} className="ig-now-art" fallback={<ActivitySourceIcon kind={preview.kind} source={preview.source} size={18} />} />
                    <span className="ig-now-txt">
                        <span className="ig-now-kind">{prefs.share ? 'Friends see' : 'Would share'}</span>
                        <b title={`${ACTIVITY_LABEL[preview.kind]} ${preview.title}`}>
                            <ActivitySourceIcon kind={preview.kind} source={preview.source} size={14} className="ig-note" />
                            <span className="ig-now-t">{ACTIVITY_LABEL[preview.kind]} {preview.title}</span>
                        </b>
                        <span title={previewDetail}>{previewDetail}</span>
                    </span>
                </div>
            )}
            {preview?.art && !unsupported && (
                <p className="su-hint" style={{ margin: 0 }}>
                    {preview.kind === 'watching'
                        ? 'Only you see the thumbnail. Friends see the title, the channel or app and a TV.'
                        : 'This cover is only for you. Friends see the album\u2019s official cover from a public music catalogue when Cipherline finds one, otherwise a music note.'}
                </p>
            )}
        </SettingsDisclosure>
    );
};

// ── Spotify showcase ────────────────────────────────────────────────────────

const SpotifySection: React.FC<{
    token: string | null;
    userId: string | null;
    items: readonly SpotifyItem[];
    onSaved: (items: SpotifyItem[]) => void;
}> = ({ token, items, onSaved }) => {
    const toast = useToast();
    const saved = useMemo(() => items.map(spotifyItemUrl), [items]);
    // The parent keys this section on the saved list, so a save starts from fresh drafts.
    const [drafts, setDrafts] = useState<string[]>(() => pad(saved));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const filled = drafts.map((d) => d.trim()).filter(Boolean);
    const parsed = drafts.map((d) => (d.trim() ? parseSpotifyLink(d) : null));
    const invalid = drafts.some((d, i) => d.trim() && !parsed[i]);
    const dirty = JSON.stringify(filled) !== JSON.stringify(saved);

    const save = async () => {
        if (!token || busy || invalid) return;
        setBusy(true);
        setError(null);
        try {
            const res = await axios.put(`${API_BASE}/integrations/spotify`, { links: filled }, { headers: { Authorization: `Bearer ${token}` } });
            const next = readSpotifyItems(res.data?.spotify);
            onSaved(next);
            toast.push({ kind: 'success', title: 'Spotify showcase saved', message: next.length ? 'It shows on your profile now.' : 'Removed from your profile.' });
        } catch (err) {
            setError(patchErrorMessage(err, 'Could not save. Check the links and try again.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <SettingsDisclosure
            id="connections.spotify" variant="card" title="Spotify showcase" defaultOpen
            summary={items.length ? `${items.length} on your profile` : 'Empty'}
            labels={['Spotify', 'Playlists', 'Albums', 'Spotify showcase']}
        >
            <p className="su-hint" style={{ margin: '0 0 4px' }}>
                Paste links to up to three public playlists or albums (Share, Copy link in Spotify). People can open them from your profile. No Spotify account is connected.
            </p>
            <div className="ig-links">
                {drafts.map((d, i) => {
                    const bad = !!d.trim() && !parsed[i];
                    return (
                        <div key={i} className="ig-link" data-state={!d.trim() ? 'empty' : bad ? 'bad' : 'ok'}>
                            <span className="ig-link-ico" aria-hidden="true">
                                {!d.trim() ? <ListMusic size={15} /> : bad ? <X size={15} /> : <Check size={15} />}
                            </span>
                            <ClInput
                                value={d}
                                className={bad ? 'ig-inp-bad' : undefined}
                                onChange={(e) => setDrafts((all) => all.map((x, j) => (j === i ? e.target.value : x)))}
                                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save(); } }}
                                aria-label={`Spotify link ${i + 1}`}
                                placeholder={i === 0 ? 'https://open.spotify.com/playlist/\u2026' : undefined}
                                aria-invalid={bad || undefined}
                                spellCheck={false}
                            />
                        </div>
                    );
                })}
            </div>
            {invalid && <p className="ig-err" role="alert">Use a link to a Spotify playlist or album, like open.spotify.com/playlist/&hellip;</p>}
            {error && <p className="ig-err" role="alert">{error}</p>}
            <div className="ig-actions">
                <ClButton size="sm" onClick={() => void save()} disabled={!dirty || invalid || busy} loading={busy}>
                    {busy ? 'Checking links' : 'Save showcase'}
                </ClButton>
                {dirty && !busy && <ClButton size="sm" variant="ghost" onClick={() => { setDrafts(pad(saved)); setError(null); }}>Cancel</ClButton>}
            </div>
            {items.length > 0 && !dirty && (
                <div className="ig-preview">
                    <p className="su-hint">On your profile:</p>
                    <SpotifyShowcase items={items} token={token} />
                </div>
            )}
        </SettingsDisclosure>
    );
};

function pad(list: readonly string[]): string[] {
    const out = list.slice(0, SPOTIFY_SHOWCASE_MAX);
    while (out.length < SPOTIFY_SHOWCASE_MAX) out.push('');
    return out;
}

export default ConnectionsPane;
