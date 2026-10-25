import React, { useState, useEffect, useCallback } from 'react';
import { Gamepad2, Plus, X, RefreshCw, EyeOff, Trash2, PlayCircle, ListTree } from 'lucide-react';
import { type GameSettingsHook } from '../hooks/useGameSettings';
import { ClToggle, ClButton, ClInput, ClSelect } from './cl';
import type { ClSelectOption } from './cl';
import { Keys } from './mascot/Keys';
import { SettingsDisclosure } from './settings/SettingsDisclosure';
import { usePlayfulLine } from '../hooks/useEasterEggs';
import { NO_GAME_POOL } from '../utils/eggPools';
import { dayNumber } from '../utils/easterEggs';

/**
 * Twilight · Game Activity — Descent redesign (phase 2): sd-card sections,
 * icon-tile master toggle, same detection/ignore interactions underneath.
 */
interface GameActivitySettingsProps {
    gameSettings: GameSettingsHook;
    /** Display name of whatever's currently detected as running, or null. */
    currentGame: string | null;
    /** The executable that produced that name. Surfaced because detection is
     *  an exe-name lookup, and when it's WRONG (a bundled runtime sitting in
     *  a game's folder, a suspended Game Pass title that never exited) the
     *  name alone tells you nothing about what to ignore — you'd be looking
     *  at "Forza Horizon 5" with Forza closed and no way to see why. */
    currentGameProcess?: string | null;
    /** Permanently ignores the currently-detected game and clears the live status. */
    onIgnoreCurrentGame: () => void;
}

const GameActivitySettings: React.FC<GameActivitySettingsProps> = ({ gameSettings, currentGame, currentGameProcess, onIgnoreCurrentGame }) => {
    // Egg: the "nothing detected" hint rotates by day (the plain line is always first in the pool).
    const noGameLine = usePlayfulLine(NO_GAME_POOL[0], NO_GAME_POOL, dayNumber(new Date()));
    const { settings, setShowGameActivity, addCustomGame, removeCustomGame, addIgnoredProcess, removeIgnoredProcess } = gameSettings;

    const [processes, setProcesses] = useState<string[]>([]);
    const [loadingProcesses, setLoadingProcesses] = useState(false);
    const [addingGame, setAddingGame] = useState(false);
    const [selectedProcess, setSelectedProcess] = useState('');
    const [displayName, setDisplayName] = useState('');

    const fetchProcesses = useCallback(async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- window.electronAPI members are optional/version-dependent and not all declared on the typed bridge
        const electronAPI = (window as any).electronAPI;
        if (!electronAPI?.getRunningProcesses) return;
        setLoadingProcesses(true);
        try {
            const procs: string[] = await electronAPI.getRunningProcesses();
            setProcesses(procs);
        } catch { /* best-effort; failure is non-fatal and intentionally ignored */ }
        setLoadingProcesses(false);
    }, []);

    useEffect(() => {
        fetchProcesses();
    }, [fetchProcesses]);

    const handleAddGame = () => {
        if (!selectedProcess || !displayName.trim()) return;
        addCustomGame(selectedProcess, displayName.trim());
        setSelectedProcess('');
        setDisplayName('');
        setAddingGame(false);
    };

    const customGameProcessNames = new Set(settings.customGames.map(g => g.processName));
    const ignoredSet = new Set(settings.ignoredProcesses);

    const availableProcesses = processes.filter(p =>
        !customGameProcessNames.has(p) && !ignoredSet.has(p)
    );

    const processOptions: ClSelectOption<string>[] = [
        { value: '', label: 'Select a running process…' },
        ...availableProcesses.map(p => ({ value: p, label: p })),
    ];

    return (
        <>
            {/* Rich presence: the switch, then what it would share right now. */}
            <div className="sd-card" data-labels="Detected game">
                <h3>Rich presence</h3>
                <p className="sd-sub">Detection is an executable-name lookup on this machine — nothing is scanned, nothing leaves unless you share it.</p>
                <div className="sd-row" style={{ borderTop: 'none' }}>
                    <span className={`sd-tile${settings.showGameActivity ? '' : ' sd-tile--dim'}`}><Gamepad2 size={16} /></span>
                    <div className="sd-rl">
                        <b>Share what you’re playing</b>
                        <span>Friends see the game name as your status. Turn it off and nothing is sent.</span>
                    </div>
                    <div className="sd-rc">
                        <ClToggle
                            checked={settings.showGameActivity}
                            onChange={setShowGameActivity}
                            aria-label="Show game activity"
                        />
                    </div>
                </div>
                <div className="sd-row">
                    <span className={`sd-tile${currentGame ? '' : ' sd-tile--dim'}`}>
                        {currentGame ? <PlayCircle size={16} /> : <Gamepad2 size={16} />}
                    </span>
                    <div className="sd-rl">
                        <b>{currentGame ?? 'Nothing detected'}</b>
                        <span>
                            {currentGame
                                ? settings.showGameActivity
                                    ? 'Showing as your status to friends right now.'
                                    : 'Detected, but not shared — "Share what you\'re playing" is off above.'
                                : noGameLine}
                        </span>
                        {currentGame && currentGameProcess && (
                            <span style={{ fontFamily: 'var(--cl-font-mono)', fontSize: 11, color: 'var(--cl-faint)', marginTop: 2 }}>
                                matched {currentGameProcess}.exe
                            </span>
                        )}
                    </div>
                    {currentGame && (
                        <div className="sd-rc">
                            <ClButton
                                size="sm"
                                variant="ghost"
                                onClick={onIgnoreCurrentGame}
                                tooltip={currentGameProcess ? `Never match ${currentGameProcess}.exe again` : undefined}
                            >
                                <EyeOff size={12} /> Ignore this
                            </ClButton>
                        </div>
                    )}
                </div>
            </div>

            {/* Custom Games */}
            <div className="sd-card">
                <div className="flex items-center justify-between">
                    <h3>Your games</h3>
                    <ClButton size="sm" variant="ghost" onClick={() => setAddingGame(true)}>
                        <Plus size={12} /> Add game
                    </ClButton>
                </div>
                <p className="sd-sub">Processes you’ve tagged as games by hand.</p>

                {addingGame && (
                    <div className="mb-3 p-3 rounded-lg space-y-2" style={{ background: 'rgba(0,0,0,.2)', border: '1px solid var(--cl-border)' }}>
                        <div className="flex items-center gap-2">
                            <div style={{ flex: 1 }}>
                                <ClSelect<string>
                                    value={selectedProcess}
                                    onChange={setSelectedProcess}
                                    options={processOptions}
                                />
                            </div>
                            <ClButton
                                icon
                                size="sm"
                                variant="ghost"
                                onClick={fetchProcesses}
                                disabled={loadingProcesses}
                                tooltip="Refresh process list"
                            >
                                <RefreshCw size={14} className={loadingProcesses ? 'animate-spin' : ''} />
                            </ClButton>
                        </div>
                        <ClInput
                            type="text"
                            value={displayName}
                            onChange={e => setDisplayName(e.target.value)}
                            placeholder="Display name (e.g. Counter-Strike 2)"
                            onKeyDown={e => { if (e.key === 'Enter') handleAddGame(); }}
                        />
                        <div className="flex items-center gap-2 justify-end">
                            <ClButton
                                size="sm"
                                variant="ghost"
                                onClick={() => { setAddingGame(false); setSelectedProcess(''); setDisplayName(''); }}
                            >
                                Cancel
                            </ClButton>
                            <ClButton
                                size="sm"
                                disabled={!selectedProcess || !displayName.trim()}
                                onClick={handleAddGame}
                            >
                                Add
                            </ClButton>
                        </div>
                    </div>
                )}

                {settings.customGames.length === 0 && !addingGame ? (
                    <div className="sx-empty">
                        <Keys size={44} waveOnMount={false} lively={false} />
                        <p><b>Nothing tagged yet</b>If Cipherline misses a game, “Add game” or the running list below turns its process into one.</p>
                    </div>
                ) : (
                    <div className="space-y-1">
                        {settings.customGames.map(game => (
                            <div key={game.processName} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-white/[0.03] group">
                                <Gamepad2 size={14} style={{ color: 'var(--cl-lume)', opacity: .6, flexShrink: 0 }} />
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm truncate" style={{ color: 'var(--cl-text)' }}>{game.displayName}</p>
                                    <p className="text-[11px] font-mono truncate" style={{ color: 'var(--cl-faint)' }}>{game.processName}</p>
                                </div>
                                <ClButton
                                    icon
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => removeCustomGame(game.processName)}
                                    tooltip="Remove"
                                    className="opacity-0 group-hover:opacity-100"
                                >
                                    <Trash2 size={13} />
                                </ClButton>
                            </div>
                        ))}
                    </div>
                )}

                <SettingsDisclosure
                    id="activity.running"
                    title="Running now"
                    summary="Every process on this machine, to tag as a game or ignore."
                    icon={<ListTree size={15} />}
                    badge={processes.length ? `${processes.length}` : null}
                    labels={['Custom games']}
                >
                        <div className="flex items-center justify-between gap-3 pt-3">
                            <p className="sd-sub" style={{ margin: 0 }}>Click a process to tag it as a game; right-click to ignore it.</p>
                            <ClButton
                                size="sm"
                                variant="ghost"
                                onClick={fetchProcesses}
                                disabled={loadingProcesses}
                            >
                                <RefreshCw size={11} className={loadingProcesses ? 'animate-spin' : ''} />
                                Refresh
                            </ClButton>
                        </div>
                    <div className="mt-2">
                        <div className="max-h-60 overflow-y-auto rounded-lg" style={{ background: 'rgba(0,0,0,.2)', border: '1px solid var(--cl-border)' }}>
                            {processes.length === 0 ? (
                                <p className="sd-empty">
                                    {loadingProcesses ? 'Listening for processes…' : 'No processes found.'}
                                </p>
                            ) : (
                                processes.map(proc => {
                                    const isCustomGame = customGameProcessNames.has(proc);
                                    const isIgnored = ignoredSet.has(proc);

                                    return (
                                        <div
                                            key={proc}
                                            onClick={() => {
                                                if (isCustomGame || isIgnored) return;
                                                setAddingGame(true);
                                                setSelectedProcess(proc);
                                            }}
                                            onContextMenu={e => {
                                                e.preventDefault();
                                                if (isIgnored) {
                                                    removeIgnoredProcess(proc);
                                                } else if (!isCustomGame) {
                                                    addIgnoredProcess(proc);
                                                }
                                            }}
                                            style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: 8,
                                                padding: '4px 12px',
                                                fontSize: 12,
                                                fontFamily: 'var(--cl-font-mono)',
                                                cursor: isCustomGame || isIgnored ? 'default' : 'pointer',
                                                color: isCustomGame ? 'var(--cl-lume)' : isIgnored ? 'var(--cl-faint)' : 'var(--cl-muted)',
                                                opacity: isCustomGame ? .8 : isIgnored ? .5 : 1,
                                                textDecoration: isIgnored ? 'line-through' : undefined,
                                                background: isCustomGame ? 'rgba(37,224,200,.04)' : 'transparent',
                                                borderBottom: '1px solid rgba(255,255,255,.02)',
                                                transition: 'background .1s',
                                            }}
                                            onMouseEnter={e => {
                                                if (!isCustomGame && !isIgnored)
                                                    (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,.03)';
                                            }}
                                            onMouseLeave={e => {
                                                (e.currentTarget as HTMLDivElement).style.background = isCustomGame ? 'rgba(37,224,200,.04)' : 'transparent';
                                            }}
                                            title={
                                                isCustomGame ? 'Already added as game'
                                                : isIgnored ? 'Right-click to un-ignore'
                                                : 'Click to add as game, right-click to ignore'
                                            }
                                        >
                                            {isCustomGame && <Gamepad2 size={11} style={{ color: 'var(--cl-lume)', opacity: .5, flexShrink: 0 }} />}
                                            {isIgnored && <EyeOff size={11} style={{ color: 'var(--cl-faint)', flexShrink: 0 }} />}
                                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{proc}</span>
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    </div>
                </SettingsDisclosure>
            </div>

            {/* Ignored processes: rarely edited, so folded with its count on the row. */}
            <SettingsDisclosure
                id="activity.ignored"
                variant="card"
                title="Ignored processes"
                summary="Never detected as games, no matter what they’re named."
                icon={<EyeOff size={15} />}
                badge={`${settings.ignoredProcesses.length}`}
                labels={['Ignored games']}
            >
                <div className="pt-2">
                    {settings.ignoredProcesses.length === 0 ? (
                        <p className="sd-empty">Nothing ignored. Right-click a process under Running now to add one.</p>
                    ) : (
                        <div className="space-y-1 mb-3">
                            {settings.ignoredProcesses.map(proc => (
                                <div key={proc} className="flex items-center gap-3 px-3 py-1.5 rounded-lg hover:bg-white/[0.03] group">
                                    <EyeOff size={13} style={{ color: 'var(--cl-faint)', flexShrink: 0 }} />
                                    <span className="text-sm font-mono flex-1 truncate" style={{ color: 'var(--cl-muted)' }}>{proc}</span>
                                    <ClButton
                                        icon
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => removeIgnoredProcess(proc)}
                                        tooltip="Remove from ignore list"
                                        className="opacity-0 group-hover:opacity-100"
                                    >
                                        <X size={13} />
                                    </ClButton>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </SettingsDisclosure>
        </>
    );
};

export default GameActivitySettings;
