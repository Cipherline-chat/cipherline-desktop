import React, { useEffect, useRef, useState } from 'react';
import { Trophy, X } from 'lucide-react';
import { useEscape } from '../hooks/useEscape';
import { flappyApi, type FlappyBoard, type FlappyEntry, type FlappyMe, type FlappyScope } from '../utils/flappyBest';

/**
 * The Firewall game's leaderboard: a panel over the game, Friends and Global
 * tabs, your row highlighted, and the opt-in for the global board.
 *
 *   - Friends: you and your accepted friends who have played. No opt-in needed.
 *   - Global: the top 100 among players who chose "Show me on the global
 *     leaderboard". That switch is OFF until you turn it on: nobody shows
 *     publicly without choosing to. Only your name#tag and score are shown.
 *
 * Keyboard: opens with focus on the active tab; Left/Right (and Home/End)
 * move between tabs; Tab reaches the switch and the close button; Esc closes
 * (through the shared Escape stack, so it closes this before the game).
 * Every state has words: loading, empty, error with Retry.
 */
export interface FlappyLeaderboardPanelProps {
    onClose: () => void;
    /** Called with the server's `me` whenever one arrives (so the game's HUD can show a best from another device). */
    onMe?: (me: FlappyMe) => void;
}

type Load = { status: 'loading' } | { status: 'error' } | { status: 'ok'; board: FlappyBoard };

const SCOPES: Array<{ id: FlappyScope; label: string }> = [
    { id: 'friends', label: 'Friends' },
    { id: 'global', label: 'Global' },
];

const tag = (e: Pick<FlappyEntry, 'username' | 'discriminator'>) =>
    e.discriminator ? `${e.username}#${String(e.discriminator).padStart(4, '0')}` : e.username;

export const FlappyLeaderboardPanel: React.FC<FlappyLeaderboardPanelProps> = ({ onClose, onMe }) => {
    const [scope, setScope] = useState<FlappyScope>('friends');
    const [load, setLoad] = useState<Load>({ status: 'loading' });
    const [optIn, setOptIn] = useState<boolean | null>(null); // null until the server has said
    const [optBusy, setOptBusy] = useState(false);
    const [optError, setOptError] = useState(false);
    const tabRefs = useRef<Record<FlappyScope, HTMLButtonElement | null>>({ friends: null, global: null });
    const onMeRef = useRef(onMe);
    useEffect(() => { onMeRef.current = onMe; });

    useEscape(onClose, true);

    // Fetch the board for the current tab; `reload` bumps to ask again (retry, or the opt-in changed
    // what the global list holds). The cleanup flag makes a stale answer (quick tab switching) harmless.
    const [reload, setReload] = useState(0);
    useEffect(() => {
        let alive = true;
        const api = flappyApi();
        void (api ? api.board(scope) : Promise.resolve(null)).then((board) => {
            if (!alive) return;
            if (!board) { setLoad({ status: 'error' }); return; }
            setLoad({ status: 'ok', board });
            setOptIn(board.me.global_opt_in);
            onMeRef.current?.(board.me);
        });
        return () => { alive = false; };
    }, [scope, reload]);
    const selectScope = (s: FlappyScope) => {
        if (s === scope) return;
        setLoad({ status: 'loading' });
        setScope(s);
    };
    const retry = () => {
        setLoad({ status: 'loading' });
        setReload((n) => n + 1);
    };
    useEffect(() => { tabRefs.current.friends?.focus({ preventScroll: true }); }, []);

    const onTabKey = (e: React.KeyboardEvent) => {
        const i = SCOPES.findIndex((s) => s.id === scope);
        let next = i;
        if (e.key === 'ArrowRight') next = (i + 1) % SCOPES.length;
        else if (e.key === 'ArrowLeft') next = (i - 1 + SCOPES.length) % SCOPES.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = SCOPES.length - 1;
        else return;
        e.preventDefault();
        e.stopPropagation();
        selectScope(SCOPES[next].id);
        tabRefs.current[SCOPES[next].id]?.focus();
    };

    const toggleOptIn = async () => {
        if (optBusy || optIn === null) return;
        const want = !optIn;
        setOptBusy(true);
        setOptError(false);
        setOptIn(want); // optimistic: the outcome is predictable
        const api = flappyApi();
        const done = api ? await api.setOptIn(want) : null;
        setOptBusy(false);
        if (done === null) { setOptIn(!want); setOptError(true); return; }
        setOptIn(done);
        if (scope === 'global') setReload((n) => n + 1); // you appear / vanish now
    };

    const board = load.status === 'ok' ? load.board : null;
    const me = board?.me;
    const youBelowCut = !!board && scope === 'global' && !!me?.global_opt_in && me.rank !== null && !board.entries.some((e) => e.is_me);

    return (
        <section className="fw-lb" role="dialog" aria-label="Firewall leaderboard" data-testid="fw-leaderboard">
            <header className="fw-lb-head">
                <span className="fw-lb-title"><Trophy size={15} strokeWidth={2.4} aria-hidden="true" /> Leaderboard</span>
                <button type="button" className="fw-close" onClick={onClose} aria-label="Close the leaderboard">
                    <X size={16} strokeWidth={2.4} />
                </button>
            </header>

            <div className="fw-lb-tabs" role="tablist" aria-label="Leaderboard scope" onKeyDown={onTabKey}>
                {SCOPES.map((s) => (
                    <button
                        key={s.id}
                        ref={(el) => { tabRefs.current[s.id] = el; }}
                        type="button"
                        role="tab"
                        id={`fw-lb-tab-${s.id}`}
                        aria-selected={scope === s.id}
                        aria-controls="fw-lb-list"
                        tabIndex={scope === s.id ? 0 : -1}
                        className={`fw-lb-tab${scope === s.id ? ' is-active' : ''}`}
                        onClick={() => selectScope(s.id)}
                    >
                        {s.label}
                    </button>
                ))}
            </div>

            <div id="fw-lb-list" className="fw-lb-body" role="tabpanel" aria-labelledby={`fw-lb-tab-${scope}`} aria-busy={load.status === 'loading'}>
                {load.status === 'loading' && <div className="fw-lb-note" role="status">Loading the leaderboard…</div>}

                {load.status === 'error' && (
                    <div className="fw-lb-note" role="alert">
                        Couldn’t load the leaderboard.
                        <div><button type="button" className="fw-btn" onClick={retry}>Try again</button></div>
                    </div>
                )}

                {board && board.entries.length === 0 && (
                    <div className="fw-lb-note" role="status">
                        {scope === 'friends'
                            ? 'None of your friends have played yet. Set the first score.'
                            : 'Nobody has joined the global leaderboard yet. Turn it on below to be the first.'}
                    </div>
                )}

                {board && board.entries.length > 0 && (
                    <ol className="fw-lb-list" aria-label={scope === 'friends' ? 'Friends leaderboard' : 'Global top 100'}>
                        {board.entries.map((e) => (
                            <li key={`${e.rank}-${e.username}-${e.discriminator ?? 0}`} className={`fw-lb-row${e.is_me ? ' is-me' : ''}`} aria-current={e.is_me ? 'true' : undefined}>
                                <span className="fw-lb-rank">{e.rank}</span>
                                <span className="fw-lb-name">{tag(e)}{e.is_me && <span className="fw-lb-you">You</span>}</span>
                                <span className="fw-lb-score">{e.score}</span>
                            </li>
                        ))}
                    </ol>
                )}

                {youBelowCut && me && (
                    <div className="fw-lb-row is-me fw-lb-below" aria-current="true">
                        <span className="fw-lb-rank">{me.rank}</span>
                        <span className="fw-lb-name">You<span className="fw-lb-you">outside the top 100</span></span>
                        <span className="fw-lb-score">{me.best_score}</span>
                    </div>
                )}

                {board && scope === 'friends' && me && me.best_score === 0 && board.entries.length > 0 && (
                    <div className="fw-lb-foot">Play a run to put yourself on the board.</div>
                )}
            </div>

            <div className="fw-lb-opt">
                <button
                    type="button"
                    role="switch"
                    aria-checked={optIn === true}
                    aria-describedby="fw-lb-opt-help"
                    className={`fw-switch${optIn ? ' is-on' : ''}`}
                    disabled={optIn === null || optBusy}
                    onClick={() => void toggleOptIn()}
                    data-testid="fw-optin"
                >
                    <span className="fw-switch-knob" aria-hidden="true" />
                    <span className="fw-switch-label">Show me on the global leaderboard</span>
                </button>
                <div id="fw-lb-opt-help" className="fw-lb-help">
                    {optError
                        ? 'Couldn’t save that. Try again.'
                        : optIn
                            ? 'Anyone can see your name#tag and best score on the global list. Friends see you either way.'
                            : 'Off. Only your friends see your score. Nobody appears on the global list without choosing to.'}
                </div>
            </div>
        </section>
    );
};

export default FlappyLeaderboardPanel;
