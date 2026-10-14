/**
 * Escaping for a single-quoted string literal inside a Google Drive `files.list`
 * `q=` query.
 *
 * Drive's query syntax treats BOTH `\` and `'` as special inside a quoted
 * literal (https://developers.google.com/drive/api/guides/search-files#escape).
 * Escaping only `'` is the classic incomplete-sanitisation bug: a value ending
 * in a backslash turns the closing quote into an escaped one and lets the rest
 * of the query be parsed as part of the literal. The backslash MUST be escaped
 * first, otherwise the backslash we add in front of a quote gets doubled.
 *
 * The renderer has its own copy, `escapeDriveQuery` in `src/utils/driveFolders.ts` (electron/ and
 * src/ cannot import each other: see the rootDir note in tsconfig.electron.json);
 * both are pinned by tests to the same expected outputs.
 *
 * Free of any `electron` import so it is unit-testable.
 */
export function escapeDriveQueryLiteral(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
