/** (named test-*.ts so tsconfig.electron.json leaves it out of the shipped build) Test double for win-sys.ts: a fake Windows process list. Not imported by production code. */
import { NO_WIN_SYS, normalizeProcessName, type WinSys } from './win-sys';

/** `"name.exe","pid",...` lines (the shape the old tasklist output had, which the detector tests build) -> names. */
export function namesFromCsv(csv: string): string[] {
    return csv.split('\n')
        .map(line => normalizeProcessName((line.split(',')[0] ?? '').replace(/"/g, '')))
        .filter(Boolean);
}

export function csvWinSys(csv: () => string, over: Partial<WinSys> = {}): WinSys {
    return { ...NO_WIN_SYS, processNames: async () => namesFromCsv(csv()), isSuspended: async () => false, ...over };
}
