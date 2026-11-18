/**
 * Thin axios wrappers for the gift routes (apps/api billing/gifts.controller.ts).
 * Every route is authenticated; the server decides every price, state and
 * entitlement — these only carry requests and hand back its answers.
 *
 * Gift ids arrive from E2EE chat messages, i.e. from another user. The shared
 * `pro_gift` validator already pins them to a UUID, but they are checked again
 * here before being put in a URL path, so a malformed id can never become a
 * different route (`../`) — it is simply "not found".
 */
import { useMemo } from 'react';
import axios from 'axios';
import {
    GIFT_ID_PATTERN,
    type GiftConfig,
    type GiftListResponse,
    type GiftMonths,
    type GiftPurchaseResult,
    type GiftRedeemResult,
    type GiftView,
} from '@cipherline/shared';
import { API_BASE } from '../../../constants';
import { apiUrl } from '../../../utils/apiPath';
import { useAuth } from '../../../contexts/AuthContext';

export interface GiftPurchaseBody {
    recipient_user_id: string;
    months: GiftMonths;
    confirmation_token_id: string;
}

export interface GiftsApi {
    config: () => Promise<GiftConfig>;
    list: () => Promise<GiftListResponse>;
    get: (giftId: string) => Promise<GiftView>;
    purchase: (body: GiftPurchaseBody) => Promise<GiftPurchaseResult>;
    confirm: (giftId: string) => Promise<GiftView>;
    redeem: (giftId: string) => Promise<GiftRedeemResult>;
}

/** Thrown (and recognised by `isGiftNotFound`) for an id that is not a UUID. */
export class InvalidGiftIdError extends Error {
    readonly status = 404;
    constructor() { super('This gift isn’t available.'); this.name = 'InvalidGiftIdError'; }
}

function giftPath(giftId: string, suffix = ''): string {
    if (typeof giftId !== 'string' || !GIFT_ID_PATTERN.test(giftId)) throw new InvalidGiftIdError();
    return apiUrl`/billing/gifts/${giftId}` + suffix;
}

export function createGiftsApi(token: string | null | undefined): GiftsApi {
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    return {
        config: async () => (await axios.get<GiftConfig>(`${API_BASE}/billing/gifts/config`, { params: { platform: 'desktop' }, headers })).data,
        list: async () => (await axios.get<GiftListResponse>(`${API_BASE}/billing/gifts`, { headers })).data,
        get: async (id) => (await axios.get<GiftView>(giftPath(id), { headers })).data,
        purchase: async (body) => (await axios.post<GiftPurchaseResult>(
            `${API_BASE}/billing/gifts`,
            { recipient_user_id: body.recipient_user_id, months: body.months, confirmation_token_id: body.confirmation_token_id, platform: 'desktop' },
            { headers },
        )).data,
        confirm: async (id) => (await axios.post<GiftView>(giftPath(id, '/confirm'), {}, { headers })).data,
        redeem: async (id) => (await axios.post<GiftRedeemResult>(giftPath(id, '/redeem'), {}, { headers })).data,
    };
}

/** The gift API bound to the signed-in account. */
export function useGiftsApi(): GiftsApi {
    const { token } = useAuth();
    return useMemo(() => createGiftsApi(token), [token]);
}

/** A 404 (or an id that could never exist): show "isn't available", not "retry". */
export function isGiftNotFound(err: unknown): boolean {
    if (err instanceof InvalidGiftIdError) return true;
    const status = (err as { response?: { status?: unknown } } | null | undefined)?.response?.status;
    return status === 404;
}
