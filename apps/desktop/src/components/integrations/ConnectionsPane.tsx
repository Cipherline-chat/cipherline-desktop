import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Check, Globe, Headphones, ListMusic, X } from 'lucide-react';
import { ClButton, ClInput, ClToggle } from '../cl';
import { API_BASE } from '../../constants';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import { SettingsDisclosure } from '../settings/SettingsDisclosure';
import { SteamConnect } from '../settings/panes/SteamConnect';
import { useSteamCard } from '../../hooks/useProfileRelations';
import { forgetUserIntegrations, useMyIntegrations } from '../../hooks/useIntegrations';
import { patchErrorMessage } from '../../utils/patchErrorMessage';
import { parseSpotifyLink, readSpotifyItems, SPOTIFY_SHOWCASE_MAX, spotifyItemUrl, type SpotifyItem } from '../../utils/integrations/api';
import { SOURCE_LABEL, useListening } from '../../utils/integrations/listening';
import { setListeningPrefs, useListeningPrefs } from '../../utils/integrations/listeningPrefs';
import { canReadNowPlaying, getNowPlaying, type NowPlayingRead } from '../../utils/integrations/nowPlaying';
import { MusicNoteIcon } from './MusicNoteIcon';
import { IntegrationArt } from './IntegrationArt';
import { SteamShowcase } from './SteamShowcase';
import { SpotifyShowcase } from './SpotifyShowcase';
// SteamConnect's rows (ps-steam) and the settings rows (su-row) live in these sheets.
import '../../styles/settings-ui.css';
import '../../styles/profile-settings.css';
import '../../styles/integrations.css';

/**
 * Settings > Connections: everything a profile can pull in from elsewhere.
 *
 *  - Steam: the verified link (Steam OpenID, always available) and, when the
 *    server has STEAM_WEB_API_KEY, a preview of the showcase it adds.
 *  - Listening status: share what this computer is playing with friends
 *    (OS media session; OFF by default; per device).
 *  - Spotify showcase: up to three public playlists / albums (public links,
 *    no Spotify account).
 *
 * Anything the server does not offer is simply not drawn (dormant).
 */
export const ConnectionsPane: React.FC = () => {
    const { user, token, refreshProfile } = useAuth();
    const userId = user?.user_id ?? null;
    const mine = useMyIntegrations(token ?? null);
    const steamLinked = !!user?.steam;
    const steamCard = useSteamCard(steamLinked ? userId : null, token ?? null);
    const available = mine.data?.available ?? null;

    return (
        <div className="ig-pane" data-testid="connections-pane">
            <SettingsDisclosure
                id="connections.steam" variant="card" title="Steam" defaultOpen
                summary={steamLinked ? `Verified${steamCard?.persona_name ? `: ${steamCard.persona_name}` : ''}` : 'Not connected'}
                labels={['Steam', 'Connect Steam', 'Steam level', 'Recently played']}
            >
                <SteamConnect token={token ?? null} userId={userId ?? undefined} linked={steamLinked} card={steamCard} onChanged={refreshProfile} />
                {steamLinked && available?.steamData && (
                    steamCard?.activity ? (
                        <div className="ig-preview">
                            <p className="su-hint">Shown on your profile to whoever can see your links. Remove the Steam block from your profile showcase to hide it.</p>
                            <SteamShowcase activity={steamCard.activity} token={token ?? null} isSelf />
                        </div>
                    ) : (
                        <p className="su-hint">Your Steam level and recent games show on your profile while the Steam block is in your showcase.</p>
                    )
                )}
            </SettingsDisclosure>

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

const ListeningSection: React.FC<{ userId: string | null }> = ({ userId }) => {
    const prefs = useListeningPrefs(userId);
    const live = useListening(prefs.share ? userId : null);
    const bridge = canReadNowPlaying();
    // With sharing off, a one-off read shows what WOULD be shared (nothing is sent).
    const [probe, setProbe] = useState<NowPlayingRead | null>(null);
    useEffect(() => {
        if (!bridge || prefs.share) return;
        let cancelled = false;
        getNowPlaying(prefs.includeBrowser).then((r) => { if (!cancelled) setProbe(r); });
        return () => { cancelled = true; };
    }, [bridge, prefs.share, prefs.includeBrowser]);

    const unsupported = !bridge || (!prefs.share && probe?.supported === false);
    const preview = prefs.share
        ? (live ? { title: live.track, artist: live.artist, app: SOURCE_LABEL[live.source], art: live.art ?? null } : null)
        : !prefs.share && probe?.supported && probe.playing
            ? { title: probe.playing.title, artist: probe.playing.artist, app: SOURCE_LABEL[probe.playing.source], art: probe.playing.art }
            : null;

    return (
        <SettingsDisclosure
            id="connections.listening" variant="card" title="Listening status" defaultOpen
            summary={prefs.share ? 'Shared with friends' : 'Off'}
            labels={['Share what I’m listening to', 'Listening to', 'Music status', 'Spotify status', 'Include music in my browser']}
        >
            <p className="su-hint" style={{ margin: '0 0 4px' }}>
                Shows &ldquo;Listening to&rdquo; with the song and artist under your name, to friends only, like a game.
                It is read from your computer&rsquo;s media controls, so it works with Spotify, Apple Music, TIDAL and more, without signing in anywhere.
                The cover stays on this device.
            </p>
            <div className="su-row">
                <span className={`sd-tile${prefs.share ? '' : ' sd-tile--dim'}`}><Headphones size={16} /></span>
                <div className="su-row-text">
                    <span className="su-row-label">Share what I&rsquo;m listening to</span>
                    <span className="su-row-hint">{prefs.share ? 'On for this computer. Pauses while you are away.' : 'Off. Nothing is read or shared.'}</span>
                </div>
                <div className="su-row-ctl">
                    <ClToggle checked={prefs.share} disabled={!userId || unsupported} onChange={(v) => userId && setListeningPrefs(userId, { share: v })} aria-label="Share what I'm listening to" />
                </div>
            </div>
            <div className="su-row">
                <span className={`sd-tile${prefs.includeBrowser ? '' : ' sd-tile--dim'}`}><Globe size={16} /></span>
                <div className="su-row-text">
                    <span className="su-row-label">Include music playing in my browser</span>
                    <span className="su-row-hint">YouTube and web players report whatever is playing, videos included.</span>
                </div>
                <div className="su-row-ctl">
                    <ClToggle checked={prefs.includeBrowser} disabled={!userId || unsupported} onChange={(v) => userId && setListeningPrefs(userId, { includeBrowser: v })} aria-label="Include music playing in my browser" />
                </div>
            </div>

            <div className="ig-now" data-state={unsupported ? 'unsupported' : preview ? 'playing' : 'idle'} aria-live="polite" data-testid="listening-preview">
                {unsupported ? (
                    <p>{bridge
                        ? 'This computer does not report what is playing. On Linux, install playerctl.'
                        : 'Update Cipherline to share what you’re listening to.'}</p>
                ) : preview ? (
                    <>
                        <IntegrationArt refs={null} src={preview.art} token={null} className="ig-now-art" fallback={<MusicNoteIcon size={18} />} />
                        <span className="ig-now-txt">
                            <span className="ig-now-kind">{prefs.share ? 'Friends see' : 'Would share'}</span>
                            <b><MusicNoteIcon size={12} className="ig-note" />Listening to {preview.title}</b>
                            <span>by {preview.artist}{preview.app ? ` on ${preview.app}` : ''}</span>
                        </span>
                    </>
                ) : (
                    <p>Nothing is playing right now.</p>
                )}
            </div>
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
