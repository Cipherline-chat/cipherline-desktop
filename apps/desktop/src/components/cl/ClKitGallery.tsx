import React, { useState } from 'react';
import { Search, Send, Phone, Trash2, Settings } from 'lucide-react';
import {
    ClButton, ClSlider, ClToggle, ClInput, ClTextarea, ClField, ClSearch,
    ClCheckbox, ClRadio, ClSegment, ClSelect, ClModal, ClConfirm, ClRadioGroup,
    ClPill, ClRole, ClProgress, ClSkeleton, ClAvatar,
} from './index';

/**
 * Living reference for the entire "glow in the deep" primitive layer. Every
 * control rendered in its real states so the design can be eyeballed as a
 * whole. Toggled in-app via Ctrl+Shift+K (see App.tsx). Dev/QA only — not
 * linked from any user-facing surface.
 */
const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
    <div style={{ marginBottom: 32 }}>
        <h3 style={{
            fontFamily: 'var(--cl-font-display)', color: 'var(--cl-text)', fontSize: 13,
            textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: 14, opacity: 0.6,
        }}>{title}</h3>
        <div style={{
            display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'center',
            background: 'var(--cl-deep)', border: '1px solid var(--cl-border)',
            borderRadius: 20, padding: 24,
        }}>{children}</div>
    </div>
);

export const ClKitGallery: React.FC<{ onClose: () => void }> = ({ onClose }) => {
    const [toggle, setToggle] = useState(true);
    const [check, setCheck] = useState(true);
    const [radio, setRadio] = useState<'a' | 'b'>('a');
    const [slider, setSlider] = useState(60);
    const [seg, setSeg] = useState<'all' | 'unread' | 'pinned'>('all');
    const [sel, setSel] = useState<'never' | '1mo' | '1wk'>('1mo');
    const [modal, setModal] = useState(false);
    const [confirm, setConfirm] = useState(false);
    const [policy, setPolicy] = useState(false);
    const [rg, setRg] = useState<'all' | 'mentions' | 'none'>('all');
    const [muted, setMuted] = useState(false);
    const [camOff, setCamOff] = useState(false);
    const [region, setRegion] = useState<'use' | 'usw' | 'eu' | 'ap'>('use');

    return (
        <div style={{
            position: 'fixed', inset: 0, zIndex: 10000, overflow: 'auto',
            background: 'var(--cl-abyss)', padding: '40px 48px',
            fontFamily: 'var(--cl-font-body)',
        }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 }}>
                <h1 style={{ fontFamily: 'var(--cl-font-display)', color: 'var(--cl-text)', fontSize: 28, margin: 0 }}>
                    Cipherline UI Kit
                </h1>
                <ClButton variant="ghost" size="sm" onClick={onClose}>Close (Esc)</ClButton>
            </div>

            <Section title="Buttons">
                <ClButton>Primary</ClButton>
                <ClButton variant="ghost">Ghost</ClButton>
                <ClButton variant="danger">Danger</ClButton>
                <ClButton variant="ok">Answer</ClButton>
                <ClButton size="sm">Small</ClButton>
                <ClButton size="lg">Large</ClButton>
                <ClButton loading>Loading</ClButton>
                <ClButton disabled>Disabled</ClButton>
                <ClButton icon><Settings size={18} /></ClButton>
                <ClButton variant="ok" icon><Phone size={18} /></ClButton>
                <ClButton pressAnim="send">Send <Send className="ico" size={15} /></ClButton>
                <ClButton variant="danger" pressAnim="trash" icon><Trash2 className="ico" size={17} /></ClButton>
            </Section>

            <Section title="Disabled → active (check the box to wake the button)">
                <ClCheckbox checked={policy} onChange={setPolicy} label="I've read the encryption policy" />
                <ClButton disabled={!policy}>Continue</ClButton>
            </Section>

            <Section title="Toggle / Checkbox / Radio">
                <ClToggle checked={toggle} onChange={setToggle} />
                <ClToggle checked={!toggle} onChange={(v) => setToggle(!v)} />
                <ClToggle checked={false} onChange={() => {}} disabled />
                <ClCheckbox checked={check} onChange={setCheck} label="Encrypted backup" />
                <ClCheckbox checked={!check} onChange={(v) => setCheck(!v)} label="Run on startup" />
                <ClRadio checked={radio === 'a'} onChange={() => setRadio('a')} label="Every device" />
                <ClRadio checked={radio === 'b'} onChange={() => setRadio('b')} label="This device" />
            </Section>

            <Section title="Inputs">
                <div style={{ width: 240 }}>
                    <ClField label="Username"><ClInput placeholder="janedoe" /></ClField>
                </div>
                <div style={{ width: 240 }}>
                    <ClField label="Password" error="Too weak — add length"><ClInput type="password" defaultValue="123" /></ClField>
                </div>
                <div style={{ width: 240 }}>
                    <ClField label="Display name" note="Shown to your friends"><ClInput placeholder="Jane" /></ClField>
                </div>
                <div style={{ width: 240 }}>
                    <ClSearch icon={<Search size={16} />} placeholder="Search…" />
                </div>
                <div style={{ width: 280 }}>
                    <ClTextarea rows={3} placeholder="Message…" />
                </div>
            </Section>

            <Section title="Segment / Select / Slider">
                <ClSegment
                    value={seg}
                    onChange={setSeg}
                    options={[{ value: 'all', label: 'All' }, { value: 'unread', label: 'Unread' }, { value: 'pinned', label: 'Pinned' }]}
                />
                <ClSelect
                    value={sel}
                    onChange={setSel}
                    options={[{ value: 'never', label: 'Keep forever' }, { value: '1mo', label: '1 month' }, { value: '1wk', label: '1 week' }]}
                />
                <ClSelect
                    value={region}
                    onChange={setRegion}
                    options={[
                        { value: 'use', label: 'US East' }, { value: 'usw', label: 'US West' },
                        { value: 'eu', label: 'Europe' }, { value: 'ap', label: 'Asia Pacific' },
                    ]}
                />
                <div style={{ width: 220 }}>
                    <ClSlider value={slider} min={0} max={100} onChange={setSlider} formatLabel={(v) => `${v}%`} />
                </div>
            </Section>

            <Section title="Call controls (active/muted slash + tooltips)">
                <ClButton icon active={muted} tooltip={muted ? 'Unmute' : 'Mute'} pressAnim={muted ? 'unmute' : 'mute'} onClick={() => setMuted((v) => !v)}>
                    <svg className="ico" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M6 10v1a6 6 0 0 0 12 0v-1" /><path d="M12 17v4" /><path className="slash" d="M5 4l14 16" /></svg>
                </ClButton>
                <ClButton icon active={camOff} tooltip={camOff ? 'Start video' : 'Stop video'} onClick={() => setCamOff((v) => !v)}>
                    <svg className="ico" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="6" width="13" height="12" rx="3" /><path d="M16 10.5l5-3v9l-5-3" /><path className="slash" d="M4 4l16 16" /></svg>
                </ClButton>
                <ClButton variant="danger" icon tooltip="Leave call" pressAnim="leave">
                    <svg className="ico" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15.5c-1.5.3-3.2.2-4.8-.4l-1-1.6c-2-.6-4.4-.6-6.4 0l-1 1.6c-1.6.6-3.3.7-4.8.4C2.4 13 3.7 9.6 6.6 8.2c3.3-1.6 7.5-1.6 10.8 0 2.9 1.4 4.2 4.8 3.6 7.3z" /></svg>
                </ClButton>
                <ClButton icon tooltip="Settings"><Settings size={18} /></ClButton>
            </Section>

            <Section title="Radio group">
                <ClRadioGroup
                    value={rg}
                    onChange={setRg}
                    options={[
                        { value: 'all', label: 'All messages' },
                        { value: 'mentions', label: 'Only @mentions' },
                        { value: 'none', label: 'Nothing' },
                    ]}
                />
            </Section>

            <Section title="Pills / Roles / Progress / Skeleton">
                <ClPill>3</ClPill>
                <ClPill>99+</ClPill>
                <ClRole>Member</ClRole>
                <ClRole variant="gold">Admin</ClRole>
                <ClRole variant="coral">Owner</ClRole>
                <ClProgress value={slider} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <ClSkeleton style={{ width: 180, height: 12 }} />
                    <ClSkeleton style={{ width: 120, height: 12 }} />
                </div>
            </Section>

            <Section title="Avatars & presence">
                <ClAvatar background="linear-gradient(135deg,#25E0C8,#12B79F)" status="online">JD</ClAvatar>
                <ClAvatar background="linear-gradient(135deg,#FFC94D,#D14A3F)" status="idle">AK</ClAvatar>
                <ClAvatar background="linear-gradient(135deg,#FF6B5E,#B23A30)" status="dnd">MR</ClAvatar>
                <ClAvatar background="var(--cl-surface)" status="off">SL</ClAvatar>
            </Section>

            <Section title="Modal & confirm">
                <ClButton onClick={() => setModal(true)}>Open modal</ClButton>
                <ClButton variant="danger" onClick={() => setConfirm(true)}>Delete (ClConfirm)</ClButton>
                <ClModal open={modal} onClose={() => setModal(false)} overlayStyle={{ zIndex: 10001 }}>
                    <h4>Delete channel?</h4>
                    <p>This will permanently delete #memes and its 1,204 messages. This can't be undone.</p>
                    <div className="mrow">
                        <ClButton variant="ghost" size="sm" onClick={() => setModal(false)}>Cancel</ClButton>
                        <ClButton variant="danger" size="sm" onClick={() => setModal(false)}>Delete channel</ClButton>
                    </div>
                </ClModal>
                <ClConfirm
                    open={confirm}
                    onClose={() => setConfirm(false)}
                    onConfirm={() => setConfirm(false)}
                    danger
                    title="Block this user?"
                    message="They won't be able to message you or send friend requests. They won't be notified."
                    confirmLabel="Block"
                    overlayStyle={{ zIndex: 10001 }}
                />
            </Section>
        </div>
    );
};

export default ClKitGallery;
