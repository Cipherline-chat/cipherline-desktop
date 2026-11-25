/**
 * Types for `psl` (Public Suffix List, utils/externalLinks/registrableDomain.ts).
 * psl ships types/index.d.ts, but its package.json "exports" map has no
 * "types" condition, so bundler resolution cannot reach them. This mirrors the
 * three functions it exports. Ambient on purpose (no top-level import/export).
 */
declare module 'psl' {
    export interface ParsedDomain {
        input: string;
        tld: string | null;
        sld: string | null;
        domain: string | null;
        subdomain: string | null;
        listed: boolean;
    }
    export interface ErrorResult {
        input: string;
        error: { code: string; message: string };
    }
    export function parse(input: string): ParsedDomain | ErrorResult;
    export function get(domain: string): string | null;
    export function isValid(domain: string): boolean;
}
