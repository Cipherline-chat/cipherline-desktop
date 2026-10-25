/**
 * BackupProgressBars — one progress bar per backup destination (local folder,
 * Google Drive) so you can see each is actually running. Driven entirely by
 * `ProgressRows` from services/backupProgressState (pure + tested).
 *
 * Google Drive shows real upload progress; the local write has nothing to
 * measure, so it shows a moving (indeterminate) bar while it runs.
 */
import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Check, AlertTriangle } from 'lucide-react';
import {
    DESTINATION_NAME, isRowRunning, rowStatusText,
    type ProgressRow, type ProgressRows,
} from '../services/backupProgressState';
import type { DestinationLabel } from '../services/driveBackup';

const ORDER: DestinationLabel[] = ['local', 'drive'];

const Bar: React.FC<{ row: ProgressRow; name: string }> = ({ row, name }) => {
    const reduceMotion = useReducedMotion();
    const failed = row.stage === 'error';
    const finished = row.stage === 'done' || row.stage === 'skipped';
    const running = isRowRunning(row);
    const indeterminate = running && row.pct === null;
    const fill = failed ? 'var(--cl-flash)' : finished ? 'var(--cl-ok)' : 'var(--cl-lume)';

    return (
        <div
            role="progressbar"
            aria-label={`${name} backup`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={indeterminate || row.stage === 'waiting' ? undefined : (row.pct ?? undefined)}
            aria-valuetext={rowStatusText(row)}
            className="relative h-1.5 rounded-full overflow-hidden"
            style={{ background: 'rgba(255,255,255,.07)' }}
        >
            {indeterminate ? (
                <motion.div
                    className="absolute inset-y-0 rounded-full"
                    style={{ width: '35%', background: fill }}
                    {...(reduceMotion
                        ? { initial: { left: '32%' } }
                        : {
                            initial: { left: '-35%' },
                            animate: { left: '100%' },
                            transition: { duration: 1.1, ease: 'easeInOut', repeat: Infinity },
                        })}
                />
            ) : (
                <motion.div
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{ background: fill }}
                    initial={false}
                    animate={{ width: `${failed ? 100 : row.stage === 'waiting' ? 0 : (row.pct ?? 0)}%` }}
                    transition={{ duration: reduceMotion ? 0 : 0.25, ease: 'easeOut' }}
                />
            )}
        </div>
    );
};

export const BackupProgressBars: React.FC<{ rows: ProgressRows }> = ({ rows }) => {
    const shown = ORDER.filter(l => rows[l]);
    if (shown.length === 0) return null;
    return (
        <div
            className="rounded-xl px-3.5 py-3 space-y-3"
            style={{ border: '1px solid var(--cl-border)', background: 'rgba(0,0,0,.15)' }}
            aria-live="polite"
        >
            {shown.map(l => {
                const row = rows[l]!;
                const failed = row.stage === 'error';
                const finished = row.stage === 'done' || row.stage === 'skipped';
                return (
                    <div key={l} className="space-y-1.5">
                        <div className="flex items-center justify-between gap-3 text-[12px]">
                            <span style={{ color: 'var(--cl-text)', fontWeight: 500 }}>{DESTINATION_NAME[l]}</span>
                            <span
                                className="flex items-center gap-1 tabular-nums"
                                style={{ color: failed ? 'var(--cl-flash)' : finished ? 'var(--cl-ok)' : 'var(--cl-faint)' }}
                            >
                                {finished && <Check size={12} />}
                                {failed && <AlertTriangle size={12} />}
                                {rowStatusText(row)}
                            </span>
                        </div>
                        <Bar row={row} name={DESTINATION_NAME[l]} />
                    </div>
                );
            })}
        </div>
    );
};
