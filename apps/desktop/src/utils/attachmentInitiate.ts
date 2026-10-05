/**
 * Body for POST /attachments/initiate — the plaintext half of an upload.
 *
 * Everything here reaches the server in the clear, so it carries only what
 * the server needs to hand out an upload slot: the ciphertext size (upload
 * cap), the MIME type (stored on purpose for validation and the download
 * Content-Type), and which conversation / channel / server the object
 * belongs to.
 *
 * There is deliberately NO file-name field. The real name travels inside the
 * E2EE message envelope (`filename` in ClientContent); the API never stored
 * the plaintext `file_name` it used to receive, so sending it only leaked it.
 * attachmentInitiate.test.ts fails if any initiate call site sends one again.
 */
export interface AttachmentInitiateFields {
    sizeBytes: number;
    mimeType: string;
    conversationId?: string;
    channelId?: string;
    serverId?: string;
    purpose?: 'group_icon';
}

export interface AttachmentInitiateBody {
    size_bytes: number;
    mime_type: string;
    conversation_id?: string;
    channel_id?: string;
    server_id?: string;
    purpose?: 'group_icon';
}

export function buildAttachmentInitiateBody(f: AttachmentInitiateFields): AttachmentInitiateBody {
    const body: AttachmentInitiateBody = { size_bytes: f.sizeBytes, mime_type: f.mimeType };
    if (f.conversationId) body.conversation_id = f.conversationId;
    if (f.channelId) body.channel_id = f.channelId;
    if (f.serverId) body.server_id = f.serverId;
    if (f.purpose) body.purpose = f.purpose;
    return body;
}
