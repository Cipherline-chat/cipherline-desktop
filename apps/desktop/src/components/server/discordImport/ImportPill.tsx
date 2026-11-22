import React from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Download, Loader2, RotateCw } from 'lucide-react';
import type { ImportPillModel } from './importPillModel';
import '../../../styles/discord-import-pill.css';

/**
 * The background Discord import's pill, centred in the title bar
 * (DiscordImportHost mounts it; owner 2026-11-22: "this pill at the top could
 * be a little bigger it can take up all the vertical space in the top bar.
 * just make it look better").
 *
 * Presentational only: what it says comes from `importPillModel`
 * (importPillModel.ts, pure, tested in ImportPill.test.ts), what a click does is the host's business.
 *
 *   run        Importing Fusion          17%      (a lume fill grows inside the pill)
 *   finishing  Importing Fusion          finishing…   (the fill is full; also "stopping…" after Stop)
 *   ok         Fusion imported           See report
 *   danger     Fusion  2 channels failed Retry    (red; stays until retried or dismissed)
 *   warn       Fusion  import stopped    See report   (or "Try again" / "imported with issues")
 */
export interface ImportPillProps {
    model: ImportPillModel;
    onClick: () => void;
    /** Tooltip (the Discord server it comes from). */
    title?: string;
}

export const ImportPill: React.FC<ImportPillProps> = ({ model: m, onClick, title }) => {
    const icon = m.tone === 'ok' ? <CheckCircle2 size={14} strokeWidth={2.4} />
        : m.tone === 'danger' ? <AlertCircle size={14} strokeWidth={2.4} />
        : m.tone === 'warn' ? <AlertTriangle size={14} strokeWidth={2.4} />
        : m.tone === 'finishing' ? <Loader2 size={14} strokeWidth={2.4} className="cl-import-pill-spin" />
        : <Download size={14} strokeWidth={2.4} />;
    return (
        <button
            type="button"
            className={`cl-import-pill no-drag is-${m.tone}`}
            data-testid="import-pill"
            data-tone={m.tone}
            onClick={onClick}
            aria-label={`${m.label}. Open the import`}
            title={title}
        >
            {m.percent !== null && (
                <span className="cl-import-pill-track" aria-hidden="true">
                    <span className="cl-import-pill-fill" data-testid="import-pill-fill" style={{ width: `${Math.max(4, m.percent)}%` }} />
                </span>
            )}
            <span className="cl-import-pill-ico" aria-hidden="true">{icon}</span>
            <span className="cl-import-pill-text" aria-hidden="true">
                {m.lead && <span className="cl-import-pill-lead">{m.lead}</span>}
                <span className="cl-import-pill-name" data-testid="import-pill-name">{m.name}</span>
                {m.detail && <span className="cl-import-pill-detail">{m.detail}</span>}
            </span>
            <span className={`cl-import-pill-tail is-${m.tailKind}`} data-testid="import-pill-tail" aria-hidden="true">
                {m.tail === 'Retry' && <RotateCw size={11} strokeWidth={2.6} />}
                {m.tail}
            </span>
        </button>
    );
};

export default ImportPill;
