import React, { useState } from 'react';
import { Lock, LockKeyholeOpen, KeyRound, TimerReset, Monitor } from 'lucide-react';
import { ClButton, ClToggle, ClSelect, ClModal, ClSegment } from './cl';
import SlottedCodeInput from './SlottedCodeInput';
import type { ScreenLockHook } from '../hooks/useScreenLock';
import { TIMEOUT_OPTIONS } from '../hooks/useScreenLock';
import type { KeybindHook } from '../hooks/useKeybinds';
import { formatCombo } from '../hooks/useKeybinds';

type Flow =
    | { kind: 'none' }
    // 'choose' picks 4 vs 6 digits before the PIN itself is typed.
    | { kind: 'setup'; step: 'choose' | 'enter' | 'confirm'; pinLength: 4 | 6; first: string }
    | { kind: 'change'; step: 'current' | 'choose' | 'new'; current: string; pinLength: 4 | 6 }
    | { kind: 'disable' };

/**
 * Privacy & Safety → Screen Lock. A local, PIN-gated overlay for "walked away
 * from your desk" — see useScreenLock.ts for the threat model (a UI gate, not
 * an extra layer of at-rest encryption; nothing here touches the server).
 */
const ScreenLockSettings: React.FC<{ screenLock: ScreenLockHook; keybinds: KeybindHook }> = ({ screenLock, keybinds }) => {
    const { settings } = screenLock;
    const [flow, setFlow] = useState<Flow>({ kind: 'none' });
    const [pin, setPin] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const closeFlow = () => { setFlow({ kind: 'none' }); setPin(''); setError(null); setBusy(false); };

    const lockCombo = keybinds.binds['lock-screen'];

    // ── Setup (first-time PIN) ──────────────────────────────────────────────
    const submitSetupChoose = (len: 4 | 6) => {
        setFlow({ kind: 'setup', step: 'enter', pinLength: len, first: '' });
    };
    const submitSetupEnter = async (code: string) => {
        if (flow.kind !== 'setup') return;
        setFlow({ kind: 'setup', step: 'confirm', pinLength: flow.pinLength, first: code });
        setPin('');
        setError(null);
    };
    const submitSetupConfirm = async (code: string) => {
        if (flow.kind !== 'setup') return;
        if (code !== flow.first) {
            setError("PINs didn't match. Let's try again.");
            setFlow({ kind: 'setup', step: 'enter', pinLength: flow.pinLength, first: '' });
            setPin('');
            return;
        }
        setBusy(true);
        await screenLock.setPin(code, flow.pinLength);
        closeFlow();
    };

    // ── Change PIN (requires current) ───────────────────────────────────────
    // The current PIN is only staged here — changePin() below is what actually
    // verifies it (against the encrypted verifier) before committing the new one.
    // pinLength defaults to the CURRENT length (this is an edit of an existing
    // choice, not a fresh setup) and is overwritten if the user picks a new one
    // at the 'choose' step.
    const submitChangeCurrent = async (code: string) => {
        setFlow({ kind: 'change', step: 'choose', current: code, pinLength: settings.pinLength });
        setPin('');
        setError(null);
    };
    const submitChangeChoose = (len: 4 | 6) => {
        if (flow.kind !== 'change') return;
        setFlow({ ...flow, step: 'new', pinLength: len });
    };
    const submitChangeNew = async (code: string) => {
        if (flow.kind !== 'change') return;
        setBusy(true);
        const ok = await screenLock.changePin(flow.current, code, flow.pinLength);
        setBusy(false);
        if (!ok) {
            setError('Current PIN was incorrect.');
            setFlow({ kind: 'none' });
            setPin('');
            return;
        }
        closeFlow();
    };

    // ── Disable (requires current PIN) ──────────────────────────────────────
    const submitDisable = async (code: string) => {
        setBusy(true);
        const ok = await screenLock.disable(code);
        setBusy(false);
        if (!ok) {
            setError('Wrong PIN.');
            setPin('');
            return;
        }
        closeFlow();
    };

    const modalTitle =
        flow.kind === 'setup' && flow.step === 'choose'  ? 'Choose your PIN length' :
        flow.kind === 'setup' && flow.step === 'enter'   ? `Choose a ${flow.pinLength}-digit PIN` :
        flow.kind === 'setup' && flow.step === 'confirm' ? 'Confirm your PIN' :
        flow.kind === 'change' && flow.step === 'current' ? 'Enter your current PIN' :
        flow.kind === 'change' && flow.step === 'choose' ? 'Choose your PIN length' :
        flow.kind === 'change' && flow.step === 'new'    ? `Choose a new ${flow.pinLength}-digit PIN` :
        flow.kind === 'disable'                          ? 'Enter your PIN to turn off Screen Lock' :
        '';

    // 'choose' steps are driven by ClSegment.onChange directly (see the modal
    // body below), not by SlottedCodeInput's onAutoSubmit — no entry here.
    const modalOnSubmit =
        flow.kind === 'setup' && flow.step === 'enter'   ? submitSetupEnter :
        flow.kind === 'setup' && flow.step === 'confirm' ? submitSetupConfirm :
        flow.kind === 'change' && flow.step === 'current' ? submitChangeCurrent :
        flow.kind === 'change' && flow.step === 'new'    ? submitChangeNew :
        flow.kind === 'disable'                          ? submitDisable :
        undefined;

    // Length to show in the active step's SlottedCodeInput: the *current*
    // stored length when verifying an existing PIN (disable; change's
    // 'current' step, whose flow.pinLength is seeded from settings.pinLength
    // anyway), otherwise the length just chosen for a new/changed PIN.
    const activeStepLength: 4 | 6 =
        flow.kind === 'disable' ? settings.pinLength :
        'pinLength' in flow ? flow.pinLength : 6;

    return (
        <>
            <div className="sd-card">
                <h3>Screen Lock</h3>
                <p className="sd-sub">
                    A local PIN gate for when you walk away from your desk. It's a screen — not extra
                    encryption — your messages stay protected the same way whether it's on or off.
                </p>

                <div className="sd-row" style={{ borderTop: 'none' }}>
                    <span className={`sd-tile${settings.enabled ? '' : ' sd-tile--dim'}`}>
                        {settings.enabled ? <Lock size={16} /> : <LockKeyholeOpen size={16} />}
                    </span>
                    <div className="sd-rl">
                        <b>Require a PIN to use Cipherline</b>
                        <span>{settings.enabled ? `A ${settings.pinLength}-digit PIN is set on this device.` : 'Off — set a PIN to turn this on.'}</span>
                    </div>
                    <div className="sd-rc">
                        {settings.enabled ? (
                            <ClButton size="sm" variant="ghost" onClick={() => setFlow({ kind: 'disable' })}>Turn off</ClButton>
                        ) : (
                            <ClButton size="sm" onClick={() => setFlow({ kind: 'setup', step: 'choose', pinLength: 6, first: '' })}>Set up</ClButton>
                        )}
                    </div>
                </div>

                {settings.enabled && (
                    <>
                        <div className="sd-row">
                            <span className="sd-tile"><KeyRound size={16} /></span>
                            <div className="sd-rl">
                                <b>Change PIN</b>
                                <span>You'll need your current PIN.</span>
                            </div>
                            <div className="sd-rc">
                                <ClButton size="sm" variant="ghost" onClick={() => setFlow({ kind: 'change', step: 'current', current: '', pinLength: settings.pinLength })}>
                                    Change
                                </ClButton>
                            </div>
                        </div>

                        <div className="sd-row">
                            <span className="sd-tile"><TimerReset size={16} /></span>
                            <div className="sd-rl">
                                <b>Lock after inactivity</b>
                                <span>Locks automatically after this long without a click or keystroke in Cipherline — even if you're busy in another app.</span>
                            </div>
                            <div className="sd-rc">
                                <ClSelect
                                    value={String(settings.timeoutMinutes)}
                                    onChange={v => screenLock.setTimeoutMinutes(Number(v))}
                                    options={TIMEOUT_OPTIONS.map(o => ({ value: String(o.value), label: o.label }))}
                                    style={{ width: 180 }}
                                />
                            </div>
                        </div>

                        <div className="sd-row">
                            <span className={`sd-tile${settings.lockOnOsLock ? '' : ' sd-tile--dim'}`}><Monitor size={16} /></span>
                            <div className="sd-rl">
                                <b>Lock with your screen lock</b>
                                <span>Also lock Cipherline whenever Windows/macOS locks or your computer sleeps.</span>
                            </div>
                            <div className="sd-rc">
                                <ClToggle checked={settings.lockOnOsLock} onChange={screenLock.setLockOnOsLock} />
                            </div>
                        </div>

                        <div className="sd-row">
                            <span className="sd-tile"><Lock size={16} /></span>
                            <div className="sd-rl">
                                <b>Lock instantly</b>
                                <span>
                                    Keybind: <b style={{ color: 'var(--cl-text)' }}>{lockCombo ? formatCombo(lockCombo) : 'Not set'}</b>
                                    {' '}— change it in Keybinds. Works even when Cipherline isn't focused.
                                </span>
                            </div>
                            <div className="sd-rc">
                                <ClButton size="sm" variant="ghost" onClick={screenLock.lockNow}>Lock now</ClButton>
                            </div>
                        </div>
                    </>
                )}
            </div>

            <ClModal open={flow.kind !== 'none'} onClose={closeFlow} width={380} label={modalTitle}>
                <div style={{ padding: '28px 24px', textAlign: 'center' }}>
                    <h2 style={{ fontSize: 17, fontWeight: 800, color: 'var(--cl-text)', margin: '0 0 6px' }}>{modalTitle}</h2>
                    {(flow.kind === 'setup' || flow.kind === 'change') && flow.step === 'choose' && (
                        <p style={{ fontSize: 12.5, color: 'var(--cl-faint)', margin: '0 0 20px' }}>
                            4 digits is quicker to type; 6 is harder to guess over your shoulder.
                        </p>
                    )}
                    {flow.kind === 'setup' && flow.step === 'enter' && (
                        <p style={{ fontSize: 12.5, color: 'var(--cl-faint)', margin: '0 0 20px' }}>
                            Pick digits you'll remember — there's no PIN recovery beyond signing out.
                        </p>
                    )}
                    {error && (
                        <div style={{
                            margin: '0 0 16px', padding: '9px 12px', borderRadius: 10, fontSize: 12.5,
                            background: 'rgba(255,77,79,0.08)', border: '1px solid rgba(255,77,79,0.28)',
                            color: 'var(--cl-flash)',
                        }}>
                            {error}
                        </div>
                    )}
                    <div style={{ margin: '20px 0' }}>
                        {(flow.kind === 'setup' || flow.kind === 'change') && flow.step === 'choose' ? (
                            // Picking a length advances the flow immediately — no separate
                            // confirm button, same as how SlottedCodeInput's onAutoSubmit
                            // already auto-advances every other step in this modal.
                            <ClSegment<'4' | '6'>
                                value={String(flow.pinLength) as '4' | '6'}
                                onChange={v => {
                                    const len = Number(v) as 4 | 6;
                                    if (flow.kind === 'setup') submitSetupChoose(len);
                                    else submitChangeChoose(len);
                                }}
                                options={[
                                    { value: '4', label: '4 digits' },
                                    { value: '6', label: '6 digits' },
                                ]}
                            />
                        ) : (
                            <SlottedCodeInput
                                key={`${flow.kind}-${'step' in flow ? flow.step : ''}`}
                                value={pin}
                                onChange={setPin}
                                onAutoSubmit={modalOnSubmit}
                                disabled={busy}
                                noAutoPaste
                                mask
                                length={activeStepLength}
                            />
                        )}
                    </div>
                    <ClButton fullWidth variant="ghost" onClick={closeFlow} disabled={busy}>Cancel</ClButton>
                </div>
            </ClModal>
        </>
    );
};

export default ScreenLockSettings;
