/**
 * Settings → Voice & Video → Your audio devices: every microphone and speaker /
 * headset this account has used on this computer, with its own remembered
 * settings (utils/audioDeviceProfiles.ts). Open one to change its settings even
 * while it is unplugged — they apply the next time it is the device in use (at
 * once if it is in use now). Forget drops a device that is not in use.
 *
 * Labels are shown here and nowhere else; they never leave the device.
 */
import React, { useId, useState } from 'react';
import { ChevronDown, Headphones, Mic } from 'lucide-react';
import { ClButton, ClConfirm, ClToggle } from '../cl';
import { ClSlider } from '../ClSlider';
import { VvRow } from './VvRow';
import { InfoTip } from './InfoTip';
import { NoiseSuppressionEngine } from '../NoiseSuppressionEngine';
import { lastUsedText, type AudioDeviceKind, type InputProfileSettings, type OutputProfileSettings } from '../../utils/audioDeviceProfiles';
import type { AudioDeviceProfilesApi } from '../../hooks/useAudioDeviceProfiles';
import { MAX_VOLUME_PERCENT } from '../../utils/volumeLimits';
import { DEFAULT_VOICE_SETTINGS } from '../../hooks/useVoiceSettings';

type Sel = { kind: AudioDeviceKind; key: string } | null;

const InputEditor: React.FC<{ s: InputProfileSettings; set: (p: Partial<InputProfileSettings>) => void }> = ({ s, set }) => (
    <>
        <VvRow label="Input volume">
            <ClSlider min={0} max={MAX_VOLUME_PERCENT} step={1} value={s.micVolume} onChange={v => set({ micVolume: v })} resetValue={DEFAULT_VOICE_SETTINGS.micVolume} formatLabel={v => `${v}%`} style={{ flex: 1, minWidth: 0 }} />
            <span className="vv-val">{s.micVolume}%</span>
        </VvRow>
        <VvRow label="Noise suppression" kind="block">
            <NoiseSuppressionEngine
                compact
                enabled={s.noiseSuppression}
                mode={s.noiseSuppressionMode}
                onEnabledChange={v => set({ noiseSuppression: v })}
                onModeChange={m => set({ noiseSuppressionMode: m })}
            />
        </VvRow>
        <VvRow label="Voice gate">
            <ClSlider
                min={-60} max={-20} step={1} value={s.voiceGateThreshold} onChange={v => set({ voiceGateThreshold: v })}
                resetValue={DEFAULT_VOICE_SETTINGS.voiceGateThreshold} formatLabel={v => `${v} dB`} style={{ flex: 1, minWidth: 0, opacity: s.voiceGate ? 1 : 0.35 }}
            />
            <span className="vv-val vv-val--wide">{s.voiceGateThreshold} dB</span>
            <ClToggle checked={s.voiceGate} onChange={v => set({ voiceGate: v })} aria-label="Voice gate" />
        </VvRow>
        <VvRow label="Echo cancellation" kind="switch" note="Only recommended when using speakers.">
            <ClToggle checked={s.echoCancellation} onChange={v => set({ echoCancellation: v })} aria-label="Echo cancellation" />
        </VvRow>
        <VvRow label="Auto gain control" kind="switch">
            <ClToggle checked={s.volumeNormalization} onChange={v => set({ volumeNormalization: v })} aria-label="Auto gain control" />
        </VvRow>
        <VvRow label="Mic EQ" kind="switch" info="Switches this mic's EQ on or off. Shape the five bands under Voice processing while this mic is in use.">
            <ClToggle checked={s.eqEnabled} onChange={v => set({ eqEnabled: v })} aria-label="Mic EQ" />
        </VvRow>
    </>
);

const OutputEditor: React.FC<{ s: OutputProfileSettings; set: (p: Partial<OutputProfileSettings>) => void }> = ({ s, set }) => (
    <>
        <VvRow label="Output volume">
            <ClSlider min={0} max={MAX_VOLUME_PERCENT} step={1} value={s.speakerVolume} onChange={v => set({ speakerVolume: v })} resetValue={DEFAULT_VOICE_SETTINGS.speakerVolume} formatLabel={v => `${v}%`} style={{ flex: 1, minWidth: 0 }} />
            <span className="vv-val">{s.speakerVolume}%</span>
        </VvRow>
        <VvRow label="Normalize voice volume" kind="switch">
            <ClToggle checked={s.normalizeIncomingVolume} onChange={v => set({ normalizeIncomingVolume: v })} aria-label="Normalize voice volume" />
        </VvRow>
    </>
);

const DeviceRow: React.FC<{
    api: AudioDeviceProfilesApi;
    kind: AudioDeviceKind;
    id: string;
    open: boolean;
    onToggle: () => void;
    onForget: () => void;
    now: number;
}> = ({ api, kind, id, open, onToggle, onForget, now }) => {
    const bodyId = useId();
    const p = api.profiles![kind][id];
    const active = kind === 'input' ? api.activeInput : api.activeOutput;
    const inUse = active?.key === id;
    const plugged = api.connected[kind].has(id);
    const status = inUse
        ? (active?.viaDefault ? 'In use · system default' : 'In use')
        : `${plugged ? 'Plugged in' : 'Not plugged in'} · ${lastUsedText(p.lastUsedAt, now)}`;
    const Icon = kind === 'input' ? Mic : Headphones;
    const set = (partial: Record<string, unknown>) => api.updateProfile(kind, id, partial);
    return (
        <li className={`vv-dev${open ? ' vv-dev--open' : ''}${inUse ? ' vv-dev--inuse' : ''}`} data-device-kind={kind}>
            <button type="button" className="vv-dev-main" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
                <Icon size={15} className="vv-dev-ico" aria-hidden="true" />
                <span className="vv-dev-txt">
                    <b>{p.label}</b>
                    <span>{status}</span>
                </span>
                {inUse && <span className="sd-chip sd-chip--lume">In use</span>}
                {!inUse && !plugged && <span className="sd-chip">Unplugged</span>}
                <ChevronDown size={16} className="vv-dev-chev" aria-hidden="true" />
            </button>
            {open && (
                <div id={bodyId} className="vv-dev-edit" role="region" aria-label={`${p.label} settings`}>
                    {kind === 'input'
                        ? <InputEditor s={p.settings as InputProfileSettings} set={set} />
                        : <OutputEditor s={p.settings as OutputProfileSettings} set={set} />}
                    <div className="vv-actions">
                        <ClButton
                            variant="ghost" size="sm" onClick={onForget} disabled={inUse}
                            tooltip={inUse ? 'In use right now. Switch to another device to forget this one.' : undefined}
                        >
                            Forget device
                        </ClButton>
                    </div>
                </div>
            )}
        </li>
    );
};

export const AudioDeviceList: React.FC<{ api: AudioDeviceProfilesApi }> = ({ api }) => {
    const [sel, setSel] = useState<Sel>(null);
    const [confirm, setConfirm] = useState<{ kind: AudioDeviceKind; key: string; label: string } | null>(null);
    // "Used 2 days ago" is relative to when the pane opened; minutes of drift do not matter here.
    const [now] = useState(() => Date.now());
    if (!api.ready || !api.profiles) return null;
    const profiles = api.profiles;
    const order = (kind: AudioDeviceKind) => {
        const activeKey = (kind === 'input' ? api.activeInput : api.activeOutput)?.key;
        const map = profiles[kind] as Record<string, { lastUsedAt: number }>;
        return Object.keys(map).sort((a, b) =>
            (b === activeKey ? 1 : 0) - (a === activeKey ? 1 : 0)
            || (api.connected[kind].has(b) ? 1 : 0) - (api.connected[kind].has(a) ? 1 : 0)
            || map[b].lastUsedAt - map[a].lastUsedAt);
    };
    const groups: { kind: AudioDeviceKind; title: string; empty: string }[] = [
        { kind: 'input', title: 'Microphones', empty: 'None yet. A microphone is remembered the first time it is used.' },
        { kind: 'output', title: 'Speakers & headphones', empty: 'None yet. A speaker or headset is remembered the first time it plays.' },
    ];
    return (
        <div className="sd-card vv-card" data-labels="Remembered devices|Audio devices">
            <div className="vv-head">
                <h3>Your audio devices</h3>
                <InfoTip label="Your audio devices">
                    <p>Every microphone and speaker or headset you use keeps its own settings: input volume, noise suppression, voice gate, echo cancellation, auto gain and mic EQ for a mic; output volume and normalize voice volume for a speaker.</p>
                    <p>When you plug one in, or Windows switches its default, that device&rsquo;s settings come back on their own, in a call too. The first time a device is used it starts from the settings you had.</p>
                    <p>Open a device to change its settings even while it is unplugged. Push to talk, camera and video settings are the same everywhere.</p>
                    <p>Device names stay on this computer and in your encrypted backup. They are never sent to Cipherline.</p>
                </InfoTip>
            </div>
            {groups.map(g => {
                const keys = order(g.kind);
                return (
                    <div key={g.kind} className="vv-devgroup">
                        <div className="vv-devgroup-title">{g.title}</div>
                        {keys.length === 0
                            ? <p className="vv-hint">{g.empty}</p>
                            : (
                                <ul className="vv-devlist">
                                    {keys.map(k => (
                                        <DeviceRow
                                            key={k}
                                            api={api}
                                            kind={g.kind}
                                            id={k}
                                            now={now}
                                            open={sel?.kind === g.kind && sel.key === k}
                                            onToggle={() => setSel(s => (s?.kind === g.kind && s.key === k ? null : { kind: g.kind, key: k }))}
                                            onForget={() => setConfirm({ kind: g.kind, key: k, label: profiles[g.kind][k].label })}
                                        />
                                    ))}
                                </ul>
                            )}
                    </div>
                );
            })}
            <ClConfirm
                open={confirm !== null}
                onClose={() => setConfirm(null)}
                onConfirm={() => {
                    if (confirm) { api.forget(confirm.kind, confirm.key); setSel(null); }
                    setConfirm(null);
                }}
                title={`Forget ${confirm?.label ?? 'this device'}?`}
                message="Its settings are deleted. If you use it again it starts from the settings you have then."
                confirmLabel="Forget"
                danger
            />
        </div>
    );
};
