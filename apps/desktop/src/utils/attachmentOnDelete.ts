/**
 * Which server-side attachment copy an EXPLICIT delete should remove.
 *
 * Storage retention is per-device, so a device's automatic retention sweep
 * only clears its own local copy; it never deletes the server copy, because
 * the user's other devices and recipients may still need it. The server copy
 * goes when a person deliberately deletes the message that carries it, which
 * is what this answers. The server's own sweep (14 days) remains the
 * backstop either way.
 *
 * Returns null for anything that is not an attachment message. The server
 * authorises the delete itself (uploader, or a group owner/admin), so a
 * request for someone else's file is simply refused there.
 */
export function attachmentToDeleteWithMessage(message: unknown): string | null {
    const content = (message as { content?: { type?: unknown; attachment_id?: unknown } } | null | undefined)?.content;
    if (!content || content.type !== 'attachment') return null;
    return typeof content.attachment_id === 'string' && content.attachment_id ? content.attachment_id : null;
}
