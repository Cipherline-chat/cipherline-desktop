import axios from 'axios';

/** The server's own message for a rejected request (its first validation line), else `fallback`. */
export function patchErrorMessage(err: unknown, fallback: string): string {
    if (axios.isAxiosError(err)) {
        const m = (err.response?.data as { message?: string | string[] } | undefined)?.message;
        const first = Array.isArray(m) ? m[0] : m;
        if (typeof first === 'string' && first) return first;
    }
    return fallback;
}
