import axios from 'axios';
import { API_BASE } from '../constants';

/** What the Dashboard's `handleStartChat` needs to open a 1:1. */
export interface StartedDm {
    id: string;
    title: string;
    type: 'dm';
    other_user_id: string;
    avatar_url?: string;
}

export interface DmPerson {
    user_id: string;
    username: string;
    avatar_url?: string | null;
}

/**
 * Open (or find) your 1:1 with `person`: ONE call, `POST /conversations/dm
 * { other_user_id }`, which find-or-creates the conversation. This is the exact
 * request StartDMModal.handleOpen sends (its test pins it), pulled out so a
 * second caller — the "group of two" interception in CreateGroupModal — opens a
 * DM through the same path instead of growing a parallel one. The server still
 * refuses a DM with a non-friend (403); that gate is never worked around here.
 *
 * Throws on failure (axios error): the caller decides how to say so.
 */
export async function startDirectMessage(opts: {
    token: string | null;
    deviceId: string | null;
    person: DmPerson;
}): Promise<StartedDm> {
    const { token, deviceId, person } = opts;
    const res = await axios.post(
        `${API_BASE}/conversations/dm`,
        { other_user_id: person.user_id },
        { headers: { Authorization: `Bearer ${token}`, 'x-device-id': deviceId } },
    );
    return {
        id: res.data.conversation_id,
        title: person.username,
        type: 'dm',
        other_user_id: person.user_id,
        avatar_url: person.avatar_url ?? undefined,
    };
}
