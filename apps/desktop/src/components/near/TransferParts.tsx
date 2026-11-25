import React from 'react';
import { ChevronRight } from 'lucide-react';
import { ClModal } from '../cl/ClModal';
import { ClButton } from '../ClButton';
import { nt } from '../../utils/nearStrings';
import '../../styles/near.css';

/**
 * Shared pieces of the own-device history transfer screens (sign-in step, picker, wait, holder sheet, endings). Composed from
 * the app's primitives (`ClModal`, `ClButton`) and near.css; no `cl/` primitive is edited (the website imports those).
 */

export type TileTone = 'lume' | 'neutral' | 'ok' | 'warn' | 'danger';

/** Icon tile + title + one paragraph: the head of every transfer dialog. */
export const XferHead: React.FC<{ icon: React.ReactNode; tone?: TileTone; title: string; body?: React.ReactNode; titleId?: string }> = ({ icon, tone = 'lume', title, body, titleId }) => (
    <div className="nr-xhead">
        <span className={`nr-tile ${tone}`} aria-hidden>{icon}</span>
        <div>
            <h2 id={titleId}>{title}</h2>
            {body != null && <p>{body}</p>}
        </div>
    </div>
);

/** A large choice row (icon, title, one line, chevron). Up / Down move between the rows of one `.nr-choices` group. */
export const Choice: React.FC<{ icon: React.ReactNode; title: string; value?: string; primary?: boolean; onClick: () => void; autoFocus?: boolean; testId?: string }> = ({ icon, title, value, primary, onClick, autoFocus, testId }) => (
    <button type="button" className={`nr-choice${primary ? ' primary' : ''}`} onClick={onClick} autoFocus={autoFocus} data-testid={testId}
        onKeyDown={(e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            const group = Array.from((e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('.nr-choice')) ?? []);
            const i = group.indexOf(e.currentTarget);
            const next = group[(i + (e.key === 'ArrowDown' ? 1 : -1) + group.length) % group.length];
            if (next) { e.preventDefault(); next.focus(); }
        }}>
        <span className="ic" aria-hidden>{icon}</span>
        <span><span className="t">{title}</span>{value && <span className="v">{value}</span>}</span>
        <ChevronRight size={18} className="chev" aria-hidden />
    </button>
);

/** Every way a transfer can end without moving anything (and the "not enough space" stop): one calm dialog. The asker can try
 *  again (the picker reopens); the holder can only close. */
export const OutcomeDialog: React.FC<{
    kind: string; icon: React.ReactNode; tone: TileTone; title: string; body?: string;
    onClose: () => void; onRetry?: () => void;
}> = ({ kind, icon, tone, title, body, onClose, onRetry }) => (
    <ClModal open onClose={onClose} width={460} label={title}>
        <div className="nr-modal" data-testid={`own-${kind}`} role="status">
            <XferHead icon={icon} tone={tone} title={title} body={body} />
            <div className="foot">
                {onRetry ? <>
                    <ClButton variant="ghost" onClick={onClose}>{nt('common.close')}</ClButton>
                    <ClButton autoFocus onClick={onRetry}>{nt('common.tryAgain')}</ClButton>
                </> : <ClButton autoFocus onClick={onClose}>{nt('common.close')}</ClButton>}
            </div>
        </div>
    </ClModal>
);

/** "just now" / "12 min ago" / "3 h ago" / "4 days ago" / a date, for a device's last activity. */
// eslint-disable-next-line react-refresh/only-export-components -- co-located helper export; splitting the file would only affect dev Fast Refresh, not runtime behaviour
export function lastActiveText(iso: string | number | null | undefined, now: number = Date.now()): string {
    const t = typeof iso === 'number' ? iso : iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, (now - t) / 1000);
    if (s < 90) return nt('f.pick.ago.now');
    if (s < 3600) return nt('f.pick.ago.m', { n: Math.round(s / 60) });
    if (s < 86_400) return nt('f.pick.ago.h', { n: Math.round(s / 3600) });
    if (s < 14 * 86_400) return nt('f.pick.ago.d', { n: Math.round(s / 86_400) });
    return new Date(t).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
}
