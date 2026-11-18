/* eslint-disable -- harness, not shipped */
// ChatPane's MemoRow with a render counter (aliased in by save-no-jump.vite.config.ts):
// window.__snjRowRenders counts every message-row body that actually re-ran.
import React from 'react';
import { MemoRow as RealMemoRow } from '../src/components/MemoRow';

export const MemoRow: React.FC<{ deps: readonly unknown[]; render: () => React.ReactNode }> = ({ deps, render }) => (
    <RealMemoRow
        deps={deps}
        render={() => {
            (window as any).__snjRowRenders = ((window as any).__snjRowRenders ?? 0) + 1;
            return render();
        }}
    />
);
